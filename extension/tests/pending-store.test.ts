// Pending store (spec section 6.4): captures waiting for the note step, kept in IndexedDB so a service-worker stop
// while the user types loses nothing, and cleaned up after 24 hours when the note step was abandoned.
import { beforeEach, describe, expect, it } from 'vitest';
import { PENDING_STORE, transact } from '../lib/db';
import {
  clearSaveRequested,
  deleteExpiredPending,
  deletePending,
  getPending,
  listPending,
  markSaveRequested,
  PENDING_MAX_AGE_MS,
  putPending,
  setPendingThumbnail,
} from '../lib/pending-store';
import type { PendingRecord } from '../lib/pending-store';
import { resetDatabase } from './helpers/queue-harness';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 20, 42, 10);

function record(captureId: string, overrides: Partial<PendingRecord> = {}): PendingRecord {
  return {
    captureId,
    capturedAt: NOW,
    blob: new Blob([`bytes of ${captureId}`], { type: 'image/png' }),
    mimeType: 'image/png',
    filename: `2026-10-07 13.42 Alex - example.com - ${captureId}.png`,
    meta: { title: 'Orders', url: 'https://example.com/orders', captureType: 'area', capturedBy: 'Alex' },
    fileKind: 'image',
    ...overrides,
  };
}

async function putRaw(value: unknown): Promise<void> {
  await transact(PENDING_STORE, 'readwrite', (store) => {
    store.put(value);
    return () => undefined;
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe('pending store', () => {
  it('stores a record and reads it back with its blob', async () => {
    const stored = record('a', { thumbnailDataUrl: 'data:image/png;base64,AAAA', message: 'Visible area.' });
    await putPending(stored);

    const read = await getPending('a');
    expect(read).toMatchObject({
      captureId: 'a',
      capturedAt: NOW,
      mimeType: 'image/png',
      filename: stored.filename,
      meta: stored.meta,
      fileKind: 'image',
      thumbnailDataUrl: 'data:image/png;base64,AAAA',
      message: 'Visible area.',
    });
    expect(read?.blob).toBeInstanceOf(Blob);
    expect(await read?.blob.text()).toBe('bytes of a');
  });

  it('returns undefined for an unknown capture', async () => {
    expect(await getPending('missing')).toBeUndefined();
  });

  it('refuses a second record with the same captureId instead of replacing the first', async () => {
    await putPending(record('a'));
    await expect(putPending(record('a', { filename: 'other.png' }))).rejects.toThrow();
    expect((await getPending('a'))?.filename).toBe(record('a').filename);
  });

  it('stores only the record fields, not extra properties a caller tacks on', async () => {
    const withExtra = { ...record('a'), secret: 'test-key' } as PendingRecord;
    await putPending(withExtra);
    expect(Object.keys((await getPending('a')) ?? {})).not.toContain('secret');
  });

  it('deletes a record and reports whether it existed', async () => {
    await putPending(record('a'));
    expect(await deletePending('a')).toBe(true);
    expect(await getPending('a')).toBeUndefined();
    expect(await deletePending('a')).toBe(false);
  });

  it('lists every record, oldest first', async () => {
    await putPending(record('b', { capturedAt: NOW + 1000 }));
    await putPending(record('a', { capturedAt: NOW }));
    await putPending(record('c', { capturedAt: NOW + 2000 }));
    expect((await listPending()).map((item) => item.captureId)).toEqual(['a', 'b', 'c']);
  });
});

describe('markSaveRequested', () => {
  it('records that Save was pressed, with the note, and returns the updated record', async () => {
    await putPending(record('a'));
    const updated = await markSaveRequested('a', 'For taxes');
    expect(updated).toMatchObject({ captureId: 'a', saveRequested: true, note: 'For taxes' });
    expect(await getPending('a')).toMatchObject({ saveRequested: true, note: 'For taxes' });
    expect(await (await getPending('a'))?.blob.text()).toBe('bytes of a');
  });

  it('returns undefined, and writes nothing, for a capture that is no longer pending', async () => {
    expect(await markSaveRequested('gone', 'x')).toBeUndefined();
    expect(await listPending()).toEqual([]);
  });

  it('keeps the stored fields on a later put of the same record shape', async () => {
    await putPending(record('a', { saveRequested: true, note: 'kept' }));
    expect(await getPending('a')).toMatchObject({ saveRequested: true, note: 'kept' });
  });
});

describe('clearSaveRequested', () => {
  it('takes back a Save request and its note, keeping the capture', async () => {
    await putPending(record('a', { saveRequested: true, note: 'x' }));
    expect(await clearSaveRequested('a')).toBe(true);
    const kept = await getPending('a');
    expect(kept?.saveRequested).toBeUndefined();
    expect(kept?.note).toBeUndefined();
    expect(await kept?.blob.text()).toBe('bytes of a');
  });

  it('does nothing for a capture that is no longer pending', async () => {
    expect(await clearSaveRequested('gone')).toBe(false);
  });
});

describe('setPendingThumbnail', () => {
  it('adds the thumbnail to a stored record', async () => {
    await putPending(record('a'));
    expect(await setPendingThumbnail('a', 'data:image/png;base64,AAAA')).toBe(true);
    expect((await getPending('a'))?.thumbnailDataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('does nothing for a capture that is no longer pending', async () => {
    expect(await setPendingThumbnail('gone', 'data:image/png;base64,AAAA')).toBe(false);
    expect(await listPending()).toEqual([]);
  });
});

describe('deleteExpiredPending', () => {
  it('uses a 24-hour limit', () => {
    expect(PENDING_MAX_AGE_MS).toBe(24 * HOUR);
  });

  it('deletes records older than 24 hours and keeps the rest', async () => {
    await putPending(record('old', { capturedAt: NOW - 25 * HOUR }));
    await putPending(record('just-expired', { capturedAt: NOW - 24 * HOUR - 1 }));
    await putPending(record('exactly-24h', { capturedAt: NOW - 24 * HOUR }));
    await putPending(record('recent', { capturedAt: NOW - HOUR }));
    await putPending(record('future', { capturedAt: NOW + HOUR }));

    expect(await deleteExpiredPending(NOW)).toBe(2);
    expect((await listPending()).map((item) => item.captureId).sort()).toEqual(['exactly-24h', 'future', 'recent']);
  });

  it('never deletes a capture the user pressed Save on, however old', async () => {
    await putPending(record('requested', { capturedAt: NOW - 72 * HOUR, saveRequested: true, note: 'keep' }));
    await putPending(record('abandoned', { capturedAt: NOW - 72 * HOUR }));
    expect(await deleteExpiredPending(NOW)).toBe(1);
    expect((await listPending()).map((item) => item.captureId)).toEqual(['requested']);
  });

  it('accepts a different age limit', async () => {
    await putPending(record('a', { capturedAt: NOW - 2 * HOUR }));
    await putPending(record('b', { capturedAt: NOW - 30 * 60 * 1000 }));
    expect(await deleteExpiredPending(NOW, HOUR)).toBe(1);
    expect((await listPending()).map((item) => item.captureId)).toEqual(['b']);
  });

  it('deletes records without a usable capture time, which can never be aged', async () => {
    await putRaw({ captureId: 'broken', blob: new Blob(['x']) });
    await putRaw({ captureId: 'nan', capturedAt: Number.NaN });
    await putPending(record('fine'));
    expect(await deleteExpiredPending(NOW)).toBe(2);
    expect((await listPending()).map((item) => item.captureId)).toEqual(['fine']);
  });

  it('does nothing on an empty store', async () => {
    expect(await deleteExpiredPending(NOW)).toBe(0);
  });

  it('defaults to the current time', async () => {
    await putPending(record('old', { capturedAt: Date.now() - 25 * HOUR }));
    await putPending(record('new', { capturedAt: Date.now() }));
    expect(await deleteExpiredPending()).toBe(1);
    expect((await listPending()).map((item) => item.captureId)).toEqual(['new']);
  });
});
