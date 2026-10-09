export interface Point {
  x: number;
  y: number;
}

export interface SelectionRect extends Point {
  width: number;
  height: number;
}

export const MIN_SELECTION_SIZE = 8;
export const SELECTION_TIMEOUT_MS = 2 * 60 * 1000;

/** Viewport CSS coordinates, independent of drag direction. */
export function normalizeSelection(start: Point, end: Point): SelectionRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function isValidSelection(rect: SelectionRect): boolean {
  return Object.values(rect).every(Number.isFinite) &&
    rect.width >= MIN_SELECTION_SIZE && rect.height >= MIN_SELECTION_SIZE;
}
