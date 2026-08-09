// API layer matching SPEC.md's "API contract (Apps Script Web App)" exactly:
// listMovies() / spin() / setWatched(id, watched) / setRating(id, rating) /
// getDetails(id).
//
// Everything that knows about *how* the data is fetched lives behind this
// one module. The base v1 backend (list/spin/setWatched) already passed QA
// (see SPEC.md), so the real fetch() path is what production builds use by
// default. The v2 endpoints below (setRating/details, and the `absent`
// param on list/spin) are being built in parallel by backend-dev — until
// that passes QA too, local UI work happens against the mock (in-memory,
// no network): set VITE_USE_MOCK=true in a .env.local (see .env.example).
import { computeMovieFields } from './lib/eligibility';
import { MOCK_MOVIES, MOCK_DETAILS } from './data/mockMovies';
import { buildAbsentParam, applyAttendanceFilter } from './lib/attendance';
import { isValidRating } from './lib/rating';

// Defaults to the real API. Set VITE_USE_MOCK=true (.env.local) to opt into
// the in-memory mock for local UI work with no backend available.
const USE_MOCK = (import.meta.env.VITE_USE_MOCK ?? 'false') === 'true';

const API_URL = import.meta.env.VITE_API_URL || '';
const API_TOKEN = import.meta.env.VITE_API_TOKEN || '';

export class ApiError extends Error {
  constructor(code) {
    super(`API error: ${code}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Mock backend — in-memory, mutated in place, matches the real contract's
// response shapes so swapping USE_MOCK off is a no-op for callers.
// ---------------------------------------------------------------------------
let mockStore = MOCK_MOVIES.map((m) => ({ ...m, seenBy: { ...m.seenBy } }));

function mockDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockListWithFields() {
  return computeMovieFields(mockStore);
}

/** Shared by mockListMovies/mockSpin: base eligibility + the attendance
 * adjustment (SPEC.md's "Attendance" section, including its empty-pool
 * fallback), given the already-resolved `absent=Name,Name` string. */
function mockAttendanceAdjusted(absentParam) {
  const base = mockListWithFields();
  const absentees = absentParam ? absentParam.split(',') : [];
  return applyAttendanceFilter(base, absentees);
}

async function mockListMovies(absentParam) {
  await mockDelay(220);
  return mockAttendanceAdjusted(absentParam);
}

async function mockSpin(absentParam) {
  await mockDelay(120);
  const { movies, attendanceApplied } = mockAttendanceAdjusted(absentParam);
  const eligible = movies.filter((m) => m.eligible);
  if (eligible.length === 0) return { movie: null, attendanceApplied };
  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  return { movie: picked, attendanceApplied };
}

async function mockSetWatched(id, watched) {
  await mockDelay(150);
  const row = mockStore.find((m) => m.id === id);
  if (!row) return { error: 'not_found' };
  row.watched = watched;
  const updated = mockListWithFields().find((m) => m.id === id);
  return { movie: updated };
}

async function mockSetRating(id, rating) {
  await mockDelay(150);
  if (!isValidRating(rating)) return { error: 'bad_request' };
  const row = mockStore.find((m) => m.id === id);
  if (!row) return { error: 'not_found' };
  row.rating = rating;
  const updated = mockListWithFields().find((m) => m.id === id);
  return { movie: updated };
}

async function mockGetDetails(id) {
  await mockDelay(700); // deliberately slow-ish, like a real TMDB/LLM round-trip
  const row = mockStore.find((m) => m.id === id);
  if (!row) return { error: 'not_found' };
  const details = MOCK_DETAILS[id];
  return { streamingPlatforms: details?.streamingPlatforms ?? [], quotes: details?.quotes ?? [] };
}

// ---------------------------------------------------------------------------
// Real backend — Apps Script Web App. See SPEC.md's "CORS gotcha" section:
// the POST call must be sent with NO explicit Content-Type header (a plain
// string body defaults to text/plain, which skips CORS preflight — Apps
// Script Web Apps don't handle preflight OPTIONS requests correctly).
// ---------------------------------------------------------------------------
function buildGetUrl(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set('token', API_TOKEN);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function realGet(action, params) {
  const res = await fetch(buildGetUrl(action, params));
  return res.json();
}

async function realPost(payload) {
  // No headers object here on purpose — see the CORS note above.
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ token: API_TOKEN, ...payload }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API — same shapes regardless of mock vs real.
// ---------------------------------------------------------------------------

/**
 * GET ?action=list[&absent=Name,Name] → { movies, attendanceApplied? }.
 * Each movie is annotated with eligible/waitingOn (attendance-adjusted when
 * `absentees` is non-empty) and, per SPEC.md, always carries a `seenBy` map.
 * `absentees` is a plain array of member names (any case/whitespace) — see
 * lib/attendance.js for how that's resolved/serialized into the wire
 * format's `absent=Name,Name` param. Omitting it (or passing []) means
 * "everyone's here," identical to today's behavior — `attendanceApplied` is
 * then `undefined`, matching the contract's "absent from the response when
 * absent wasn't sent at all."
 */
export async function listMovies(absentees = []) {
  const absent = buildAbsentParam(absentees);
  if (USE_MOCK) return mockListMovies(absent);
  const data = await realGet('list', { absent });
  if (data.error) throw new ApiError(data.error);
  return { movies: data.movies, attendanceApplied: data.attendanceApplied };
}

/** GET ?action=spin[&absent=Name,Name] → { movie, attendanceApplied? } or
 * { movie: null } when nothing is eligible. Does not mutate. See listMovies
 * above for the `absentees` param shape. */
export async function spin(absentees = []) {
  const absent = buildAbsentParam(absentees);
  if (USE_MOCK) return mockSpin(absent);
  const data = await realGet('spin', { absent });
  if (data.error) throw new ApiError(data.error);
  return data;
}

/** POST action=setWatched → { movie } (updated row) or throws ApiError('not_found'). */
export async function setWatched(id, watched) {
  if (USE_MOCK) {
    const data = await mockSetWatched(id, watched);
    if (data.error) throw new ApiError(data.error);
    return data;
  }
  const data = await realPost({ action: 'setWatched', id, watched });
  if (data.error) throw new ApiError(data.error);
  return data;
}

/** POST action=setRating → { movie } (updated row) or throws ApiError
 * ('not_found' | 'bad_request'). `rating` is null (clear) or a half-step
 * number in [0.5, 5] — see SPEC.md's "Ratings" section. Mirrors setWatched's
 * shape/error-handling exactly, including the no-headers CORS-safe POST. */
export async function setRating(id, rating) {
  if (USE_MOCK) {
    const data = await mockSetRating(id, rating);
    if (data.error) throw new ApiError(data.error);
    return data;
  }
  const data = await realPost({ action: 'setRating', id, rating });
  if (data.error) throw new ApiError(data.error);
  return data;
}

/** GET ?action=details&id=<id> → { streamingPlatforms, quotes } or throws
 * ApiError('not_found'). Lazy/secondary call, made right after a reveal —
 * never bundled into list/spin. Either array may legitimately be empty. */
export async function getDetails(id) {
  if (USE_MOCK) {
    const data = await mockGetDetails(id);
    if (data.error) throw new ApiError(data.error);
    return data;
  }
  const data = await realGet('details', { id });
  if (data.error) throw new ApiError(data.error);
  return data;
}
