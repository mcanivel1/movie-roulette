// Pure rating-validation/quantization helpers mirroring SPEC.md's "Ratings"
// section: a rating is either `null` (unrated) or a half-step number in
// [0.5, 5] (0.5, 1, 1.5, ... 5 -- 10 possible values). Kept isolated/pure,
// same rule as lib/eligibility.js, so it's unit-testable without any DOM
// globals and reusable by both the StarRating widget (client-side snapping
// while dragging/hovering) and the local mock backend's setRating validation
// (api.js), which needs to reject the same inputs the real Apps Script
// backend would (`bad_request`).

export const MIN_RATING = 0.5;
export const MAX_RATING = 5;

/** Is `rating` a legal value to send to setRating -- null, or a half-step
 * number in [MIN_RATING, MAX_RATING]? */
export function isValidRating(rating) {
  if (rating === null) return true;
  if (typeof rating !== 'number' || Number.isNaN(rating)) return false;
  if (rating < MIN_RATING || rating > MAX_RATING) return false;
  // Half-step: doubling must land exactly on an integer (1, 2, 3, ... 10).
  return Number.isInteger(rating * 2);
}

/** Snap an arbitrary float (e.g. a pointer position expressed as a 0-5
 * ratio) to the nearest valid half-star step, clamped to the legal range.
 * Always returns a rateable value (never 0/null) -- used while the user is
 * actively hovering/dragging/tapping the widget, where "no rating yet" isn't
 * a reachable pointer position. */
export function snapToHalfStar(value) {
  const clamped = Math.max(MIN_RATING, Math.min(MAX_RATING, value));
  return Math.round(clamped * 2) / 2;
}
