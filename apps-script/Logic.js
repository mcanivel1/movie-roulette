/**
 * Logic.js — pure, Apps-Script-free business logic for Movie Roulette.
 *
 * IMPORTANT: this file must never reference SpreadsheetApp, UrlFetchApp,
 * PropertiesService, ContentService, or any other Apps Script global. Every
 * function here takes plain data in and returns plain data out so it can be
 * unit tested with plain Node (see apps-script/test/).
 *
 * Apps Script's V8 runtime shares one global scope across all .js files in
 * the project — there is no import/export here on purpose. Every top-level
 * declaration below becomes a global available to Code.js at runtime (and,
 * for tests, becomes a property on the vm context this file is executed in).
 */

var POSTER_NONE_SENTINEL = 'none';

// Fixed 8-person group roster (SPEC.md "Attendance"). Column headers, the
// `absent` param, and the `seenBy` response map all key off these exact
// names -- matching is case-insensitive/trimmed at every boundary that reads
// user/sheet input, but the canonical casing below is what's ever emitted.
var ROSTER = ['Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'];

// ---------------------------------------------------------------------------
// Header / row parsing
// ---------------------------------------------------------------------------

/**
 * Resolve the column index of each known header, case-insensitively and
 * independent of column order. Unknown/extra columns are ignored. Returns
 * -1 for any header that isn't present. `members` maps each roster name to
 * its column index (also -1 if absent).
 */
function resolveHeaderIndexes(headerRow) {
  var indexes = { movie: -1, year: -1, prequel: -1, watched: -1, posterUrl: -1, rating: -1, members: {} };
  ROSTER.forEach(function (name) {
    indexes.members[name] = -1;
  });
  if (!headerRow) return indexes;
  for (var i = 0; i < headerRow.length; i++) {
    var raw = headerRow[i];
    var key = (raw === null || raw === undefined) ? '' : String(raw).trim().toLowerCase();
    switch (key) {
      case 'movie':
        indexes.movie = i;
        break;
      case 'year':
        indexes.year = i;
        break;
      case 'prequel':
        indexes.prequel = i;
        break;
      case 'watched':
        indexes.watched = i;
        break;
      case 'poster url':
        indexes.posterUrl = i;
        break;
      case 'rating':
      case 'ratings':
        // Accept both spellings -- a real deployment used the plural
        // "Ratings" header, which a singular-only match silently dropped
        // (indexes.rating stayed -1, so every read/write against it failed
        // closed with no visible error). See SPEC.md's Sheet-shape table.
        indexes.rating = i;
        break;
      default:
        // Not one of the fixed single-purpose headers -- check whether it's
        // one of the 8 per-member attendance columns before giving up on it.
        var matchedMember = ROSTER.filter(function (name) {
          return name.toLowerCase() === key;
        })[0];
        if (matchedMember) indexes.members[matchedMember] = i;
        break; // otherwise: extra/unknown column, ignored
    }
  }
  return indexes;
}

/** Normalize a title for case-insensitive/trimmed matching. */
function normalizeTitle(title) {
  return (title === null || title === undefined) ? '' : String(title).trim().toLowerCase();
}

/**
 * Duck-typed Date check (Object.prototype.toString tag) rather than
 * `instanceof Date`. Sheet values only ever come from one JS realm in real
 * Apps Script, so `instanceof` would be fine there too — but this is a more
 * robust check in general and, notably, is what lets unit tests construct
 * Date fixtures without caring which realm's Date constructor built them.
 */
function isDateValue_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

/** Year column may hold an integer, a numeric string, or a Date. */
function extractYear(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (isDateValue_(rawValue)) return rawValue.getFullYear();
  if (typeof rawValue === 'number') return Math.trunc(rawValue);
  if (typeof rawValue === 'string') {
    var trimmed = rawValue.trim();
    if (trimmed === '') return null;
    var asNum = Number(trimmed);
    if (!isNaN(asNum)) return Math.trunc(asNum);
    var parsedDate = new Date(trimmed);
    if (!isNaN(parsedDate.getTime())) return parsedDate.getFullYear();
    return null;
  }
  return null;
}

/** Watched column may be a real boolean or a truthy string variant Sheets can store. */
function parseWatched(rawValue) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (typeof rawValue === 'number') return rawValue !== 0;
  if (typeof rawValue === 'string') {
    var normalized = rawValue.trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === '1';
  }
  return false;
}

/**
 * Rating column holds a plain number (0.5-5 in half-steps) or is blank.
 * Unlike Watched/attendance columns this isn't a truthy/falsy read -- an
 * unparseable or out-of-range value just reads back as null (the same as
 * blank) rather than being coerced or rejected here; validation of a
 * *write* is a separate concern, see isValidRating below.
 */
function extractRatingCell(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') return rawValue;
  if (typeof rawValue === 'string') {
    var trimmed = rawValue.trim();
    if (trimmed === '') return null;
    var asNum = Number(trimmed);
    if (!isNaN(asNum)) return asNum;
  }
  return null;
}

/**
 * Build the `seenBy` map for one row: one truthy/falsy entry per roster
 * member, using the same truthy-string parsing rules as Watched (per
 * SPEC.md's Attendance section). A member whose column is missing from the
 * sheet entirely reads as false (hasn't seen it), matching Watched's
 * missing-column default.
 */
function buildSeenByFromRow(rowValues, headerIndexes) {
  var seenBy = {};
  ROSTER.forEach(function (name) {
    var idx = headerIndexes.members[name];
    var raw = idx >= 0 ? rowValues[idx] : false;
    seenBy[name] = parseWatched(raw);
  });
  return seenBy;
}

/**
 * Build one internal movie record from a single sheet data row.
 * rowNumber is the row's absolute, 1-indexed position in the sheet
 * (including the header row) — this becomes the movie's stable `id`.
 */
function buildMovieFromRow(rowValues, headerIndexes, rowNumber) {
  var titleRaw = headerIndexes.movie >= 0 ? rowValues[headerIndexes.movie] : '';
  var title = (titleRaw === null || titleRaw === undefined) ? '' : String(titleRaw).trim();

  var yearRaw = headerIndexes.year >= 0 ? rowValues[headerIndexes.year] : null;

  var prequelRaw = headerIndexes.prequel >= 0 ? rowValues[headerIndexes.prequel] : '';
  var prequel = (prequelRaw === null || prequelRaw === undefined) ? '' : String(prequelRaw).trim();

  var watchedRaw = headerIndexes.watched >= 0 ? rowValues[headerIndexes.watched] : false;

  var posterUrlCellRaw = headerIndexes.posterUrl >= 0 ? rowValues[headerIndexes.posterUrl] : '';
  var posterUrlCell = (posterUrlCellRaw === null || posterUrlCellRaw === undefined) ? '' : String(posterUrlCellRaw).trim();

  var ratingRaw = headerIndexes.rating >= 0 ? rowValues[headerIndexes.rating] : null;

  return {
    id: rowNumber,
    title: title,
    year: extractYear(yearRaw),
    prequel: prequel,
    watched: parseWatched(watchedRaw),
    posterUrlCell: posterUrlCell,
    rating: extractRatingCell(ratingRaw),
    seenBy: buildSeenByFromRow(rowValues, headerIndexes)
  };
}

/**
 * Convert a full 2D sheet values array (header row + data rows, as returned
 * by Range#getValues) into internal movie records. Rows with a blank title
 * are skipped.
 */
function buildMoviesFromSheetValues(sheetValues) {
  if (!sheetValues || sheetValues.length === 0) return [];
  var headerIndexes = resolveHeaderIndexes(sheetValues[0]);
  var movies = [];
  for (var r = 1; r < sheetValues.length; r++) {
    var rowNumber = r + 1; // absolute 1-indexed row, including header
    var movie = buildMovieFromRow(sheetValues[r], headerIndexes, rowNumber);
    if (movie.title === '') continue;
    movies.push(movie);
  }
  return movies;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * eligible(movie, allMovies) =
 *      movie.watched === false
 *   && (movie.prequel is empty
 *       OR the movie whose title matches movie.prequel has watched === true)
 *
 * A prequel reference that doesn't match any row's title fails closed
 * (not eligible), and waitingOn surfaces the raw referenced text either way.
 *
 * Returns a new array of movies (does not mutate input) with `eligible`
 * and `waitingOn` added.
 */
function computeEligibility(movies) {
  var byTitle = {};
  movies.forEach(function (m) {
    byTitle[normalizeTitle(m.title)] = m;
  });

  return movies.map(function (m) {
    var eligible = false;
    var waitingOn = null;

    if (m.watched === true) {
      eligible = false;
      waitingOn = null;
    } else if (!m.prequel) {
      eligible = true;
      waitingOn = null;
    } else {
      var prequelMovie = byTitle[normalizeTitle(m.prequel)];
      if (!prequelMovie) {
        // dangling reference — fail closed
        eligible = false;
        waitingOn = m.prequel;
      } else if (prequelMovie.watched === true) {
        eligible = true;
        waitingOn = null;
      } else {
        eligible = false;
        waitingOn = m.prequel;
      }
    }

    var out = {};
    for (var k in m) {
      if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
    }
    out.eligible = eligible;
    out.waitingOn = waitingOn;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

/**
 * Validate a setRating write: null (clears the rating) or a number in
 * [0.5, 5] on an exact half-step. Anything else (wrong type, NaN,
 * out-of-range, or off-grid like 3.3) is invalid.
 */
function isValidRating(rating) {
  if (rating === null) return true;
  if (typeof rating !== 'number' || isNaN(rating)) return false;
  if (rating < 0.5 || rating > 5) return false;
  var doubled = rating * 2;
  return Math.abs(doubled - Math.round(doubled)) < 1e-9;
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/**
 * Parse the `absent` query param (comma-separated member names) into a
 * de-duplicated array of canonical roster names. Matching is
 * case-insensitive/trimmed; any entry that doesn't match a roster member
 * (typo, unknown name, stray comma) is silently dropped rather than
 * erroring -- a request with an unrecognized name behaves the same as one
 * that simply didn't name that person as absent.
 */
function parseAbsentParam(raw) {
  if (raw === null || raw === undefined) return [];
  var result = [];
  String(raw).split(',').forEach(function (part) {
    var trimmed = part.trim();
    if (trimmed === '') return;
    var matched = ROSTER.filter(function (name) {
      return name.toLowerCase() === trimmed.toLowerCase();
    })[0];
    if (matched && result.indexOf(matched) === -1) result.push(matched);
  });
  return result;
}

/**
 * Recompute eligibility factoring in who's absent tonight, per SPEC.md's
 * Attendance rule: a movie that's otherwise eligible is filtered out only
 * if some absent member hasn't personally seen it (their `seenBy` entry is
 * falsy). Presence never adds eligibility -- only absence can remove it.
 *
 * `waitingOn` is deliberately left untouched here: it only ever reflects
 * prequel-gating (see computeEligibility above). A movie knocked out by
 * attendance still reports whatever waitingOn the prequel computation gave
 * it (usually null) -- the frontend already has `seenBy` plus its own
 * absent-member selection to explain an attendance-caused block, so
 * overloading waitingOn for that too would be redundant and ambiguous
 * about which reason actually applies.
 *
 * Fallback (SPEC.md): if the attendance filter would leave the eligible
 * pool empty, drop the attendance criterion entirely for this request --
 * every movie's eligibility reverts to the plain (pre-attendance) value,
 * and `attendanceApplied` is false so the caller knows the criterion didn't
 * actually apply. Assumes `absentNames` is already non-empty; callers
 * should only invoke this when the request actually named someone absent.
 *
 * Returns { movies, attendanceApplied } — a new movies array (does not
 * mutate input).
 */
function computeAttendanceEligibility(movies, absentNames) {
  var baseEligible = movies.filter(function (m) { return m.eligible === true; });
  var attendanceEligible = baseEligible.filter(function (m) {
    return absentNames.every(function (name) {
      return m.seenBy && m.seenBy[name] === true;
    });
  });

  var applied = attendanceEligible.length > 0;

  if (!applied) {
    // Fallback: pool would be empty under the filter -- ignore attendance,
    // movies keep their plain eligibility unchanged.
    return { movies: movies.slice(), attendanceApplied: false };
  }

  var stillEligibleIds = {};
  attendanceEligible.forEach(function (m) {
    stillEligibleIds[m.id] = true;
  });

  var adjusted = movies.map(function (m) {
    var out = {};
    for (var k in m) {
      if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
    }
    out.eligible = m.eligible === true && stillEligibleIds[m.id] === true;
    return out;
  });

  return { movies: adjusted, attendanceApplied: true };
}

// ---------------------------------------------------------------------------
// Selection / lookup
// ---------------------------------------------------------------------------

/**
 * Uniform-random pick among movies with eligible === true. Returns null if
 * none are eligible. `rng` defaults to Math.random but can be injected for
 * deterministic tests.
 */
function pickRandomEligible(movies, rng) {
  var randomFn = rng || Math.random;
  var eligibleMovies = movies.filter(function (m) { return m.eligible === true; });
  if (eligibleMovies.length === 0) return null;
  var idx = Math.floor(randomFn() * eligibleMovies.length);
  if (idx < 0) idx = 0;
  if (idx >= eligibleMovies.length) idx = eligibleMovies.length - 1;
  return eligibleMovies[idx];
}

/** Find a movie by its stable row-number id. Returns null if not found. */
function findMovieById(movies, id) {
  for (var i = 0; i < movies.length; i++) {
    if (movies[i].id === id) return movies[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Constant-shape token check; both values must be non-empty strings that match. */
function isTokenValid(provided, expected) {
  return typeof provided === 'string' &&
    typeof expected === 'string' &&
    expected.length > 0 &&
    provided === expected;
}

// ---------------------------------------------------------------------------
// Posters (TMDB)
// ---------------------------------------------------------------------------

/**
 * Decide what to do with a row's current Poster URL cell:
 *  - 'cached': cell already holds a usable URL, use it as-is, no fetch.
 *  - 'none':   cell holds the sentinel — TMDB was already checked and had no
 *              match, skip re-fetching, posterUrl stays null.
 *  - 'missing': cell is blank — a TMDB fetch is needed.
 */
function getPosterCacheStatus(cellValue) {
  var trimmed = (cellValue === null || cellValue === undefined) ? '' : String(cellValue).trim();
  if (trimmed === '') return { status: 'missing', posterUrl: null };
  if (trimmed.toLowerCase() === POSTER_NONE_SENTINEL) return { status: 'none', posterUrl: null };
  return { status: 'cached', posterUrl: trimmed };
}

/** Build a full TMDB poster image URL from a poster_path, or null if absent. */
function buildTmdbImageUrl(posterPath) {
  if (!posterPath) return null;
  return 'https://image.tmdb.org/t/p/w500' + posterPath;
}

/** Build the TMDB search-by-title(+year) request URL. */
function buildTmdbSearchUrl(apiKey, title, year) {
  var url = 'https://api.themoviedb.org/3/search/movie?api_key=' + encodeURIComponent(apiKey || '') +
    '&query=' + encodeURIComponent(title || '');
  if (year) url += '&year=' + encodeURIComponent(year);
  return url;
}

/**
 * Pick the right entry out of a TMDB /search/movie `results` array. TMDB's
 * `year` query param (see buildTmdbSearchUrl) is only a hint, not a strict
 * filter -- titles with many entries across decades (remakes, animated vs.
 * live-action versions, re-releases -- "Cinderella" has a 1950 animated
 * version, a 1997 TV movie, a 2015 live-action version, a 2021 musical,
 * plus foreign versions) can still return a same-named result from the
 * wrong year as `results[0]`. This is shared by both posters
 * (parseTmdbSearchResponse) and the streaming-platforms TMDB-id lookup
 * (extractTmdbMovieId) -- they're the same underlying search, so a
 * wrong-year poster match and a wrong-year streaming-platforms match are
 * the same bug (SPEC.md's "Posters" section).
 *
 * `targetYear` null/undefined (row has no parseable year) -> today's
 * existing behavior, `results[0]`. Otherwise scan for a `release_date`
 * (format "YYYY-MM-DD", sometimes blank) whose year matches exactly, and
 * use the first such match. No result matches the target year -> fall back
 * to `results[0]` rather than reporting "no match" -- a wrong-year guess is
 * still more useful than an honest-empty-state poster for what's plainly a
 * real, found movie; only a completely empty `results` array means "no
 * match" (see parseTmdbSearchResponse/extractTmdbMovieId below).
 */
function selectTmdbResultByYear(results, targetYear) {
  if (!Array.isArray(results) || results.length === 0) return null;
  if (targetYear === null || targetYear === undefined) return results[0];

  var targetYearStr = String(targetYear);
  for (var i = 0; i < results.length; i++) {
    var releaseDate = results[i] && results[i].release_date;
    if (typeof releaseDate === 'string' && releaseDate.indexOf(targetYearStr) === 0) {
      return results[i];
    }
  }
  return results[0];
}

/**
 * Parse a TMDB /search/movie JSON response into a poster resolution result.
 * `cacheValue` is what should be written back into the sheet's Poster URL
 * cell: either the resolved URL, or the `none` sentinel when there's no
 * match (so future requests skip re-searching). `targetYear` is the sheet
 * row's Year cell, used to disambiguate among multiple TMDB hits -- see
 * selectTmdbResultByYear above.
 */
function parseTmdbSearchResponse(tmdbJson, targetYear) {
  if (!tmdbJson || !Array.isArray(tmdbJson.results) || tmdbJson.results.length === 0) {
    return { posterUrl: null, cacheValue: POSTER_NONE_SENTINEL };
  }
  var chosen = selectTmdbResultByYear(tmdbJson.results, targetYear);
  var posterUrl = buildTmdbImageUrl(chosen && chosen.poster_path);
  if (!posterUrl) {
    return { posterUrl: null, cacheValue: POSTER_NONE_SENTINEL };
  }
  return { posterUrl: posterUrl, cacheValue: posterUrl };
}

/**
 * Pull the year-matched TMDB search result's movie id out of a
 * /search/movie response, or null. `targetYear` is the sheet row's Year
 * cell -- see selectTmdbResultByYear above for the disambiguation rule.
 */
function extractTmdbMovieId(tmdbJson, targetYear) {
  if (!tmdbJson || !Array.isArray(tmdbJson.results) || tmdbJson.results.length === 0) return null;
  var chosen = selectTmdbResultByYear(tmdbJson.results, targetYear);
  return (chosen && typeof chosen.id === 'number') ? chosen.id : null;
}

// ---------------------------------------------------------------------------
// Streaming platforms (TMDB watch/providers)
// ---------------------------------------------------------------------------

/** Build the TMDB `watch/providers` request URL for an already-resolved TMDB movie id. */
function buildTmdbProvidersUrl(apiKey, tmdbMovieId) {
  return 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdbMovieId) +
    '/watch/providers?api_key=' + encodeURIComponent(apiKey || '');
}

// Tier/qualifier words TMDB appends to a provider's plain brand name to list
// an ad-supported (or other tier) variant as its own separate provider
// entry -- e.g. "Netflix" and "Netflix Standard with Ads" are the same
// underlying service. Order matters: multi-word phrases must be stripped
// before the single words they contain ("with ads" before "ads"), or
// stripping "ads" first leaves a dangling "with" that "with ads" can no
// longer match. Not Netflix-specific -- TMDB applies the same pattern to
// Hulu, Peacock, and others, so this generalizes to any service name.
var PROVIDER_TIER_QUALIFIERS = ['with ads', 'ads', 'standard', 'basic', 'premium'];

/** Escape RegExp-special characters so a plain word/phrase can be embedded in a pattern literally. */
function escapeRegExpChars_(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a TMDB provider name to a brand key for dedup purposes (see
 * PROVIDER_TIER_QUALIFIERS above). Lowercases, strips known tier/qualifier
 * words wherever they appear *as whole words* (`\b`-bounded -- "ads" must
 * not match inside an unrelated word like a hypothetical "Radsson+"; a
 * plain substring split/join would wrongly mangle that), and collapses the
 * resulting whitespace -- both "Netflix" and "Netflix Standard with Ads"
 * normalize to "netflix".
 */
function normalizeProviderBrandKey(name) {
  var key = name.toLowerCase();
  PROVIDER_TIER_QUALIFIERS.forEach(function (qualifier) {
    var pattern = new RegExp('\\b' + escapeRegExpChars_(qualifier) + '\\b', 'g');
    key = key.replace(pattern, ' ');
  });
  return key.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a TMDB `watch/providers` response into a plain list of provider
 * names for the fixed `US` region (per SPEC.md -- there's no per-user
 * locale to key off of). Only the `flatrate` (subscription-included)
 * offering counts as "currently carries the movie" -- rent/buy listings
 * aren't included since those aren't a platform "carrying" it the way a
 * subscription service is. Missing region/data (or a malformed response)
 * yields an empty list, never an error -- an empty result is a valid,
 * expected state per SPEC.md.
 *
 * Dedupes by normalized brand (see normalizeProviderBrandKey), not raw
 * exact string, so an ad-tier variant doesn't show up as a redundant
 * second pill alongside the plain service name. When multiple raw names
 * collapse to the same brand, the plain (unqualified) name wins the
 * display slot if one exists among the duplicates -- it's the more
 * recognizable name for the UI; if every variant for a brand has a
 * qualifier (no plain version present at all), the first one encountered
 * is kept as-is rather than inventing a cleaned-up display name. Distinct
 * services never merge -- this only collapses genuine tier variants of the
 * *same* brand key.
 */
function parseTmdbProvidersResponse(tmdbJson) {
  if (!tmdbJson || !tmdbJson.results || !tmdbJson.results.US) return [];
  var us = tmdbJson.results.US;
  var flatrate = Array.isArray(us.flatrate) ? us.flatrate : [];

  var byBrand = {}; // brandKey -> { displayName, isPlain }
  var brandOrder = [];

  flatrate.forEach(function (entry) {
    var rawName = entry && entry.provider_name;
    if (typeof rawName !== 'string' || rawName.trim() === '') return;
    var trimmedName = rawName.trim();
    var brandKey = normalizeProviderBrandKey(trimmedName);
    if (brandKey === '') return; // stripped down to nothing brand-like -- skip

    var isPlain = brandKey === trimmedName.toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(byBrand, brandKey)) {
      byBrand[brandKey] = { displayName: trimmedName, isPlain: isPlain };
      brandOrder.push(brandKey);
    } else if (isPlain && !byBrand[brandKey].isPlain) {
      // A plain name for this brand showed up after a qualified one --
      // upgrade the display name, first plain name wins from here on.
      byBrand[brandKey].displayName = trimmedName;
      byBrand[brandKey].isPlain = true;
    }
  });

  return brandOrder.map(function (brandKey) {
    return byBrand[brandKey].displayName;
  });
}

// ---------------------------------------------------------------------------
// Memorable quotes (Google Gemini API)
// ---------------------------------------------------------------------------

/**
 * Build the Gemini `generateContent` request body for generating 2-4 short,
 * character-attributed movie quotes. Uses `responseSchema` (structured
 * output) so the response is guaranteed-parseable JSON -- a plain array of
 * quote strings -- rather than free text we'd have to regex out of a
 * paragraph. Chosen over the Anthropic API specifically so this app can run
 * on Gemini's free tier (SPEC.md) -- no billing account required.
 */
function buildGeminiQuotesPayload(title, year) {
  var titleWithYear = year ? (title + ' (' + year + ')') : title;
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'List 2-4 short, memorable quotes from the movie "' + titleWithYear + '". ' +
              'Attribute each quote to the speaking character where natural, appended as ' +
              '" — Character Name". If you are not confident about real quotes from this specific ' +
              'movie, return an empty array rather than inventing one.'
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: { type: 'STRING' }
      }
    }
  };
}

/**
 * True when a Gemini `generateContent` response indicates the request
 * produced no usable candidate -- no `candidates` array at all, or the top
 * candidate's `finishReason` is present and isn't `"STOP"` (e.g.
 * `"SAFETY"`). Distinguishing this from "the model legitimately generated
 * an empty array" matters for caching (see resolveQuotes_ in Code.js): a
 * block should never be cached per SPEC.md -- always retry next time --
 * while a genuine empty result from a successful generation is a real
 * answer and gets cached like any other.
 */
function isGeminiBlocked(geminiJson) {
  if (!geminiJson || !Array.isArray(geminiJson.candidates) || geminiJson.candidates.length === 0) return true;
  var candidate = geminiJson.candidates[0];
  return !!(candidate.finishReason && candidate.finishReason !== 'STOP');
}

/**
 * Parse a Gemini `generateContent` response into a plain quotes array.
 * Fails closed to an empty array on anything unexpected -- a block (see
 * isGeminiBlocked above), missing/malformed content, or JSON that doesn't
 * parse -- an empty array is itself a valid response per SPEC.md, so
 * there's no separate error path here; a bad LLM response degrades exactly
 * like "no quotes found" rather than surfacing as an API error.
 *
 * Because the request set `responseMimeType: "application/json"`, the
 * generated text at `candidates[0].content.parts[0].text` is itself a JSON
 * *string* we still have to JSON.parse() -- Gemini doesn't hand back
 * already-parsed JSON in a separate field.
 */
function parseGeminiQuotesResponse(geminiJson) {
  try {
    if (isGeminiBlocked(geminiJson)) return [];
    var content = geminiJson.candidates[0].content;
    if (!content || !Array.isArray(content.parts) || content.parts.length === 0) return [];
    var text = content.parts[0].text;
    if (typeof text !== 'string') return [];
    var parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    var quotes = parsed.filter(function (q) { return typeof q === 'string' && q.trim() !== ''; });
    return quotes.slice(0, 4);
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/** Build the public `seenBy` map: one boolean per roster member, in fixed roster order. */
function buildPublicSeenBy(internalSeenBy) {
  var out = {};
  ROSTER.forEach(function (name) {
    out[name] = !!(internalSeenBy && internalSeenBy[name] === true);
  });
  return out;
}

/**
 * Shape an internal movie record + resolved posterUrl into the public API
 * Movie object. `options.includeSeenBy` adds the `seenBy` map -- only the
 * `list` response includes it (see SPEC.md's Attendance section); `spin`
 * and the setWatched/setRating responses omit it.
 */
function toPublicMovie(movie, posterUrl, options) {
  var opts = options || {};
  var out = {
    id: movie.id,
    title: movie.title,
    year: movie.year,
    prequel: movie.prequel ? movie.prequel : null,
    watched: movie.watched,
    rating: (movie.rating === null || movie.rating === undefined) ? null : movie.rating,
    eligible: movie.eligible,
    waitingOn: movie.waitingOn,
    posterUrl: (posterUrl === undefined ? null : posterUrl)
  };
  if (opts.includeSeenBy) {
    out.seenBy = buildPublicSeenBy(movie.seenBy);
  }
  return out;
}
