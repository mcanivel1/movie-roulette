// API layer matching SPEC.md's "API contract (Apps Script Web App)" exactly:
// listMovies() / spin() / setWatched(id, watched).
//
// Everything that knows about *how* the data is fetched lives behind this
// one module. The backend passed QA (see SPEC.md), so the real fetch() path
// below is what production builds use by default. Mock mode (in-memory,
// no network) is still available as an explicit local-dev opt-in — set
// VITE_USE_MOCK=true in a .env.local (see .env.example) when you want to
// work on UI without a deployed Apps Script Web App URL at hand.
import { computeMovieFields } from './lib/eligibility';
import { MOCK_MOVIES } from './data/mockMovies';

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
let mockStore = MOCK_MOVIES.map((m) => ({ ...m }));

function mockDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockListWithFields() {
  return computeMovieFields(mockStore);
}

async function mockListMovies() {
  await mockDelay(220);
  return mockListWithFields();
}

async function mockSpin() {
  await mockDelay(120);
  const eligible = mockListWithFields().filter((m) => m.eligible);
  if (eligible.length === 0) return { movie: null };
  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  return { movie: picked };
}

async function mockSetWatched(id, watched) {
  await mockDelay(150);
  const row = mockStore.find((m) => m.id === id);
  if (!row) return { error: 'not_found' };
  row.watched = watched;
  const updated = mockListWithFields().find((m) => m.id === id);
  return { movie: updated };
}

// ---------------------------------------------------------------------------
// Real backend — Apps Script Web App. See SPEC.md's "CORS gotcha" section:
// the POST call must be sent with NO explicit Content-Type header (a plain
// string body defaults to text/plain, which skips CORS preflight — Apps
// Script Web Apps don't handle preflight OPTIONS requests correctly).
// ---------------------------------------------------------------------------
function buildGetUrl(action) {
  const url = new URL(API_URL);
  url.searchParams.set('token', API_TOKEN);
  url.searchParams.set('action', action);
  return url.toString();
}

async function realGet(action) {
  const res = await fetch(buildGetUrl(action));
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

/** GET ?action=list → the full movie list, each annotated with eligible/waitingOn. */
export async function listMovies() {
  if (USE_MOCK) return mockListMovies();
  const data = await realGet('list');
  if (data.error) throw new ApiError(data.error);
  return data.movies;
}

/** GET ?action=spin → { movie } or { movie: null } when nothing is eligible. Does not mutate. */
export async function spin() {
  if (USE_MOCK) return mockSpin();
  const data = await realGet('spin');
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
