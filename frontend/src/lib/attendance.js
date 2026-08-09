// Pure attendance helpers mirroring SPEC.md's "Attendance" section. Kept
// isolated/pure (no fetch/DOM) so the rule -- and its empty-pool fallback --
// is unit-testable the same way lib/eligibility.js is, and so the
// AttendanceDropdown's live "N eligible tonight" preview, the local mock
// backend (api.js), AND the real Apps Script backend all apply the exact
// same rule (via applyAttendanceFilter below), never just three
// independently-drifting approximations of it.

// Fixed 8-person roster, per SPEC.md -- same names as the sheet's per-member
// watched columns.
export const ROSTER = ['Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle'];

function normalize(str) {
  return (str || '').trim().toLowerCase();
}

/** Resolve arbitrary name strings (any case/whitespace) to their canonical
 * roster spelling, dropping anything that doesn't match a roster member --
 * per SPEC.md's "matched case-insensitively/trimmed against the fixed
 * roster" wire-format rule. */
export function resolveRosterNames(names) {
  return (names || [])
    .map((raw) => ROSTER.find((member) => normalize(member) === normalize(raw)))
    .filter(Boolean);
}

/** Build the `absent=Name,Name` query value per SPEC.md's exact wire
 * format. Returns '' when nobody's absent (the frontend then omits the
 * param entirely, identical to "everyone's here"). */
export function buildAbsentParam(absentees) {
  return resolveRosterNames(absentees).join(',');
}

/**
 * Full backend-shaped attendance adjustment: given movies already annotated
 * with `eligible`/`waitingOn` (e.g. by computeMovieFields) and each carrying
 * a `seenBy` map, returns the same movies with `eligible` re-annotated for
 * the attendance-adjusted rule, plus whether the adjustment was actually
 * applied.
 *
 * Rule (SPEC.md): on top of normal eligibility, a movie is only offered if
 * every *absent* member has already personally seen it. Presence never
 * removes an otherwise-eligible movie; only absence can, and only for movies
 * an absent person hasn't seen.
 *
 * Fallback (SPEC.md): if applying that filter would leave zero eligible
 * movies, drop the attendance criterion entirely (fall back to plain
 * eligibility) rather than showing an empty pool -- reported via
 * `attendanceApplied: false` so the UI can say so instead of pretending
 * attendance had no effect.
 *
 * Used by the local mock backend (api.js) to fake the real Apps Script
 * behavior for offline/local dev; the real backend implements the identical
 * rule server-side in its own pure Logic.js.
 */
export function applyAttendanceFilter(movies, absentees) {
  const resolved = resolveRosterNames(absentees);
  if (resolved.length === 0) {
    return { movies, attendanceApplied: undefined };
  }

  const adjusted = movies.map((movie) => {
    if (!movie.eligible) return movie;
    const stillEligible = resolved.every((name) => movie.seenBy && movie.seenBy[name] === true);
    return stillEligible ? movie : { ...movie, eligible: false };
  });

  const wouldBeEmpty = adjusted.every((movie) => !movie.eligible);
  if (wouldBeEmpty) {
    return { movies, attendanceApplied: false };
  }
  return { movies: adjusted, attendanceApplied: true };
}

/**
 * Client-side preview for the attendance popover's live "N eligible
 * tonight" note. Deliberately delegates to applyAttendanceFilter above --
 * the SAME rule *and* fallback the mock/real backend apply for actual
 * list/spin calls -- rather than a stripped-down version that skips the
 * fallback. An earlier version of this preview omitted the fallback and
 * could show "0 eligible" while the Roulette tab, a moment later, correctly
 * fell back to the full pool: the app visibly disagreeing with itself in
 * exactly the scenario the fallback exists to handle. No network round-trip
 * needed either way, since it's pure and operates on the already-fetched
 * `movies` (each carrying a `seenBy` map per SPEC.md).
 */
export function previewAttendanceEligibility(movies, absentees) {
  const { movies: adjusted, attendanceApplied } = applyAttendanceFilter(movies, absentees);
  return { count: adjusted.filter((movie) => movie.eligible).length, attendanceApplied };
}
