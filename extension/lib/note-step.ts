// Note step (spec section 6.4), background only. Every capture flow ends here:
//
// 1. `startNoteStep` writes the capture (bytes and metadata) to the IndexedDB pending store under a new captureId,
//    so a service-worker stop while the user types loses nothing.
// 2. It then shows the note UI: the in-page card (content-scripts/note-card.js, injected on demand) or, when the tab
//    cannot host it (browser pages, the web store, no tab at all), a small note window (note.html?id=<captureId>).
// 3. The card or window answers with `note:save` or `note:discard`. Save first marks the pending record
//    `saveRequested` (with the note), then queues the capture with a description built from the note, then deletes
//    the pending record. Discard deletes it. The window first asks for what to show with `note:get`.
//
// `showMessage` uses the same card (or window) to show a message on its own, for capture errors.
// At service-worker startup (`recoverPendingCaptures`), captures whose Save was requested but never queued (the
// worker stopped in between) are queued, then abandoned pending records older than 24 hours are deleted.

import { browser } from 'wxt/browser';
import { buildDescription } from './description';
import type { CaptureType } from './description';
import { buildFilename } from './filename';
import { isNoteCardResponse } from './messages';
import type {
  NoteCaptureView,
  NoteCardMessage,
  NoteDiscardMessage,
  NoteDiscardResponse,
  NoteGetMessage,
  NoteGetResponse,
  NoteMessageKind,
  NoteRequestMessage,
  NoteSaveMessage,
  NoteSaveResponse,
} from './messages';
import { NOTE_GONE_TEXT, SAVE_FAILED_TEXT, settleWithin } from './note-status';
import {
  clearSaveRequested,
  deleteExpiredPending,
  deletePending,
  getPending,
  listPending,
  markSaveRequested,
  putPending,
  setPendingThumbnail,
} from './pending-store';
import type { PendingRecord } from './pending-store';
import { addItem, enqueue, getItem, processQueue } from './queue';
import type { AttemptOutcome, NewQueueItem, QueueItem } from './queue';
import { getSettings } from './settings';
import type { Settings } from './settings';
import { createThumbnailDataUrl, fileKindFor } from './thumbnail';
import { checkFileSize } from './upload-batch';

export interface StartNoteStepInput {
  /** The tab to show the note card in. Without one (or when the tab cannot host the card) the note window opens. */
  tabId?: number;
  blob: Blob;
  mimeType: string;
  captureType: CaptureType;
  /** Filename source: see `sourceFromUrl` (a web hostname without "www.", or "browser"), or "upload". */
  source: string;
  /** Filename label: page title, or the original filename without its extension. */
  label?: string;
  /** Page title for the description. */
  title?: string;
  /** Page or file URL for the description. */
  url?: string;
  originalFilename?: string;
  /** Extra line in the note UI, such as the visible-area fallback notice. */
  message?: string;
}

export type NoteRequestResponse = NoteGetResponse | NoteSaveResponse | NoteDiscardResponse;

/** What the note step depends on. The background uses the defaults; tests inject their own. */
export interface NoteStepDeps {
  getSettings: () => Promise<Settings | null>;
  openOptionsPage: () => Promise<void>;
  enqueue: (item: NewQueueItem) => Promise<AttemptOutcome>;
  getQueueItem: (captureId: string) => Promise<QueueItem | undefined>;
  now: () => number;
  newCaptureId: () => string;
  /** A thumbnail data URL for an image blob; rejects when the image cannot be decoded. */
  makeThumbnail: (blob: Blob) => Promise<string>;
  /** Runs the note card script in the tab's top frame; rejects when the page cannot be scripted. */
  injectCard: (tabId: number) => Promise<void>;
  /** Sends a message to the card in the tab and resolves with its answer. */
  sendToCard: (tabId: number, message: NoteCardMessage) => Promise<unknown>;
  /** Opens note.html?<query> in a popup window. */
  openWindow: (query: string, size: WindowSize) => Promise<void>;
  /** Stores a queue item without uploading it (worker-start recovery). Rejects if the queue already holds it. */
  addToQueue: (item: NewQueueItem) => Promise<void>;
  /** Asks the queue to upload what is due. */
  processQueue: () => Promise<void>;
  /** How long to wait for the card before falling back to the window. */
  showCardTimeoutMs: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface NoteStep {
  start(input: StartNoteStepInput): Promise<void>;
  showMessage(tabId: number | undefined, message: string, kind: NoteMessageKind): Promise<void>;
  /** Carries out a note:get, note:save, or note:discard request. Never rejects. */
  handle(message: NoteGetMessage): Promise<NoteGetResponse>;
  handle(message: NoteSaveMessage): Promise<NoteSaveResponse>;
  handle(message: NoteDiscardMessage): Promise<NoteDiscardResponse>;
  handle(message: NoteRequestMessage): Promise<NoteRequestResponse>;
  /**
   * Worker start: queues captures whose Save was requested but never queued (deleting, with a warning, any it has not
   * managed to queue for 7 days), then deletes abandoned pending captures older than 24 hours. Resolves with how many
   * were queued and how many deleted.
   */
  recoverPending(): Promise<{ requeued: number; deleted: number }>;
}

/** Built path of the runtime-registered note card content script (entrypoints/note-card.content.ts). */
export const NOTE_CARD_SCRIPT = '/content-scripts/note-card.js';
/**
 * The note window for a capture (spec: popup, about 420 x 320). Taller than that so the fallback notice, the
 * thumbnail, the field, and the buttons fit without scrolling (checked in Chromium: 380 leaves about 350px inside).
 */
export const NOTE_WINDOW_SIZE: WindowSize = { width: 420, height: 380 };
/** The note window for a message on its own. */
export const MESSAGE_WINDOW_SIZE: WindowSize = { width: 420, height: 220 };
/**
 * How long the card may take to appear. Injection waits while the page is blocked (an alert, a hung script); after
 * this the window opens instead, so the user is never left without a note step.
 */
export const SHOW_CARD_TIMEOUT_MS = 5000;

/**
 * A Save request that worker starts have not managed to queue for this long (counted from the capture time) is
 * deleted with a warning, so a capture that can never be queued does not stay in the pending store forever.
 */
export const REQUESTED_SAVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const LOG_PREFIX = 'Capture to Drive:';

const DEFAULT_DEPS: NoteStepDeps = {
  getSettings,
  openOptionsPage: () => browser.runtime.openOptionsPage(),
  enqueue,
  getQueueItem: getItem,
  now: () => Date.now(),
  newCaptureId: () => crypto.randomUUID(),
  makeThumbnail: createThumbnailDataUrl,
  injectCard: async (tabId) => {
    // injectImmediately: do not wait for a page that is still loading to finish.
    await browser.scripting.executeScript({ target: { tabId }, files: [NOTE_CARD_SCRIPT], injectImmediately: true });
  },
  // Only the top frame, where the card script was injected, may answer.
  sendToCard: (tabId, message) => browser.tabs.sendMessage(tabId, message, { frameId: 0 }),
  openWindow: async (query, size) => {
    await browser.windows.create({
      url: `${browser.runtime.getURL('/note.html')}?${query}`,
      type: 'popup',
      width: size.width,
      height: size.height,
      focused: true,
    });
  },
  addToQueue: addItem,
  processQueue,
  showCardTimeoutMs: SHOW_CARD_TIMEOUT_MS,
};

/** The queue item for a pending capture, with the description built from the user's note. */
function queueItemFor(record: PendingRecord, note: string): NewQueueItem {
  return {
    captureId: record.captureId,
    filename: record.filename,
    mimeType: record.mimeType,
    description: buildDescription({
      note,
      title: record.meta.title,
      url: record.meta.url,
      capturedBy: record.meta.capturedBy,
      capturedAt: new Date(record.capturedAt),
      captureType: record.meta.captureType,
      captureId: record.captureId,
    }),
    blob: record.blob,
  };
}

function viewOf(record: PendingRecord): NoteCaptureView {
  const view: NoteCaptureView = { captureId: record.captureId, filename: record.filename, fileKind: record.fileKind };
  if (record.thumbnailDataUrl !== undefined) view.thumbnailDataUrl = record.thumbnailDataUrl;
  if (record.message !== undefined) view.message = record.message;
  return view;
}

export function createNoteStep(overrides: Partial<NoteStepDeps> = {}): NoteStep {
  const deps: NoteStepDeps = { ...DEFAULT_DEPS, ...overrides };
  // Saves in progress, by captureId. A second Save for the same capture joins the first instead of queueing it twice,
  // and a Discard that arrives during the save is ignored (Save was pressed first).
  const saving = new Map<string, Promise<NoteSaveResponse>>();

  /** Shows a message in the tab's card. Resolves true once the card confirms it is showing it. */
  async function showInTab(tabId: number, message: NoteCardMessage): Promise<boolean> {
    let abandoned = false;
    const attempt = (async () => {
      await deps.injectCard(tabId);
      // Gave up waiting and opened the window: a late card would be a second note UI for the same capture.
      if (abandoned) return false;
      const response = await deps.sendToCard(tabId, message);
      return isNoteCardResponse(response) && response.ok;
    })();
    // Undefined when injection or delivery failed, or took too long.
    const shown = await settleWithin(attempt, deps.showCardTimeoutMs);
    if (shown === undefined) abandoned = true;
    return shown === true;
  }

  async function start(input: StartNoteStepInput): Promise<void> {
    const settings = await deps.getSettings();
    if (settings === null) {
      // No mailbox to save to yet: finish setup first. Nothing is kept.
      await deps.openOptionsPage();
      return;
    }
    // The one size check every flow passes through (screenshots are not measured anywhere else). A file the mailbox
    // would refuse is turned away now, before it is stored or a note is typed for it.
    const tooBig = checkFileSize(input.blob.size);
    if (tooBig !== null) {
      await showMessage(input.tabId, tooBig, 'error');
      return;
    }

    const captureId = deps.newCaptureId();
    const capturedAt = deps.now();
    const fileKind = fileKindFor(input.mimeType);
    const record: PendingRecord = {
      captureId,
      capturedAt,
      blob: input.blob,
      mimeType: input.mimeType,
      filename: buildFilename({
        capturedAt: new Date(capturedAt),
        name: settings.name,
        source: input.source,
        label: input.label,
        mimeType: input.mimeType,
        originalFilename: input.originalFilename,
      }),
      meta: { title: input.title, url: input.url, captureType: input.captureType, capturedBy: settings.name },
      fileKind,
      message: input.message,
    };
    // Store the capture first: a thumbnail that is slow or fails must never put the capture itself at risk.
    await putPending(record);
    if (fileKind === 'image') {
      try {
        const thumbnail = await deps.makeThumbnail(input.blob);
        record.thumbnailDataUrl = thumbnail;
        // Stored too, so the note window (note:get) shows it.
        await setPendingThumbnail(captureId, thumbnail);
      } catch {
        // Not decodable here (SVG, for example): the UI shows a file icon. Not storable: the card still gets this copy.
      }
    }

    const view = viewOf(record);
    if (input.tabId !== undefined && (await showInTab(input.tabId, { type: 'note:show', ...view }))) return;
    await deps.openWindow(new URLSearchParams({ id: captureId }).toString(), NOTE_WINDOW_SIZE);
  }

  async function showMessage(tabId: number | undefined, message: string, kind: NoteMessageKind): Promise<void> {
    if (tabId !== undefined && (await showInTab(tabId, { type: 'note:message', message, kind }))) return;
    await deps.openWindow(new URLSearchParams({ message, kind }).toString(), MESSAGE_WINDOW_SIZE);
  }

  async function get(captureId: string): Promise<NoteGetResponse> {
    const record = await getPending(captureId);
    return { capture: record === undefined ? null : viewOf(record) };
  }

  /** The answer for a capture the queue holds: its state there, or will_retry while it waits. */
  function answerForQueued(outcome: AttemptOutcome, item: QueueItem | undefined): NoteSaveResponse {
    if (outcome !== 'needs_attention') return { outcome };
    return { outcome, message: item?.lastMessage ?? SAVE_FAILED_TEXT };
  }

  async function saveNow(captureId: string, note: string): Promise<NoteSaveResponse> {
    // Persist the Save (and the note) first: if this worker stops before the capture is queued, the next worker start
    // queues it from the pending store.
    const record = await markSaveRequested(captureId, note);
    if (record === undefined) return { outcome: 'needs_attention', message: NOTE_GONE_TEXT };

    let outcome: AttemptOutcome;
    try {
      outcome = await deps.enqueue(queueItemFor(record, note));
    } catch (error) {
      // The queue may already hold it (an earlier save stored it, then the worker stopped before the pending record
      // was deleted). Then it is safely queued. Otherwise the capture stays pending, and the save failed.
      const queued = await deps.getQueueItem(captureId);
      if (queued === undefined) {
        console.error(`${LOG_PREFIX} could not queue a capture.`, error);
        // The user is told to capture again, so take the Save request back: otherwise the next worker start would
        // queue this copy as well, and the 24-hour cleanup would never delete it.
        await clearSaveRequested(captureId).catch((clearError: unknown) => {
          console.error(`${LOG_PREFIX} could not take back a failed Save request.`, clearError);
        });
        return { outcome: 'needs_attention', message: SAVE_FAILED_TEXT };
      }
      outcome = queued.status === 'needs_attention' ? 'needs_attention' : 'will_retry';
    }

    try {
      await deletePending(captureId);
    } catch (error) {
      // The capture is queued; the leftover pending copy is deleted by the 24-hour cleanup.
      console.warn(`${LOG_PREFIX} could not delete a pending capture after queueing it.`, error);
    }
    return answerForQueued(outcome, outcome === 'needs_attention' ? await deps.getQueueItem(captureId) : undefined);
  }

  function save(captureId: string, note: string): Promise<NoteSaveResponse> {
    const inProgress = saving.get(captureId);
    if (inProgress !== undefined) return inProgress;
    const done = saveNow(captureId, note)
      .catch((error: unknown): NoteSaveResponse => {
        console.error(`${LOG_PREFIX} saving a capture from the note step failed.`, error);
        return { outcome: 'needs_attention', message: SAVE_FAILED_TEXT };
      })
      .finally(() => {
        saving.delete(captureId);
      });
    saving.set(captureId, done);
    return done;
  }

  async function discard(captureId: string): Promise<NoteDiscardResponse> {
    // Save was pressed first (for example, Esc reached the window while the save was being sent): the save wins,
    // including a save requested before a worker restart, which the next worker start queues.
    if (saving.has(captureId)) return { ok: true };
    if ((await getPending(captureId))?.saveRequested === true) return { ok: true };
    await deletePending(captureId);
    return { ok: true };
  }

  /** Queues one capture whose Save was requested earlier. Resolves true if it was added to the queue now. */
  async function requeue(record: PendingRecord): Promise<boolean> {
    try {
      await deps.addToQueue(queueItemFor(record, record.note ?? ''));
    } catch (error) {
      // Already queued (the worker stopped after queueing, before deleting the pending copy): only clean up, whatever
      // error the add reported. Otherwise keep it for the next start.
      if ((await deps.getQueueItem(record.captureId)) === undefined) {
        console.error(`${LOG_PREFIX} could not queue a saved capture; trying again at the next start.`, error);
        return false;
      }
      await deletePending(record.captureId);
      return false;
    }
    await deletePending(record.captureId);
    return true;
  }

  async function recoverPending(): Promise<{ requeued: number; deleted: number }> {
    let requeued = 0;
    let gaveUp = 0;
    const oldestRequeued = deps.now() - REQUESTED_SAVE_MAX_AGE_MS;
    for (const record of await listPending()) {
      // A save this worker is carrying out right now is not a leftover.
      if (record.saveRequested !== true || saving.has(record.captureId)) continue;
      if (!Number.isFinite(record.capturedAt) || record.capturedAt < oldestRequeued) {
        console.warn(`${LOG_PREFIX} deleting saved capture ${record.captureId}: it could not be queued in 7 days.`);
        await deletePending(record.captureId);
        gaveUp += 1;
        continue;
      }
      const done = requeue(record);
      // A Save of the same capture arriving meanwhile joins this one; a Discard is ignored.
      const queued = (): NoteSaveResponse => ({ outcome: 'will_retry' });
      saving.set(record.captureId, done.then(queued, queued));
      try {
        if (await done) requeued += 1;
      } finally {
        saving.delete(record.captureId);
      }
    }
    if (requeued > 0) {
      deps.processQueue().catch((error: unknown) => {
        console.error(`${LOG_PREFIX} processing the queue after recovering saves failed.`, error);
      });
    }
    // Only after the saves above are queued: the age cleanup never touches a requested save anyway.
    const deleted = gaveUp + (await deleteExpiredPending(deps.now()));
    return { requeued, deleted };
  }

  async function handle(message: NoteRequestMessage): Promise<NoteRequestResponse> {
    try {
      switch (message.type) {
        case 'note:get':
          return await get(message.captureId);
        case 'note:save':
          return await save(message.captureId, message.note);
        case 'note:discard':
          return await discard(message.captureId);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} the ${message.type} request failed.`, error);
      switch (message.type) {
        case 'note:get':
          return { capture: null };
        case 'note:save':
          return { outcome: 'needs_attention', message: SAVE_FAILED_TEXT };
        case 'note:discard':
          return { ok: false };
      }
    }
  }

  return {
    start,
    showMessage,
    handle: handle as NoteStep['handle'],
    recoverPending,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The background's note step, created on first use with the default dependencies.

let defaultStep: NoteStep | null = null;

function noteStep(): NoteStep {
  defaultStep ??= createNoteStep();
  return defaultStep;
}

/**
 * Background only. Stores the capture as pending and shows the note card in `input.tabId` (or the note window).
 * If settings are missing, opens Settings instead and keeps nothing; if the file is over MAX_FILE_BYTES, shows the size
 * message instead and keeps nothing. Resolves once the note UI is showing; rejects if the capture could not be stored
 * or no note UI could be opened.
 */
export function startNoteStep(input: StartNoteStepInput): Promise<void> {
  return noteStep().start(input);
}

/**
 * Background only. Shows a message in the tab's card, or in the note window. An error stays until the user closes it;
 * information goes after 6 s (paused while the pointer or focus is on it).
 */
export function showMessage(tabId: number | undefined, message: string, kind: 'error' | 'info'): Promise<void> {
  return noteStep().showMessage(tabId, message, kind);
}

/** Background only. Carries out a note:get, note:save, or note:discard request. Never rejects. */
export function handleNoteRequest(message: NoteRequestMessage): Promise<NoteRequestResponse> {
  return noteStep().handle(message);
}

/**
 * Background only, at service-worker startup: queues captures whose Save was requested but never queued, then deletes
 * abandoned pending captures older than 24 hours.
 */
export function recoverPendingCaptures(): Promise<{ requeued: number; deleted: number }> {
  return noteStep().recoverPending();
}
