'use strict';

const test = require('node:test');
// Deliberately the non-strict assert module here, not 'node:assert/strict'.
// Logic.js is executed inside a vm sandbox (a separate JS realm), so plain
// object literals it returns have a different Object.prototype identity
// than object literals in this file. assert.deepStrictEqual treats that as
// a mismatch ("not reference-equal") even when every property matches;
// plain assert.deepEqual compares structurally without that realm check.
const assert = require('node:assert');
const { loadGasContext } = require('./helpers');

// Logic.js has zero Apps Script dependencies, so it loads with no mocks.
const ctx = loadGasContext(['Logic.js']);

// ---------------------------------------------------------------------------
// Header resolution
// ---------------------------------------------------------------------------

test('resolveHeaderIndexes: resolves shuffled columns with extra columns present', () => {
  const header = ['Extra', 'Watched', 'Prequel', 'Movie', 'Notes', 'Year'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.movie, 3);
  assert.equal(idx.watched, 1);
  assert.equal(idx.prequel, 2);
  assert.equal(idx.year, 5);
  assert.equal(idx.posterUrl, -1); // not present
});

test('resolveHeaderIndexes: case-insensitive and trims whitespace, including Poster URL', () => {
  const header = [' movie ', 'YEAR', 'PreQuel', 'watched', 'Poster URL'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.deepEqual(idx, {
    movie: 0, year: 1, prequel: 2, watched: 3, posterUrl: 4, rating: -1,
    members: { Austin: -1, Eugie: -1, Josh: -1, Jouissance: -1, Lynda: -1, Marvin: -1, Mel: -1, Michelle: -1 }
  });
});

test('resolveHeaderIndexes: missing headers resolve to -1, unrecognized columns ignored', () => {
  const idx = ctx.resolveHeaderIndexes(['Foo', 'Bar']);
  assert.deepEqual(idx, {
    movie: -1, year: -1, prequel: -1, watched: -1, posterUrl: -1, rating: -1,
    members: { Austin: -1, Eugie: -1, Josh: -1, Jouissance: -1, Lynda: -1, Marvin: -1, Mel: -1, Michelle: -1 }
  });
});

test('resolveHeaderIndexes: resolves Rating and all 8 member columns, case-insensitive/trimmed', () => {
  const header = ['Movie', ' rating ', 'AUSTIN', 'Eugie', 'josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.rating, 1);
  assert.deepEqual(idx.members, { Austin: 2, Eugie: 3, Josh: 4, Jouissance: 5, Lynda: 6, Marvin: 7, Mel: 8, Michelle: 9 });
});

test('resolveHeaderIndexes: also accepts the plural "Ratings" header (real deployment used this spelling)', () => {
  const header = ['Movie', 'Ratings'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.rating, 1);
});

test('resolveHeaderIndexes: "Ratings" is case-insensitive/trimmed same as every other header', () => {
  const header = ['Movie', ' RATINGS '];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.rating, 1);
});

test('resolveHeaderIndexes: singular "Rating" still resolves unchanged (widening, not a breaking rename)', () => {
  const header = ['Movie', 'Rating'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.rating, 1);
});

// ---------------------------------------------------------------------------
// Row parsing end-to-end
// ---------------------------------------------------------------------------

test('buildMoviesFromSheetValues: shuffled headers, extra columns, blank title rows skipped', () => {
  const values = [
    ['Notes', 'Watched', 'Movie', 'Prequel', 'Year'],
    ['n/a', false, 'Part I', '', 2018],
    ['n/a', true, '', '', 2010], // blank title -> skipped
    ['n/a', true, 'Prelude', '', 2010]
  ];
  const movies = ctx.buildMoviesFromSheetValues(values);
  assert.equal(movies.length, 2);
  assert.equal(movies[0].id, 2); // absolute row number, header counted
  assert.equal(movies[0].title, 'Part I');
  assert.equal(movies[0].year, 2018);
  assert.equal(movies[1].id, 4);
  assert.equal(movies[1].title, 'Prelude');
});

test('buildMoviesFromSheetValues: reads Rating and per-member attendance columns end to end', () => {
  const values = [
    ['Movie', 'Watched', 'Rating', 'Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'],
    ['Part I', true, 4.5, true, false, 'Yes', 'No', 1, 0, 'TRUE', 'FALSE']
  ];
  const movies = ctx.buildMoviesFromSheetValues(values);
  assert.equal(movies[0].rating, 4.5);
  assert.deepEqual(movies[0].seenBy, {
    Austin: true, Eugie: false, Josh: true, Jouissance: false,
    Lynda: true, Marvin: false, Mel: true, Michelle: false
  });
});

test('buildMoviesFromSheetValues: missing Rating/member columns default to null rating and all-false seenBy', () => {
  const values = [
    ['Movie', 'Watched'],
    ['Part I', false]
  ];
  const movies = ctx.buildMoviesFromSheetValues(values);
  assert.equal(movies[0].rating, null);
  assert.deepEqual(movies[0].seenBy, {
    Austin: false, Eugie: false, Josh: false, Jouissance: false,
    Lynda: false, Marvin: false, Mel: false, Michelle: false
  });
});

test('extractYear: handles Date objects, numeric strings, and plain numbers', () => {
  assert.equal(ctx.extractYear(new Date(2021, 5, 1)), 2021);
  assert.equal(ctx.extractYear('2019'), 2019);
  assert.equal(ctx.extractYear(2005), 2005);
  assert.equal(ctx.extractYear(''), null);
  assert.equal(ctx.extractYear(null), null);
});

test('parseWatched: handles booleans and Sheets-style truthy strings', () => {
  assert.equal(ctx.parseWatched(true), true);
  assert.equal(ctx.parseWatched(false), false);
  assert.equal(ctx.parseWatched('TRUE'), true);
  assert.equal(ctx.parseWatched('false'), false);
  assert.equal(ctx.parseWatched(''), false);
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('eligibility: no prequel, unwatched -> eligible', () => {
  const movies = [{ id: 2, title: 'Solo Film', prequel: '', watched: false }];
  const [result] = ctx.computeEligibility(movies);
  assert.equal(result.eligible, true);
  assert.equal(result.waitingOn, null);
});

test('eligibility: already watched -> never eligible regardless of prequel', () => {
  const movies = [{ id: 2, title: 'Solo Film', prequel: '', watched: true }];
  const [result] = ctx.computeEligibility(movies);
  assert.equal(result.eligible, false);
  assert.equal(result.waitingOn, null);
});

test('eligibility: prequel watched -> eligible, waitingOn null', () => {
  const movies = [
    { id: 2, title: 'Part I', prequel: '', watched: true },
    { id: 3, title: 'Part II', prequel: 'Part I', watched: false }
  ];
  const result = ctx.computeEligibility(movies);
  const partTwo = result.find((m) => m.title === 'Part II');
  assert.equal(partTwo.eligible, true);
  assert.equal(partTwo.waitingOn, null);
});

test('eligibility: prequel unwatched -> not eligible, waitingOn is the prequel title', () => {
  const movies = [
    { id: 2, title: 'Part I', prequel: '', watched: false },
    { id: 3, title: 'Part II', prequel: 'Part I', watched: false }
  ];
  const result = ctx.computeEligibility(movies);
  const partTwo = result.find((m) => m.title === 'Part II');
  assert.equal(partTwo.eligible, false);
  assert.equal(partTwo.waitingOn, 'Part I');
});

test('eligibility: prequel match is case-insensitive and trims whitespace', () => {
  const movies = [
    { id: 2, title: '  Part I  ', prequel: '', watched: true },
    { id: 3, title: 'Part II', prequel: 'part i', watched: false }
  ];
  const result = ctx.computeEligibility(movies);
  const partTwo = result.find((m) => m.title === 'Part II');
  assert.equal(partTwo.eligible, true);
});

test('eligibility: dangling prequel reference fails closed and surfaces raw text', () => {
  const movies = [
    { id: 2, title: 'Part II', prequel: 'Nonexistent Part', watched: false }
  ];
  const [result] = ctx.computeEligibility(movies);
  assert.equal(result.eligible, false);
  assert.equal(result.waitingOn, 'Nonexistent Part');
});

// ---------------------------------------------------------------------------
// Spin / lookup
// ---------------------------------------------------------------------------

test('pickRandomEligible: empty eligible pool returns null', () => {
  const movies = [
    { id: 2, title: 'A', eligible: false },
    { id: 3, title: 'B', eligible: false }
  ];
  assert.equal(ctx.pickRandomEligible(movies, () => 0.5), null);
});

test('pickRandomEligible: no movies at all returns null', () => {
  assert.equal(ctx.pickRandomEligible([], () => 0.5), null);
});

test('pickRandomEligible: only considers eligible rows, deterministic via injected rng', () => {
  const movies = [
    { id: 2, title: 'A', eligible: true },
    { id: 3, title: 'B', eligible: false },
    { id: 4, title: 'C', eligible: true }
  ];
  assert.equal(ctx.pickRandomEligible(movies, () => 0).title, 'A');
  assert.equal(ctx.pickRandomEligible(movies, () => 0.999999).title, 'C');
});

test('findMovieById: unknown id returns null', () => {
  const movies = [{ id: 2, title: 'A' }];
  assert.equal(ctx.findMovieById(movies, 999), null);
});

test('findMovieById: matches by exact id', () => {
  const movies = [{ id: 2, title: 'A' }, { id: 3, title: 'B' }];
  assert.equal(ctx.findMovieById(movies, 3).title, 'B');
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('isTokenValid: rejects missing, wrong, or empty-expected tokens', () => {
  assert.equal(ctx.isTokenValid('abc', 'abc'), true);
  assert.equal(ctx.isTokenValid('wrong', 'abc'), false);
  assert.equal(ctx.isTokenValid(undefined, 'abc'), false);
  assert.equal(ctx.isTokenValid(null, 'abc'), false);
  assert.equal(ctx.isTokenValid('abc', ''), false);
  assert.equal(ctx.isTokenValid('abc', null), false);
});

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------

test('getPosterCacheStatus: "none" sentinel skips future fetches', () => {
  const status = ctx.getPosterCacheStatus('none');
  assert.equal(status.status, 'none');
  assert.equal(status.posterUrl, null);
});

test('getPosterCacheStatus: sentinel match is case-insensitive/trimmed', () => {
  assert.equal(ctx.getPosterCacheStatus(' NONE ').status, 'none');
});

test('getPosterCacheStatus: populated cell is used as-is, no fetch needed', () => {
  const url = 'https://image.tmdb.org/t/p/w500/abc.jpg';
  const status = ctx.getPosterCacheStatus(url);
  assert.equal(status.status, 'cached');
  assert.equal(status.posterUrl, url);
});

test('getPosterCacheStatus: blank cell means a fetch is needed', () => {
  assert.equal(ctx.getPosterCacheStatus('').status, 'missing');
  assert.equal(ctx.getPosterCacheStatus(null).status, 'missing');
});

test('parseTmdbSearchResponse: top result builds poster URL and matching cache value', () => {
  const json = { results: [{ poster_path: '/abc123.jpg' }, { poster_path: '/other.jpg' }] };
  const result = ctx.parseTmdbSearchResponse(json);
  assert.equal(result.posterUrl, 'https://image.tmdb.org/t/p/w500/abc123.jpg');
  assert.equal(result.cacheValue, 'https://image.tmdb.org/t/p/w500/abc123.jpg');
});

test('parseTmdbSearchResponse: no results caches the none sentinel', () => {
  const result = ctx.parseTmdbSearchResponse({ results: [] });
  assert.equal(result.posterUrl, null);
  assert.equal(result.cacheValue, 'none');
});

test('parseTmdbSearchResponse: malformed/missing response caches the none sentinel', () => {
  assert.equal(ctx.parseTmdbSearchResponse(null).cacheValue, 'none');
  assert.equal(ctx.parseTmdbSearchResponse({}).cacheValue, 'none');
  assert.equal(ctx.parseTmdbSearchResponse({ results: [{}] }).cacheValue, 'none');
});

test('buildTmdbSearchUrl: encodes title/year into the query', () => {
  const url = ctx.buildTmdbSearchUrl('KEY123', 'Harbor Lights III: Undertow', 2021);
  assert.match(url, /api_key=KEY123/);
  assert.match(url, /query=Harbor%20Lights%20III%3A%20Undertow/);
  assert.match(url, /year=2021/);
});

// ---------------------------------------------------------------------------
// TMDB multi-result year disambiguation (real-world bug: "Cinderella" has
// entries from 1950, 1997, 2015, 2021, and more -- results[0] alone is not
// reliable). Fixture below mirrors that shape.
// ---------------------------------------------------------------------------

const CINDERELLA_RESULTS = [
  { id: 11224, poster_path: '/2015-poster.jpg', release_date: '2015-03-13' }, // results[0]: most popular, but not always the target year
  { id: 12345, poster_path: '/1950-poster.jpg', release_date: '1950-02-15' },
  { id: 67890, poster_path: '/2021-poster.jpg', release_date: '2021-09-03' }
];

test('selectTmdbResultByYear: picks the entry whose release_date year matches targetYear, ignoring result order', () => {
  assert.equal(ctx.selectTmdbResultByYear(CINDERELLA_RESULTS, 1950).id, 12345);
  assert.equal(ctx.selectTmdbResultByYear(CINDERELLA_RESULTS, 2021).id, 67890);
  assert.equal(ctx.selectTmdbResultByYear(CINDERELLA_RESULTS, 2015).id, 11224);
});

test('selectTmdbResultByYear: no result matches targetYear -> falls back to results[0]', () => {
  assert.equal(ctx.selectTmdbResultByYear(CINDERELLA_RESULTS, 1997).id, 11224);
});

test('selectTmdbResultByYear: targetYear null/undefined -> falls back to results[0] (existing behavior preserved)', () => {
  assert.equal(ctx.selectTmdbResultByYear(CINDERELLA_RESULTS, null).id, 11224);
  assert.equal(ctx.selectTmdbResultByYear(CINDERELLA_RESULTS, undefined).id, 11224);
});

test('selectTmdbResultByYear: tolerates a blank/missing release_date on some entries without crashing', () => {
  const results = [{ id: 1, release_date: '' }, { id: 2, release_date: '2010-01-01' }, { id: 3 }];
  assert.equal(ctx.selectTmdbResultByYear(results, 2010).id, 2);
  assert.equal(ctx.selectTmdbResultByYear(results, 1999).id, 1); // no match -> results[0]
});

test('selectTmdbResultByYear: empty/malformed results returns null', () => {
  assert.equal(ctx.selectTmdbResultByYear([], 2010), null);
  assert.equal(ctx.selectTmdbResultByYear(null, 2010), null);
});

test('parseTmdbSearchResponse: with a target year, picks the year-matched result over results[0]', () => {
  const result = ctx.parseTmdbSearchResponse({ results: CINDERELLA_RESULTS }, 1950);
  assert.equal(result.posterUrl, 'https://image.tmdb.org/t/p/w500/1950-poster.jpg');
  assert.equal(result.cacheValue, 'https://image.tmdb.org/t/p/w500/1950-poster.jpg');
});

test('parseTmdbSearchResponse: no result matches the target year -> falls back to results[0], not "no match"', () => {
  const result = ctx.parseTmdbSearchResponse({ results: CINDERELLA_RESULTS }, 1997);
  assert.equal(result.posterUrl, 'https://image.tmdb.org/t/p/w500/2015-poster.jpg');
});

test('parseTmdbSearchResponse: no year on the row at all -> falls back to results[0] (existing behavior preserved)', () => {
  const result = ctx.parseTmdbSearchResponse({ results: CINDERELLA_RESULTS }, null);
  assert.equal(result.posterUrl, 'https://image.tmdb.org/t/p/w500/2015-poster.jpg');
});

test('extractTmdbMovieId: with a target year, picks the year-matched result\'s id over results[0]', () => {
  assert.equal(ctx.extractTmdbMovieId({ results: CINDERELLA_RESULTS }, 2021), 67890);
});

test('extractTmdbMovieId: no result matches the target year -> falls back to results[0]\'s id', () => {
  assert.equal(ctx.extractTmdbMovieId({ results: CINDERELLA_RESULTS }, 1997), 11224);
});

test('extractTmdbMovieId: no year on the row at all -> falls back to results[0]\'s id (existing behavior preserved)', () => {
  assert.equal(ctx.extractTmdbMovieId({ results: CINDERELLA_RESULTS }, undefined), 11224);
});

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

test('toPublicMovie: shapes the public Movie contract, empty prequel becomes null, rating null by default, no seenBy by default', () => {
  const movie = { id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: false, eligible: true, waitingOn: null };
  const out = ctx.toPublicMovie(movie, 'https://image.tmdb.org/t/p/w500/x.jpg');
  assert.deepEqual(out, {
    id: 5,
    title: 'Solo Film',
    year: 2020,
    prequel: null,
    watched: false,
    rating: null,
    eligible: true,
    waitingOn: null,
    posterUrl: 'https://image.tmdb.org/t/p/w500/x.jpg'
  });
  assert.equal('seenBy' in out, false);
});

test('toPublicMovie: posterUrl defaults to null when undefined', () => {
  const movie = { id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: false, eligible: true, waitingOn: null };
  const out = ctx.toPublicMovie(movie, undefined);
  assert.equal(out.posterUrl, null);
});

test('toPublicMovie: passes through an existing numeric rating', () => {
  const movie = { id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: true, rating: 4.5, eligible: false, waitingOn: null };
  const out = ctx.toPublicMovie(movie, null);
  assert.equal(out.rating, 4.5);
});

test('toPublicMovie: includeSeenBy option adds a full 8-member seenBy map in roster order', () => {
  const movie = {
    id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: false, eligible: true, waitingOn: null,
    seenBy: { Austin: true, Eugie: false, Josh: true, Jouissance: false, Lynda: true, Marvin: false, Mel: true, Michelle: false }
  };
  const out = ctx.toPublicMovie(movie, null, { includeSeenBy: true });
  assert.deepEqual(out.seenBy, {
    Austin: true, Eugie: false, Josh: true, Jouissance: false, Lynda: true, Marvin: false, Mel: true, Michelle: false
  });
});

test('toPublicMovie: includeSeenBy with no internal seenBy data defaults every member to false', () => {
  const movie = { id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: false, eligible: true, waitingOn: null };
  const out = ctx.toPublicMovie(movie, null, { includeSeenBy: true });
  assert.deepEqual(out.seenBy, {
    Austin: false, Eugie: false, Josh: false, Jouissance: false, Lynda: false, Marvin: false, Mel: false, Michelle: false
  });
});

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

test('isValidRating: null clears an existing rating', () => {
  assert.equal(ctx.isValidRating(null), true);
});

test('isValidRating: accepts every half-step from 0.5 to 5', () => {
  for (let doubled = 1; doubled <= 10; doubled++) {
    assert.equal(ctx.isValidRating(doubled / 2), true, `${doubled / 2} should be valid`);
  }
});

test('isValidRating: rejects 0, negative, above 5, and off-grid values', () => {
  assert.equal(ctx.isValidRating(0), false);
  assert.equal(ctx.isValidRating(-1), false);
  assert.equal(ctx.isValidRating(5.5), false);
  assert.equal(ctx.isValidRating(3.3), false);
  assert.equal(ctx.isValidRating(0.3), false);
});

test('isValidRating: rejects non-numeric and NaN values', () => {
  assert.equal(ctx.isValidRating('4.5'), false);
  assert.equal(ctx.isValidRating(undefined), false);
  assert.equal(ctx.isValidRating(NaN), false);
  assert.equal(ctx.isValidRating({}), false);
});

test('extractRatingCell: blank cell and unparseable text both read as null', () => {
  assert.equal(ctx.extractRatingCell(''), null);
  assert.equal(ctx.extractRatingCell(null), null);
  assert.equal(ctx.extractRatingCell('not a number'), null);
});

test('extractRatingCell: reads numbers and numeric strings through', () => {
  assert.equal(ctx.extractRatingCell(4.5), 4.5);
  assert.equal(ctx.extractRatingCell('3'), 3);
});

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

test('parseAbsentParam: comma-separated names matched case-insensitively/trimmed', () => {
  const names = ctx.parseAbsentParam(' austin , JOSH ,Lynda');
  assert.deepEqual(names, ['Austin', 'Josh', 'Lynda']);
});

test('parseAbsentParam: unrecognized/misspelled names are silently dropped, not errors', () => {
  assert.deepEqual(ctx.parseAbsentParam('Austin,Bob'), ['Austin']);
  assert.deepEqual(ctx.parseAbsentParam('Bob,Xyz'), []);
});

test('parseAbsentParam: empty/blank/null/undefined all yield an empty array', () => {
  assert.deepEqual(ctx.parseAbsentParam(''), []);
  assert.deepEqual(ctx.parseAbsentParam(null), []);
  assert.deepEqual(ctx.parseAbsentParam(undefined), []);
  assert.deepEqual(ctx.parseAbsentParam(' , , '), []);
});

test('parseAbsentParam: de-duplicates repeated names', () => {
  assert.deepEqual(ctx.parseAbsentParam('Austin,austin,AUSTIN'), ['Austin']);
});

function movieFixture(overrides) {
  return Object.assign({
    id: 2,
    title: 'Some Movie',
    year: 2020,
    prequel: '',
    watched: false,
    eligible: true,
    waitingOn: null,
    seenBy: { Austin: false, Eugie: false, Josh: false, Jouissance: false, Lynda: false, Marvin: false, Mel: false, Michelle: false }
  }, overrides);
}

test('computeAttendanceEligibility: sole eligible movie blocked by an absent member triggers fallback (would leave pool empty)', () => {
  const movies = [movieFixture({ seenBy: Object.assign({}, movieFixture().seenBy, { Austin: false }) })];
  const result = ctx.computeAttendanceEligibility(movies, ['Austin']);
  assert.equal(result.attendanceApplied, false); // filtering this one movie out would leave zero -> fallback
  assert.equal(result.movies[0].eligible, true); // fallback reverts to base eligibility
});

test('computeAttendanceEligibility: absent member who HAS seen it keeps the movie eligible', () => {
  const movies = [
    movieFixture({ id: 2, seenBy: Object.assign({}, movieFixture().seenBy, { Austin: true }) })
  ];
  const result = ctx.computeAttendanceEligibility(movies, ['Austin']);
  assert.equal(result.attendanceApplied, true);
  assert.equal(result.movies[0].eligible, true);
});

test('computeAttendanceEligibility: mixed pool -- blocks only the movies the absent member has not seen', () => {
  const movies = [
    movieFixture({ id: 2, title: 'Seen It', seenBy: Object.assign({}, movieFixture().seenBy, { Austin: true }) }),
    movieFixture({ id: 3, title: 'Has Not Seen It', seenBy: Object.assign({}, movieFixture().seenBy, { Austin: false }) })
  ];
  const result = ctx.computeAttendanceEligibility(movies, ['Austin']);
  assert.equal(result.attendanceApplied, true);
  const seenIt = result.movies.find((m) => m.title === 'Seen It');
  const hasNotSeenIt = result.movies.find((m) => m.title === 'Has Not Seen It');
  assert.equal(seenIt.eligible, true);
  assert.equal(hasNotSeenIt.eligible, false);
});

test('computeAttendanceEligibility: presence never adds eligibility -- a base-ineligible movie stays ineligible', () => {
  const movies = [movieFixture({ eligible: false, waitingOn: 'Some Prequel' })];
  const result = ctx.computeAttendanceEligibility(movies, ['Austin']);
  // Nothing was eligible to begin with, so the attendance-filtered pool is
  // also empty -> fallback kicks in.
  assert.equal(result.attendanceApplied, false);
  assert.equal(result.movies[0].eligible, false);
  assert.equal(result.movies[0].waitingOn, 'Some Prequel'); // untouched by attendance
});

test('computeAttendanceEligibility: fallback triggers when the filtered pool would be empty, base eligibility restored', () => {
  const movies = [
    movieFixture({ id: 2, title: 'A', seenBy: Object.assign({}, movieFixture().seenBy, { Austin: false }) }),
    movieFixture({ id: 3, title: 'B', seenBy: Object.assign({}, movieFixture().seenBy, { Austin: false }) })
  ];
  const result = ctx.computeAttendanceEligibility(movies, ['Austin']);
  assert.equal(result.attendanceApplied, false);
  assert.equal(result.movies.find((m) => m.title === 'A').eligible, true);
  assert.equal(result.movies.find((m) => m.title === 'B').eligible, true);
});

test('computeAttendanceEligibility: multiple absent members -- ALL of them must have seen it', () => {
  const movies = [
    movieFixture({ id: 2, seenBy: Object.assign({}, movieFixture().seenBy, { Austin: true, Josh: false }) }),
    movieFixture({ id: 3, seenBy: Object.assign({}, movieFixture().seenBy, { Austin: true, Josh: true }) })
  ];
  const result = ctx.computeAttendanceEligibility(movies, ['Austin', 'Josh']);
  assert.equal(result.attendanceApplied, true);
  assert.equal(result.movies[0].eligible, false); // Josh hasn't seen movie 2
  assert.equal(result.movies[1].eligible, true); // both have seen movie 3
});

test('computeAttendanceEligibility: waitingOn is never overwritten by attendance filtering', () => {
  const movies = [movieFixture({ id: 3, seenBy: Object.assign({}, movieFixture().seenBy, { Austin: true }) })];
  // Second, separately-eligible movie so the pool isn't emptied by the filter.
  movies.push(movieFixture({ id: 4, seenBy: Object.assign({}, movieFixture().seenBy, { Austin: true }) }));
  const result = ctx.computeAttendanceEligibility(movies, ['Austin']);
  result.movies.forEach((m) => assert.equal(m.waitingOn, null));
});

// ---------------------------------------------------------------------------
// Streaming platforms (TMDB watch/providers)
// ---------------------------------------------------------------------------

test('buildTmdbProvidersUrl: builds the watch/providers URL for a TMDB movie id', () => {
  const url = ctx.buildTmdbProvidersUrl('KEY123', 603);
  assert.match(url, /\/movie\/603\/watch\/providers/);
  assert.match(url, /api_key=KEY123/);
});

test('extractTmdbMovieId: pulls the top search result id', () => {
  assert.equal(ctx.extractTmdbMovieId({ results: [{ id: 603 }, { id: 604 }] }), 603);
});

test('extractTmdbMovieId: no results or malformed response returns null', () => {
  assert.equal(ctx.extractTmdbMovieId({ results: [] }), null);
  assert.equal(ctx.extractTmdbMovieId(null), null);
  assert.equal(ctx.extractTmdbMovieId({}), null);
});

test('parseTmdbProvidersResponse: extracts US flatrate provider names, deduplicated', () => {
  const json = {
    results: {
      US: {
        flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'Hulu' }, { provider_name: 'Netflix' }]
      }
    }
  };
  assert.deepEqual(ctx.parseTmdbProvidersResponse(json), ['Netflix', 'Hulu']);
});

test('parseTmdbProvidersResponse: missing US region or flatrate list returns empty array, not an error', () => {
  assert.deepEqual(ctx.parseTmdbProvidersResponse({ results: {} }), []);
  assert.deepEqual(ctx.parseTmdbProvidersResponse({ results: { US: {} } }), []);
  assert.deepEqual(ctx.parseTmdbProvidersResponse(null), []);
  assert.deepEqual(ctx.parseTmdbProvidersResponse({}), []);
});

// ---------------------------------------------------------------------------
// Quotes (Google Gemini API)
// ---------------------------------------------------------------------------

function geminiSuccess(quotesArray, finishReason) {
  return {
    candidates: [{
      finishReason: finishReason === undefined ? 'STOP' : finishReason,
      content: { parts: [{ text: JSON.stringify(quotesArray) }] }
    }]
  };
}

test('buildGeminiQuotesPayload: builds a structured-output request with responseSchema and the title in the prompt', () => {
  const payload = ctx.buildGeminiQuotesPayload('Harbor Lights III: Undertow', 2021);
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.equal(payload.generationConfig.responseSchema.type, 'ARRAY');
  assert.equal(payload.generationConfig.responseSchema.items.type, 'STRING');
  assert.match(payload.contents[0].parts[0].text, /Harbor Lights III: Undertow \(2021\)/);
  assert.equal(payload.contents[0].role, 'user');
});

test('buildGeminiQuotesPayload: omits the year from the prompt when not known', () => {
  const payload = ctx.buildGeminiQuotesPayload('Untitled Project', null);
  assert.match(payload.contents[0].parts[0].text, /"Untitled Project"/);
  assert.doesNotMatch(payload.contents[0].parts[0].text, /\(null\)/);
});

test('isGeminiBlocked: false for a normal STOP-finished candidate', () => {
  assert.equal(ctx.isGeminiBlocked(geminiSuccess(['a quote'])), false);
});

test('isGeminiBlocked: false when finishReason is absent (some minimal successful responses omit it)', () => {
  assert.equal(ctx.isGeminiBlocked({ candidates: [{ content: { parts: [{ text: '[]' }] } }] }), false);
});

test('isGeminiBlocked: true for a safety block or any other non-STOP finishReason', () => {
  assert.equal(ctx.isGeminiBlocked({ candidates: [{ finishReason: 'SAFETY' }] }), true);
  assert.equal(ctx.isGeminiBlocked({ candidates: [{ finishReason: 'RECITATION' }] }), true);
});

test('isGeminiBlocked: true when there are no candidates at all, or a malformed/missing response', () => {
  assert.equal(ctx.isGeminiBlocked({ candidates: [] }), true);
  assert.equal(ctx.isGeminiBlocked(null), true);
  assert.equal(ctx.isGeminiBlocked({}), true);
});

test('parseGeminiQuotesResponse: extracts quotes from the JSON-string text part', () => {
  const geminiJson = geminiSuccess(['"May the Force be with you." — Obi-Wan Kenobi']);
  assert.deepEqual(ctx.parseGeminiQuotesResponse(geminiJson), ['"May the Force be with you." — Obi-Wan Kenobi']);
});

test('parseGeminiQuotesResponse: empty quotes array is valid, not an error', () => {
  assert.deepEqual(ctx.parseGeminiQuotesResponse(geminiSuccess([])), []);
});

test('parseGeminiQuotesResponse: a safety-blocked response degrades to empty array, not an error', () => {
  assert.deepEqual(ctx.parseGeminiQuotesResponse({ candidates: [{ finishReason: 'SAFETY' }] }), []);
});

test('parseGeminiQuotesResponse: malformed/missing response degrades to empty array', () => {
  assert.deepEqual(ctx.parseGeminiQuotesResponse(null), []);
  assert.deepEqual(ctx.parseGeminiQuotesResponse({}), []);
  assert.deepEqual(ctx.parseGeminiQuotesResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }), []);
  assert.deepEqual(ctx.parseGeminiQuotesResponse(geminiSuccess('not an array')), []);
  assert.deepEqual(ctx.parseGeminiQuotesResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] }), []);
});

test('parseGeminiQuotesResponse: caps at 4 quotes even if the model returns more', () => {
  const quotes = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(ctx.parseGeminiQuotesResponse(geminiSuccess(quotes)), ['a', 'b', 'c', 'd']);
});
