// Pure logic and copy for the note step (spec section 6.4), shared by the in-page note card, the note window, and the
// background. No DOM and no browser APIs, so it is safe in a content script and in tests.

import { isNoteSaveResponse } from './messages';
import type { NoteMessageKind } from './messages';

/** Which capture status circle (assets/components.css) goes with a line of status text. */
export type NoteStatusTone = 'uploading' | 'saved' | 'waiting' | 'attention';

export interface NoteStatusView {
  text: string;
  tone: NoteStatusTone;
}

export const NOTE_LABEL = 'Note (optional)';
export const SAVE_LABEL = 'Save';
export const DISCARD_LABEL = 'Discard';
export const CLOSE_LABEL = 'Close';
/** Accessible name of the card and the note window's heading. */
export const NOTE_DIALOG_LABEL = 'Capture to Drive';

export const SAVED_TEXT = 'Saved to Capture ✓';
/**
 * The capture is in the upload queue but not in Drive yet: the first try failed, is slow, or the background restarted.
 * Worded so it reads as working, not broken: the queue retries by itself (spec section 6.4).
 */
export const WILL_RETRY_TEXT = 'Still uploading. It will finish on its own.';
/** needs_attention without a message, or a save the background could not carry out. */
export const SAVE_FAILED_TEXT = "Couldn't save this capture. Capture it again.";
/** The capture is no longer pending: already saved or discarded, or cleaned up after 24 hours. */
export const NOTE_GONE_TEXT = 'This capture is no longer available. Capture it again.';

export const SAVING_STATUS: NoteStatusView = { text: 'Saving…', tone: 'uploading' };

/** The card and window go this long after a saved or still-uploading status. An error stays (saveDismissDelay). */
export const DISMISS_AFTER_SAVE_MS = 2000;
/** An informational message shown on its own disappears after this long (paused while the pointer or focus is on it). */
export const MESSAGE_DISMISS_MS = 6000;

/**
 * How long a message on its own stays before it goes by itself: an error never does (WCAG 2.2.1: it stays until the user
 * presses Close or Esc, so it can be read at any pace), information after MESSAGE_DISMISS_MS. Null means it stays.
 */
export function messageDismissDelay(kind: NoteMessageKind): number | null {
  return kind === 'error' ? null : MESSAGE_DISMISS_MS;
}

/**
 * How long the final status of a save stays before the card goes by itself: saved and still-uploading after
 * DISMISS_AFTER_SAVE_MS (feedback, also announced by the live region), an error never (WCAG 2.2.1: it stays until the
 * user presses Close or Esc, as an error message on its own does). Null means it stays.
 */
export function saveDismissDelay(status: NoteStatusView): number | null {
  return status.tone === 'attention' ? null : DISMISS_AFTER_SAVE_MS;
}

/** The timer functions a countdown needs, so tests can drive it with fake timers and a page can pass its window's. */
export interface CountdownClock<Handle> {
  setTimeout(callback: () => void, ms: number): Handle;
  clearTimeout(handle: Handle): void;
}

/**
 * The auto-dismiss countdown of a message. It runs for `delayMs` after `start()` and calls `onExpire` once. It pauses
 * while the pointer is over the message or focus is inside it, and starts again from the full delay when both have left.
 * A null delay (an error) never runs. After `stop()` or the expiry it does nothing more.
 */
export class MessageDismissTimer<Handle> {
  private handle: Handle | undefined;
  private hovered = false;
  private focused = false;
  private ended = false;

  constructor(
    private readonly delayMs: number | null,
    private readonly onExpire: () => void,
    private readonly clock: CountdownClock<Handle>,
  ) {}

  start(): void {
    this.arm();
  }

  setHovered(hovered: boolean): void {
    this.hovered = hovered;
    this.arm();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.arm();
  }

  /** True while a countdown is running. */
  get running(): boolean {
    return this.handle !== undefined;
  }

  stop(): void {
    this.ended = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private arm(): void {
    this.clear();
    if (this.ended || this.delayMs === null || this.hovered || this.focused) return;
    this.handle = this.clock.setTimeout(() => {
      this.handle = undefined;
      if (this.ended) return;
      this.ended = true;
      this.onExpire();
    }, this.delayMs);
  }
}
/**
 * How long the card waits for the background's answer to Save before it shows the will-retry line. The capture is
 * already queued by then (or still pending if the worker died first), and the queue keeps trying on its own.
 */
export const SAVE_RESPONSE_TIMEOUT_MS = 30_000;

/** Status line for the background's answer to `note:save`. No (or a malformed) answer reads as will_retry. */
export function statusForSaveResponse(response: unknown): NoteStatusView {
  if (!isNoteSaveResponse(response)) return { text: WILL_RETRY_TEXT, tone: 'waiting' };
  switch (response.outcome) {
    case 'saved':
      return { text: SAVED_TEXT, tone: 'saved' };
    case 'will_retry':
      return { text: WILL_RETRY_TEXT, tone: 'waiting' };
    case 'needs_attention':
      return { text: response.message ?? SAVE_FAILED_TEXT, tone: 'attention' };
  }
}

/**
 * True for the key press that saves the note: a trusted Enter that is not confirming text an input method is composing
 * and is not a held key's repeat. The Enter that started a capture (Select area's Enter for the whole view) can still be
 * held down when the card takes focus, and its repeats must not save an empty note.
 */
export function isSaveKey(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'isTrusted' | 'repeat'>): boolean {
  return event.key === 'Enter' && !event.isComposing && event.isTrusted && !event.repeat;
}

export type NotePhase = 'editing' | 'saving' | 'done' | 'failed';

/**
 * The note step's state: editing until Save or Discard, then saving until the answer, then done. An answer that is an
 * error leaves it failed instead, until the user closes it (then done). Each transition happens once, so a second Save
 * (double click, Enter held down) or an Esc during the save is ignored.
 */
export class NoteSession {
  phase: NotePhase = 'editing';

  /** True while the user has not pressed Save or Discard yet. */
  get isEditing(): boolean {
    return this.phase === 'editing';
  }

  /** Returns true if the save should go ahead. */
  beginSave(): boolean {
    if (this.phase !== 'editing') return false;
    this.phase = 'saving';
    return true;
  }

  /** Returns true if the discard should go ahead. */
  beginDiscard(): boolean {
    if (this.phase !== 'editing') return false;
    this.phase = 'done';
    return true;
  }

  /**
   * Returns true if this is the answer to the save in progress. `stays` is for an error: the card then waits for the
   * user to close it (beginClose) instead of finishing on its own.
   */
  finishSave(stays = false): boolean {
    if (this.phase !== 'saving') return false;
    this.phase = stays ? 'failed' : 'done';
    return true;
  }

  /** Returns true if the user's Close or Esc should finish the card: only after an error, and only once. */
  beginClose(): boolean {
    if (this.phase !== 'failed') return false;
    this.phase = 'done';
    return true;
  }
}

/** How a Save request ended, seen from the card or window. */
export type SaveResult =
  | { kind: 'answered'; answer: unknown }
  /** Sent, but no answer came (the worker stopped mid-save, or it took too long). The background has it. */
  | { kind: 'no_answer' }
  /** Never left this page (the extension was reloaded or updated): nothing will upload it. */
  | { kind: 'not_sent' };

/** Thrown or rejected by a note transport when a request could not be sent at all. */
export class NoteNotSentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NoteNotSentError';
  }
}

// Chrome's errors for a message that never reached a listener: the content script's extension context is gone
// (extension reloaded or updated), or no extension context is listening at all.
const NOT_DELIVERED_MESSAGES = ['Extension context invalidated', 'Receiving end does not exist'];

/** True when an error means the request never reached the background (as opposed to "sent, no answer"). */
export function isNotDeliveredError(error: unknown): boolean {
  if (error instanceof NoteNotSentError) return true;
  return error instanceof Error && NOT_DELIVERED_MESSAGES.some((text) => error.message.includes(text));
}

/**
 * Sends a Save with `send` and waits up to `ms` for the answer. Never rejects. A synchronous throw or a not-delivered
 * error is `not_sent`; any other rejection (port closed) or no answer in time is `no_answer`.
 */
export async function awaitSaveAnswer(send: () => Promise<unknown>, ms: number): Promise<SaveResult> {
  let sending: Promise<unknown>;
  try {
    sending = send();
  } catch {
    return { kind: 'not_sent' };
  }
  let notSent = false;
  const answer = await settleWithin(
    sending.catch((error: unknown) => {
      notSent = isNotDeliveredError(error);
      throw error;
    }),
    ms,
  );
  if (notSent) return { kind: 'not_sent' };
  return answer === undefined ? { kind: 'no_answer' } : { kind: 'answered', answer };
}

/** Status line for how a Save ended. */
export function statusForSaveResult(result: SaveResult): NoteStatusView {
  switch (result.kind) {
    case 'answered':
      return statusForSaveResponse(result.answer);
    case 'no_answer':
      return { text: WILL_RETRY_TEXT, tone: 'waiting' };
    case 'not_sent':
      return { text: SAVE_FAILED_TEXT, tone: 'attention' };
  }
}

/**
 * Resolves with the promise's value, or with undefined if it rejects or has not settled within `ms`. Never rejects,
 * so a dead service worker (closed message port, or no answer at all) can never leave the UI waiting forever.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
