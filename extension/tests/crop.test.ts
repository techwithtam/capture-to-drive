import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeCropRect, cropImage } from '../lib/crop';

const VIEWPORT = { width: 1000, height: 800 };
const RECT = { x: 100, y: 120, width: 80, height: 60 };

afterEach(() => vi.unstubAllGlobals());

describe('computeCropRect', () => {
  it.each([1, 2, 1.25])('scales all coordinates at image/viewport ratio %s', (scale) => {
    expect(computeCropRect(RECT, VIEWPORT, { width: 1000 * scale, height: 800 * scale })).toEqual({
      x: 100 * scale, y: 120 * scale, width: 80 * scale, height: 60 * scale,
    });
  });

  it('rounds the clamped edges, then derives width and height', () => {
    expect(computeCropRect({ x: 1.4, y: 2.6, width: 8.4, height: 9.2 }, VIEWPORT, VIEWPORT)).toEqual({
      x: 1, y: 3, width: 9, height: 9,
    });
  });

  it('uses the width ratio for both axes, even if heights differ', () => {
    expect(computeCropRect(RECT, VIEWPORT, { width: 2000, height: 1500 })).toEqual({
      x: 200, y: 240, width: 160, height: 120,
    });
  });

  it.each([
    [{ x: -10, y: 20, width: 30, height: 40 }, { x: 0, y: 20, width: 20, height: 40 }],
    [{ x: 20, y: -10, width: 30, height: 40 }, { x: 20, y: 0, width: 30, height: 30 }],
    [{ x: 980, y: 20, width: 30, height: 40 }, { x: 980, y: 20, width: 20, height: 40 }],
    [{ x: 20, y: 780, width: 30, height: 40 }, { x: 20, y: 780, width: 30, height: 20 }],
    [{ x: -10, y: -10, width: 1020, height: 820 }, { x: 0, y: 0, width: 1000, height: 800 }],
  ])('clamps %j to the image bounds', (rect, expected) => {
    expect(computeCropRect(rect, VIEWPORT, VIEWPORT)).toEqual(expected);
  });

  it.each([
    { x: -20, y: 0, width: 10, height: 10 },
    { x: 1000, y: 0, width: 10, height: 10 },
    { x: 0, y: -20, width: 10, height: 10 },
    { x: 0, y: 800, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: -10, height: 10 },
    { x: 0, y: 0, width: 0.1, height: 10 },
    { x: NaN, y: 0, width: 10, height: 10 },
  ])('returns null for empty or invalid %j', (rect) => {
    expect(computeCropRect(rect, VIEWPORT, VIEWPORT)).toBeNull();
  });

  it('keeps an exact minimum selection and permits a smaller clamped remainder', () => {
    expect(computeCropRect({ x: 0, y: 0, width: 8, height: 8 }, VIEWPORT, VIEWPORT)?.width).toBe(8);
    expect(computeCropRect({ x: 999, y: 799, width: 8, height: 8 }, VIEWPORT, VIEWPORT)).toEqual({
      x: 999, y: 799, width: 1, height: 1,
    });
  });

  it.each([
    { width: 0, height: 800 }, { width: 1000, height: 0 }, { width: Infinity, height: 800 },
  ])('rejects unusable dimensions %j', (size) => {
    expect(computeCropRect(RECT, size, VIEWPORT)).toBeNull();
    expect(computeCropRect(RECT, VIEWPORT, size)).toBeNull();
  });
});

describe('cropImage', () => {
  function stubCanvas(contextAvailable = true) {
    const bitmap = { width: 2000, height: 1600, close: vi.fn() };
    const output = new Blob(['cropped'], { type: 'image/png' });
    const drawImage = vi.fn();
    const convertToBlob = vi.fn().mockResolvedValue(output);
    const Canvas = vi.fn(function () {
      return { getContext: () => contextAvailable ? { drawImage } : null, convertToBlob };
    });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal('OffscreenCanvas', Canvas);
    return { bitmap, output, drawImage, convertToBlob, Canvas };
  }

  it('draws the scaled region into a crop-sized canvas and exports PNG', async () => {
    const f = stubCanvas();
    const input = new Blob(['original']);
    expect(await cropImage(input, RECT, VIEWPORT)).toBe(f.output);
    expect(createImageBitmap).toHaveBeenCalledWith(input);
    expect(f.Canvas).toHaveBeenCalledWith(160, 120);
    expect(f.drawImage).toHaveBeenCalledWith(f.bitmap, 200, 240, 160, 120, 0, 0, 160, 120);
    expect(f.convertToBlob).toHaveBeenCalledWith({ type: 'image/png' });
    expect(f.bitmap.close).toHaveBeenCalledOnce();
  });

  it('clamps before drawing', async () => {
    const f = stubCanvas();
    await cropImage(new Blob(), { x: -10, y: -10, width: 30, height: 30 }, VIEWPORT);
    expect(f.drawImage).toHaveBeenCalledWith(f.bitmap, 0, 0, 40, 40, 0, 0, 40, 40);
  });

  it.each(['empty', 'no context', 'encoding'] as const)('closes the bitmap when %s fails', async (failure) => {
    const f = stubCanvas(failure !== 'no context');
    if (failure === 'encoding') f.convertToBlob.mockRejectedValue(new Error('Encoding failed'));
    const rect = failure === 'empty' ? { ...RECT, x: 3000 } : RECT;
    await expect(cropImage(new Blob(), rect, VIEWPORT)).rejects.toThrow();
    expect(f.bitmap.close).toHaveBeenCalledOnce();
  });
});
