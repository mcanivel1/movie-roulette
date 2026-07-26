'use strict';

/**
 * Adversarial QA pass — independent of the backend dev's own 44 tests.
 * These target gaps found by reading Logic.js/Code.js against SPEC.md line
 * by line: edge cases around empty sheets, type coercion at the HTTP
 * boundary, watched/prequel interaction, poster-column creation from
 * scratch, and failure modes not explicitly enumerated by the spec.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadGasContext,
  createMockSheet,
  createMockPropertiesService,
  createMockSpreadsheetApp,
  createMockUrlFetchApp,
  mockContentService
} = require('./helpers');

const SHARED_TOKEN = 'test-token-123';
const SPREADSHEET_ID = 'fake-spreadsheet-id';
const TMDB_API_KEY = 'fake-tmdb-key';

function setUp(sheetValues, responder) {
  const sheet = createMockSheet(sheetValues);
  const fetchMock = createMockUrlFetchApp(responder || (() => ({ results: [] })));
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: createMockSpreadsheetApp(sheet),
    PropertiesService: createMockPropertiesService({
      SPREADSHEET_ID,
      SHARED_TOKEN,
      TMDB_API_KEY
    }),
    UrlFetchApp: fetchMock,
    ContentService: mockContentService,
    console
  });
  return { sheet, fetchMock, context };
}

// ---------------------------------------------------------------------------
// Header-only sheet (no movie rows at all)
// ---------------------------------------------------------------------------

test('QA: sheet with only a header row -> list returns empty array, no crash', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const { context, fetchMock } = setUp([HEADER]);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  assert.deepEqual(res.json(), { movies: [] });
  assert.equal(fetchMock.calls.length, 0); // nothing to resolve posters for
});

test('QA: sheet with only a header row -> spin returns {movie: null}, no crash', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const { context } = setUp([HEADER]);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin' } });
  assert.deepEqual(res.json(), { movie: null });
});

// ---------------------------------------------------------------------------
// Watched + prequel interaction (waitingOn priority)
// ---------------------------------------------------------------------------

test('QA: a watched movie with a dangling prequel reference still reports waitingOn: null (ineligible because watched, not because of the prequel)', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [
    HEADER,
    ['Sequel', 2020, 'Nonexistent Prequel', true, 'none']
  ];
  const { context } = setUp(values);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const movie = res.json().movies[0];
  assert.equal(movie.watched, true);
  assert.equal(movie.eligible, false);
  assert.equal(movie.waitingOn, null); // not "Nonexistent Prequel"
});

test('QA: a watched movie whose prequel is unwatched also reports waitingOn: null', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [
    HEADER,
    ['Part I', 2018, '', false, 'none'],
    ['Part II', 2020, 'Part I', true, 'none'] // watched, even though its prequel isn't
  ];
  const { context } = setUp(values);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const partII = res.json().movies.find((m) => m.title === 'Part II');
  assert.equal(partII.eligible, false);
  assert.equal(partII.waitingOn, null);
});

// ---------------------------------------------------------------------------
// setWatched: type strictness at the HTTP boundary
// ---------------------------------------------------------------------------

test('QA: setWatched with id sent as a string (not a number) is rejected as bad_request', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [HEADER, ['Part I', 2018, '', false, 'none']];
  const { context } = setUp(values);
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: '2', watched: true }) }
  });
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

test('QA: setWatched with an extremely large id returns not_found, not a crash', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [HEADER, ['Part I', 2018, '', false, 'none']];
  const { context } = setUp(values);
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 9007199254740991, watched: true }) }
  });
  assert.deepEqual(res.json(), { error: 'not_found' });
});

test('QA: setWatched with a non-integer numeric id (e.g. 2.5) does not match a row -> not_found', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [HEADER, ['Part I', 2018, '', false, 'none']];
  const { context } = setUp(values);
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 2.5, watched: true }) }
  });
  assert.deepEqual(res.json(), { error: 'not_found' });
});

// ---------------------------------------------------------------------------
// Undoing a watched mark (Library "undo" flow) re-locks dependent sequels
// ---------------------------------------------------------------------------

test('QA: unmarking a prequel watched (watched: false) re-locks its sequel on next read', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [
    HEADER,
    ['Part I', 2018, '', true, 'none'], // id 2, already watched
    ['Part II', 2020, 'Part I', false, 'none'] // id 3, currently eligible
  ];
  const { context } = setUp(values);

  // Sanity: Part II starts eligible because Part I is watched.
  let list = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } }).json();
  assert.equal(list.movies.find((m) => m.title === 'Part II').eligible, true);

  // Undo Part I's watched mark.
  const undo = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 2, watched: false }) }
  });
  assert.equal(undo.json().movie.watched, false);

  // Part II must now be re-locked.
  list = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } }).json();
  const partII = list.movies.find((m) => m.title === 'Part II');
  assert.equal(partII.eligible, false);
  assert.equal(partII.waitingOn, 'Part I');
});

// ---------------------------------------------------------------------------
// Poster URL column doesn't exist yet at all (not just a blank cell)
// ---------------------------------------------------------------------------

test('QA: sheet with no Poster URL column at all gets it created exactly once, even with multiple rows needing resolution', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched']; // no Poster URL column
  const values = [
    HEADER,
    ['Alpha', 2001, '', false],
    ['Beta', 2002, '', false]
  ];
  const { context, sheet, fetchMock } = setUp(values, () => ({ results: [{ poster_path: '/p.jpg' }] }));
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const body = res.json();

  assert.equal(body.movies.length, 2);
  assert.equal(body.movies[0].posterUrl, 'https://image.tmdb.org/t/p/w500/p.jpg');
  assert.equal(body.movies[1].posterUrl, 'https://image.tmdb.org/t/p/w500/p.jpg');
  assert.equal(fetchMock.calls.length, 2);

  const data = sheet._snapshot();
  // Exactly one "Poster URL" header cell, at column 5 (index 4), not duplicated.
  const headerRow = data[0];
  const posterHeaderCount = headerRow.filter((h) => String(h).trim().toLowerCase() === 'poster url').length;
  assert.equal(posterHeaderCount, 1);
  assert.equal(headerRow.length, 5);
  assert.equal(data[1][4], 'https://image.tmdb.org/t/p/w500/p.jpg');
  assert.equal(data[2][4], 'https://image.tmdb.org/t/p/w500/p.jpg');

  // A second list call must not re-fetch or add another column.
  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  assert.equal(fetchMock.calls.length, 2);
});

// ---------------------------------------------------------------------------
// doPost with missing/malformed postData shape entirely
// ---------------------------------------------------------------------------

test('QA: doPost with postData entirely absent returns bad_request instead of throwing', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const { context } = setUp([HEADER, ['Part I', 2018, '', false, 'none']]);
  const res = context.doPost({}); // no postData at all
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

test('QA: doPost with e itself undefined returns bad_request instead of throwing', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const { context } = setUp([HEADER, ['Part I', 2018, '', false, 'none']]);
  const res = context.doPost(undefined);
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

// ---------------------------------------------------------------------------
// Self-referencing prequel (data integrity edge case) — must fail closed,
// not crash or infinite-loop.
// ---------------------------------------------------------------------------

test('QA: a movie whose Prequel references its own title fails closed without crashing', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [HEADER, ['Loop', 2020, 'Loop', false, 'none']];
  const { context } = setUp(values);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const movie = res.json().movies[0];
  assert.equal(movie.eligible, false);
  assert.equal(movie.waitingOn, 'Loop');
});

// ---------------------------------------------------------------------------
// Prequel reference that differs only in *internal* whitespace does NOT
// match (spec says matching is "trimmed, case-insensitive" only — not full
// whitespace normalization) — documents intentional fail-closed behavior.
// ---------------------------------------------------------------------------

test('QA: prequel text differing only in internal whitespace from the real title does not match (fails closed, per spec\'s trim-only matching rule)', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [
    HEADER,
    ['Part  I', 2018, '', true, 'none'], // double space in title, watched
    ['Part II', 2020, 'Part I', false, 'none'] // single space reference -> no exact match after trim
  ];
  const { context } = setUp(values);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const partII = res.json().movies.find((m) => m.title === 'Part II');
  assert.equal(partII.eligible, false);
  assert.equal(partII.waitingOn, 'Part I');
});

// ---------------------------------------------------------------------------
// Mixed Poster URL states (real URL / sentinel / blank) all in one sheet,
// combined with a setWatched call, to make sure caching and mutation don't
// cross-contaminate rows.
// ---------------------------------------------------------------------------

test('QA: mixed real-URL/sentinel/blank Poster URL rows resolve independently and correctly, only blanks trigger a fetch', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [
    HEADER,
    ['Cached', 2001, '', false, 'https://image.tmdb.org/t/p/w500/cached.jpg'],
    ['Sentinel', 2002, '', false, 'none'],
    ['Blank', 2003, '', false, '']
  ];
  const { context, fetchMock, sheet } = setUp(values, () => ({ results: [{ poster_path: '/blank.jpg' }] }));
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const movies = res.json().movies;

  assert.equal(movies.find((m) => m.title === 'Cached').posterUrl, 'https://image.tmdb.org/t/p/w500/cached.jpg');
  assert.equal(movies.find((m) => m.title === 'Sentinel').posterUrl, null);
  assert.equal(movies.find((m) => m.title === 'Blank').posterUrl, 'https://image.tmdb.org/t/p/w500/blank.jpg');
  assert.equal(fetchMock.calls.length, 1); // only the genuinely blank row

  // The already-cached row's cell must be untouched (not rewritten).
  const data = sheet._snapshot();
  assert.equal(data[1][4], 'https://image.tmdb.org/t/p/w500/cached.jpg');
  assert.equal(data[2][4], 'none');
});

// ---------------------------------------------------------------------------
// TMDB request failure / malformed response mid-list: a bad response for one
// row must not take down the whole list call. Fixed after QA flagged the
// original behavior (whole request failing with sheet_error) as a
// resilience risk for a family app on a flaky/rate-limited TMDB response.
// ---------------------------------------------------------------------------

test('QA: a malformed/non-JSON TMDB response for one row degrades to posterUrl: null for that row only, the rest of the list call still succeeds', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [
    HEADER,
    ['Alpha', 2001, '', false, ''], // blank poster cell -> triggers a TMDB fetch that will fail
    ['Beta', 2002, '', false, 'https://image.tmdb.org/t/p/w500/ok.jpg'] // already cached, no fetch needed
  ];
  const sheet = createMockSheet(values);
  const fetchMock = {
    calls: [],
    fetch(url, options) {
      this.calls.push({ url, options });
      return { getContentText: () => 'Not JSON — TMDB rate-limited or down' };
    }
  };
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: createMockSpreadsheetApp(sheet),
    PropertiesService: createMockPropertiesService({ SPREADSHEET_ID, SHARED_TOKEN, TMDB_API_KEY }),
    UrlFetchApp: fetchMock,
    ContentService: mockContentService,
    console
  });
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const body = res.json();

  // The whole request must still succeed...
  assert.equal(body.error, undefined);
  assert.equal(body.movies.length, 2);

  // ...with the row whose TMDB call failed falling back to posterUrl: null...
  assert.equal(body.movies.find((m) => m.title === 'Alpha').posterUrl, null);
  // ...and the sibling row, which never needed a network call, unaffected.
  assert.equal(body.movies.find((m) => m.title === 'Beta').posterUrl, 'https://image.tmdb.org/t/p/w500/ok.jpg');

  // The failed row's cell must be left blank (not permanently cached as
  // "none"), so a later request retries TMDB for it instead of getting
  // stuck forever on a transient failure.
  const data = sheet._snapshot();
  assert.equal(data[1][4], '');

  assert.equal(fetchMock.calls.length, 1); // only Alpha's blank cell triggered a fetch
});

test('QA: a malformed/non-JSON TMDB response for the spin winner still returns the movie with posterUrl: null instead of failing', () => {
  const HEADER = ['Movie', 'Year', 'Prequel', 'Watched', 'Poster URL'];
  const values = [HEADER, ['Alpha', 2001, '', false, '']];
  const sheet = createMockSheet(values);
  const fetchMock = {
    calls: [],
    fetch(url, options) {
      this.calls.push({ url, options });
      return { getContentText: () => 'Not JSON — TMDB rate-limited or down' };
    }
  };
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: createMockSpreadsheetApp(sheet),
    PropertiesService: createMockPropertiesService({ SPREADSHEET_ID, SHARED_TOKEN, TMDB_API_KEY }),
    UrlFetchApp: fetchMock,
    ContentService: mockContentService,
    console
  });
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin' } });
  const body = res.json();
  assert.equal(body.error, undefined);
  assert.equal(body.movie.title, 'Alpha');
  assert.equal(body.movie.posterUrl, null);
});
