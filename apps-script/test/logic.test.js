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
  assert.deepEqual(idx, { movie: 0, year: 1, prequel: 2, watched: 3, posterUrl: 4 });
});

test('resolveHeaderIndexes: missing headers resolve to -1, unrecognized columns ignored', () => {
  const idx = ctx.resolveHeaderIndexes(['Foo', 'Bar']);
  assert.deepEqual(idx, { movie: -1, year: -1, prequel: -1, watched: -1, posterUrl: -1 });
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
// Output shaping
// ---------------------------------------------------------------------------

test('toPublicMovie: shapes the public Movie contract, empty prequel becomes null', () => {
  const movie = { id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: false, eligible: true, waitingOn: null };
  const out = ctx.toPublicMovie(movie, 'https://image.tmdb.org/t/p/w500/x.jpg');
  assert.deepEqual(out, {
    id: 5,
    title: 'Solo Film',
    year: 2020,
    prequel: null,
    watched: false,
    eligible: true,
    waitingOn: null,
    posterUrl: 'https://image.tmdb.org/t/p/w500/x.jpg'
  });
});

test('toPublicMovie: posterUrl defaults to null when undefined', () => {
  const movie = { id: 5, title: 'Solo Film', year: 2020, prequel: '', watched: false, eligible: true, waitingOn: null };
  const out = ctx.toPublicMovie(movie, undefined);
  assert.equal(out.posterUrl, null);
});
