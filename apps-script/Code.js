/**
 * Code.js — the thin Apps-Script-facing layer. This is the only file that
 * touches SpreadsheetApp / PropertiesService / UrlFetchApp / ContentService.
 * All business logic lives in Logic.js and is called from here.
 *
 * Apps Script's V8 runtime shares one global scope across every .js file in
 * the project, so the functions from Logic.js (resolveHeaderIndexes,
 * computeEligibility, pickRandomEligible, etc.) are available here as plain
 * globals with no import statement.
 */

var POSTER_URL_HEADER = 'Poster URL';

// Streaming-platform and quote lookups are lazy/secondary (SPEC.md's
// "details" endpoint) and cached via CacheService rather than the sheet --
// a multi-hour TTL is fine per spec since neither TMDB providers nor an
// LLM's answer for a given movie changes on any meaningful timescale.
// CacheService's own max TTL is 6 hours (21600s); this sits right at it.
var DETAILS_CACHE_TTL_SECONDS = 6 * 60 * 60;

// Gemini Flash: fast, cheap-to-free, and its free tier needs no billing
// account (SPEC.md's whole reason for choosing it over the Anthropic API).
//
// Google retires model versions on a real cadence, not a hypothetical one:
// the original pick here (gemini-2.0-flash-lite) was retired 2026-06-01,
// which silently degraded every quote-generation call to the (indistinguishable
// from the outside) "no quotes" empty-array fail-safe -- a *permanent*
// failure wearing a *transient*-failure costume, so it went unnoticed until
// a product owner report. There is no code-level guardrail against a vendor
// deprecating a model out from under us; the mitigation is procedural --
// before touching this line, check Google's CURRENT model list at
// https://ai.google.dev/gemini-api/docs/models (not memory, not this
// comment) for a free-tier-eligible Flash/Flash-Lite model, update it here
// AND in README.md's Script Properties/setup docs (nowhere else references
// it), and if quotes ever silently stop populating in production again,
// this retirement is the first thing to check.
var GEMINI_MODEL = 'gemini-3.1-flash-lite';
var GEMINI_GENERATE_CONTENT_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' +
  GEMINI_MODEL + ':generateContent';

// ---------------------------------------------------------------------------
// Config / sheet access
// ---------------------------------------------------------------------------

function getScriptProperties_() {
  var props = PropertiesService.getScriptProperties();
  return {
    spreadsheetId: props.getProperty('SPREADSHEET_ID'),
    sharedToken: props.getProperty('SHARED_TOKEN'),
    tmdbApiKey: props.getProperty('TMDB_API_KEY'),
    geminiApiKey: props.getProperty('GEMINI_API_KEY')
  };
}

function getSheet_(props) {
  var ss = SpreadsheetApp.openById(props.spreadsheetId);
  return ss.getSheets()[0];
}

function readHeaderRow_(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) return [];
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
}

function readMovies_(sheet) {
  var values = sheet.getDataRange().getValues();
  var baseMovies = buildMoviesFromSheetValues(values);
  return computeEligibility(baseMovies);
}

/**
 * Ensure the sheet has a "Poster URL" column, creating it at the end of the
 * header row if it doesn't exist yet. Returns the column's 1-indexed
 * position.
 */
function ensurePosterColumn_(sheet) {
  var headerRow = readHeaderRow_(sheet);
  var headerIndexes = resolveHeaderIndexes(headerRow);
  if (headerIndexes.posterUrl >= 0) {
    return headerIndexes.posterUrl + 1;
  }
  var newColumn = sheet.getLastColumn() + 1;
  sheet.getRange(1, newColumn).setValue(POSTER_URL_HEADER);
  return newColumn;
}

/**
 * Resolve (and cache back into the sheet) the poster URL for a single
 * movie row. Only hits TMDB when the cell is genuinely blank — a cached URL
 * or the `none` sentinel short-circuits with no network call.
 *
 * The TMDB fetch+parse is deliberately isolated in its own try/catch: if
 * TMDB is down, rate-limited, or returns something unparseable for this one
 * row, that failure must not take down the whole list/spin response —
 * including sibling rows whose posters were already cached and needed no
 * network call at all. On failure we return posterUrl: null for this row
 * WITHOUT writing anything back to the sheet, so the next request retries
 * TMDB for it rather than permanently caching a bad result.
 */
function resolvePosterForMovie_(sheet, props, movie) {
  var cacheStatus = getPosterCacheStatus(movie.posterUrlCell);
  if (cacheStatus.status === 'cached' || cacheStatus.status === 'none') {
    return cacheStatus.posterUrl;
  }

  var result;
  try {
    var searchUrl = buildTmdbSearchUrl(props.tmdbApiKey, movie.title, movie.year);
    var response = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true });
    var json = JSON.parse(response.getContentText());
    result = parseTmdbSearchResponse(json, movie.year);
  } catch (err) {
    // TMDB unreachable / rate-limited / non-JSON response for this row only.
    // Don't cache anything — leave the cell blank so this row is retried on
    // the next request instead of being stuck as a permanent "none".
    return null;
  }

  var column = ensurePosterColumn_(sheet);
  sheet.getRange(movie.id, column).setValue(result.cacheValue);

  return result.posterUrl;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * `absentNames` is the already-parsed (parseAbsentParam) roster subset for
 * this request -- empty when `absent` was omitted/blank/all-unrecognized,
 * in which case attendance is a no-op and `attendanceApplied` is left
 * `undefined` so JSON.stringify drops the key entirely (SPEC.md: the field
 * is only present when `absent` was sent non-empty).
 */
function listMovies_(sheet, props, absentNames) {
  var movies = readMovies_(sheet);
  var attendanceApplied;
  if (absentNames && absentNames.length > 0) {
    var attendanceResult = computeAttendanceEligibility(movies, absentNames);
    movies = attendanceResult.movies;
    attendanceApplied = attendanceResult.attendanceApplied;
  }
  var publicMovies = movies.map(function (m) {
    var posterUrl = resolvePosterForMovie_(sheet, props, m);
    return toPublicMovie(m, posterUrl, { includeSeenBy: true });
  });
  return { movies: publicMovies, attendanceApplied: attendanceApplied };
}

function spinMovie_(sheet, props, absentNames) {
  var movies = readMovies_(sheet);
  var attendanceApplied;
  if (absentNames && absentNames.length > 0) {
    var attendanceResult = computeAttendanceEligibility(movies, absentNames);
    movies = attendanceResult.movies;
    attendanceApplied = attendanceResult.attendanceApplied;
  }
  var picked = pickRandomEligible(movies);
  var movie = null;
  if (picked) {
    var posterUrl = resolvePosterForMovie_(sheet, props, picked);
    movie = toPublicMovie(picked, posterUrl);
  }
  return { movie: movie, attendanceApplied: attendanceApplied };
}

/**
 * Write the Watched cell. Sheets commonly represent this column one of two
 * ways: a native checkbox (real boolean TRUE/FALSE) or a "Yes"/"No" text
 * dropdown (data validation on string values) -- writing a boolean into a
 * Yes/No-validated cell throws. Try the boolean first (the documented,
 * recommended format) and fall back to the Yes/No string on a validation
 * error, so either sheet setup works without extra configuration.
 *
 * The explicit flush() after each attempt matters: Apps Script can batch/
 * defer Sheets writes, so without forcing a synchronous commit here, a
 * validation failure on the first (boolean) attempt can surface later as an
 * unrelated-looking exception from whatever next touches the sheet (we saw
 * this manifest as the *next read* throwing this cell's validation error)
 * instead of being catchable right here where we can actually retry.
 */
function writeWatchedCell_(sheet, row, column, watchedValue) {
  try {
    sheet.getRange(row, column).setValue(watchedValue);
    SpreadsheetApp.flush();
  } catch (err) {
    sheet.getRange(row, column).setValue(watchedValue ? 'Yes' : 'No');
    SpreadsheetApp.flush();
  }
}

function setWatchedAction_(sheet, props, id, watchedValue) {
  var movies = readMovies_(sheet);
  var target = findMovieById(movies, id);
  if (!target) return { error: 'not_found' };

  var headerIndexes = resolveHeaderIndexes(readHeaderRow_(sheet));
  if (headerIndexes.watched < 0) return { error: 'sheet_error' };

  writeWatchedCell_(sheet, id, headerIndexes.watched + 1, watchedValue);

  // Re-read after write so the response reflects the persisted state
  // (including any eligibility changes it unlocks for other rows).
  var updatedMovies = readMovies_(sheet);
  var updated = findMovieById(updatedMovies, id);
  var posterUrl = resolvePosterForMovie_(sheet, props, updated);
  return { movie: toPublicMovie(updated, posterUrl) };
}

/**
 * Write the Rating cell. Unlike Watched, there's no Sheets-data-validation
 * fallback to worry about here -- Rating is a plain number column (or
 * blank to clear), not a checkbox/dropdown, so a single setValue() covers
 * it. `ratingValue` has already been validated (isValidRating) by the
 * caller before this runs.
 */
function setRatingAction_(sheet, props, id, ratingValue) {
  var movies = readMovies_(sheet);
  var target = findMovieById(movies, id);
  if (!target) return { error: 'not_found' };

  var headerIndexes = resolveHeaderIndexes(readHeaderRow_(sheet));
  if (headerIndexes.rating < 0) return { error: 'sheet_error' };

  var cellValue = (ratingValue === null) ? '' : ratingValue;
  sheet.getRange(id, headerIndexes.rating + 1).setValue(cellValue);
  SpreadsheetApp.flush();

  // Re-read after write, same as setWatchedAction_ -- keeps this response
  // consistent with whatever's actually persisted.
  var updatedMovies = readMovies_(sheet);
  var updated = findMovieById(updatedMovies, id);
  var posterUrl = resolvePosterForMovie_(sheet, props, updated);
  return { movie: toPublicMovie(updated, posterUrl) };
}

/** Cache key for a movie's streaming-platforms/quotes lookup, scoped by kind. */
function detailsCacheKey_(kind, movie) {
  return kind + ':' + normalizeTitle(movie.title) + (movie.year ? (':' + movie.year) : '');
}

/**
 * Resolve TMDB's movie id for a title/year, reusing the same
 * search-by-title(+year) lookup posters already do (SPEC.md). Throws on a
 * TMDB failure or malformed response -- callers are expected to wrap this
 * in their own try/catch, same isolation pattern as resolvePosterForMovie_.
 */
function resolveTmdbMovieId_(props, movie) {
  var searchUrl = buildTmdbSearchUrl(props.tmdbApiKey, movie.title, movie.year);
  var response = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true });
  var json = JSON.parse(response.getContentText());
  return extractTmdbMovieId(json, movie.year);
}

/**
 * Resolve (and cache) the streaming platforms for one movie. Cached via
 * CacheService, not the sheet (SPEC.md -- nothing in the sheet schema is
 * reserved for this).
 *
 * The cache.put() lives INSIDE the try block, after every fetch/parse step
 * has already succeeded -- mirroring resolvePosterForMovie_'s own fix for
 * the identical failure mode. A genuine "checked, TMDB has no match" result
 * (tmdbId null, or a match with no US flatrate listing) is a real answer
 * and gets cached like any other. But if UrlFetchApp/JSON.parse throws
 * partway through (TMDB down, rate-limited, non-JSON response), execution
 * never reaches the cache.put() line, so nothing is written -- the next
 * request retries TMDB for this movie instead of being stuck serving an
 * incorrectly-cached empty list for the full TTL.
 */
function resolveStreamingPlatforms_(props, movie) {
  var cache = CacheService.getScriptCache();
  var key = detailsCacheKey_('providers', movie);
  var cached = cache.get(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached);
    } catch (err) {
      // Corrupt cache entry -- fall through and recompute.
    }
  }

  try {
    var platforms = [];
    var tmdbId = resolveTmdbMovieId_(props, movie);
    if (tmdbId) {
      var url = buildTmdbProvidersUrl(props.tmdbApiKey, tmdbId);
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var json = JSON.parse(response.getContentText());
      platforms = parseTmdbProvidersResponse(json);
    }
    cache.put(key, JSON.stringify(platforms), DETAILS_CACHE_TTL_SECONDS);
    return platforms;
  } catch (err) {
    // TMDB unreachable / rate-limited / non-JSON response -- degrade to
    // empty for THIS request only. Deliberately not cached (see doc comment
    // above), so a transient failure gets retried next time.
    return [];
  }
}

/**
 * Resolve (and cache) memorable quotes for one movie via the Google Gemini
 * API's `generateContent` endpoint (chosen over the Anthropic API so this
 * app can run on Gemini's free tier -- see SPEC.md). Cached via
 * CacheService keyed by title (SPEC.md) -- an LLM call is slower and
 * costlier than a cache hit, and quotes for a given movie don't change.
 *
 * Three distinct failure shapes all degrade to an empty list for THIS
 * request only, without writing to the cache, so the next request retries
 * rather than getting stuck on a permanently-cached false "no quotes":
 *  - a thrown fetch/JSON.parse exception (network down, non-JSON body),
 *  - a non-200 HTTP response (bad/missing API key, rate limit, ...) --
 *    `muteHttpExceptions: true` means this arrives as a normal response,
 *    not a thrown exception, so it needs its own check,
 *  - a "blocked" response per isGeminiBlocked (no candidates, or a
 *    finishReason other than "STOP", e.g. a safety block).
 * Only past all three does cache.put() run, mirroring
 * resolveStreamingPlatforms_'s fail-open-for-retry shape above -- and the
 * same fix QA caught when this cached unconditionally on the old
 * Anthropic-backed path.
 *
 * Returns `{ quotes, debug }`. `debug` is non-null exactly when `quotes` is
 * empty, and says *why*:
 *   { type: 'exception', message }
 *   { type: 'http_error', status, body }
 *   { type: 'blocked', reason }
 *   { type: 'empty_success' }      -- Gemini responded fine, genuinely 0 quotes
 *   { type: 'cached_empty' }       -- served from cache; see below
 * TEMPORARY: this `debug` field only exists to power detailsAction_'s
 * `_quotesDebug` response field, added to chase a live "quotes always
 * empty" report by piggybacking on the Network-tab debugging channel the
 * product owner already has working (Apps Script's Executions panel proved
 * unusable for them). Remove `debug` here and `_quotesDebug` in
 * detailsAction_ together once that investigation is resolved.
 */
function resolveQuotes_(props, movie) {
  var cache = CacheService.getScriptCache();
  var key = detailsCacheKey_('quotes', movie);
  var cached = cache.get(key);
  if (cached !== null) {
    try {
      var cachedQuotes = JSON.parse(cached);
      // A cache hit that's empty means some earlier request already
      // resolved this to a genuine `empty_success` (that's the only way an
      // empty result gets cached at all, per the fail-open-for-retry rule
      // below) -- but that earlier request's specific reasoning wasn't
      // itself cached, so this is as precise as we can be after the fact.
      var cachedDebug = cachedQuotes.length === 0 ? { type: 'cached_empty' } : null;
      return { quotes: cachedQuotes, debug: cachedDebug };
    } catch (err) {
      // Corrupt cache entry -- fall through and recompute.
    }
  }

  try {
    var payload = buildGeminiQuotesPayload(movie.title, movie.year);
    var response = UrlFetchApp.fetch(GEMINI_GENERATE_CONTENT_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-goog-api-key': props.geminiApiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      // Diagnostic only -- behavior is unchanged (still [], still uncached).
      // Apps Script's basic Executions panel (Extensions > Apps Script >
      // Executions) shows console.error output with zero extra setup, unlike
      // Cloud Logging via `clasp logs`, which needs a linked GCP project.
      // Gemini error bodies usually carry a useful error.message -- log the
      // raw text rather than bothering to parse it out, still readable by eye.
      var errorBody = response.getContentText();
      console.error('[quotes] Gemini returned non-200 for "' + movie.title + '": status=' +
        response.getResponseCode() + ' body=' + errorBody);
      return { quotes: [], debug: { type: 'http_error', status: response.getResponseCode(), body: errorBody.slice(0, 500) } };
    }
    var json = JSON.parse(response.getContentText());
    if (isGeminiBlocked(json)) {
      var candidate = json && Array.isArray(json.candidates) && json.candidates[0];
      var blockReason = candidate ? candidate.finishReason : (json && json.promptFeedback && json.promptFeedback.blockReason);
      console.error('[quotes] Gemini blocked the request for "' + movie.title + '": ' +
        (blockReason ? ('reason=' + blockReason) : 'no candidates and no promptFeedback.blockReason -- raw response: ' + JSON.stringify(json)));
      return { quotes: [], debug: { type: 'blocked', reason: blockReason || null } };
    }
    var quotes = parseGeminiQuotesResponse(json);
    cache.put(key, JSON.stringify(quotes), DETAILS_CACHE_TTL_SECONDS);
    return { quotes: quotes, debug: quotes.length === 0 ? { type: 'empty_success' } : null };
  } catch (err) {
    // Gemini unreachable / non-JSON response -- degrade to empty for THIS
    // request only. Deliberately not cached (see doc comment above), so a
    // transient failure gets retried next time.
    var errorMessage = (err && err.message) ? err.message : String(err);
    console.error('[quotes] threw while fetching quotes for "' + movie.title + '": ' +
      (err && err.stack ? err.stack : err));
    return { quotes: [], debug: { type: 'exception', message: errorMessage } };
  }
}

/**
 * GET action=details&id=X — lazy/secondary call, not bundled into
 * list/spin (SPEC.md). `idParam` arrives as a raw query-string value
 * (always a string on GET); anything that doesn't resolve to a real row
 * id is `not_found`, same error SPEC.md specifies for an `id` mismatch.
 */
function detailsAction_(sheet, idParam, props) {
  var id = Number(idParam);
  if (idParam === undefined || idParam === '' || isNaN(id)) return { error: 'not_found' };

  var movies = readMovies_(sheet);
  var movie = findMovieById(movies, id);
  if (!movie) return { error: 'not_found' };

  var quotesResult = resolveQuotes_(props, movie);
  var result = {
    streamingPlatforms: resolveStreamingPlatforms_(props, movie),
    quotes: quotesResult.quotes
  };

  // Debugging aid -- uncomment to surface why quotes came back empty.
  // if (quotesResult.quotes.length === 0 && quotesResult.debug) {
  //   result._quotesDebug = quotesResult.debug;
  // }

  return result;
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var props = getScriptProperties_();

    if (!isTokenValid(params.token, props.sharedToken)) {
      return jsonResponse_({ error: 'unauthorized' });
    }

    var sheet = getSheet_(props);
    var absentNames = parseAbsentParam(params.absent);

    if (params.action === 'list') {
      return jsonResponse_(listMovies_(sheet, props, absentNames));
    }
    if (params.action === 'spin') {
      return jsonResponse_(spinMovie_(sheet, props, absentNames));
    }
    if (params.action === 'details') {
      return jsonResponse_(detailsAction_(sheet, params.id, props));
    }
    return jsonResponse_({ error: 'bad_request' });
  } catch (err) {
    return jsonResponse_({ error: 'sheet_error' });
  }
}

function doPost(e) {
  // CORS gotcha (see SPEC.md): the frontend deliberately sends this request
  // with no Content-Type header so the browser treats it as a "simple
  // request" and skips preflight. That means it arrives as text/plain no
  // matter what — always parse e.postData.contents as JSON directly, never
  // branch on e.postData.type.
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: 'bad_request' });
  }

  try {
    var props = getScriptProperties_();

    if (!isTokenValid(body.token, props.sharedToken)) {
      return jsonResponse_({ error: 'unauthorized' });
    }

    var sheet = getSheet_(props);

    if (body.action === 'setWatched') {
      if (typeof body.id !== 'number' || typeof body.watched !== 'boolean') {
        return jsonResponse_({ error: 'bad_request' });
      }
      return jsonResponse_(setWatchedAction_(sheet, props, body.id, body.watched));
    }

    if (body.action === 'setRating') {
      if (typeof body.id !== 'number') {
        return jsonResponse_({ error: 'bad_request' });
      }
      // isValidRating rejects anything that isn't null or a valid
      // half-step number in [0.5, 5] -- including a missing/undefined
      // `rating` field, since a write must say explicitly what it wants.
      if (!isValidRating(body.rating)) {
        return jsonResponse_({ error: 'bad_request' });
      }
      return jsonResponse_(setRatingAction_(sheet, props, body.id, body.rating));
    }

    return jsonResponse_({ error: 'bad_request' });
  } catch (err) {
    return jsonResponse_({ error: 'sheet_error' });
  }
}
