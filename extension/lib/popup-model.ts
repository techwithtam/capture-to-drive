// Logic and copy for the toolbar popup (spec sections 6.3, 6.5, 6.6). No DOM and no browser APIs, so it is tested on
// its own; entrypoints/popup/main.ts only renders what this module decides and sends the messages it builds.

import type { IconName } from './icons';
import type {
  CaptureAreaMessage,
  CapturePageMessage,
  CapturePdfMessage,
  QueueDiscardMessage,
  QueueRetryMessage,
} from './messages';
import type { PdfTabStatus } from './pdf-detect';
import type { QueueItem } from './queue';

// Commands -------------------------------------------------------------------------------------------------------

export type CaptureCommandId = 'area' | 'page' | 'pdf';
export type PopupCommandId = CaptureCommandId | 'upload';

export interface PopupCommand {
  id: PopupCommandId;
  label: string;
  icon: IconName;
}

/** Accessible name of the capture menu (a role="menu" container of real buttons with role="menuitem"). */
export const COMMANDS_MENU_LABEL = 'Capture';

/** The popup's rows, top to bottom. */
export const POPUP_COMMANDS: readonly PopupCommand[] = [
  { id: 'area', label: 'Select area', icon: 'crop' },
  { id: 'page', label: 'Whole page', icon: 'file-text' },
  { id: 'pdf', label: 'Save this PDF', icon: 'file-type-pdf' },
  { id: 'upload', label: 'Upload files…', icon: 'upload' },
];

export type CaptureMessage = CaptureAreaMessage | CapturePageMessage | CapturePdfMessage;

/** The background trigger for a capture row, for the tab that was active when the popup opened. */
export function captureMessage(id: CaptureCommandId, tabId: number): CaptureMessage {
  switch (id) {
    case 'area':
      return { type: 'capture:area', tabId };
    case 'page':
      return { type: 'capture:page', tabId };
    case 'pdf':
      return { type: 'capture:pdf', tabId };
  }
}

/**
 * How long a capture row waits for the background's answer to its trigger before the popup closes. A popup that closes
 * while a stopped (idle) service worker is still starting loses the message, and MV3 stops an idle worker after about
 * 30 s even while the popup stays open. Select area and Whole page answer as soon as their listener has run, so this
 * only costs time while the worker starts. Save this PDF first re-asks tab:pdf-status (which wakes the worker, see
 * `confirmPdfCapture`), and its answer comes once the PDF is fetched and the note step shown, so the popup closes then
 * or after this long, whichever comes first.
 */
export const DELIVERY_WAIT_MS = 2_500;

// Settings gate ----------------------------------------------------------------------------------------------------

export const SETUP_TEXT = 'Set up your mailbox to start saving to Drive.';
export const FINISH_SETUP_LABEL = 'Finish setup';

// Save this PDF ----------------------------------------------------------------------------------------------------

export const NOT_PDF_HINT = 'Open a PDF in this tab to use this.';
export const LOCAL_FILE_HINT = 'Local file? Use Upload files.';

/** How long the popup waits for the background's PDF check (which gives up on its own probes after 1 s). */
export const PDF_STATUS_TIMEOUT_MS = 3_000;

/**
 * The Save this PDF row: `checking` until the background answers `tab:pdf-status`, then the answer, or `unavailable`
 * when the check failed, timed out, or answered with something unexpected.
 */
export type PdfRowState = 'checking' | PdfTabStatus | 'unavailable';

export interface PdfRowView {
  enabled: boolean;
  /** Text under the label explaining why the row is disabled, or null for none. */
  hint: string | null;
  /**
   * Keep an empty hint line, so the row does not grow (and push the rows below it) when the answer is a hint. Most tabs
   * are not PDFs, so the check usually ends with one.
   */
  reserveHint: boolean;
}

export function pdfRowView(state: PdfRowState): PdfRowView {
  switch (state) {
    case 'checking':
      return { enabled: false, hint: null, reserveHint: true };
    case 'pdf':
      return { enabled: true, hint: null, reserveHint: false };
    case 'local-file':
      return { enabled: false, hint: LOCAL_FILE_HINT, reserveHint: false };
    case 'not-pdf':
    case 'unavailable':
      return { enabled: false, hint: NOT_PDF_HINT, reserveHint: false };
  }
}

const PDF_TAB_STATUSES: ReadonlySet<string> = new Set<PdfTabStatus>(['pdf', 'not-pdf', 'local-file']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPdfTabStatus(value: unknown): value is PdfTabStatus {
  return typeof value === 'string' && PDF_TAB_STATUSES.has(value);
}

/** Reads the background's answer to `tab:pdf-status`; no answer or a malformed one is `unavailable`. */
export function pdfRowStateFromResponse(response: unknown): PdfRowState {
  if (!isRecord(response) || !isPdfTabStatus(response.status)) return 'unavailable';
  return response.status;
}

export interface PdfCaptureDecision {
  /** Send capture:pdf now. */
  send: boolean;
  /** The row's state from the re-check, shown when the capture is not sent. */
  state: PdfRowState;
}

/**
 * Save this PDF asks the background `tab:pdf-status` again right before it sends `capture:pdf`. The answer proves the
 * service worker is running (the request wakes a stopped one), so `capture:pdf` is not lost when the popup closes, and
 * it re-checks the tab. Only a `pdf` answer sends the capture; anything else (including no answer in time) updates the
 * row instead.
 */
export function confirmPdfCapture(response: unknown): PdfCaptureDecision {
  const state = pdfRowStateFromResponse(response);
  return { send: state === 'pdf', state };
}

/**
 * What a screen reader announces (through a polite live region) when the Save this PDF re-check, made right before the
 * capture, finds that the row is not usable after all: the row's hint, since the row itself changes silently. Null when
 * the capture goes ahead, or there is no hint to read.
 */
export function pdfRecheckAnnouncement(decision: PdfCaptureDecision): string | null {
  if (decision.send) return null;
  return pdfRowView(decision.state).hint;
}

/**
 * What to speak when someone presses a row that cannot run: Save this PDF's hint (why, and what to do instead). A row
 * that is enabled, or has no hint yet (the PDF check is still running), has nothing to say.
 */
export function disabledRowAnnouncement(id: PopupCommandId, pdf: PdfRowState): string | null {
  if (commandEnabled(id, pdf)) return null;
  return pdfRowView(pdf).hint;
}

/** Select area, Whole page, and Upload files always work; Save this PDF only on a tab the background called a PDF. */
export function commandEnabled(id: PopupCommandId, pdf: PdfRowState): boolean {
  return id === 'pdf' ? pdfRowView(pdf).enabled : true;
}

// Status line ------------------------------------------------------------------------------------------------------

export const ALL_SAVED_TEXT = 'All saved';
export const RETRY_NOW_LABEL = 'Retry now';
export const VIEW_LABEL = 'View';
export const HIDE_LABEL = 'Hide';
export const RETRY_LABEL = 'Retry';
export const DISCARD_LABEL = 'Discard';
/** Shown for a needs-attention item that has no message of its own (same wording as the upload page). */
export const ATTENTION_FALLBACK_MESSAGE = 'Upload needs attention.';

/** Which capture status circle (assets/components.css) the status line shows. */
export type StatusTone = 'saved' | 'waiting' | 'uploading' | 'attention';

export interface StatusLineView {
  text: string;
  tone: StatusTone;
  /** Show Retry now, which makes every waiting item due at once. */
  retryAll: boolean;
  /** Show View (Hide while open): the list of items with a reason to read, each with Retry and Discard. */
  view: boolean;
}

export const QUEUE_UNAVAILABLE_STATUS: StatusLineView = {
  text: "Couldn't check the upload queue.",
  tone: 'attention',
  retryAll: false,
  view: false,
};

/**
 * Failed attempts after which a waiting item shows its last reason (behind View). A reason that lasts this long, such as
 * a full Drive or a deleted Capture folder, will not clear by itself, so the user can read it and Discard the item.
 */
export const REASON_AFTER_FAILED_ATTEMPTS = 3;

type ReasonFields = Pick<QueueItem, 'status' | 'attempts' | 'lastMessage'>;

function hasMessage(item: Pick<QueueItem, 'lastMessage'>): item is { lastMessage: string } {
  return item.lastMessage !== undefined && item.lastMessage !== '';
}

/**
 * A waiting item that has failed at least REASON_AFTER_FAILED_ATTEMPTS times and has a reason. Only finished attempts
 * count: an item being uploaded has one more under way. It stays listed while it is retried.
 */
function keepsFailing(item: ReasonFields): boolean {
  if (item.status === 'needs_attention') return false;
  const failed = item.status === 'uploading' ? item.attempts - 1 : item.attempts;
  return failed >= REASON_AFTER_FAILED_ATTEMPTS && hasMessage(item);
}

/**
 * The popup's summary of the upload queue (spec section 6.5): "All saved", "N waiting to upload" with Retry now (and
 * View once a waiting item keeps failing), or "N needs attention" with View. Needs attention wins, because those items
 * will not upload until someone acts.
 */
export function statusLine(items: readonly ReasonFields[]): StatusLineView {
  const attention = items.filter((item) => item.status === 'needs_attention').length;
  if (attention > 0) {
    return {
      text: `${attention} ${attention === 1 ? 'needs' : 'need'} attention`,
      tone: 'attention',
      retryAll: false,
      view: true,
    };
  }
  const pending = items.length;
  if (pending === 0) return { text: ALL_SAVED_TEXT, tone: 'saved', retryAll: false, view: false };
  const uploading = items.some((item) => item.status === 'uploading');
  return {
    text: `${pending} waiting to upload`,
    tone: uploading ? 'uploading' : 'waiting',
    retryAll: true,
    view: items.some(keepsFailing),
  };
}

/** The list behind View stays open only while there is something in it; it never opens by itself. */
export function keepExpanded(expanded: boolean, line: StatusLineView): boolean {
  return expanded && line.view;
}

// The list behind View ---------------------------------------------------------------------------------------------

/**
 * Accessible name of the list behind View (a `<ul>` of items, set by main.ts). It holds needs-attention items and also
 * waiting items that keep failing, so it is named for what they share: the upload has a problem.
 */
export const ATTENTION_LIST_LABEL = 'Uploads with problems';

/**
 * Spoken before an uploading row's message (visually hidden). The status circle is silent, and the message is still
 * the reason the last attempt failed, which on its own reads as if nothing were happening.
 */
export const UPLOADING_NOW_LABEL = 'Uploading now.';

export interface AttentionEntry {
  captureId: string;
  filename: string;
  message: string;
  /**
   * The item's status circle: needs attention, waiting (it keeps failing but is still retried), or uploading (that
   * retry is under way right now; the row keeps the reason it failed before).
   */
  tone: Extract<StatusTone, 'attention' | 'waiting' | 'uploading'>;
  /**
   * Show Retry and Discard. Not while the item uploads: a retry has nothing to add, and a discard cannot stop the
   * upload, so the file would land in Drive after the popup said it was gone. The buttons return when the attempt ends.
   */
  actions: boolean;
  /** Visually hidden text read before the message when the message alone would mislead, else null. */
  statusLabel: string | null;
}

/**
 * The items behind View, in queue order (oldest first), each with the message that says what is wrong: every
 * needs-attention item, and every waiting item that keeps failing (with its last reason), also while it is retried.
 */
export function attentionEntries(
  items: readonly Pick<QueueItem, 'captureId' | 'filename' | 'status' | 'attempts' | 'lastMessage'>[],
): AttentionEntry[] {
  return items.flatMap((item): AttentionEntry[] => {
    if (item.status === 'needs_attention') {
      const message = hasMessage(item) ? item.lastMessage : ATTENTION_FALLBACK_MESSAGE;
      return [
        { captureId: item.captureId, filename: item.filename, message, tone: 'attention', actions: true, statusLabel: null },
      ];
    }
    if (keepsFailing(item) && hasMessage(item)) {
      const uploading = item.status === 'uploading';
      return [
        {
          captureId: item.captureId,
          filename: item.filename,
          message: item.lastMessage,
          tone: uploading ? 'uploading' : 'waiting',
          actions: !uploading,
          statusLabel: uploading ? UPLOADING_NOW_LABEL : null,
        },
      ];
    }
    return [];
  });
}

/** Retry one item, or (without an id) every waiting item: the status line's Retry now. */
export function retryMessage(captureId?: string): QueueRetryMessage {
  return captureId === undefined ? { type: 'queue:retry' } : { type: 'queue:retry', captureId };
}

export function discardMessage(captureId: string): QueueDiscardMessage {
  return { type: 'queue:discard', captureId };
}

/**
 * Where focus goes when the Retry or Discard button holding it goes away: its item left the list (retried, discarded,
 * or saved), or stayed but lost its buttons (it started uploading). `lostIndex` is where the item was in the list, and
 * `hasActions` says which items of the new list show their buttons, in order. Focus goes to the nearest item from that
 * position on (the item that moved into its place, or the one after a hidden item), else the nearest one before it,
 * else nowhere (null) because no item offers a button.
 */
export function focusIndexAfterActionsLost(lostIndex: number, hasActions: readonly boolean[]): number | null {
  const start = Math.min(Math.max(lostIndex, 0), hasActions.length);
  for (let index = start; index < hasActions.length; index += 1) {
    if (hasActions[index] === true) return index;
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    if (hasActions[index] === true) return index;
  }
  return null;
}

export type AttentionButton = 'retry' | 'discard';

/** What focus does once the list is drawn again: stay, move to a row's button, or go to the status line. */
export type FocusMove =
  | { kind: 'keep' }
  | { kind: 'row'; index: number; button: AttentionButton }
  | { kind: 'fallback' };

/**
 * What to do with focus after the list is redrawn, given the button that held it before (`index` is its item's
 * position in the old list). Nothing, while that button is still there. Otherwise the same button on the next item that
 * shows buttons (see `focusIndexAfterActionsLost`), or the fallback (the status line's View or Hide button) when there
 * is none or the list is closed.
 *
 * One exception: a Discard whose item is still listed goes to the fallback. Its buttons went because the queue
 * changed under the user (an upload started, so a Discard just pressed was refused), not because the user discarded
 * the item, so no other item's Discard may take focus: one more Enter would discard an item the user never chose. Only
 * a Discard that removed its own item hands focus on to the Discard of the item that took its place.
 */
export function focusMoveAfterRender(
  focused: { index: number; captureId: string; button: AttentionButton },
  entries: readonly Pick<AttentionEntry, 'captureId' | 'actions'>[],
  expanded: boolean,
): FocusMove {
  const position = entries.findIndex((entry) => entry.captureId === focused.captureId);
  const listed = position !== -1;
  if (listed && entries[position]?.actions === true) return { kind: 'keep' };
  if (!expanded || (listed && focused.button === 'discard')) return { kind: 'fallback' };
  const index = focusIndexAfterActionsLost(
    listed ? position : focused.index,
    entries.map((entry) => entry.actions),
  );
  return index === null ? { kind: 'fallback' } : { kind: 'row', index, button: focused.button };
}

// Keyboard ---------------------------------------------------------------------------------------------------------

/**
 * Roving tabindex of the capture menu: only the active row is a tab stop, so Tab passes through the menu in one stop
 * and the arrow keys move within it.
 */
export function rovingTabIndex(index: number, active: number): 0 | -1 {
  return index === active ? 0 : -1;
}

export type NavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

const NAVIGATION_KEYS: ReadonlySet<string> = new Set<NavigationKey>(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function isNavigationKey(key: string): key is NavigationKey {
  return NAVIGATION_KEYS.has(key);
}

/**
 * The row that becomes active after a key press. Up and Down step one row and wrap around the ends; Home and End jump
 * to the first and last row. Every row counts, disabled ones included, so their hint can be reached and read.
 */
export function moveSelection(current: number, key: NavigationKey, count: number): number {
  if (count <= 0) return 0;
  const last = count - 1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowDown':
      if (current < 0 || current >= last) return 0;
      return current + 1;
    case 'ArrowUp':
      if (current <= 0 || current > last) return last;
      return current - 1;
  }
}

// ARIA names for the keys `shortcutKeys` returns (Windows and Linux names, and the macOS symbols).
const ARIA_KEY_NAMES: Readonly<Record<string, string>> = {
  Alt: 'Alt',
  '⌥': 'Alt',
  Shift: 'Shift',
  '⇧': 'Shift',
  Ctrl: 'Control',
  MacCtrl: 'Control',
  '⌃': 'Control',
  Command: 'Meta',
  '⌘': 'Meta',
};

/**
 * The `aria-keyshortcuts` value for the Select area shortcut, so assistive technology hears it while the `.kbd` chips
 * stay decorative. Undefined (leave the attribute out) when there is no shortcut or a key has no ARIA name here.
 */
export function ariaKeyShortcuts(keys: readonly string[]): string | undefined {
  if (keys.length === 0) return undefined;
  const names: string[] = [];
  for (const key of keys) {
    const name = ARIA_KEY_NAMES[key] ?? (/^[A-Za-z0-9]$/.test(key) ? key.toUpperCase() : undefined);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names.join('+');
}

// Live refresh -----------------------------------------------------------------------------------------------------

/**
 * Wraps a refresh so overlapping requests never run it twice at once: a request during a run makes exactly one more run
 * after it (however many requests came in), and every caller's promise settles after a run that started after its
 * request. Used to re-read the queue on each `queue:changed` broadcast. The task should handle its own errors; one that
 * rejects ends the current run and its rejection reaches every caller waiting on that run.
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;

  async function drain(): Promise<void> {
    try {
      do {
        again = false;
        await task();
      } while (again);
    } finally {
      running = undefined;
    }
  }

  return () => {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = drain();
    return running;
  };
}
