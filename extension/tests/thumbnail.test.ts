// Thumbnails for the note card: target size (at most 320px wide, never upscaled), image size read from the file
// header (so large images are decoded straight to thumbnail size), file kind by MIME type, and the data URL
// encoding. Canvas drawing needs createImageBitmap and OffscreenCanvas, which Node lacks, so it requires
// a browser check.
import { describe, expect, it } from 'vitest';
import {
  blobToDataUrl,
  fileKindFor,
  imageHeaderSize,
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  thumbnailSize,
} from '../lib/thumbnail';

describe('thumbnailSize', () => {
  it('caps the width at 320px and the height at 320px', () => {
    expect(THUMBNAIL_MAX_WIDTH).toBe(320);
    expect(THUMBNAIL_MAX_HEIGHT).toBe(320);
  });

  it.each([
    // [source width, source height, expected width, expected height]
    [1920, 1080, 320, 180], // wide screenshot: width-bound
    [2880, 1800, 320, 200], // retina screenshot
    [640, 640, 320, 320], // square
    [800, 3200, 80, 320], // tall capture: height-bound
    [1280, 20000, 20, 320], // very tall page image
    [200, 100, 200, 100], // smaller than the box: never upscaled
    [320, 320, 320, 320], // exactly the box
    [321, 100, 320, 100], // rounds to whole pixels
    [5000, 1, 320, 1], // never collapses to zero
    [1, 5000, 1, 320],
  ])('%i x %i becomes %i x %i', (width, height, expectedWidth, expectedHeight) => {
    expect(thumbnailSize(width, height)).toEqual({ width: expectedWidth, height: expectedHeight });
  });

  it('honours a custom box', () => {
    expect(thumbnailSize(1000, 500, { maxWidth: 100, maxHeight: 100 })).toEqual({ width: 100, height: 50 });
  });

  it.each([
    [0, 100],
    [100, 0],
    [-5, 10],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
  ])('has no size for an unusable source %s x %s', (width, height) => {
    expect(thumbnailSize(width, height)).toBeUndefined();
  });
});

describe('fileKindFor', () => {
  it.each([
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['IMAGE/WEBP', 'image'],
    ['image/gif', 'image'],
    ['application/pdf', 'pdf'],
    ['application/pdf; charset=binary', 'pdf'],
    ['text/csv', 'file'],
    ['application/octet-stream', 'file'],
    ['', 'file'],
  ])('%s is shown as %s', (mimeType, kind) => {
    expect(fileKindFor(mimeType)).toBe(kind);
  });
});

describe('blobToDataUrl', () => {
  it('encodes the bytes as base64 with the blob type', async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])], { type: 'image/png' });
    expect(await blobToDataUrl(blob)).toBe('data:image/png;base64,iVBORwD/');
  });

  it('encodes large blobs without overflowing the call stack', async () => {
    const bytes = new Uint8Array(300_000).map((_, index) => index % 256);
    const url = await blobToDataUrl(new Blob([bytes], { type: 'image/jpeg' }));
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const decoded = Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64');
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
  });

  it('falls back to application/octet-stream for an untyped blob', async () => {
    expect(await blobToDataUrl(new Blob(['hi']))).toBe('data:application/octet-stream;base64,aGk=');
  });
});

// --- File headers --------------------------------------------------------------------------------------------------

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32be = (value: number) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u32le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];

function png(width: number, height: number): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([...signature, ...ihdr]);
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

function sof(marker: number, width: number, height: number): number[] {
  return segment(marker, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

function exif(orientation: number, littleEndian: boolean): number[] {
  const u16 = littleEndian ? u16le : u16be;
  const u32 = littleEndian ? u32le : u32be;
  const tiff = [...ascii(littleEndian ? 'II' : 'MM'), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  return segment(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);
}

function jpeg(...segments: number[][]): Uint8Array {
  const app0 = segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dqt = segment(0xdb, new Array(65).fill(1));
  return new Uint8Array([0xff, 0xd8, ...app0, ...segments.flat(), ...dqt, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

describe('imageHeaderSize', () => {
  it('reads a PNG size from its IHDR chunk', () => {
    expect(imageHeaderSize(png(6000, 4000))).toEqual({ width: 6000, height: 4000 });
  });

  it.each([
    ['baseline', 0xc0],
    ['progressive', 0xc2],
  ])('reads a %s JPEG size from its frame header', (_name, marker) => {
    expect(imageHeaderSize(jpeg(sof(marker, 4032, 3024)))).toEqual({ width: 4032, height: 3024 });
  });

  it.each([
    [1, false, { width: 4032, height: 3024 }],
    [3, true, { width: 4032, height: 3024 }],
    [6, false, { width: 3024, height: 4032 }],
    [8, true, { width: 3024, height: 4032 }],
    [5, true, { width: 3024, height: 4032 }],
  ])('applies EXIF orientation %i (little-endian %s): the size as displayed', (orientation, littleEndian, size) => {
    expect(imageHeaderSize(jpeg(exif(orientation, littleEndian), sof(0xc0, 4032, 3024)))).toEqual(size);
  });

  it('skips segments that are not a frame header (DHT and friends)', () => {
    const dht = segment(0xc4, new Array(20).fill(0));
    expect(imageHeaderSize(jpeg(dht, sof(0xc1, 800, 600)))).toEqual({ width: 800, height: 600 });
  });

  it('reads a GIF size', () => {
    const gif = new Uint8Array([...ascii('GIF89a'), ...u16le(640), ...u16le(480), 0, 0, 0]);
    expect(imageHeaderSize(gif)).toEqual({ width: 640, height: 480 });
  });

  it.each([
    ['an empty file', new Uint8Array()],
    ['a truncated PNG', png(100, 100).slice(0, 20)],
    ['a JPEG cut inside its frame header', jpeg(sof(0xc0, 10, 10)).slice(0, 26)],
    ['a WebP file', new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 ')])],
    ['a PNG of size zero', png(0, 10)],
    ['text', new Uint8Array(ascii('hello world, not an image'))],
  ])('has no size for %s', (_name, bytes) => {
    expect(imageHeaderSize(bytes)).toBeUndefined();
  });
});
