// Upload queue (spec section 6.5). Every capture is stored in IndexedDB first and stays there until the mailbox has
// it, so nothing is lost when the network, the mailbox, or the service worker goes away mid-upload.
//
// Two layers:
// - Storage (`addItem`, `listItems`, `getItem`) works in any extension context. Pages add items and ask the
//   background to process them with a `queue:kick` message.
// - Processing (`enqueue`, `processQueue`, `retryNow`, `discard`) runs only in the background service worker, which
//   creates the one processor with `installQueueProcessor()`. Anywhere else those calls reject.
//
// Processing is single-flight: one "drain" at a time uploads due items one by one, oldest first. Calls that arrive
// while a drain runs (a new capture, the retry alarm, Retry now) join it instead of starting a second one. After every
// state change the processor tells open pages (`queue:changed`) and refreshes the badge and the `retry` alarm.

import { browser } from 'wxt/browser';
import { updateBadge } from './badge';
import { QUEUE_STATUS_INDEX, QUEUE_STORE, transact } from './db';
import { MAX_FILE_BYTES, saveToMailbox } from './mailbox-client';
import type { MailboxResult, MailboxSettings, SavePayload } from './mailbox-client';
import { isNoReceiverError } from './messages';
import type { QueueChangedMessage, QueueChangedState, QueueRequestMessage } from './messages';
import { getSettings } from './settings';

export type QueueStatus = 'waiting' | 'uploading' | 'needs_attention';

export interface QueueItem {
  captureId: string;
  createdAt: number;
  filename: string;
  mimeType: string;
  description: string;
  blob: Blob;
  /** Upload attempts started so far. */
  attempts: number;
  /** When the item may be tried again (ms since epoch). Due when `nextAttemptAt <= now`. */
  nextAttemptAt: number;
  status: QueueStatus;
  /** Error code of the last failed attempt, for example `network` or `unauthorized`. */
  lastError?: string;
  /**
   * UI text for the last failed attempt: for a `needs_attention` item, the spec wording keyed on the error code; for a
   * waiting item, the reason the attempt failed, which the popup shows once the item keeps failing.
   */
  lastMessage?: string;
}

export type AttemptOutcome = 'saved' | 'will_retry' | 'needs_attention';

export interface NewQueueItem {
  captureId: string;
  filename: string;
  mimeType: string;
  description: string;
  blob: Blob;
}

export type SaveFunction = (
  payload: SavePayload,
  settings: MailboxSettings,
  options: { timeoutMs: number },
) => Promise<MailboxResult>;

/** What the processor depends on. The background uses the defaults; tests inject their own. */
export interface QueueDeps {
  save: SaveFunction;
  /** Null while settings are missing or incomplete: items then wait without being tried. */
  getSettings: () => Promise<MailboxSettings | null>;
  now: () => number;
  /** A cheap extension API call, repeated during an upload so the browser does not stop the worker mid-request. */
  keepAlivePing: () => Promise<unknown>;
}

export interface QueueProcessor {
  /** Stores the item and tries it right away; resolves with the outcome of this item's first attempt. */
  enqueue(item: NewQueueItem): Promise<AttemptOutcome>;
  /** Uploads every due item, oldest first; resolves when none is left to try now. */
  processQueue(): Promise<void>;
  /** Makes one item (or, without an id, every waiting item) due now, then processes the queue. */
  retryNow(captureId?: string): Promise<void>;
  /**
   * Removes an item without uploading it. Resolves false, leaving the item alone, while it is being uploaded: that
   * upload cannot be stopped, so a discard would report the file as gone while it still lands in Drive. Resolves true
   * once the item is gone, including when it was not in the queue.
   */
  discard(captureId: string): Promise<boolean>;
  /** Worker start: puts uploads cut off by a worker stop back in line and restores the badge and alarm. No upload. */
  recover(): Promise<void>;
  /** Carries out a `queue:kick`, `queue:retry`, or `queue:discard` request. Resolves false for a refused discard. */
  handle(message: QueueRequestMessage): Promise<boolean>;
}

type NeedsAttentionError = Extract<MailboxResult, { kind: 'needs_attention' }>['error'];

/** Name of the alarm that wakes the worker for the next retry. */
export const RETRY_ALARM = 'retry';
/** How often the worker pings itself awake while an upload is in flight. */
export const KEEP_ALIVE_INTERVAL_MS = 20_000;
/**
 * How long past its own timeout an upload may run before the queue stops waiting for it. The mailbox client already
 * aborts at its timeout; this only guards against a request that ignores the abort, which would otherwise stall the
 * queue (and, with the keep-alive, keep the worker awake) forever.
 */
export const UPLOAD_WATCHDOG_GRACE_MS = 30_000;
/**
 * When an item is overdue but could not be tried (settings missing, or a failed pass), the retry alarm checks back
 * after this long instead of firing again at once.
 */
export const OVERDUE_RECHECK_MS = 5 * 60_000;

/** UI text for each needs-attention error (spec section 6.5). */
export const NEEDS_ATTENTION_MESSAGES: Readonly<Record<NeedsAttentionError, string>> = {
  unauthorized: 'Mailbox key was rejected. Check Settings.',
  too_large: 'Too big for the mailbox.',
  bad_request: "This capture couldn't be read. Discard it and capture again.",
  not_found: 'Mailbox not found. Check the URL in Settings.',
};

/**
 * The reason stored for a retryable failure with no usable wording of its own: a network failure (the browser says only
 * "Failed to fetch") or an upload that failed unexpectedly.
 */
export const UNREACHABLE_MESSAGE = "Couldn't reach Drive. Check your internet connection.";

const MINUTE_MS = 60_000;
const MAX_BACKOFF_MINUTES = 30;
const BACKOFF_MINUTES: readonly number[] = [1, 2, 5, 10, MAX_BACKOFF_MINUTES];
const BASE_UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_PER_MB_MS = 10_000;
const BYTES_PER_MB = 1024 * 1024;
const LOG_PREFIX = 'Capture to Drive:';

/** Delay after attempt number `attempts` (1-based): 1, 2, 5, 10, then 30 minutes from then on. */
export function backoffDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return (BACKOFF_MINUTES[index] ?? MAX_BACKOFF_MINUTES) * MINUTE_MS;
}

/** Upload timeout for a file of `bytes`: 60 s plus 10 s per started megabyte (20 MB gets 260 s). */
export function uploadTimeoutMs(bytes: number): number {
  return BASE_UPLOAD_TIMEOUT_MS + UPLOAD_TIMEOUT_PER_MB_MS * Math.ceil(bytes / BYTES_PER_MB);
}

// ---------------------------------------------------------------------------------------------------------------
// Storage. Records in the queue store are written only by this module.

function byAge(a: QueueItem, b: QueueItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.captureId < b.captureId ? -1 : a.captureId > b.captureId ? 1 : 0;
}

function withoutMessage(item: QueueItem): QueueItem {
  const copy = { ...item };
  delete copy.lastMessage;
  return copy;
}

/** UI text for a retryable failure: the mailbox's or client's own reason, unless it has none worth reading. */
function retryableMessage(result: Extract<MailboxResult, { kind: 'retryable' }>): string {
  if (result.error === 'network' || result.message === undefined || result.message.trim() === '') {
    return UNREACHABLE_MESSAGE;
  }
  return result.message;
}

function blobSize(item: QueueItem): number {
  return item.blob instanceof Blob ? item.blob.size : 0;
}

async function storeNewItem(item: NewQueueItem, now: number): Promise<void> {
  // Copy only the queue fields, so nothing a caller tacks on ends up stored.
  const record: QueueItem = {
    captureId: item.captureId,
    createdAt: now,
    filename: item.filename,
    mimeType: item.mimeType,
    description: item.description,
    blob: item.blob,
    attempts: 0,
    nextAttemptAt: now,
    status: 'waiting',
  };
  // `add`, not `put`: a second item with the same captureId is a bug and must not replace one still waiting.
  await transact(QUEUE_STORE, 'readwrite', (store) => {
    store.add(record);
    return () => undefined;
  });
}

function readAllItems(): Promise<QueueItem[]> {
  return transact(QUEUE_STORE, 'readonly', (store) => {
    const request = store.getAll();
    return () => request.result as QueueItem[];
  });
}

/** Stores a capture as a waiting item, due now. Any extension context; it does not upload anything. */
export function addItem(item: NewQueueItem): Promise<void> {
  return storeNewItem(item, Date.now());
}

/** Every queue item, oldest first. Any extension context. */
export async function listItems(): Promise<QueueItem[]> {
  return (await readAllItems()).sort(byAge);
}

/** One queue item, or undefined if it is not (or no longer) in the queue. Any extension context. */
export function getItem(captureId: string): Promise<QueueItem | undefined> {
  return transact(QUEUE_STORE, 'readonly', (store) => {
    const request = store.get(captureId);
    return () => request.result as QueueItem | undefined;
  });
}

/**
 * Atomically picks the oldest due waiting item and marks it uploading. Its attempt count and next attempt time are
 * set now, so an upload cut off by a worker stop still counts and still waits out its backoff.
 */
function claimNextDue(now: number): Promise<QueueItem | undefined> {
  return transact(QUEUE_STORE, 'readwrite', (store) => {
    let claimed: QueueItem | undefined;
    const request = store.index(QUEUE_STATUS_INDEX).getAll('waiting');
    request.onsuccess = () => {
      const due = (request.result as QueueItem[]).filter((item) => item.nextAttemptAt <= now).sort(byAge);
      const next = due[0];
      if (next === undefined) return;
      const attempts = next.attempts + 1;
      claimed = { ...next, status: 'uploading', attempts, nextAttemptAt: now + backoffDelayMs(attempts) };
      store.put(claimed);
    };
    return () => claimed;
  });
}

/** Rewrites an item if it is still in the queue; returns false if it was removed meanwhile. */
function updateIfPresent(captureId: string, change: (current: QueueItem) => QueueItem): Promise<boolean> {
  return transact(QUEUE_STORE, 'readwrite', (store) => {
    let updated = false;
    const request = store.get(captureId);
    request.onsuccess = () => {
      const current = request.result as QueueItem | undefined;
      if (current === undefined) return;
      store.put(change(current));
      updated = true;
    };
    return () => updated;
  });
}

function deleteItem(captureId: string): Promise<boolean> {
  return transact(QUEUE_STORE, 'readwrite', (store) => {
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

type DiscardResult = 'removed' | 'missing' | 'uploading';

/**
 * Deletes an item unless it is being uploaded. The check and the delete share one transaction, so an item the drain
 * claims at the same moment is either removed first (and never claimed) or refused here, never both.
 */
function deleteUnlessUploading(captureId: string): Promise<DiscardResult> {
  return transact(QUEUE_STORE, 'readwrite', (store) => {
    let result: DiscardResult = 'missing';
    const request = store.get(captureId);
    request.onsuccess = () => {
      const current = request.result as QueueItem | undefined;
      if (current === undefined) return;
      if (current.status === 'uploading') {
        result = 'uploading';
        return;
      }
      store.delete(captureId);
      result = 'removed';
    };
    return () => result;
  });
}

/** Back to `waiting` for every item a stopped worker left marked `uploading`. Keeps their next attempt time. */
function resetInterruptedUploads(): Promise<string[]> {
  return transact(QUEUE_STORE, 'readwrite', (store) => {
    const reset: string[] = [];
    const request = store.index(QUEUE_STATUS_INDEX).getAll('uploading');
    request.onsuccess = () => {
      for (const item of request.result as QueueItem[]) {
        store.put({ ...item, status: 'waiting' });
        reset.push(item.captureId);
      }
    };
    return () => reset;
  });
}

/** Makes items due now. Leaves items being uploaded alone. Returns the ids that changed state. */
function makeDue(captureId: string | undefined, now: number): Promise<string[]> {
  return transact(QUEUE_STORE, 'readwrite', (store) => {
    const nowWaiting: string[] = [];
    const retry = (item: QueueItem) => {
      if (item.status === 'uploading') return;
      if (item.status === 'waiting' && item.nextAttemptAt <= now) return;
      // A needs-attention message no longer applies once the item is retried. A waiting item keeps its last reason
      // until the attempt it is about to get replaces it, so the popup does not lose it in between.
      const kept = item.status === 'needs_attention' ? withoutMessage(item) : item;
      store.put({ ...kept, status: 'waiting', nextAttemptAt: now });
      if (item.status !== 'waiting') nowWaiting.push(item.captureId);
    };
    if (captureId === undefined) {
      // "Retry now" for the whole queue covers waiting items only; a needs-attention item is retried on its own.
      const request = store.index(QUEUE_STATUS_INDEX).getAll('waiting');
      request.onsuccess = () => {
        for (const item of request.result as QueueItem[]) retry(item);
      };
    } else {
      const request = store.get(captureId);
      request.onsuccess = () => {
        const item = request.result as QueueItem | undefined;
        if (item !== undefined) retry(item);
      };
    }
    return () => nowWaiting;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Side channels: broadcasts to open pages, badge, and retry alarm. None of these may ever stop an upload.

function broadcastChange(captureId: string, state: QueueChangedState, message?: string): void {
  const change: QueueChangedMessage =
    message === undefined
      ? { type: 'queue:changed', captureId, state }
      : { type: 'queue:changed', captureId, state, message };
  try {
    // Fire and forget: a page that never answers must not hold up the queue.
    Promise.resolve(browser.runtime.sendMessage(change)).catch(reportBroadcastError);
  } catch (error) {
    reportBroadcastError(error);
  }
}

function reportBroadcastError(error: unknown): void {
  // No extension page open to hear it: the normal case for a broadcast.
  if (isNoReceiverError(error)) return;
  console.warn(`${LOG_PREFIX} could not tell open pages about a queue change.`, error);
}

async function scheduleRetryAlarm(items: readonly QueueItem[], now: number): Promise<void> {
  // Every item that will be tried again counts, including one marked uploading: its nextAttemptAt is when it is
  // retried if this worker stops mid-upload, and the alarm is what wakes a stopped worker.
  const times = items.filter((item) => item.status !== 'needs_attention').map((item) => item.nextAttemptAt);
  if (times.length === 0) {
    await browser.alarms.clear(RETRY_ALARM);
    return;
  }
  const earliest = Math.min(...times);
  await browser.alarms.create(RETRY_ALARM, { when: earliest > now ? earliest : now + OVERDUE_RECHECK_MS });
}

// ---------------------------------------------------------------------------------------------------------------
// Processor.

const DEFAULT_DEPS: QueueDeps = {
  save: (payload, settings, options) => saveToMailbox(payload, settings, options),
  getSettings,
  now: () => Date.now(),
  keepAlivePing: () => browser.runtime.getPlatformInfo(),
};

export function createQueueProcessor(overrides: Partial<QueueDeps> = {}): QueueProcessor {
  const deps: QueueDeps = { ...DEFAULT_DEPS, ...overrides };

  // Single flight: `draining` is the one drain in progress, if any. `processRequested` asks it to (re)scan for due
  // items; it is checked again after every pass, so a request that arrives mid-drain is never dropped.
  let draining: Promise<void> | null = null;
  let processRequested = false;
  // Callers of enqueue waiting for their item's first attempt.
  const firstAttemptWaiters = new Map<string, Array<(outcome: AttemptOutcome) => void>>();
  // Badge and alarm updates run one at a time, each reading the queue when it runs, so the last one always shows
  // the latest state even when updates from a drain and from discard overlap.
  let indicators: Promise<void> = Promise.resolve();

  function ensureDraining(): Promise<void> {
    // drain() always awaits before it can finish, so `draining` is assigned before drain() clears it.
    if (draining === null) draining = drain();
    return draining;
  }

  function requestProcessing(): Promise<void> {
    processRequested = true;
    return ensureDraining();
  }

  async function drain(): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      // No upload can be in flight when a drain starts (drains never overlap, and other contexts never process),
      // so anything still marked uploading was cut off by a stopped worker or a failed write.
      for (const captureId of await resetInterruptedUploads()) broadcastChange(captureId, 'waiting');
      for (;;) {
        while (processRequested) {
          processRequested = false;
          await processDueItems();
        }
        await refreshIndicators();
        if (!processRequested) break;
      }
    } catch (error) {
      failure = { error };
      // Best effort, so the alarm still brings the worker back for whatever is left.
      await refreshIndicators();
    }
    // Nothing between the last check of processRequested and here awaits, so no request slips by unseen.
    draining = null;
    // A waiter still here was not tried: its item got a whole pass after it was added but could not go (no settings
    // yet, or it was discarded), or this drain failed. Either way the item stays queued and is retried later.
    for (const captureId of [...firstAttemptWaiters.keys()]) resolveWaiters(captureId, 'will_retry');
    if (failure !== undefined) throw failure.error;
  }

  async function processDueItems(): Promise<void> {
    for (;;) {
      // Read settings before claiming, so nothing is marked uploading that cannot be sent.
      const settings = await deps.getSettings();
      if (settings === null) return;
      const item = await claimNextDue(deps.now());
      if (item === undefined) return;
      await attempt(item, settings);
    }
  }

  async function attempt(item: QueueItem, settings: MailboxSettings): Promise<void> {
    broadcastChange(item.captureId, 'uploading');
    await refreshIndicators();
    const result = await upload(item, settings);
    const outcome = await recordResult(item.captureId, result, deps.now());
    await refreshIndicators();
    // Resolved last, so whoever waits on this attempt sees the queue, badge, and alarm already updated.
    resolveWaiters(item.captureId, outcome);
  }

  async function upload(item: QueueItem, settings: MailboxSettings): Promise<MailboxResult> {
    // The capture flows turn oversize files away before they are queued; anything that got past them would only be
    // refused by the mailbox after a long upload, so it is not sent.
    if (blobSize(item) > MAX_FILE_BYTES) return { kind: 'needs_attention', error: 'too_large' };
    const timeoutMs = uploadTimeoutMs(blobSize(item));
    const payload: SavePayload = {
      captureId: item.captureId,
      filename: item.filename,
      mimeType: item.mimeType,
      description: item.description,
      blob: item.blob,
    };
    const keepAlive = setInterval(keepWorkerAwake, KEEP_ALIVE_INTERVAL_MS);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<MailboxResult>((resolve) => {
      watchdog = setTimeout(
        () => resolve({ kind: 'retryable', error: 'timeout', message: 'The upload did not finish in time.' }),
        timeoutMs + UPLOAD_WATCHDOG_GRACE_MS,
      );
    });
    try {
      return await Promise.race([callSave(payload, settings, timeoutMs), abandoned]);
    } finally {
      clearTimeout(watchdog);
      clearInterval(keepAlive);
    }
  }

  async function callSave(payload: SavePayload, settings: MailboxSettings, timeoutMs: number): Promise<MailboxResult> {
    try {
      return await deps.save(payload, settings, { timeoutMs });
    } catch (error) {
      // saveToMailbox never throws; if a save function does anyway, treat it as transient and try again later.
      console.warn(`${LOG_PREFIX} the upload failed unexpectedly.`, error);
      return { kind: 'retryable', error: 'unexpected_error' };
    }
  }

  function keepWorkerAwake(): void {
    try {
      deps.keepAlivePing().catch(() => undefined);
    } catch {
      // The ping only keeps the worker awake; if it fails there is nothing to do.
    }
  }

  async function recordResult(captureId: string, result: MailboxResult, finishedAt: number): Promise<AttemptOutcome> {
    switch (result.kind) {
      case 'success':
        await deleteItem(captureId);
        broadcastChange(captureId, 'saved');
        return 'saved';
      case 'retryable': {
        // An item that was removed during its upload (discard refuses one in flight, so this is only a safeguard) stays
        // gone. The reason is kept for the popup, which shows it once the item keeps failing (a full Drive or a deleted
        // Capture folder never clears by itself).
        const kept = await updateIfPresent(captureId, (current) => ({
          ...current,
          status: 'waiting',
          nextAttemptAt: finishedAt + backoffDelayMs(current.attempts),
          lastError: result.error,
          lastMessage: retryableMessage(result),
        }));
        if (kept) broadcastChange(captureId, 'waiting');
        return 'will_retry';
      }
      case 'needs_attention': {
        // The UI text is chosen by error code; the mailbox's own message is never shown.
        const message = NEEDS_ATTENTION_MESSAGES[result.error];
        const kept = await updateIfPresent(captureId, (current) => ({
          ...current,
          status: 'needs_attention',
          lastError: result.error,
          lastMessage: message,
        }));
        if (kept) broadcastChange(captureId, 'needs_attention', message);
        return 'needs_attention';
      }
    }
  }

  function resolveWaiters(captureId: string, outcome: AttemptOutcome): void {
    const waiters = firstAttemptWaiters.get(captureId);
    if (waiters === undefined) return;
    firstAttemptWaiters.delete(captureId);
    for (const resolve of waiters) resolve(outcome);
  }

  function refreshIndicators(): Promise<void> {
    indicators = indicators.then(updateIndicators);
    return indicators;
  }

  /** Never rejects: a badge or alarm failure is logged and the queue carries on. */
  async function updateIndicators(): Promise<void> {
    let items: QueueItem[];
    try {
      items = await readAllItems();
    } catch (error) {
      console.error(`${LOG_PREFIX} could not read the upload queue for the badge.`, error);
      return;
    }
    try {
      await updateBadge(items);
    } catch (error) {
      console.error(`${LOG_PREFIX} could not update the badge.`, error);
    }
    try {
      await scheduleRetryAlarm(items, deps.now());
    } catch (error) {
      console.error(`${LOG_PREFIX} could not schedule the retry alarm.`, error);
    }
  }

  async function enqueueItem(item: NewQueueItem): Promise<AttemptOutcome> {
    await storeNewItem(item, deps.now());
    broadcastChange(item.captureId, 'waiting');
    // Register the waiter and request processing in one synchronous step, so the drain cannot finish in between.
    const outcome = new Promise<AttemptOutcome>((resolve) => {
      const waiters = firstAttemptWaiters.get(item.captureId) ?? [];
      waiters.push(resolve);
      firstAttemptWaiters.set(item.captureId, waiters);
    });
    // A failed drain settles this item's waiter itself; the error only needs logging.
    requestProcessing().catch((error: unknown) => {
      console.error(`${LOG_PREFIX} processing the upload queue failed.`, error);
    });
    return outcome;
  }

  async function retryItems(captureId?: string): Promise<void> {
    for (const id of await makeDue(captureId, deps.now())) broadcastChange(id, 'waiting');
    await requestProcessing();
  }

  async function discardItem(captureId: string): Promise<boolean> {
    const result = await deleteUnlessUploading(captureId);
    // An upload in flight cannot be called back, so the item stays and nothing about it changed.
    if (result === 'uploading') return false;
    if (result === 'removed') broadcastChange(captureId, 'discarded');
    await refreshIndicators();
    return true;
  }

  async function handleRequest(message: QueueRequestMessage): Promise<boolean> {
    switch (message.type) {
      case 'queue:kick':
        await requestProcessing();
        return true;
      case 'queue:retry':
        await retryItems(message.captureId);
        return true;
      case 'queue:discard':
        return discardItem(message.captureId);
    }
  }

  return {
    enqueue: enqueueItem,
    processQueue: requestProcessing,
    retryNow: retryItems,
    discard: discardItem,
    recover: ensureDraining,
    handle: handleRequest,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The background's processor. Only the background service worker installs one; in any other context the processing
// calls below reject, so a page can never upload alongside the worker.

let installed: QueueProcessor | null = null;

/** Background only: creates this worker's processor. Call once, at the top of the background entry point. */
export function installQueueProcessor(overrides: Partial<QueueDeps> = {}): QueueProcessor {
  installed = createQueueProcessor(overrides);
  return installed;
}

function installedProcessor(): QueueProcessor {
  if (installed === null) {
    throw new Error(
      'The upload queue is processed only in the background service worker. Pages add items with addItem() and send { type: "queue:kick" }.',
    );
  }
  return installed;
}

/** Background only: add + process; resolves with this item's first-attempt outcome. */
export async function enqueue(item: NewQueueItem): Promise<AttemptOutcome> {
  return installedProcessor().enqueue(item);
}

/** Background only. */
export async function processQueue(): Promise<void> {
  return installedProcessor().processQueue();
}

/** Background only. */
export async function retryNow(captureId?: string): Promise<void> {
  return installedProcessor().retryNow(captureId);
}

/** Background only. Resolves false, leaving the item alone, while it is being uploaded. */
export async function discard(captureId: string): Promise<boolean> {
  return installedProcessor().discard(captureId);
}
