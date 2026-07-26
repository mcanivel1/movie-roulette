import { describe, expect, it } from 'vitest';
import { computeMovieFields } from './eligibility';

// Mirrors SPEC.md's "Core business logic" examples: standalone films,
// resolved prequel chains, an unwatched prequel blocking a sequel, and a
// dangling prequel reference (fail closed).
describe('computeMovieFields', () => {
  it('marks a standalone unwatched film eligible with no waitingOn', () => {
    const [movie] = computeMovieFields([
      { id: 1, title: 'Neon Meridian', prequel: '', watched: false },
    ]);
    expect(movie.eligible).toBe(true);
    expect(movie.waitingOn).toBeNull();
  });

  it('marks a watched film not eligible, with no waitingOn (not blocked by a prequel)', () => {
    const [movie] = computeMovieFields([
      { id: 1, title: 'Harbor Lights', prequel: '', watched: true },
    ]);
    expect(movie.eligible).toBe(false);
    expect(movie.waitingOn).toBeNull();
  });

  it('marks a sequel eligible once its prequel is watched (case/whitespace-insensitive match)', () => {
    const movies = computeMovieFields([
      { id: 1, title: 'Harbor Lights', prequel: '', watched: true },
      { id: 2, title: 'Harbor Lights II: The Tide', prequel: '  harbor lights  ', watched: false },
    ]);
    const sequel = movies.find((m) => m.id === 2);
    expect(sequel.eligible).toBe(true);
    expect(sequel.waitingOn).toBeNull();
  });

  it('marks a sequel not eligible while its prequel is unwatched, reporting waitingOn', () => {
    const movies = computeMovieFields([
      { id: 1, title: 'The Glass Orchard', prequel: '', watched: false },
      { id: 2, title: 'Glass Orchard: Winter', prequel: 'The Glass Orchard', watched: false },
    ]);
    const sequel = movies.find((m) => m.id === 2);
    expect(sequel.eligible).toBe(false);
    expect(sequel.waitingOn).toBe('The Glass Orchard');
  });

  it('fails closed on a dangling prequel reference (no matching row) and still reports waitingOn', () => {
    const [movie] = computeMovieFields([
      { id: 1, title: 'Cinder & Salt II: Aftermath', prequel: 'Cinder & Salt', watched: false },
    ]);
    expect(movie.eligible).toBe(false);
    expect(movie.waitingOn).toBe('Cinder & Salt');
  });

  it('uniform spin selection should only ever be drawn from eligible === true rows (sanity on the flag itself)', () => {
    const movies = computeMovieFields([
      { id: 1, title: 'A', prequel: '', watched: true },
      { id: 2, title: 'B', prequel: 'A', watched: false },
      { id: 3, title: 'C', prequel: '', watched: false },
    ]);
    const eligibleTitles = movies.filter((m) => m.eligible).map((m) => m.title);
    expect(eligibleTitles.sort()).toEqual(['B', 'C']);
  });
});
