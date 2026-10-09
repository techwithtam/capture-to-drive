// Every runtime message the extension sends, as one discriminated union. A new message type is added here.
// Safe to import from any extension context, including content scripts (it has no browser API dependencies).

import type { AttemptOutcome } from './queue';
import type { PdfTabStatus } from './pdf-detect';
import type { SelectionRect } from './selection-rect';
import { isValidSelection } from './selection-rect';

/** What happened to a queued capture. `discarded` is sent when the user removes an item from the queue. */
export type QueueChangedState = 'saved' | 'waiting' | 'uploading' | 'needs_attention' | 'discarded';

/** Background -> pages: a queue item changed state. `message` is the UI text for `needs_attention`. */
export interface QueueChangedMessage {
  type: 'queue:changed';
  captureId: string;
  state: QueueChangedState;
  message?: string;
}

/** Pages -> background: process the queue now (for example after adding items with `addItem`). */
export interface QueueKickMessage {
  type: 'queue:kick';
}

/** Pages -> background: retry one item now, or (without `captureId`) every waiting item. */
export interface QueueRetryMessage {
  type: 'queue:retry';
  captureId?: string;
}

/**
 * Pages -> background: remove an item from the queue without uploading it. Refused (answered with `ok: false`, item
 * untouched) while the item is being uploaded: that upload cannot be stopped, so the file would still reach Drive.
 */
export interface QueueDiscardMessage {
  type: 'queue:discard';
  captureId: string;
}

export type QueueRequestMessage = QueueKickMessage | QueueRetryMessage | QueueDiscardMessage;

/**
 * The background's answer to a queue request, sent once it has been handled. `ok` is false when the request failed, and
 * also when a discard was refused because its item is being uploaded (the item stays in the queue).
 */
export interface QueueRequestResponse {
  ok: boolean;
}

// Note step (spec section 6.4). -----------------------------------------------------------------------------------

/** How the note UI shows a capture: a thumbnail for images, a file icon plus the filename for everything else. */
export type NoteFileKind = 'image' | 'pdf' | 'file';

/** Everything the note card or note window renders for one capture (content scripts cannot read IndexedDB). */
export interface NoteCaptureView {
  captureId: string;
  /** The final filename, shown read-only. */
  filename: string;
  fileKind: NoteFileKind;
  /** An image thumbnail at most 320px wide, as a `data:image/...` URL. */
  thumbnailDataUrl?: string;
  /** Extra line, such as the visible-area fallback notice. */
  message?: string;
}

/** Background -> note card (tabs.sendMessage): show the note step for a capture. */
export interface NoteShowMessage extends NoteCaptureView {
  type: 'note:show';
}

export type NoteMessageKind = 'error' | 'info';

/** Background -> note card: show a message on its own, with a Close button. */
export interface NoteMessageMessage {
  type: 'note:message';
  message: string;
  kind: NoteMessageKind;
}

export type NoteCardMessage = NoteShowMessage | NoteMessageMessage;

/** The note card's answer to a NoteCardMessage: whether it is now showing it. */
export interface NoteCardResponse {
  ok: boolean;
}

/** Note window -> background: what to show for a capture. Answered with NoteGetResponse. */
export interface NoteGetMessage {
  type: 'note:get';
  captureId: string;
}

/** Note card or window -> background: save the capture with this note (may be empty). Answered with NoteSaveResponse. */
export interface NoteSaveMessage {
  type: 'note:save';
  captureId: string;
  note: string;
}

/** Note card or window -> background: delete the capture without saving it. Answered with NoteDiscardResponse. */
export interface NoteDiscardMessage {
  type: 'note:discard';
  captureId: string;
}

export type NoteRequestMessage = NoteGetMessage | NoteSaveMessage | NoteDiscardMessage;

/** `capture` is null when the capture is no longer pending (saved, discarded, or cleaned up). */
export interface NoteGetResponse {
  capture: NoteCaptureView | null;
}

/** The outcome of the capture's first upload attempt. `message` is the UI text for `needs_attention`. */
export interface NoteSaveResponse {
  outcome: AttemptOutcome;
  message?: string;
}

export interface NoteDiscardResponse {
  ok: boolean;
}

export interface TabPdfStatusMessage {
  type: 'tab:pdf-status';
  tabId: number;
}

export interface TabPdfStatusResponse {
  status: PdfTabStatus;
}

export interface CapturePdfMessage {
  type: 'capture:pdf';
  tabId: number;
}

export interface CapturePdfResponse {
  ok: boolean;
}

export interface CaptureAreaMessage {
  type: 'capture:area';
  tabId: number;
}

export interface SelectAreaDoneMessage {
  type: 'select-area:done';
  rect: SelectionRect;
  viewportWidth: number;
  viewportHeight: number;
}

export interface SelectAreaCancelMessage {
  type: 'select-area:cancel';
}

/** Overlay -> background: Enter was pressed with no drag in progress, so capture the whole visible area (no crop). */
export interface SelectAreaVisibleMessage {
  type: 'select-area:visible';
}

/** Background -> selection overlay: tear down without sending a cancellation back. */
export interface SelectAreaAbortMessage {
  type: 'select-area:abort';
}

export type SelectAreaMessage = SelectAreaDoneMessage | SelectAreaCancelMessage | SelectAreaVisibleMessage;

export type RuntimeMessage =
  | QueueChangedMessage
  | QueueRequestMessage
  | NoteCardMessage
  | NoteRequestMessage
  | CapturePageMessage
  | TabPdfStatusMessage
  | CapturePdfMessage
  | CaptureAreaMessage
  | SelectAreaMessage
  | SelectAreaAbortMessage;

const QUEUE_CHANGED_STATES: ReadonlySet<string> = new Set<QueueChangedState>([
  'saved',
  'waiting',
  'uploading',
  'needs_attention',
  'discarded',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTabPdfStatusMessage(value: unknown): value is TabPdfStatusMessage {
  return isRecord(value) && value.type === 'tab:pdf-status' &&
    typeof value.tabId === 'number' && Number.isInteger(value.tabId) && value.tabId >= 0;
}

export function isCapturePdfMessage(value: unknown): value is CapturePdfMessage {
  return isRecord(value) && value.type === 'capture:pdf' &&
    typeof value.tabId === 'number' && Number.isInteger(value.tabId) && value.tabId >= 0;
}

export function isCaptureAreaMessage(value: unknown): value is CaptureAreaMessage {
  return isRecord(value) && value.type === 'capture:area' &&
    typeof value.tabId === 'number' && Number.isInteger(value.tabId) && value.tabId >= 0;
}

export function isSelectAreaAbortMessage(value: unknown): value is SelectAreaAbortMessage {
  return isRecord(value) && value.type === 'select-area:abort';
}

export function isSelectAreaMessage(value: unknown): value is SelectAreaMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'select-area:cancel' || value.type === 'select-area:visible') return true;
  if (value.type !== 'select-area:done' || !isRecord(value.rect)) return false;
  const { x, y, width, height } = value.rect;
  return typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number' &&
    isValidSelection({ x, y, width, height }) &&
    typeof value.viewportWidth === 'number' && Number.isFinite(value.viewportWidth) && value.viewportWidth > 0 &&
    typeof value.viewportHeight === 'number' && Number.isFinite(value.viewportHeight) && value.viewportHeight > 0;
}

function isCaptureId(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function isQueueRequestMessage(value: unknown): value is QueueRequestMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'queue:kick':
      return true;
    case 'queue:retry':
      return value.captureId === undefined || isCaptureId(value.captureId);
    case 'queue:discard':
      return isCaptureId(value.captureId);
    default:
      return false;
  }
}

export function isQueueChangedMessage(value: unknown): value is QueueChangedMessage {
  return (
    isRecord(value) &&
    value.type === 'queue:changed' &&
    isCaptureId(value.captureId) &&
    typeof value.state === 'string' &&
    QUEUE_CHANGED_STATES.has(value.state) &&
    (value.message === undefined || typeof value.message === 'string')
  );
}

const NOTE_FILE_KINDS: ReadonlySet<string> = new Set<NoteFileKind>(['image', 'pdf', 'file']);
const NOTE_MESSAGE_KINDS: ReadonlySet<string> = new Set<NoteMessageKind>(['error', 'info']);
const ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set<AttemptOutcome>(['saved', 'will_retry', 'needs_attention']);
// The thumbnail becomes an <img> source inside a web page, so only inline image data is accepted.
const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isNoteRequestMessage(value: unknown): value is NoteRequestMessage {
  if (!isRecord(value) || !isCaptureId(value.captureId)) return false;
  switch (value.type) {
    case 'note:get':
    case 'note:discard':
      return true;
    case 'note:save':
      return typeof value.note === 'string';
    default:
      return false;
  }
}

function isNoteCaptureView(value: Record<string, unknown>): boolean {
  return (
    isCaptureId(value.captureId) &&
    typeof value.filename === 'string' &&
    typeof value.fileKind === 'string' &&
    NOTE_FILE_KINDS.has(value.fileKind) &&
    (value.thumbnailDataUrl === undefined ||
      (typeof value.thumbnailDataUrl === 'string' && IMAGE_DATA_URL.test(value.thumbnailDataUrl))) &&
    isOptionalString(value.message)
  );
}

export function isNoteCardMessage(value: unknown): value is NoteCardMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'note:show':
      return isNoteCaptureView(value);
    case 'note:message':
      return typeof value.message === 'string' && typeof value.kind === 'string' && NOTE_MESSAGE_KINDS.has(value.kind);
    default:
      return false;
  }
}

export function isNoteGetResponse(value: unknown): value is NoteGetResponse {
  return isRecord(value) && (value.capture === null || (isRecord(value.capture) && isNoteCaptureView(value.capture)));
}

export function isNoteCardResponse(value: unknown): value is NoteCardResponse {
  return isRecord(value) && typeof value.ok === 'boolean';
}

export function isNoteSaveResponse(value: unknown): value is NoteSaveResponse {
  return (
    isRecord(value) &&
    typeof value.outcome === 'string' &&
    ATTEMPT_OUTCOMES.has(value.outcome) &&
    isOptionalString(value.message)
  );
}

// Whole page capture (spec section 6.3 flow B). ------------------------------------------------------------------

/** Popup -> background: save the whole page in this tab as a PDF. No response; the popup closes itself. */
export interface CapturePageMessage {
  type: 'capture:page';
  tabId: number;
}

export function isCapturePageMessage(value: unknown): value is CapturePageMessage {
  return (
    isRecord(value) &&
    value.type === 'capture:page' &&
    typeof value.tabId === 'number' &&
    Number.isInteger(value.tabId) &&
    value.tabId >= 0
  );
}

/**
 * True for Chrome's error when `runtime.sendMessage` finds no listener, which is normal for a broadcast sent while no
 * extension page is open.
 */
export function isNoReceiverError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Receiving end does not exist');
}
