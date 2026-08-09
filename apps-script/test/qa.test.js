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
  createMockCacheService,
  mockContentService
} = require('./helpers');

const SHARED_TOKEN = 'test-token-123';
const SPREADSHEET_ID = 'fake-spreadsheet-id';
const TMDB_API_KEY = 'fake-tmdb-key';
const GEMINI_API_KEY = 'fake-gemini-key';

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

// ---------------------------------------------------------------------------
// v2 adversarial pass — Ratings, Attendance, Streaming/quotes
//
// Independent of backend-dev's own 116 tests (logic.test.js/code.test.js),
// which already cover the isValidRating grid, parseAbsentParam dedup/typo
// handling, the attendance fallback rule, and per-row TMDB/Gemini
// failure isolation for `details`. These target gaps found reading the v2
// implementation against SPEC.md that weren't in that coverage.
// ---------------------------------------------------------------------------

const HEADER_V2 = [
  'Watched', 'Movie', 'Year', 'Prequel', 'Poster URL', 'Rating',
  'Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'
];

function setUpV2(sheetValues, responder) {
  const sheet = createMockSheet(sheetValues);
  const fetchMock = createMockUrlFetchApp(responder || (() => ({ results: [] })));
  const cacheServiceMock = createMockCacheService();
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: createMockSpreadsheetApp(sheet),
    PropertiesService: createMockPropertiesService({
      SPREADSHEET_ID,
      SHARED_TOKEN,
      TMDB_API_KEY,
      GEMINI_API_KEY
    }),
    UrlFetchApp: fetchMock,
    CacheService: cacheServiceMock,
    ContentService: mockContentService,
    console
  });
  return { sheet, fetchMock, context, cacheServiceMock };
}

// ---------------------------------------------------------------------------
// Ratings: independent of Watched state across an actual round trip
// (SPEC.md: "stored/read correctly independent of Watched state" — the
// dev's own tests check this at the write boundary; this checks it survives
// unrelated writes to the *other* field in both directions).
// ---------------------------------------------------------------------------

test('QA: a rating survives an unrelated setWatched toggle in both directions', () => {
  const values = [
    HEADER_V2,
    [false, 'Part I', 2018, '', '', '', true, true, true, true, true, true, true, true] // id 2
  ];
  const { context, sheet } = setUpV2(values);

  const rated = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 2, rating: 4.5 }) }
  }).json();
  assert.equal(rated.movie.rating, 4.5);

  const markedWatched = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 2, watched: true }) }
  }).json();
  assert.equal(markedWatched.movie.watched, true);
  assert.equal(markedWatched.movie.rating, 4.5, 'setWatched must not touch the Rating cell');

  const unmarkedWatched = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 2, watched: false }) }
  }).json();
  assert.equal(unmarkedWatched.movie.watched, false);
  assert.equal(unmarkedWatched.movie.rating, 4.5, 'undoing Watched must not clear the rating either');

  const ratingColIdx = HEADER_V2.indexOf('Rating');
  assert.equal(sheet._snapshot()[1][ratingColIdx], 4.5);
});

// ---------------------------------------------------------------------------
// Attendance: seenBy truthy-string parsing across the same variant set
// Watched already has to handle (SPEC.md explicitly calls this out).
// buildSheetValuesV2 fixtures elsewhere in the suite only ever use real
// booleans for member columns -- this exercises the mixed-representation
// case a real hand-edited or imported sheet would actually have.
// ---------------------------------------------------------------------------

test('QA: seenBy parses the same truthy-string variants as Watched, per member column, independently', () => {
  const values = [
    HEADER_V2,
    // Austin='TRUE' string, Eugie=false boolean, Josh='Yes', Jouissance='No',
    // Lynda=1 (number), Marvin=0, Mel='' (blank), Michelle=true boolean.
    [false, 'Mixed Reps', 2020, '', '', '', 'TRUE', false, 'Yes', 'No', 1, 0, '', true]
  ];
  const { context } = setUpV2(values);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const seenBy = res.json().movies[0].seenBy;
  assert.deepEqual(seenBy, {
    Austin: true,
    Eugie: false,
    Josh: true,
    Jouissance: false,
    Lynda: true,
    Marvin: false,
    Mel: false,
    Michelle: true
  });
});

// ---------------------------------------------------------------------------
// Attendance: list and spin must stay consistent under the same absent set
// (SPEC.md: "the Roulette pool count and decoy-shuffle candidates the
// frontend already builds from list stay consistent with what spin can
// actually pick").
// ---------------------------------------------------------------------------

test('QA: list and spin agree on both the eligible set and attendanceApplied under the same absent param', () => {
  const values = [
    HEADER_V2,
    // id 2: Austin has NOT seen it -> knocked out when Austin is absent.
    [false, 'Spoiler Risk', 2020, '', '', '', false, true, true, true, true, true, true, true],
    // id 3: Austin HAS seen it -> stays eligible when Austin is absent.
    [false, 'Safe To Watch', 2021, '', '', '', true, true, true, true, true, true, true, true]
  ];
  const { context } = setUpV2(values);

  const list = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list', absent: 'Austin' } }).json();
  assert.equal(list.attendanceApplied, true);
  const eligibleInList = list.movies.filter((m) => m.eligible).map((m) => m.title);
  assert.deepEqual(eligibleInList, ['Safe To Watch']);

  const spin = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin', absent: 'Austin' } }).json();
  assert.equal(spin.attendanceApplied, true);
  assert.equal(spin.movie.title, 'Safe To Watch', 'spin must only ever pick from the same pool list reported as eligible');
});

// ---------------------------------------------------------------------------
// Streaming/quotes: a *transient* TMDB/Gemini failure must not get
// permanently cached as an empty result for the full TTL -- same fail-open-
// for-retry convention poster resolution (Code.js resolvePosterForMovie_)
// already uses (nothing written back to the sheet on failure, so the next
// request retries). QA originally caught resolveStreamingPlatforms_/
// resolveQuotes_ calling cache.put() unconditionally, including on the
// caught-exception path -- fixed by backend-dev by moving cache.put() to
// only run after a fetch/parse genuinely succeeds. This test now pins down
// the *fixed* behavior against the current Gemini-backed quotes path: a
// failure isn't cached, and a retry after upstream recovers gets the real
// answer instead of a stale empty one.
// ---------------------------------------------------------------------------

test('QA: a transient TMDB/Gemini failure on `details` is not cached, and a retry after upstream recovers gets the real answer', () => {
  const values = [HEADER_V2, [false, 'Flaky Upstream', 2020, '', '', '', true, true, true, true, true, true, true, true]];
  const sheet = createMockSheet(values);
  let upstreamIsDown = true;
  const fetchMock = {
    calls: [],
    fetch(url, options) {
      this.calls.push({ url, options });
      if (upstreamIsDown) {
        return { getResponseCode: () => 200, getContentText: () => 'Not JSON — TMDB/Gemini rate-limited or down' };
      }
      if (url.includes('/watch/providers')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ results: { US: { flatrate: [{ provider_name: 'Netflix' }] } } })
        };
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [{ text: JSON.stringify(['"A real quote." — Someone']) }] }
            }]
          })
        };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ results: [{ id: 42, poster_path: '/p.jpg' }] }) };
    }
  };
  const cacheServiceMock = createMockCacheService();
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: createMockSpreadsheetApp(sheet),
    PropertiesService: createMockPropertiesService({ SPREADSHEET_ID, SHARED_TOKEN, TMDB_API_KEY, GEMINI_API_KEY }),
    UrlFetchApp: fetchMock,
    CacheService: cacheServiceMock,
    ContentService: mockContentService,
    console
  });

  // First call: upstream is down -> degrades to empty arrays (already
  // covered by backend-dev's own test) and, per the fix, writes NOTHING to
  // CacheService -- a transient failure must not get baked in.
  const first = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } }).json();
  assert.deepEqual(first.streamingPlatforms, []);
  assert.deepEqual(first.quotes, []);
  const putCallsAfterFailure = cacheServiceMock.calls.filter((c) => c.op === 'put');
  assert.equal(putCallsAfterFailure.length, 0, 'a fetch/parse failure must not be written to CacheService');

  // Upstream recovers -- since nothing was cached, the second call retries
  // TMDB/Gemini for real and gets the actual answer, not a stale empty
  // result.
  upstreamIsDown = false;
  const second = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } }).json();
  assert.deepEqual(second.streamingPlatforms, ['Netflix']);
  assert.deepEqual(second.quotes, ['"A real quote." — Someone']);

  // And *this* successful result now IS cached (a third call, still with
  // upstream up, must not re-hit the network).
  const callsBeforeThird = fetchMock.calls.length;
  const third = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } }).json();
  assert.deepEqual(third.streamingPlatforms, ['Netflix']);
  assert.deepEqual(third.quotes, ['"A real quote." — Someone']);
  assert.equal(fetchMock.calls.length, callsBeforeThird, 'a genuinely successful result should be cached, unlike a failure');
});

// ---------------------------------------------------------------------------
// Streaming/quotes: a Gemini safety block (candidate present, but
// finishReason !== "STOP") must degrade to empty quotes WITHOUT being
// cached -- same fail-open-for-retry requirement as a network failure,
// called out explicitly in SPEC.md ("don't write anything to the cache, so
// the next request retries instead of permanently caching a false 'no
// quotes' result"). Distinct from a genuinely empty *successful* generation
// (covered elsewhere), which SHOULD be cached.
// ---------------------------------------------------------------------------

test('QA: a Gemini safety block on `details` degrades to empty quotes and is not cached, unlike a genuine empty result', () => {
  const values = [HEADER_V2, [false, 'Sensitive Title', 2020, '', '', '', true, true, true, true, true, true, true, true]];
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: { US: {} } };
    if (url.includes('generativelanguage.googleapis.com')) {
      // No usable candidate -- blocked before any content was generated.
      return { candidates: [{ finishReason: 'SAFETY' }] };
    }
    return { results: [{ id: 9, poster_path: '/p.jpg' }] };
  };
  const { context, cacheServiceMock } = setUpV2(values, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } });
  const body = res.json();
  assert.equal(body.error, undefined);
  assert.deepEqual(body.quotes, [], 'a safety block degrades to an empty quotes array, not an error');

  const quotesPutCalls = cacheServiceMock.calls.filter((c) => c.op === 'put' && c.key.startsWith('quotes:'));
  assert.equal(quotesPutCalls.length, 0, 'a safety block must not be cached -- the next request should retry, per SPEC.md');
});

// ---------------------------------------------------------------------------
// Streaming/quotes: failure isolation is per *network call*, not just per
// movie -- a TMDB providers failure must not take down the independently-
// sourced Gemini quotes for the same details call, and vice versa.
// ---------------------------------------------------------------------------

test('QA: a TMDB watch/providers failure for one movie does not affect that same call\'s independently-fetched quotes', () => {
  const values = [HEADER_V2, [false, 'Partial Failure', 2020, '', '', '', true, true, true, true, true, true, true, true]];
  const responder = (url) => {
    if (url.includes('/watch/providers')) throw new Error('TMDB providers endpoint down');
    if (url.includes('generativelanguage.googleapis.com')) {
      return {
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(['"Still works." — Narrator']) }] }
        }]
      };
    }
    return { results: [{ id: 7, poster_path: '/p.jpg' }] }; // TMDB title search (id resolution)
  };
  const { context } = setUpV2(values, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } });
  const body = res.json();
  assert.equal(body.error, undefined, 'the whole details call must not fail because one of its two sub-fetches did');
  assert.deepEqual(body.streamingPlatforms, []);
  assert.deepEqual(body.quotes, ['"Still works." — Narrator']);
});

// ---------------------------------------------------------------------------
// Auth: action=details follows the same unauthorized-before-dispatch path
// as list/spin/setWatched/setRating -- a quick regression guard, since
// details is dispatched from a different branch of doGet than list/spin.
// ---------------------------------------------------------------------------

test('QA: doGet action=details with a bad token returns unauthorized without touching TMDB/Gemini', () => {
  const values = [HEADER_V2, [false, 'Anything', 2020, '', '', '', true, true, true, true, true, true, true, true]];
  const { context, fetchMock } = setUpV2(values);
  const res = context.doGet({ parameter: { token: 'wrong-token', action: 'details', id: '2' } });
  assert.deepEqual(res.json(), { error: 'unauthorized' });
  assert.equal(fetchMock.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Streaming/quotes: the Gemini request itself must carry the key on the
// `x-goog-api-key` header per SPEC.md ("not a query param") -- a request
// that leaked the key into the URL instead would still pass every test
// above (they only assert on the *response*), so this checks the actual
// outgoing request shape directly.
// ---------------------------------------------------------------------------

test('QA: the Gemini generateContent request carries the key on the x-goog-api-key header, never in the URL or an Authorization header', () => {
  const values = [HEADER_V2, [false, 'Header Check', 2020, '', '', '', true, true, true, true, true, true, true, true]];
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: {} };
    if (url.includes('generativelanguage.googleapis.com')) {
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[]' }] } }] };
    }
    return { results: [] };
  };
  const { context, fetchMock } = setUpV2(values, responder);
  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } });

  const geminiCall = fetchMock.calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
  assert.ok(geminiCall, 'expected a call to the Gemini generateContent endpoint');
  assert.equal(geminiCall.url.includes('key='), false, 'the API key must not be sent as a URL query param');
  assert.match(geminiCall.url, /:generateContent$/);
  assert.equal(geminiCall.options.headers['x-goog-api-key'], GEMINI_API_KEY);
  assert.equal(geminiCall.options.headers.Authorization, undefined, 'must not use an Authorization/Bearer header -- Gemini expects x-goog-api-key');
});

// ---------------------------------------------------------------------------
// Streaming/quotes: Gemini has two distinct block shapes -- a per-candidate
// finishReason (already covered above) and a *prompt-level* block, where
// the prompt itself is rejected before any candidate is generated at all
// (`promptFeedback.blockReason` present, no `candidates` key in the response
// whatsoever). isGeminiBlocked's "no candidates array" branch already
// happens to cover this, but it's a distinct real-world Gemini response
// shape worth locking in explicitly rather than relying on the coincidence.
// ---------------------------------------------------------------------------

test('QA: a Gemini prompt-level block (promptFeedback.blockReason, no candidates key at all) is treated as blocked and not cached', () => {
  const values = [HEADER_V2, [false, 'Prompt Blocked', 2020, '', '', '', true, true, true, true, true, true, true, true]];
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: {} };
    if (url.includes('generativelanguage.googleapis.com')) {
      // Real Gemini shape for a prompt rejected before generation started --
      // no `candidates` key at all, just promptFeedback.
      return { promptFeedback: { blockReason: 'SAFETY' } };
    }
    return { results: [] };
  };
  const { context, cacheServiceMock } = setUpV2(values, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } });
  assert.deepEqual(res.json().quotes, []);
  const quotesPutCalls = cacheServiceMock.calls.filter((c) => c.op === 'put' && c.key.startsWith('quotes:'));
  assert.equal(quotesPutCalls.length, 0, 'a prompt-level block must not be cached either, same as a candidate-level block');
});

// ---------------------------------------------------------------------------
// Rating header alias (bug 1 fix): must be an exact case-insensitive/trimmed
// match on "rating" or "ratings" specifically -- not a loose substring match
// that would also catch an unrelated column that merely contains "rating"
// somewhere in its name (e.g. a hypothetical future "Co-rating" or "Average
// Rating (IMDb)" column). Confirmed via code read that the fix is a switch
// with two literal `case` labels, not `.includes('rating')` -- this test
// locks that in so a future refactor can't accidentally loosen it.
// ---------------------------------------------------------------------------

test('QA: the "rating"/"ratings" header alias is an exact match, not a substring match -- an unrelated column merely containing "rating" is ignored', () => {
  const { loadGasContext: load } = require('./helpers');
  const ctx = load(['Logic.js']);

  // Columns that contain "rating"/"ratings" as a substring but are not
  // themselves the rating column -- none of these should resolve.
  const header = ['Movie', 'Co-rating', 'Average Rating (IMDb)', 'Star Ratings Note', 'Ratings Explained'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.rating, -1, 'no column merely containing "rating"/"ratings" as a substring should resolve as the Rating column');
});

test('QA: "rating"/"ratings" alias still resolves correctly when a decoy substring column sits right next to the real one', () => {
  const { loadGasContext: load } = require('./helpers');
  const ctx = load(['Logic.js']);
  const header = ['Movie', 'Co-rating', 'Ratings', 'Average Rating (IMDb)'];
  const idx = ctx.resolveHeaderIndexes(header);
  assert.equal(idx.rating, 2, 'the real "Ratings" column must still resolve correctly even with substring-decoy columns on both sides');
});

// ---------------------------------------------------------------------------
// TMDB year-matching (bug 2 fix): when the year-matched result itself has no
// poster_path (a real TMDB possibility -- some entries are metadata-only),
// selectTmdbResultByYear must NOT fall through to a different, wrong-year
// result just because that one happens to have art. Correctness (the right
// movie) takes priority over "some poster, even if it's the wrong movie's" --
// the same principle the whole fix exists for.
// ---------------------------------------------------------------------------

test('QA: a year-matched TMDB result with no poster_path resolves to posterUrl: null, not a different (wrong-year) result\'s poster', () => {
  const values = [HEADER_V2, [false, 'Cinderella', 1950, '', '', '', true, true, true, true, true, true, true, true]];
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: {} };
    if (url.includes('generativelanguage.googleapis.com')) {
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '[]' }] } }] };
    }
    return {
      results: [
        { id: 11224, poster_path: '/2015-poster.jpg', release_date: '2015-03-13' }, // wrong year, HAS art
        { id: 12345, poster_path: null, release_date: '1950-02-15' } // right year, NO art
      ]
    };
  };
  const { context, sheet } = setUpV2(values, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const movie = res.json().movies[0];
  assert.equal(movie.posterUrl, null, 'must not silently substitute the wrong-year 2015 poster just because the correct 1950 entry lacks art');

  const posterColIdx = HEADER_V2.indexOf('Poster URL');
  assert.equal(sheet._snapshot()[1][posterColIdx], 'none', 'the "no match" sentinel should be cached, not the wrong-year URL');
});
