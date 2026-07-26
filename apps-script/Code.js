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

// ---------------------------------------------------------------------------
// Config / sheet access
// ---------------------------------------------------------------------------

function getScriptProperties_() {
  var props = PropertiesService.getScriptProperties();
  return {
    spreadsheetId: props.getProperty('SPREADSHEET_ID'),
    sharedToken: props.getProperty('SHARED_TOKEN'),
    tmdbApiKey: props.getProperty('TMDB_API_KEY')
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
    result = parseTmdbSearchResponse(json);
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

function listMovies_(sheet, props) {
  var movies = readMovies_(sheet);
  return movies.map(function (m) {
    var posterUrl = resolvePosterForMovie_(sheet, props, m);
    return toPublicMovie(m, posterUrl);
  });
}

function spinMovie_(sheet, props) {
  var movies = readMovies_(sheet);
  var picked = pickRandomEligible(movies);
  if (!picked) return null;
  var posterUrl = resolvePosterForMovie_(sheet, props, picked);
  return toPublicMovie(picked, posterUrl);
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

    if (params.action === 'list') {
      return jsonResponse_({ movies: listMovies_(sheet, props) });
    }
    if (params.action === 'spin') {
      return jsonResponse_({ movie: spinMovie_(sheet, props) });
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

    if (body.action !== 'setWatched') {
      return jsonResponse_({ error: 'bad_request' });
    }
    if (typeof body.id !== 'number' || typeof body.watched !== 'boolean') {
      return jsonResponse_({ error: 'bad_request' });
    }

    var sheet = getSheet_(props);
    var result = setWatchedAction_(sheet, props, body.id, body.watched);
    return jsonResponse_(result);
  } catch (err) {
    return jsonResponse_({ error: 'sheet_error' });
  }
}
