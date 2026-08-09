// Substitute for genuine integration testing: there's no live deployed Apps
// Script Web App URL to hit yet (deploying it is a manual step the human
// running this project has to do herself). Instead, these tests mock global
// fetch and assert the real-fetch code path in api.js builds requests that
// match SPEC.md's "API contract" and "CORS gotcha" sections exactly:
//
//   - GET requests carry `token` and `action` as query params.
//   - POST (setWatched) is called with NO explicit headers/init object
//     beyond method+body — an unset Content-Type on a string body defaults
//     to text/plain, which is what lets it skip the CORS preflight that
//     Apps Script Web Apps can't handle.
//   - POST body is exactly {token, action: "setWatched", id, watched}.
//   - Any `{ error: "<code>" }` response shape is treated as a failure
//     (thrown ApiError), never returned as if it were a success.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE_URL = 'https://script.google.com/macros/s/FAKE_DEPLOYMENT_ID/exec';
const FAKE_TOKEN = 'test-shared-token';

/** Fresh import of api.js with USE_MOCK forced off and fetch mocked. */
async function loadRealApi() {
  vi.resetModules();
  vi.stubEnv('VITE_USE_MOCK', 'false');
  vi.stubEnv('VITE_API_URL', FAKE_URL);
  vi.stubEnv('VITE_API_TOKEN', FAKE_TOKEN);
  return import('./api.js');
}

describe('src/api.js — real backend wiring (fetch mocked, per SPEC.md)', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('listMovies() sends a GET with token + action=list as query params, no init object', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movies: [{ id: 2, title: 'Harbor Lights' }] }),
    });

    const { listMovies } = await loadRealApi();
    const result = await listMovies();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    const url = new URL(calledUrl);

    expect(url.origin + url.pathname).toBe(FAKE_URL);
    expect(url.searchParams.get('token')).toBe(FAKE_TOKEN);
    expect(url.searchParams.get('action')).toBe('list');
    expect(url.searchParams.has('absent')).toBe(false);
    expect(calledInit).toBeUndefined();
    expect(result).toEqual({ movies: [{ id: 2, title: 'Harbor Lights' }], attendanceApplied: undefined });
  });

  it('listMovies(absentees) appends &absent=Name,Name and surfaces attendanceApplied', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movies: [{ id: 2, title: 'Harbor Lights' }], attendanceApplied: true }),
    });

    const { listMovies } = await loadRealApi();
    const result = await listMovies(['Austin', ' josh ']);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('absent')).toBe('Austin,Josh');
    expect(result).toEqual({ movies: [{ id: 2, title: 'Harbor Lights' }], attendanceApplied: true });
  });

  it('spin() sends a GET with action=spin and returns { movie } untouched', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movie: { id: 4, title: 'Neon Meridian' } }),
    });

    const { spin } = await loadRealApi();
    const result = await spin();

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('action')).toBe('spin');
    expect(result).toEqual({ movie: { id: 4, title: 'Neon Meridian' } });
  });

  it('spin() passes through { movie: null } for an empty eligible pool without throwing', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ movie: null }) });

    const { spin } = await loadRealApi();
    await expect(spin()).resolves.toEqual({ movie: null });
  });

  it('spin(absentees) appends &absent=Name,Name', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movie: { id: 4, title: 'Neon Meridian' }, attendanceApplied: false }),
    });

    const { spin } = await loadRealApi();
    const result = await spin(['Mel']);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('absent')).toBe('Mel');
    expect(result).toEqual({ movie: { id: 4, title: 'Neon Meridian' }, attendanceApplied: false });
  });

  it('getDetails() sends a GET with action=details and id, no init object', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ streamingPlatforms: ['Netflix'], quotes: ['A quote.'] }),
    });

    const { getDetails } = await loadRealApi();
    const result = await getDetails(5);

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('action')).toBe('details');
    expect(url.searchParams.get('id')).toBe('5');
    expect(calledInit).toBeUndefined();
    expect(result).toEqual({ streamingPlatforms: ['Netflix'], quotes: ['A quote.'] });
  });

  it('getDetails() surfaces { error: "not_found" } as a thrown ApiError', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ error: 'not_found' }) });

    const { getDetails, ApiError } = await loadRealApi();
    await expect(getDetails(999)).rejects.toBeInstanceOf(ApiError);
  });

  it('setRating() POSTs with no headers object and the exact SPEC.md body shape', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movie: { id: 5, rating: 4.5 } }),
    });

    const { setRating } = await loadRealApi();
    await setRating(5, 4.5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];

    expect(calledUrl).toBe(FAKE_URL);
    expect(calledInit.method).toBe('POST');
    // Same CORS-safe convention as setWatched — no headers key at all.
    expect(calledInit).not.toHaveProperty('headers');
    expect(typeof calledInit.body).toBe('string');
    expect(JSON.parse(calledInit.body)).toEqual({
      token: FAKE_TOKEN,
      action: 'setRating',
      id: 5,
      rating: 4.5,
    });
  });

  it('setRating() also works for clearing a rating (rating: null)', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ movie: { id: 5, rating: null } }) });

    const { setRating } = await loadRealApi();
    await setRating(5, null);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.rating).toBeNull();
  });

  it('setRating() surfaces { error: "bad_request" } as a thrown ApiError', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ error: 'bad_request' }) });

    const { setRating, ApiError } = await loadRealApi();
    await expect(setRating(5, 3.25)).rejects.toBeInstanceOf(ApiError);
    await expect(setRating(5, 3.25)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('setWatched() POSTs with no headers object and the exact SPEC.md body shape', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movie: { id: 5, watched: true } }),
    });

    const { setWatched } = await loadRealApi();
    await setWatched(5, true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];

    expect(calledUrl).toBe(FAKE_URL);
    expect(calledInit.method).toBe('POST');
    // The whole point: no headers key at all, so a string body defaults to
    // text/plain and the browser treats it as a CORS "simple request".
    expect(calledInit).not.toHaveProperty('headers');
    expect(typeof calledInit.body).toBe('string');
    expect(JSON.parse(calledInit.body)).toEqual({
      token: FAKE_TOKEN,
      action: 'setWatched',
      id: 5,
      watched: true,
    });
  });

  it('setWatched() also works for un-marking (watched: false)', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ movie: { id: 5, watched: false } }),
    });

    const { setWatched } = await loadRealApi();
    await setWatched(5, false);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.watched).toBe(false);
  });

  it('an { error } response from list/spin surfaces as a thrown ApiError, not a success', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ error: 'unauthorized' }) });

    const { listMovies, ApiError } = await loadRealApi();
    await expect(listMovies()).rejects.toBeInstanceOf(ApiError);
    await expect(listMovies()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('an { error: "not_found" } response from setWatched surfaces as a thrown ApiError', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ error: 'not_found' }) });

    const { setWatched, ApiError } = await loadRealApi();
    await expect(setWatched(999, true)).rejects.toBeInstanceOf(ApiError);
    await expect(setWatched(999, true)).rejects.toMatchObject({ code: 'not_found' });
  });
});
