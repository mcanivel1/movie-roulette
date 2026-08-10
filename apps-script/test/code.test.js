'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadGasContext,
  createMockSheet,
  createMockPropertiesService,
  createMockSpreadsheetApp,
  createMockUrlFetchApp,
  mockHttpResponse,
  createMockCacheService,
  mockContentService
} = require('./helpers');

const SHARED_TOKEN = 'test-token-123';
const SPREADSHEET_ID = 'fake-spreadsheet-id';
const TMDB_API_KEY = 'fake-tmdb-key';
const GEMINI_API_KEY = 'fake-gemini-key';

// Header intentionally shuffled + has an extra column, to exercise real
// order-independent header resolution end to end through doGet/doPost.
const HEADER = ['Watched', 'Movie', 'Year', 'Prequel', 'Notes', 'Poster URL'];

function buildSheetValues() {
  return [
    HEADER,
    [true, 'Prelude', 2010, '', 'n/a', 'https://image.tmdb.org/t/p/w500/prelude.jpg'], // id 2: watched, cached poster
    [false, 'Part I', 2018, '', 'n/a', ''], // id 3: unwatched, no prequel -> eligible, poster missing (fetch)
    [false, 'Part II', 2020, 'Part I', 'n/a', ''], // id 4: waiting on Part I, poster missing (fetch)
    [true, 'Lost Reel', 2005, '', 'n/a', 'none'] // id 5: watched, poster sentinel already cached
  ];
}

function tmdbResponder(url) {
  if (url.includes('Part%20I') && !url.includes('Part%20II')) {
    return { results: [{ poster_path: '/partI.jpg' }] };
  }
  if (url.includes('Part%20II')) {
    return { results: [] }; // no match -> caches "none"
  }
  return { results: [] };
}

function setUp(sheetValues, sheetOptions, responder) {
  const sheet = createMockSheet(sheetValues || buildSheetValues(), sheetOptions);
  const fetchMock = createMockUrlFetchApp(responder || tmdbResponder);
  const spreadsheetAppMock = createMockSpreadsheetApp(sheet);
  const cacheServiceMock = createMockCacheService();
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: spreadsheetAppMock,
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
  return { sheet, fetchMock, context, spreadsheetAppMock, cacheServiceMock };
}

// ---------------------------------------------------------------------------
// doGet — list
// ---------------------------------------------------------------------------

test('doGet list: returns all movies with eligibility, waitingOn, and posterUrl resolved', () => {
  const { context, fetchMock } = setUp();
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const body = res.json();

  assert.equal(body.movies.length, 4);

  const prelude = body.movies.find((m) => m.title === 'Prelude');
  assert.equal(prelude.watched, true);
  assert.equal(prelude.eligible, false);
  assert.equal(prelude.posterUrl, 'https://image.tmdb.org/t/p/w500/prelude.jpg');

  const partI = body.movies.find((m) => m.title === 'Part I');
  assert.equal(partI.eligible, true);
  assert.equal(partI.posterUrl, 'https://image.tmdb.org/t/p/w500/partI.jpg');

  const partII = body.movies.find((m) => m.title === 'Part II');
  assert.equal(partII.eligible, false);
  assert.equal(partII.waitingOn, 'Part I');
  assert.equal(partII.posterUrl, null);

  const lostReel = body.movies.find((m) => m.title === 'Lost Reel');
  assert.equal(lostReel.posterUrl, null);

  // TMDB only hit for the two rows with genuinely blank Poster URL cells.
  assert.equal(fetchMock.calls.length, 2);
});

test('doGet list: resolved posters are cached back into the sheet (Poster URL column, and none sentinel)', () => {
  const { sheet, context } = setUp();
  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });

  const data = sheet._snapshot();
  const posterColIdx = HEADER.indexOf('Poster URL');
  assert.equal(data[2][posterColIdx], 'https://image.tmdb.org/t/p/w500/partI.jpg'); // Part I row
  assert.equal(data[3][posterColIdx], 'none'); // Part II row, no TMDB match
});

test('doGet list: a second call does not re-hit TMDB for rows already resolved', () => {
  const { context, fetchMock } = setUp();
  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  assert.equal(fetchMock.calls.length, 2);

  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  assert.equal(fetchMock.calls.length, 2); // unchanged — everything cached now, including "none"
});

test('doGet list: a title with multiple TMDB entries across years (e.g. "Cinderella") resolves the poster matching the sheet row\'s Year, not TMDB\'s top/most-popular hit', () => {
  // Real product-owner-reported bug: TMDB's most popular "Cinderella" hit is
  // the 2015 live-action version, but a sheet row for the 1950 animated
  // classic (Year=1950) was getting the 2015 poster because the old code
  // always took results[0] regardless of year.
  const values = [
    HEADER,
    [false, 'Cinderella', 1950, '', 'n/a', '']
  ];
  const cinderellaResponder = () => ({
    results: [
      { id: 11224, poster_path: '/2015-poster.jpg', release_date: '2015-03-13' }, // most popular -> results[0]
      { id: 12345, poster_path: '/1950-poster.jpg', release_date: '1950-02-15' }, // the actual sheet row's year
      { id: 67890, poster_path: '/2021-poster.jpg', release_date: '2021-09-03' }
    ]
  });
  const { context, sheet } = setUp(values, undefined, cinderellaResponder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const body = res.json();
  assert.equal(body.movies[0].posterUrl, 'https://image.tmdb.org/t/p/w500/1950-poster.jpg');

  // And that's what gets cached back into the sheet, not the 2015 one.
  const posterColIdx = HEADER.indexOf('Poster URL');
  assert.equal(sheet._snapshot()[1][posterColIdx], 'https://image.tmdb.org/t/p/w500/1950-poster.jpg');
});

test('doGet: unauthorized token returns {error: "unauthorized"} without touching the sheet', () => {
  const { context, fetchMock } = setUp();
  const res = context.doGet({ parameter: { token: 'wrong-token', action: 'list' } });
  assert.deepEqual(res.json(), { error: 'unauthorized' });
  assert.equal(fetchMock.calls.length, 0);
});

test('doGet: missing token returns unauthorized', () => {
  const { context } = setUp();
  const res = context.doGet({ parameter: { action: 'list' } });
  assert.deepEqual(res.json(), { error: 'unauthorized' });
});

test('doGet: unknown action returns bad_request', () => {
  const { context } = setUp();
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'nope' } });
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

// ---------------------------------------------------------------------------
// doGet — spin
// ---------------------------------------------------------------------------

test('doGet spin: returns one eligible movie with posterUrl resolved', () => {
  const { context } = setUp();
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin' } });
  const body = res.json();
  assert.equal(body.movie.title, 'Part I'); // only eligible row in the fixture
  assert.equal(body.movie.eligible, true);
  assert.equal(body.movie.posterUrl, 'https://image.tmdb.org/t/p/w500/partI.jpg');
});

test('doGet spin: empty eligible pool returns {movie: null}, not an error', () => {
  const allWatchedOrWaiting = [
    HEADER,
    [true, 'Prelude', 2010, '', 'n/a', 'none'],
    [true, 'Part I', 2018, '', 'n/a', 'none'],
    [false, 'Part II', 2020, 'Part I', 'n/a', 'none'] // waiting, since Part I is watched here it'd be eligible — force waiting via unwatched prequel below instead
  ];
  // Make Part I unwatched so Part II is genuinely stuck waiting, and mark
  // every row watched/ineligible so the pool is empty.
  allWatchedOrWaiting[2] = [true, 'Part I', 2018, '', 'n/a', 'none'];
  allWatchedOrWaiting[3] = [true, 'Part II', 2020, 'Part I', 'n/a', 'none'];

  const { context } = setUp(allWatchedOrWaiting);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin' } });
  assert.deepEqual(res.json(), { movie: null });
});

// ---------------------------------------------------------------------------
// doPost — setWatched
// ---------------------------------------------------------------------------

test('doPost setWatched: marks a row watched and returns the updated movie', () => {
  const { context, sheet, spreadsheetAppMock } = setUp();
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 3, watched: true }) }
  });
  const body = res.json();
  assert.equal(body.movie.id, 3);
  assert.equal(body.movie.title, 'Part I');
  assert.equal(body.movie.watched, true);

  const watchedColIdx = HEADER.indexOf('Watched');
  assert.equal(sheet._snapshot()[2][watchedColIdx], true);

  // Regression guard: writeWatchedCell_ must force a synchronous flush
  // after writing. Without it, a validation failure on the write can defer
  // and resurface later as an unrelated-looking exception from whatever
  // next touches the sheet, instead of being catchable at the write site.
  assert.ok(spreadsheetAppMock._flushCalls.count >= 1, 'expected SpreadsheetApp.flush() to be called after writing the Watched cell');
});

test('doPost setWatched: falls back to a "Yes"/"No" string when the Watched column is validated as text (not a boolean checkbox)', () => {
  // Reproduces a real deployment: a "Watched" column with Sheets data
  // validation restricting it to the literal strings Yes/No throws when
  // you setValue(true) -- writeWatchedCell_ must catch that and retry with
  // the string form instead of letting the write silently fail.
  const watchedColIdx = HEADER.indexOf('Watched'); // 0-indexed
  const { context, sheet, spreadsheetAppMock } = setUp(buildSheetValues(), { rejectBooleanColumns: [watchedColIdx + 1] });

  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 3, watched: true }) }
  });
  const body = res.json();

  assert.equal(body.error, undefined, 'setWatched should succeed, not fall through to sheet_error');
  assert.equal(body.movie.id, 3);
  assert.equal(body.movie.watched, true, 'the response should still report watched:true (boolean) regardless of how it was stored');
  assert.equal(sheet._snapshot()[2][watchedColIdx], 'Yes', 'the cell itself should hold the Yes/No string this column actually validates');
  assert.equal(spreadsheetAppMock._flushCalls.count, 1, 'flush should happen once, after the successful retry -- not once per attempt');
});

test('doPost setWatched: marking a prequel watched unlocks the sequel on the next read', () => {
  const { context } = setUp();
  context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 3, watched: true }) }
  });
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const partII = res.json().movies.find((m) => m.title === 'Part II');
  assert.equal(partII.eligible, true);
  assert.equal(partII.waitingOn, null);
});

test('doPost setWatched: unknown id returns {error: "not_found"}', () => {
  const { context } = setUp();
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 999, watched: true }) }
  });
  assert.deepEqual(res.json(), { error: 'not_found' });
});

test('doPost: unauthorized token returns error without mutating the sheet', () => {
  const { context, sheet } = setUp();
  const before = sheet._snapshot();
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: 'wrong', action: 'setWatched', id: 3, watched: true }) }
  });
  assert.deepEqual(res.json(), { error: 'unauthorized' });
  assert.deepEqual(sheet._snapshot(), before);
});

test('doPost: malformed JSON body returns bad_request instead of throwing', () => {
  const { context } = setUp();
  const res = context.doPost({ postData: { contents: '{not valid json' } });
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

test('doPost: body is parsed as JSON even when postData.type says text/plain (the CORS-dodge convention)', () => {
  const { context } = setUp();
  // This mirrors exactly what the real frontend sends per SPEC.md: fetch()
  // with a string body and no headers object, which Apps Script reports as
  // text/plain. doPost must not branch on postData.type.
  const res = context.doPost({
    postData: {
      type: 'text/plain',
      contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 3, watched: true })
    }
  });
  const body = res.json();
  assert.equal(body.movie.id, 3);
  assert.equal(body.movie.watched, true);
});

test('doPost: non-boolean watched value is rejected as bad_request', () => {
  const { context } = setUp();
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setWatched', id: 3, watched: 'yes' }) }
  });
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

// ---------------------------------------------------------------------------
// Ratings + Attendance fixtures
// ---------------------------------------------------------------------------

// Header intentionally shuffled + has an extra column, matching the base
// fixture's convention, extended with Rating and the 8 member columns.
const HEADER_V2 = [
  'Watched', 'Movie', 'Year', 'Prequel', 'Notes', 'Poster URL', 'Rating',
  'Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'
];

function buildSheetValuesV2() {
  return [
    HEADER_V2,
    // id 2: watched, rated 4.5, poster cached, everyone has seen it
    [true, 'Prelude', 2010, '', 'n/a', 'https://image.tmdb.org/t/p/w500/prelude.jpg', 4.5, true, true, true, true, true, true, true, true],
    // id 3: unwatched, no prequel -> eligible, unrated, poster missing -- everyone but Austin has seen it
    [false, 'Part I', 2018, '', 'n/a', '', '', false, true, true, true, true, true, true, true],
    // id 4: waiting on Part I (unwatched prequel), unrated, poster missing -- nobody's seen it
    [false, 'Part II', 2020, 'Part I', 'n/a', '', '', false, false, false, false, false, false, false, false],
    // id 5: watched, unrated, poster sentinel already cached
    [true, 'Lost Reel', 2005, '', 'n/a', 'none', '', true, true, true, true, true, true, true, true]
  ];
}

// ---------------------------------------------------------------------------
// doPost — setRating
// ---------------------------------------------------------------------------

test('doPost setRating: sets a valid half-step rating and returns the updated movie', () => {
  const { context, sheet } = setUp(buildSheetValuesV2());
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 3, rating: 3.5 }) }
  });
  const body = res.json();
  assert.equal(body.movie.id, 3);
  assert.equal(body.movie.rating, 3.5);

  const ratingColIdx = HEADER_V2.indexOf('Rating');
  assert.equal(sheet._snapshot()[2][ratingColIdx], 3.5);
});

test('doPost setRating: rating null clears an existing rating', () => {
  const { context, sheet } = setUp(buildSheetValuesV2());
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 2, rating: null }) }
  });
  const body = res.json();
  assert.equal(body.movie.id, 2);
  assert.equal(body.movie.rating, null);

  const ratingColIdx = HEADER_V2.indexOf('Rating');
  assert.equal(sheet._snapshot()[1][ratingColIdx], '');
});

test('doPost setRating: does not require watched === true (a stray rating on an unwatched row is accepted)', () => {
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doPost({
    // id 4 (Part II) is unwatched and not even eligible yet.
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 4, rating: 2 }) }
  });
  const body = res.json();
  assert.equal(body.error, undefined);
  assert.equal(body.movie.rating, 2);
  assert.equal(body.movie.watched, false);
});

test('doPost setRating: rejects out-of-range, off-grid, and non-numeric ratings as bad_request', () => {
  const { context } = setUp(buildSheetValuesV2());
  const invalidValues = [0, -1, 5.5, 3.3, '4.5', undefined];
  invalidValues.forEach((rating) => {
    const body = { token: SHARED_TOKEN, action: 'setRating', id: 3 };
    if (rating !== undefined) body.rating = rating;
    const res = context.doPost({ postData: { contents: JSON.stringify(body) } });
    assert.deepEqual(res.json(), { error: 'bad_request' }, `expected bad_request for rating ${JSON.stringify(rating)}`);
  });
});

test('doPost setRating: unknown id returns not_found', () => {
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 999, rating: 3 }) }
  });
  assert.deepEqual(res.json(), { error: 'not_found' });
});

test('doPost setRating: non-number id is rejected as bad_request', () => {
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: '3', rating: 3 }) }
  });
  assert.deepEqual(res.json(), { error: 'bad_request' });
});

test('doPost setRating: missing Rating column returns sheet_error', () => {
  const values = [
    ['Movie', 'Watched'],
    ['Part I', false]
  ];
  const { context } = setUp(values);
  const res = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 2, rating: 3 }) }
  });
  assert.deepEqual(res.json(), { error: 'sheet_error' });
});

test('doPost setRating: a real deployment using the plural "Ratings" header round-trips a write and a subsequent list read', () => {
  // Regression test for a real product-owner-reported bug: their sheet's
  // header cell was "Ratings" (plural), which a singular-only header match
  // silently failed to resolve -- ratings read back null forever and
  // (before this fix landed) presumably never wrote either.
  const values = [
    ['Movie', 'Watched', 'Ratings', 'Poster URL'],
    ['Part I', false, '', 'none']
  ];
  const { context, sheet } = setUp(values);

  const written = context.doPost({
    postData: { contents: JSON.stringify({ token: SHARED_TOKEN, action: 'setRating', id: 2, rating: 4 }) }
  }).json();
  assert.equal(written.error, undefined, 'setRating must succeed against a "Ratings" header, not fall through to sheet_error');
  assert.equal(written.movie.rating, 4);
  assert.equal(sheet._snapshot()[1][2], 4); // written into the "Ratings" column, not lost

  const list = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } }).json();
  assert.equal(list.movies[0].rating, 4, 'a rating stored under "Ratings" must also be readable back via list');
});

// ---------------------------------------------------------------------------
// Attendance — GET action=list[&absent=...]
// ---------------------------------------------------------------------------

test('doGet list: every movie gets a full seenBy map, absent omitted entirely', () => {
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } });
  const body = res.json();
  assert.equal('attendanceApplied' in body, false);
  const partI = body.movies.find((m) => m.title === 'Part I');
  assert.deepEqual(partI.seenBy, {
    Austin: false, Eugie: true, Josh: true, Jouissance: true, Lynda: true, Marvin: true, Mel: true, Michelle: true
  });
});

test('doGet list: absent param applies normally when the absent member has seen the only eligible movie', () => {
  // Part I is the only base-eligible movie in this fixture; Eugie has
  // already seen it, so the attendance filter keeps it and actually
  // "applies" (as opposed to the empty-pool fallback covered separately).
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list', absent: 'Eugie' } });
  const body = res.json();
  assert.equal(body.attendanceApplied, true);
  const partI = body.movies.find((m) => m.title === 'Part I');
  assert.equal(partI.eligible, true); // Eugie has seen Part I -> stays eligible
});

test('doGet list: absent param empties the eligible pool -> fallback, attendanceApplied: false', () => {
  const { context } = setUp(buildSheetValuesV2());
  // Part I is the only eligible movie, and Austin hasn't seen it -- the
  // attendance filter would leave zero eligible, so it's dropped.
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list', absent: 'Austin' } });
  const body = res.json();
  assert.equal(body.attendanceApplied, false);
  const partI = body.movies.find((m) => m.title === 'Part I');
  assert.equal(partI.eligible, true); // fallback restores base eligibility
});

test('doGet list: absent omitted or blank behaves identically to everyone present', () => {
  const { context } = setUp(buildSheetValuesV2());
  const omitted = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list' } }).json();
  const blank = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list', absent: '' } }).json();
  assert.equal('attendanceApplied' in omitted, false);
  assert.equal('attendanceApplied' in blank, false);
});

test('doGet list: absent naming only unrecognized members behaves like nobody absent (no attendanceApplied key)', () => {
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'list', absent: 'Bob,Xyz' } });
  const body = res.json();
  assert.equal('attendanceApplied' in body, false);
});

// ---------------------------------------------------------------------------
// Attendance — GET action=spin[&absent=...]
// ---------------------------------------------------------------------------

test('doGet spin: absent param narrows the pool to only the movie the absent member has seen', () => {
  // Two base-eligible movies; Austin hasn't seen Alpha but has seen Beta.
  // Since Beta alone keeps the attendance-filtered pool non-empty, the
  // filter genuinely applies (no fallback) and spin can only land on Beta.
  const values = [
    HEADER_V2,
    [false, 'Alpha', 2001, '', 'n/a', 'none', '', false, true, true, true, true, true, true, true],
    [false, 'Beta', 2002, '', 'n/a', 'none', '', true, true, true, true, true, true, true, true]
  ];
  const { context } = setUp(values);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin', absent: 'Austin' } });
  const body = res.json();
  assert.equal(body.attendanceApplied, true);
  assert.equal(body.movie.title, 'Beta'); // the only one Austin has seen
});

test('doGet spin: seenBy is not included on the spin response', () => {
  const { context } = setUp(buildSheetValuesV2());
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'spin' } });
  const body = res.json();
  assert.equal('seenBy' in body.movie, false);
});

// ---------------------------------------------------------------------------
// GET action=details
// ---------------------------------------------------------------------------

function detailsResponder(url) {
  if (url.includes('/watch/providers')) {
    return { results: { US: { flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'Hulu' }] } } };
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    return {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: JSON.stringify(['"May the Force be with you." — Obi-Wan Kenobi']) }] }
      }]
    };
  }
  // TMDB title search -> resolves a TMDB movie id for the providers lookup
  return { results: [{ id: 603, poster_path: '/partI.jpg' }] };
}

test('doGet details: returns streamingPlatforms and quotes for a valid id', () => {
  const { context, fetchMock } = setUp(buildSheetValuesV2(), undefined, detailsResponder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  const body = res.json();
  assert.deepEqual(body.streamingPlatforms, ['Netflix', 'Hulu']);
  assert.deepEqual(body.quotes, ['"May the Force be with you." — Obi-Wan Kenobi']);
  // search (to resolve TMDB id) + providers + gemini generateContent = 3 calls
  assert.equal(fetchMock.calls.length, 3);
  assert.equal('_quotesDebug' in body, false, 'the temporary debug field must stay scoped to the empty-quotes case -- omitted entirely on a real result');
});

test('doGet details: the Gemini request targets a current, non-retired model string', () => {
  // Regression guard for a real production incident: the original model
  // (gemini-2.0-flash-lite) was retired by Google on 2026-06-01, which
  // silently degraded every quote-generation call to the same "no quotes
  // found" empty-array fail-safe a genuinely transient failure produces --
  // so quotes never populated in production and nothing caught it until a
  // user report. Asserting the exact model string in the outgoing request
  // means a future silent revert to a retired model fails CI instead of
  // shipping unnoticed.
  const { context, fetchMock } = setUp(buildSheetValuesV2(), undefined, detailsResponder);
  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });

  const geminiCall = fetchMock.calls.find((c) => c.url.includes('generativelanguage.googleapis.com'));
  assert.ok(geminiCall, 'expected a call to the Gemini generateContent endpoint');
  assert.match(geminiCall.url, /\/models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(geminiCall.url.includes('gemini-2.0-flash-lite'), false, 'must not have silently reverted to the retired model');
});

test('doGet details: unknown id returns not_found without calling TMDB or Gemini', () => {
  const { context, fetchMock } = setUp(buildSheetValuesV2(), undefined, detailsResponder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '999' } });
  assert.deepEqual(res.json(), { error: 'not_found' });
  assert.equal(fetchMock.calls.length, 0);
});

test('doGet details: missing/non-numeric id returns not_found', () => {
  const { context } = setUp(buildSheetValuesV2(), undefined, detailsResponder);
  const missing = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details' } });
  assert.deepEqual(missing.json(), { error: 'not_found' });
  const nonNumeric = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: 'abc' } });
  assert.deepEqual(nonNumeric.json(), { error: 'not_found' });
});

test('doGet details: a second call for the same movie is served from cache, no repeat TMDB/Gemini calls', () => {
  const { context, fetchMock } = setUp(buildSheetValuesV2(), undefined, detailsResponder);
  context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  assert.equal(fetchMock.calls.length, 3);

  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  assert.deepEqual(res.json().streamingPlatforms, ['Netflix', 'Hulu']);
  assert.deepEqual(res.json().quotes, ['"May the Force be with you." — Obi-Wan Kenobi']);
  assert.equal(fetchMock.calls.length, 3); // unchanged -- both cached
});

test('doGet details: empty streamingPlatforms/quotes are valid, not an error', () => {
  const emptyResponder = (url) => {
    if (url.includes('/watch/providers')) return { results: {} };
    if (url.includes('generativelanguage.googleapis.com')) {
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([]) }] } }] };
    }
    return { results: [] }; // TMDB search finds nothing -> no id to look providers up with
  };
  const { context } = setUp(buildSheetValuesV2(), undefined, emptyResponder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  const body = res.json();
  assert.deepEqual(body.streamingPlatforms, []);
  assert.deepEqual(body.quotes, []);
  assert.equal(body.error, undefined);
});

test('doGet details: TMDB/Gemini failure for this movie degrades to empty arrays instead of failing the whole request', () => {
  // Every fetch (TMDB search, TMDB providers, Gemini generateContent) returns
  // non-JSON, mirroring the "upstream is down" scenario poster resolution
  // already isolates per-row -- the whole details response must still
  // succeed with empty arrays rather than surfacing as sheet_error.
  const sheet = createMockSheet(buildSheetValuesV2());
  const fetchMock = {
    calls: [],
    fetch(url, options) {
      this.calls.push({ url, options });
      return { getResponseCode: () => 200, getContentText: () => 'Not JSON -- upstream is down' };
    }
  };
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: createMockSpreadsheetApp(sheet),
    PropertiesService: createMockPropertiesService({ SPREADSHEET_ID, SHARED_TOKEN, TMDB_API_KEY, GEMINI_API_KEY }),
    UrlFetchApp: fetchMock,
    CacheService: createMockCacheService(),
    ContentService: mockContentService,
    console
  });
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  const body = res.json();
  assert.equal(body.error, undefined);
  assert.deepEqual(body.streamingPlatforms, []);
  assert.deepEqual(body.quotes, []);
  // TEMPORARY debug field (see resolveQuotes_/detailsAction_) -- remove this
  // assertion along with the field once the live "quotes always empty"
  // investigation is closed.
  assert.equal(body._quotesDebug.type, 'exception');
  assert.equal(typeof body._quotesDebug.message, 'string');
  assert.notEqual(body._quotesDebug.message, '');
});

test('doGet details: a title with multiple TMDB entries across years resolves streaming platforms for the year-matched movie id, not TMDB\'s top hit', () => {
  // Same underlying bug as the poster case (SPEC.md's Posters section
  // explicitly calls this out) -- extractTmdbMovieId must also prefer the
  // sheet row's Year over TMDB's top/most-popular search hit.
  const values = [HEADER_V2, [false, 'Cinderella', 1950, '', 'n/a', '', '', true, true, true, true, true, true, true, true]];
  const responder = (url) => {
    if (url.includes('/watch/providers')) {
      // Only the 1950-matched id (12345) has providers configured here --
      // if the code used results[0] (11224, the 2015 version) instead, this
      // branch wouldn't match and streamingPlatforms would come back empty.
      if (url.includes('/movie/12345/')) return { results: { US: { flatrate: [{ provider_name: 'Disney+' }] } } };
      return { results: {} };
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([]) }] } }] };
    }
    // TMDB title search -> multiple entries across years, same shape as the
    // list/poster test above.
    return {
      results: [
        { id: 11224, poster_path: '/2015-poster.jpg', release_date: '2015-03-13' },
        { id: 12345, poster_path: '/1950-poster.jpg', release_date: '1950-02-15' },
        { id: 67890, poster_path: '/2021-poster.jpg', release_date: '2021-09-03' }
      ]
    };
  };
  const { context } = setUp(values, undefined, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '2' } });
  const body = res.json();
  assert.deepEqual(body.streamingPlatforms, ['Disney+']);
});

test('doGet details: ad-tier variants of the same service collapse into one pill, end to end', () => {
  const responder = (url) => {
    if (url.includes('/watch/providers')) {
      return {
        results: {
          US: {
            flatrate: [
              { provider_name: 'Netflix' },
              { provider_name: 'Netflix Standard with Ads' },
              { provider_name: 'Hulu' }
            ]
          }
        }
      };
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([]) }] } }] };
    }
    return { results: [{ id: 603, poster_path: '/p.jpg' }] };
  };
  const { context } = setUp(buildSheetValuesV2(), undefined, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  assert.deepEqual(res.json().streamingPlatforms, ['Netflix', 'Hulu']);
});

test('doGet details: a non-200 Gemini response (e.g. invalid API key) degrades to empty quotes and is not cached', () => {
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: { US: { flatrate: [{ provider_name: 'Netflix' }] } } };
    if (url.includes('generativelanguage.googleapis.com')) {
      return mockHttpResponse(403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } });
    }
    return { results: [{ id: 603, poster_path: '/partI.jpg' }] };
  };
  const { context, cacheServiceMock } = setUp(buildSheetValuesV2(), undefined, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  const body = res.json();
  assert.equal(body.error, undefined);
  assert.deepEqual(body.quotes, []);
  assert.deepEqual(body.streamingPlatforms, ['Netflix']);
  const quotesPutCalls = cacheServiceMock.calls.filter((c) => c.op === 'put' && c.key.startsWith('quotes:'));
  assert.equal(quotesPutCalls.length, 0, 'a non-200 Gemini response must not be cached');
  // TEMPORARY debug field (see resolveQuotes_/detailsAction_).
  assert.deepEqual(body._quotesDebug, {
    type: 'http_error',
    status: 403,
    body: JSON.stringify({ error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } })
  });
});

test('doGet details: a Gemini safety block (finishReason !== STOP) degrades to empty quotes and is not cached', () => {
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: { US: { flatrate: [{ provider_name: 'Netflix' }] } } };
    if (url.includes('generativelanguage.googleapis.com')) return { candidates: [{ finishReason: 'SAFETY' }] };
    return { results: [{ id: 603, poster_path: '/partI.jpg' }] };
  };
  const { context, cacheServiceMock } = setUp(buildSheetValuesV2(), undefined, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  const body = res.json();
  assert.equal(body.error, undefined);
  assert.deepEqual(body.quotes, []);
  const quotesPutCalls = cacheServiceMock.calls.filter((c) => c.op === 'put' && c.key.startsWith('quotes:'));
  assert.equal(quotesPutCalls.length, 0, 'a safety block must not be cached');
  // TEMPORARY debug field (see resolveQuotes_/detailsAction_).
  assert.deepEqual(body._quotesDebug, { type: 'blocked', reason: 'SAFETY' });
});

test('doGet details: quotes cache-only-on-success -- a genuinely empty Gemini result (finishReason STOP, empty array) IS cached', () => {
  const responder = (url) => {
    if (url.includes('/watch/providers')) return { results: {} };
    if (url.includes('generativelanguage.googleapis.com')) {
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify([]) }] } }] };
    }
    return { results: [{ id: 603, poster_path: '/partI.jpg' }] };
  };
  const { context, cacheServiceMock, fetchMock } = setUp(buildSheetValuesV2(), undefined, responder);
  const res = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } });
  const body = res.json();
  assert.deepEqual(body.quotes, []);
  const quotesPutCalls = cacheServiceMock.calls.filter((c) => c.op === 'put' && c.key.startsWith('quotes:'));
  assert.equal(quotesPutCalls.length, 1, 'a genuine (if empty) successful generation should be cached');
  assert.equal(quotesPutCalls[0].value, '[]');
  // TEMPORARY debug field (see resolveQuotes_/detailsAction_): a real,
  // successful-but-empty generation is distinguishable from the three
  // failure cases above -- this is what tells the live investigation
  // "Gemini worked fine, there just weren't any quotes" vs. "something's
  // actually broken."
  assert.deepEqual(body._quotesDebug, { type: 'empty_success' });

  // Second call for the same movie: served from cache, no repeat Gemini
  // call -- but the debug field should say so explicitly (`cached_empty`),
  // not silently repeat `empty_success` as if a fresh generation happened.
  const callsBeforeSecond = fetchMock.calls.length;
  const second = context.doGet({ parameter: { token: SHARED_TOKEN, action: 'details', id: '3' } }).json();
  assert.deepEqual(second.quotes, []);
  assert.deepEqual(second._quotesDebug, { type: 'cached_empty' });
  assert.equal(fetchMock.calls.length, callsBeforeSecond, 'the second call must be served from cache, not re-hit Gemini');
});
