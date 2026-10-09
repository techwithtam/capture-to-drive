// Pure upload helpers. IDs and timestamps come from the page; only the background processes queued records.
import { buildDescription } from './description';
import { buildFilename, stripExtension } from './filename';
import { MAX_FILE_BYTES } from './mailbox-client';
import type { QueueChangedMessage } from './messages';
import type { NewQueueItem } from './queue';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

export const TOO_BIG_MESSAGE = `Too big for the mailbox (max ${MAX_FILE_BYTES / BYTES_PER_MB} MB). Drag it into Drive directly.`;

export interface UploadRecordInput {
  file: File;
  capturedAt: Date;
  captureId: string;
  name: string;
  note?: string;
}

export interface UploadRowState {
  className: 'status-waiting' | 'status-uploading' | 'status-saved' | 'status-attention';
  text: string;
}

/** The upload page's reason for an empty file. Queued, it would only fail later with a message that cannot help. */
export const EMPTY_FILE_MESSAGE = 'This file is empty.';

/**
 * A new row says "Adding…" until its file is stored in the queue (IndexedDB). From then on it uploads even if the tab
 * is closed. Amber, half-filled ring: in progress, and not yet safe. (The gray dashed ring is Waiting, which means
 * safely queued; red would read as a failure.)
 */
export const ADDING_ROW_STATE: Readonly<UploadRowState> = { className: 'status-uploading', text: 'Adding…' };

/** The row state once the file is stored and waiting its turn. */
export const WAITING_ROW_STATE: Readonly<UploadRowState> = { className: 'status-waiting', text: 'Waiting' };

/**
 * The page message once every file in the batch is stored (a file refused on the spot needs no storing): nothing more
 * can be lost if the tab closes.
 */
export const ALL_QUEUED_MESSAGE = 'Every file is queued. You can close this tab.';

/** Starts the page message when the final start fails and the line above is not showing (some file was not stored). */
export const SOME_QUEUED_MESSAGE = 'Files are queued.';

/** Says what to do when the final start fails: the files are safe in the queue, but nothing uploads until Retry now. */
export const START_FAILED_MESSAGE = "Couldn't start the upload. Use Retry now in the extension popup.";

/** Null means accepted, including a file exactly at the cap. */
export function checkFileSize(bytes: number): string | null {
  return bytes > MAX_FILE_BYTES
    ? TOO_BIG_MESSAGE
    : null;
}

/** A row's status text for a file that failed (spec section 6.3 D.4): "Failed: reason". */
function failedText(reason: string): string {
  return `Failed: ${reason}`;
}

/** The upload page's status for a file turned away on the spot (empty, or over the cap), or null to queue it. */
export function uploadRejection(bytes: number): string | null {
  if (bytes === 0) return failedText(EMPTY_FILE_MESSAGE);
  const tooBig = checkFileSize(bytes);
  return tooBig === null ? null : failedText(tooBig);
}

export interface StoreBatchDeps<T> {
  /** Stores one file in the queue (IndexedDB). */
  store(item: T): Promise<void>;
  /** Asks the background to process the queue (queue:kick); settles once it has, which can take the whole upload. */
  kick(): Promise<void>;
  /** Called at once for a file that is now stored, before the background is asked to start. */
  onStored(item: T): void;
  /** Called at once for a file that could not be stored. */
  onStoreFailed(item: T): void;
}

/** Starts a kick, turning a synchronous throw into a rejection. */
function startKick<T>(deps: StoreBatchDeps<T>): Promise<void> {
  try {
    return deps.kick();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Stores a batch of accepted files one by one, telling the page as each is stored (`onStored`) or fails
 * (`onStoreFailed`), so it can show which files are safe. The background is asked to start as soon as the first file is
 * stored (not waited for: it answers only once the uploads have run), so that file uploads even if the tab is closed
 * while the rest are stored. Once the batch is stored it is asked again, and that answer says whether uploading
 * started: `started` is null when nothing was stored.
 */
export async function storeBatch<T>(
  items: readonly T[],
  deps: StoreBatchDeps<T>,
): Promise<{ stored: number; started: boolean | null }> {
  let stored = 0;
  for (const [index, item] of items.entries()) {
    try {
      await deps.store(item);
    } catch {
      deps.onStoreFailed(item);
      continue;
    }
    deps.onStored(item);
    stored += 1;
    // The final kick below covers the last file; this one only matters while more files are still being stored.
    if (stored === 1 && index < items.length - 1) startKick(deps).catch(() => undefined);
  }
  if (stored === 0) return { stored, started: null };
  try {
    await startKick(deps);
    return { stored, started: true };
  } catch {
    return { stored, started: false };
  }
}

export function buildUploadRecord({ file, capturedAt, captureId, name, note }: UploadRecordInput): NewQueueItem {
  const mimeType = file.type || 'application/octet-stream';
  return {
    captureId,
    filename: buildFilename({
      capturedAt,
      name,
      source: 'upload',
      label: stripExtension(file.name),
      mimeType,
      originalFilename: file.name,
    }),
    mimeType,
    description: buildDescription({ note, capturedBy: name, capturedAt, captureType: 'upload', captureId }),
    blob: file,
  };
}

export function formatFileSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let size = bytes / BYTES_PER_KB;
  let unit = 0;
  while (size >= BYTES_PER_KB && unit < units.length - 1) {
    size /= BYTES_PER_KB;
    unit += 1;
  }
  return `${Number(size.toFixed(1))} ${units[unit]}`;
}

/**
 * Spoken-only text put before a row's new status, so the upload page's live region says which file the status belongs to
 * ("invoice.pdf: Saved") instead of a bare "Saved".
 */
export function statusAnnouncementPrefix(fileName: string): string {
  return `${fileName}: `;
}

/**
 * How long the spoken-only file name stays in a row after its status changed. Long enough for a screen reader to read
 * the live update (even when several are queued), short enough that browsing the list later does not read the name
 * twice.
 */
export const ANNOUNCEMENT_PREFIX_LIFETIME_MS = 8000;

/** A discarded capture has no row. Other states always carry visible text beside the status circle. */
export function rowStateFromBroadcast({ state, message }: QueueChangedMessage): UploadRowState | null {
  switch (state) {
    case 'waiting':
      return { ...WAITING_ROW_STATE };
    case 'uploading':
      return { className: 'status-uploading', text: 'Uploading' };
    case 'saved':
      return { className: 'status-saved', text: 'Saved ✓' };
    case 'needs_attention':
      return { className: 'status-attention', text: failedText(message || 'Upload needs attention.') };
    case 'discarded':
      return null;
  }
}
