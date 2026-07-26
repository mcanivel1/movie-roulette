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

// ---------------------------------------------------------------------------
// Header / row parsing
// ---------------------------------------------------------------------------

/**
 * Resolve the column index of each known header, case-insensitively and
 * independent of column order. Unknown/extra columns are ignored. Returns
 * -1 for any header that isn't present.
 */
function resolveHeaderIndexes(headerRow) {
  var indexes = { movie: -1, year: -1, prequel: -1, watched: -1, posterUrl: -1 };
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
      default:
        break; // extra/unknown column, ignored
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

  return {
    id: rowNumber,
    title: title,
    year: extractYear(yearRaw),
    prequel: prequel,
    watched: parseWatched(watchedRaw),
    posterUrlCell: posterUrlCell
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
 * Parse a TMDB /search/movie JSON response into a poster resolution result.
 * `cacheValue` is what should be written back into the sheet's Poster URL
 * cell: either the resolved URL, or the `none` sentinel when there's no
 * match (so future requests skip re-searching).
 */
function parseTmdbSearchResponse(tmdbJson) {
  if (!tmdbJson || !Array.isArray(tmdbJson.results) || tmdbJson.results.length === 0) {
    return { posterUrl: null, cacheValue: POSTER_NONE_SENTINEL };
  }
  var top = tmdbJson.results[0];
  var posterUrl = buildTmdbImageUrl(top && top.poster_path);
  if (!posterUrl) {
    return { posterUrl: null, cacheValue: POSTER_NONE_SENTINEL };
  }
  return { posterUrl: posterUrl, cacheValue: posterUrl };
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/** Shape an internal movie record + resolved posterUrl into the public API Movie object. */
function toPublicMovie(movie, posterUrl) {
  return {
    id: movie.id,
    title: movie.title,
    year: movie.year,
    prequel: movie.prequel ? movie.prequel : null,
    watched: movie.watched,
    eligible: movie.eligible,
    waitingOn: movie.waitingOn,
    posterUrl: (posterUrl === undefined ? null : posterUrl)
  };
}
