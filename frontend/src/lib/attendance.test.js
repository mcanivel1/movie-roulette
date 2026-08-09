import { describe, expect, it } from 'vitest';
import {
  ROSTER,
  resolveRosterNames,
  buildAbsentParam,
  applyAttendanceFilter,
  previewAttendanceEligibility,
} from './attendance';

function seenBy(present) {
  // Build a full 8-member seenBy map, true for the given names, false
  // otherwise -- mirrors SPEC.md's Movie object shape.
  const map = {};
  ROSTER.forEach((name) => {
    map[name] = present.includes(name);
  });
  return map;
}

describe('resolveRosterNames', () => {
  it('matches roster members case-insensitively and trims whitespace', () => {
    expect(resolveRosterNames([' austin ', 'JOSH'])).toEqual(['Austin', 'Josh']);
  });

  it('drops names that are not on the roster', () => {
    expect(resolveRosterNames(['Austin', 'NotAPerson'])).toEqual(['Austin']);
  });

  it('returns an empty array for empty/undefined input', () => {
    expect(resolveRosterNames([])).toEqual([]);
    expect(resolveRosterNames(undefined)).toEqual([]);
  });
});

describe('buildAbsentParam', () => {
  it('joins resolved roster names with commas', () => {
    expect(buildAbsentParam(['Austin', 'Josh'])).toBe('Austin,Josh');
  });

  it('is empty when nobody is absent', () => {
    expect(buildAbsentParam([])).toBe('');
  });
});

describe('previewAttendanceEligibility', () => {
  const movies = [
    { id: 1, eligible: true, seenBy: seenBy(['Austin', 'Josh']) },
    // Seen by everyone EXCEPT Michelle -- deliberately not "everyone,"
    // otherwise marking the full roster absent would never actually empty
    // the adjusted pool and the fallback test below couldn't exercise
    // anything (see mockMovies.js's near-identical fixture-data lesson).
    { id: 2, eligible: true, seenBy: seenBy(ROSTER.filter((n) => n !== 'Michelle')) },
    { id: 3, eligible: false, seenBy: seenBy(ROSTER) }, // not eligible regardless of attendance
  ];

  it('counts all eligible movies when nobody is absent', () => {
    expect(previewAttendanceEligibility(movies, []).count).toBe(2);
  });

  it('excludes a movie an absent member has not seen', () => {
    // Eugie hasn't seen movie 1, but has seen movie 2.
    expect(previewAttendanceEligibility(movies, ['Eugie']).count).toBe(1);
  });

  it('never counts an already-ineligible movie, even if every absentee has seen it', () => {
    expect(previewAttendanceEligibility(movies, ['Austin']).count).toBe(2);
  });

  it('applies the same empty-pool fallback as applyAttendanceFilter, so it never reports 0 while a real spin would still find something', () => {
    // Marking the full roster absent leaves nothing (movie 1 is missing
    // most members' seenBy, and movie 2 is missing Michelle's) -- the
    // adjusted pool is empty, so the fallback kicks in: the preview reports
    // the ORIGINAL eligible count (2) and attendanceApplied: false,
    // matching exactly what listMovies(everyone-absent) would return --
    // never a bare "0" that the Roulette tab then contradicts.
    const result = previewAttendanceEligibility(movies, ROSTER);
    expect(result.attendanceApplied).toBe(false);
    expect(result.count).toBe(2);
  });

  it('reports attendanceApplied: true (and a narrowed, non-fallback count) when the adjusted pool stays non-empty', () => {
    const result = previewAttendanceEligibility(movies, ['Eugie']);
    expect(result.attendanceApplied).toBe(true);
    expect(result.count).toBe(1);
  });
});

describe('applyAttendanceFilter', () => {
  const movies = [
    { id: 1, eligible: true, waitingOn: null, seenBy: seenBy(['Austin']) },
    { id: 2, eligible: true, waitingOn: null, seenBy: seenBy(ROSTER) },
    { id: 3, eligible: false, waitingOn: 'Some Prequel', seenBy: seenBy(ROSTER) },
  ];

  it('is a no-op (attendanceApplied undefined) when nobody is absent', () => {
    const result = applyAttendanceFilter(movies, []);
    expect(result.attendanceApplied).toBeUndefined();
    expect(result.movies).toBe(movies);
  });

  it('marks a movie ineligible when an absent member has not seen it', () => {
    const result = applyAttendanceFilter(movies, ['Eugie']);
    expect(result.attendanceApplied).toBe(true);
    const one = result.movies.find((m) => m.id === 1);
    const two = result.movies.find((m) => m.id === 2);
    expect(one.eligible).toBe(false);
    expect(two.eligible).toBe(true); // everyone's seen movie 2
  });

  it('leaves an already-ineligible movie (e.g. waiting on a prequel) untouched', () => {
    const result = applyAttendanceFilter(movies, ['Eugie']);
    const three = result.movies.find((m) => m.id === 3);
    expect(three.eligible).toBe(false);
    expect(three.waitingOn).toBe('Some Prequel');
  });

  it('falls back to plain eligibility when the adjusted pool would be empty', () => {
    // Nobody but Austin has seen movie 1; everyone's seen movie 2. Marking
    // everyone except Austin absent leaves movie 1 filtered out, but movie 2
    // survives (everyone's seen it) -- not empty, so no fallback.
    const notEmpty = applyAttendanceFilter(movies, ROSTER.filter((n) => n !== 'Austin'));
    expect(notEmpty.attendanceApplied).toBe(true);

    // Now also make movie 2 fail (nobody except Austin has seen it either) --
    // the adjusted pool is empty, so the fallback should kick in and return
    // the ORIGINAL (pre-attendance) movies/eligibility untouched.
    const allBlocked = [
      { id: 1, eligible: true, waitingOn: null, seenBy: seenBy(['Austin']) },
      { id: 2, eligible: true, waitingOn: null, seenBy: seenBy(['Austin']) },
    ];
    const result = applyAttendanceFilter(allBlocked, ROSTER.filter((n) => n !== 'Austin'));
    expect(result.attendanceApplied).toBe(false);
    expect(result.movies).toBe(allBlocked);
    expect(result.movies.every((m) => m.eligible)).toBe(true);
  });

  it('resolves absentee names case-insensitively before applying the rule', () => {
    const result = applyAttendanceFilter(movies, [' eugie ']);
    const one = result.movies.find((m) => m.id === 1);
    expect(one.eligible).toBe(false);
  });
});
