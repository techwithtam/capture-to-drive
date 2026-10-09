import { describe, expect, it } from 'vitest';
import { isValidSelection, normalizeSelection } from '../lib/selection-rect';

describe('normalizeSelection', () => {
  it.each([
    [{ x: 10, y: 20 }, { x: 50, y: 80 }],
    [{ x: 50, y: 80 }, { x: 10, y: 20 }],
    [{ x: 10, y: 80 }, { x: 50, y: 20 }],
    [{ x: 50, y: 20 }, { x: 10, y: 80 }],
  ])('normalizes a drag from %j to %j', (start, end) => {
    expect(normalizeSelection(start, end)).toEqual({ x: 10, y: 20, width: 40, height: 60 });
  });

  it('preserves fractional CSS coordinates', () => {
    expect(normalizeSelection({ x: 1.25, y: 3.5 }, { x: 9.75, y: 12 })).toEqual({
      x: 1.25, y: 3.5, width: 8.5, height: 8.5,
    });
  });
});

describe('the 8 by 8 CSS pixel minimum', () => {
  it.each([
    [8, 8, true], [8.01, 9, true], [7.999, 9, false], [9, 7.999, false],
    [0, 0, false], [-8, 8, false], [Infinity, 8, false], [8, NaN, false],
  ])('accepts width %s and height %s: %s', (width, height, valid) => {
    expect(isValidSelection({ x: 0, y: 0, width, height })).toBe(valid);
  });
});
