import type { SelectionRect } from './selection-rect';

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Map CSS coordinates to screenshot pixels. The width ratio covers both DPR and zoom.
 * Round the clamped edges, then subtract: output pixels never extend beyond the image.
 * The UI applies its 8px minimum before this step; a clipped remainder may be smaller.
 */
export function computeCropRect(rect: SelectionRect, viewport: Viewport, image: Viewport): SelectionRect | null {
  const values = [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, image.width, image.height];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 ||
    viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) return null;

  const scale = image.width / viewport.width;
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)));
  const x = clamp(rect.x * scale, image.width);
  const y = clamp(rect.y * scale, image.height);
  const right = clamp((rect.x + rect.width) * scale, image.width);
  const bottom = clamp((rect.y + rect.height) * scale, image.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Decode and crop in the service worker, without a DOM or object URLs. */
export async function cropImage(blob: Blob, rect: SelectionRect, viewport: Viewport): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const source = computeCropRect(rect, viewport, bitmap);
    if (source === null) throw new Error('The selection has no image pixels.');
    const canvas = new OffscreenCanvas(source.width, source.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No 2D canvas is available.');
    context.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, source.width, source.height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}
