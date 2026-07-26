'use strict';

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

function setUp(sheetValues, sheetOptions) {
  const sheet = createMockSheet(sheetValues || buildSheetValues(), sheetOptions);
  const fetchMock = createMockUrlFetchApp(tmdbResponder);
  const spreadsheetAppMock = createMockSpreadsheetApp(sheet);
  const context = loadGasContext(['Logic.js', 'Code.js'], {
    SpreadsheetApp: spreadsheetAppMock,
    PropertiesService: createMockPropertiesService({
      SPREADSHEET_ID,
      SHARED_TOKEN,
      TMDB_API_KEY
    }),
    UrlFetchApp: fetchMock,
    ContentService: mockContentService,
    console
  });
  return { sheet, fetchMock, context, spreadsheetAppMock };
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
