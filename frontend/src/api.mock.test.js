// Integration-style smoke test for the LOCAL MOCK path (VITE_USE_MOCK=true)
// covering the v2 features end to end: rating persistence, details lookup,
// and attendance-adjusted list/spin (including its empty-pool fallback).
// Complements api.real.test.js, which only checks the real-fetch wiring
// (request shape) without exercising any actual business logic. Uses real
// timers (the mock's artificial delays are all well under a second) rather
// than fake ones, to avoid unhandled-rejection timing gotchas around
// `expect(...).rejects` + fake timers.
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadMockApi() {
  vi.resetModules();
  vi.stubEnv('VITE_USE_MOCK', 'true');
  return import('./api.js');
}

describe('src/api.js — local mock backend (v2 features)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('listMovies() returns movies each carrying a seenBy map, and no attendanceApplied when absent is omitted', async () => {
    const { listMovies } = await loadMockApi();
    const { movies, attendanceApplied } = await listMovies();

    expect(movies.length).toBeGreaterThan(0);
    expect(attendanceApplied).toBeUndefined();
    movies.forEach((m) => {
      expect(m.seenBy).toBeTypeOf('object');
      expect(m.seenBy).toHaveProperty('Austin');
    });
  });

  it('setRating() persists a valid half-step rating and it shows up on the next listMovies()', async () => {
    const { listMovies, setRating } = await loadMockApi();
    const { movies } = await listMovies();
    const unrated = movies.find((m) => m.watched && m.rating === null);
    expect(unrated).toBeTruthy();

    const { movie: updated } = await setRating(unrated.id, 3.5);
    expect(updated.rating).toBe(3.5);

    const { movies: after } = await listMovies();
    expect(after.find((m) => m.id === unrated.id).rating).toBe(3.5);
  });

  it('setRating() rejects an invalid (non-half-step) rating with bad_request', async () => {
    const { setRating, ApiError } = await loadMockApi();
    const err = await setRating(2, 3.25).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'bad_request' });
  });

  it('setRating() rejects an unknown id with not_found', async () => {
    const { setRating, ApiError } = await loadMockApi();
    const err = await setRating(99999, 4).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found' });
  });

  it('setRating(id, null) clears an existing rating', async () => {
    const { setRating } = await loadMockApi();
    const { movie } = await setRating(2, null);
    expect(movie.rating).toBeNull();
  });

  it('getDetails() returns streamingPlatforms/quotes arrays for a known movie', async () => {
    const { getDetails } = await loadMockApi();
    const details = await getDetails(4);
    expect(Array.isArray(details.streamingPlatforms)).toBe(true);
    expect(Array.isArray(details.quotes)).toBe(true);
  });

  it('getDetails() returns empty (not error) arrays for a movie with no fixture data', async () => {
    const { getDetails } = await loadMockApi();
    const details = await getDetails(3);
    expect(details).toEqual({ streamingPlatforms: [], quotes: [] });
  });

  it('getDetails() rejects an unknown id with not_found', async () => {
    const { getDetails, ApiError } = await loadMockApi();
    const err = await getDetails(99999).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('listMovies(absentees) narrows eligible movies and reports attendanceApplied: true when the pool stays non-empty', async () => {
    const { listMovies } = await loadMockApi();
    const baseline = await listMovies();
    const baselineEligible = baseline.movies.filter((m) => m.eligible).map((m) => m.id).sort();

    // Marking Austin absent (per mockMovies.js's fixture data) should filter
    // out at least one movie they haven't seen, without emptying the pool.
    const adjusted = await listMovies(['Austin']);
    const adjustedEligible = adjusted.movies.filter((m) => m.eligible).map((m) => m.id).sort();

    expect(adjusted.attendanceApplied).toBe(true);
    expect(adjustedEligible.length).toBeLessThan(baselineEligible.length);
  });

  it('listMovies(absentees) falls back to the full pool (attendanceApplied: false) when the adjusted pool would be empty', async () => {
    const { listMovies } = await loadMockApi();
    const everyone = ['Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'];
    const result = await listMovies(everyone);

    expect(result.attendanceApplied).toBe(false);
    // Fallback means the SAME (unadjusted) eligible set as a plain list().
    const baseline = await listMovies();
    const baselineEligible = baseline.movies.filter((m) => m.eligible).map((m) => m.id).sort();
    const fallbackEligible = result.movies.filter((m) => m.eligible).map((m) => m.id).sort();
    expect(fallbackEligible).toEqual(baselineEligible);
  });

  it('spin(absentees) only ever picks from the attendance-adjusted eligible pool', async () => {
    const { listMovies, spin } = await loadMockApi();
    const { movies } = await listMovies(['Austin']);
    const eligibleIds = new Set(movies.filter((m) => m.eligible).map((m) => m.id));

    for (let i = 0; i < 10; i++) {
      const { movie } = await spin(['Austin']);
      if (movie) expect(eligibleIds.has(movie.id)).toBe(true);
    }
  });

  it('setWatched() still works unchanged alongside the v2 additions', async () => {
    const { listMovies, setWatched } = await loadMockApi();
    const { movies } = await listMovies();
    const unwatched = movies.find((m) => !m.watched && m.eligible);
    expect(unwatched).toBeTruthy();

    const { movie: updated } = await setWatched(unwatched.id, true);
    expect(updated.watched).toBe(true);
  });
});
