import { describe, expect, it } from 'vitest';
import { isValidRating, snapToHalfStar, MIN_RATING, MAX_RATING } from './rating';

describe('isValidRating', () => {
  it('accepts null (unrated / clearing a rating)', () => {
    expect(isValidRating(null)).toBe(true);
  });

  it.each([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5])('accepts the half-step value %s', (v) => {
    expect(isValidRating(v)).toBe(true);
  });

  it('rejects 0 (below the minimum half-step)', () => {
    expect(isValidRating(0)).toBe(false);
  });

  it('rejects values below MIN_RATING', () => {
    expect(isValidRating(0.25)).toBe(false);
    expect(isValidRating(-1)).toBe(false);
  });

  it('rejects values above MAX_RATING', () => {
    expect(isValidRating(5.5)).toBe(false);
    expect(isValidRating(10)).toBe(false);
  });

  it('rejects non-half-step numbers', () => {
    expect(isValidRating(3.25)).toBe(false);
    expect(isValidRating(4.1)).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(isValidRating('4.5')).toBe(false);
    expect(isValidRating(undefined)).toBe(false);
    expect(isValidRating(NaN)).toBe(false);
  });
});

describe('snapToHalfStar', () => {
  it('rounds to the nearest half-star step', () => {
    expect(snapToHalfStar(3.1)).toBe(3);
    expect(snapToHalfStar(3.3)).toBe(3.5);
    expect(snapToHalfStar(3.7)).toBe(3.5);
    expect(snapToHalfStar(3.8)).toBe(4);
  });

  it('clamps below MIN_RATING up to MIN_RATING (never 0)', () => {
    expect(snapToHalfStar(0)).toBe(MIN_RATING);
    expect(snapToHalfStar(-3)).toBe(MIN_RATING);
  });

  it('clamps above MAX_RATING down to MAX_RATING', () => {
    expect(snapToHalfStar(9)).toBe(MAX_RATING);
  });
});
