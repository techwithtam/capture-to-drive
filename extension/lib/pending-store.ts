// Pending store (spec section 6.4): a capture waits here, bytes and all, from the moment it is taken until the user
// saves or discards it in the note step. The service worker can stop while the user types, so nothing is held only in
// memory. Records abandoned mid-note (tab closed) are deleted after 24 hours, at service-worker startup.
//
// Uses the `pending` store that lib/db.ts creates (keyPath `captureId`). Safe to import from any extension context;
// content scripts cannot reach this database, so the background sends the note card what it shows.

import { PENDING_STORE, transact } from './db';
import type { CaptureType } from './description';
import type { NoteFileKind } from './messages';

/** What the Drive description needs besides the note. */
export interface PendingMeta {
  title?: string;
  url?: string;
  captureType: CaptureType;
  /** The Settings name at capture time ("Captured by"), so filename and description always agree. */
  capturedBy: string;
}

export interface PendingRecord {
  captureId: string;
  /** Capture time (ms since epoch). The filename and description use it, and the 24-hour cleanup counts from it. */
  capturedAt: number;
  blob: Blob;
  mimeType: string;
  /** The final filename, built when the capture was taken. */
  filename: string;
  meta: PendingMeta;
  /** What the note UI shows: a thumbnail for images, a file icon for PDFs and other files. */
  fileKind: NoteFileKind;
  /** Image thumbnail (at most 320px wide) as a data URL, when one could be made. */
  thumbnailDataUrl?: string;
  /** Extra line for the note UI, such as the visible-area fallback notice. */
  message?: string;
  /**
   * Set (with `note`) the moment the user presses Save, before the capture is queued. If the worker stops in between,
   * the next worker start queues it from here, and the 24-hour cleanup never deletes it.
   */
  saveRequested?: boolean;
  /** The note the user saved with, once `saveRequested` is set. */
  note?: string;
}

/** Abandoned note steps are deleted once they are older than this. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function copyRecord(record: PendingRecord): PendingRecord {
  // Copy only the record fields, so nothing a caller tacks on ends up stored.
  const copy: PendingRecord = {
    captureId: record.captureId,
    capturedAt: record.capturedAt,
    blob: record.blob,
    mimeType: record.mimeType,
    filename: record.filename,
    meta: { captureType: record.meta.captureType, capturedBy: record.meta.capturedBy },
    fileKind: record.fileKind,
  };
  if (record.meta.title !== undefined) copy.meta.title = record.meta.title;
  if (record.meta.url !== undefined) copy.meta.url = record.meta.url;
  if (record.thumbnailDataUrl !== undefined) copy.thumbnailDataUrl = record.thumbnailDataUrl;
  if (record.message !== undefined) copy.message = record.message;
  if (record.saveRequested === true) copy.saveRequested = true;
  if (record.note !== undefined) copy.note = record.note;
  return copy;
}

/** Rewrites a stored record in one transaction; resolves with the new record, or undefined if it is gone. */
function updatePending(
  captureId: string,
  change: (current: PendingRecord) => PendingRecord,
): Promise<PendingRecord | undefined> {
  return transact(PENDING_STORE, 'readwrite', (store) => {
    let updated: PendingRecord | undefined;
    const request = store.get(captureId);
    request.onsuccess = () => {
      const current = request.result as PendingRecord | undefined;
      if (current === undefined) return;
      updated = change(current);
      store.put(updated);
    };
    return () => updated;
  });
}

/** Stores a new capture. Rejects (and keeps the existing one) if a record with the same captureId is already there. */
export async function putPending(record: PendingRecord): Promise<void> {
  const copy = copyRecord(record);
  await transact(PENDING_STORE, 'readwrite', (store) => {
    // `add`, not `put`: two captures never share an id, so a clash is a bug and must not overwrite a capture.
    store.add(copy);
    return () => undefined;
  });
}

/** One pending capture, or undefined when it was saved, discarded, or cleaned up. */
export function getPending(captureId: string): Promise<PendingRecord | undefined> {
  return transact(PENDING_STORE, 'readonly', (store) => {
    const request = store.get(captureId);
    return () => request.result as PendingRecord | undefined;
  });
}

/** Deletes one pending capture. Resolves true if it was there. */
export function deletePending(captureId: string): Promise<boolean> {
  return transact(PENDING_STORE, 'readwrite', (store) => {
    let existed = false;
    const request = store.count(captureId);
    request.onsuccess = () => {
      if (request.result === 0) return;
      existed = true;
      store.delete(captureId);
    };
    return () => existed;
  });
}

/**
 * Records that the user pressed Save, with their note, before the capture is queued. Resolves with the updated
 * record, or undefined when the capture is no longer pending.
 */
export function markSaveRequested(captureId: string, note: string): Promise<PendingRecord | undefined> {
  return updatePending(captureId, (current) => ({ ...current, saveRequested: true, note }));
}

/**
 * Takes back a Save request (the save failed and the user was told to capture again), so the next worker start does
 * not queue it after all. The capture stays pending and ages out like any abandoned one. Resolves false when it is gone.
 */
export async function clearSaveRequested(captureId: string): Promise<boolean> {
  const updated = await updatePending(captureId, (current) => {
    const copy = { ...current };
    delete copy.saveRequested;
    delete copy.note;
    return copy;
  });
  return updated !== undefined;
}

/** Adds the thumbnail to a stored capture. Resolves false when the capture is no longer pending. */
export async function setPendingThumbnail(captureId: string, thumbnailDataUrl: string): Promise<boolean> {
  return (await updatePending(captureId, (current) => ({ ...current, thumbnailDataUrl }))) !== undefined;
}

/** Every pending capture, oldest first. */
export async function listPending(): Promise<PendingRecord[]> {
  const records = await transact(PENDING_STORE, 'readonly', (store) => {
    const request = store.getAll();
    return () => request.result as PendingRecord[];
  });
  return records.sort((a, b) => a.capturedAt - b.capturedAt);
}

function isExpired(value: unknown, oldestKept: number): boolean {
  const fields = typeof value === 'object' && value !== null ? (value as Partial<Record<keyof PendingRecord, unknown>>) : {};
  // The user pressed Save on it: it is queued at worker start, never thrown away for its age.
  if (fields.saveRequested === true) return false;
  const { capturedAt } = fields;
  // A record without a usable capture time can never be aged, so it goes too.
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return true;
  return capturedAt < oldestKept;
}

/**
 * Deletes pending captures older than `maxAgeMs` (default 24 hours), in one transaction, except captures the user
 * pressed Save on. Run at service-worker startup, after those have been queued. Resolves with the number deleted.
 */
export function deleteExpiredPending(now: number = Date.now(), maxAgeMs: number = PENDING_MAX_AGE_MS): Promise<number> {
  const oldestKept = now - maxAgeMs;
  return transact(PENDING_STORE, 'readwrite', (store) => {
    let deleted = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      if (isExpired(cursor.value, oldestKept)) {
        cursor.delete();
        deleted += 1;
      }
      cursor.continue();
    };
    return () => deleted;
  });
}
