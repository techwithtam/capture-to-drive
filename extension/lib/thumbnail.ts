// Thumbnails for the note step (spec section 6.4). The note card lives in a web page and cannot read the extension's
// IndexedDB, so the background draws a small copy of an image capture and sends it as a data URL. Uses
// createImageBitmap and OffscreenCanvas, which the service worker has; no object URLs are created, so there is
// nothing to revoke. The image size comes from the file header where possible, so a large capture is decoded straight
// to thumbnail size instead of at full size.

import type { NoteFileKind } from './messages';

export const THUMBNAIL_MAX_WIDTH = 320;
export const THUMBNAIL_MAX_HEIGHT = 320;

export interface Size {
  width: number;
  height: number;
}

/**
 * The thumbnail size for a `width` x `height` image: scaled down (never up) to fit the box, keeping the aspect ratio,
 * in whole pixels and at least 1px each way. Undefined when the source size is unusable.
 */
export function thumbnailSize(
  width: number,
  height: number,
  box: { maxWidth: number; maxHeight: number } = { maxWidth: THUMBNAIL_MAX_WIDTH, maxHeight: THUMBNAIL_MAX_HEIGHT },
): Size | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const scale = Math.min(1, box.maxWidth / width, box.maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** How the note UI shows a file of this MIME type. */
export function fileKindFor(mimeType: string): NoteFileKind {
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'file';
}

// btoa takes a binary string; building it in slices keeps String.fromCharCode under the argument-count limit.
const ENCODE_CHUNK_BYTES = 0x8000;

/** `data:<type>;base64,...` for a blob. Works in a service worker (no FileReader needed). */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += ENCODE_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(start, start + ENCODE_CHUNK_BYTES));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

// --- Image size from the file header -------------------------------------------------------------------------------

/** How much of a file to read for its header. A JPEG's frame header follows its metadata segments (EXIF, ICC). */
export const HEADER_BYTES = 256 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_ORIENTATION_TAG = 0x0112;

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000 + (u16be(bytes, at + 1) << 8)) + (bytes[at + 3] ?? 0);
}

function positive(width: number, height: number): Size | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function pngSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return undefined;
  // The first chunk is IHDR: length (4), type (4), then width and height.
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
  return positive(u32be(bytes, 16), u32be(bytes, 20));
}

function gifSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 10) return undefined;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined;
  return positive((bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8), (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8));
}

/** The EXIF orientation (1 to 8) in an APP1 segment's payload `[start, end)`, if it has one. */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number | undefined {
  if (String.fromCharCode(...bytes.subarray(start, start + 6)) !== 'Exif\u0000\u0000') return undefined;
  const tiff = start + 6;
  const order = String.fromCharCode(...bytes.subarray(tiff, tiff + 2));
  if (order !== 'II' && order !== 'MM') return undefined;
  const little = order === 'II';
  const u16 = (at: number) => (little ? (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) : u16be(bytes, at));
  const u32 = (at: number) => (little ? u16(at) + u16(at + 2) * 0x10000 : u32be(bytes, at));
  if (u16(tiff + 2) !== 42) return undefined;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) === EXIF_ORIENTATION_TAG) {
      const orientation = u16(entry + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : undefined;
    }
  }
  return undefined;
}

/** Start-of-frame markers carry the image size; C4 (DHT), C8 (JPG), and CC (DAC) share the range but do not. */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array): Size | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    let marker = bytes[offset + 1] ?? 0;
    // Any number of 0xFF fill bytes may come before a marker.
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }
    offset += 2;
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // End of image, or image data, before any frame header.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, offset);
    if (length < 2) return undefined;
    if (isFrameHeader(marker)) {
      if (offset + 7 > bytes.length) return undefined;
      const size = positive(u16be(bytes, offset + 5), u16be(bytes, offset + 3));
      // Orientations 5 to 8 turn the image a quarter, so it is displayed with width and height swapped.
      return size !== undefined && orientation >= 5 ? { width: size.height, height: size.width } : size;
    }
    if (offset + length > bytes.length) return undefined;
    if (marker === 0xe1) orientation = exifOrientation(bytes, offset + 2, offset + length) ?? orientation;
    offset += length;
  }
  return undefined;
}

/**
 * The size of a PNG, JPEG (as displayed, after its EXIF orientation), or GIF, read from the first bytes of the file.
 * Undefined for other formats or when the header is not in `bytes`.
 */
export function imageHeaderSize(bytes: Uint8Array): Size | undefined {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes);
}

// --- Drawing -------------------------------------------------------------------------------------------------------

/**
 * Decodes the image at thumbnail size. When the header tells the size, the browser decodes straight to the small
 * size (no full-size bitmap is kept); otherwise one full decode reads the size and is drawn scaled.
 */
async function decodeForThumbnail(blob: Blob): Promise<{ bitmap: ImageBitmap; size: Size }> {
  const header = imageHeaderSize(new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer()));
  if (header !== undefined) {
    const size = thumbnailSize(header.width, header.height);
    if (size === undefined) throw new Error('The image has no size.');
    const bitmap = await createImageBitmap(blob, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: 'medium',
    });
    return { bitmap, size };
  }
  const bitmap = await createImageBitmap(blob);
  const size = thumbnailSize(bitmap.width, bitmap.height);
  if (size === undefined) {
    bitmap.close();
    throw new Error('The image has no size.');
  }
  return { bitmap, size };
}

/**
 * A PNG thumbnail of an image blob as a data URL, at most 320 x 320px. Rejects when the browser cannot decode the
 * image (for example SVG, which createImageBitmap does not take in a worker); callers then show a file icon instead.
 */
export async function createThumbnailDataUrl(blob: Blob): Promise<string> {
  const { bitmap, size } = await decodeForThumbnail(blob);
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No 2D canvas is available.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  } finally {
    bitmap.close();
  }
}
