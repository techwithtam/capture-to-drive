// The note step's UI (spec section 6.4), shared by the in-page note card (entrypoints/note-card.content.ts, inside a
// shadow root on a web page) and the note window (entrypoints/note/). Builds DOM from the shared component classes
// (assets/components.css) plus assets/note-view.css. Talks to the background only through the callbacks it is given,
// so it is the same in a content script and in an extension page.
//
// Two views:
// - The note view: thumbnail or file icon, the final filename (read-only), "Note (optional)", Save and Discard.
//   Enter in the field saves, Esc discards. After Save it shows "Saving…", then the outcome, then finishes 2 s later.
//   A save that ends in an error stays instead, with a Close button (and Esc) to finish it (WCAG 2.2.1).
// - The message view: a message on its own with a Close button. An error stays until Close or Esc; information goes
//   after 6 s (paused while hovered or focused).
//
// Only real user input acts: click and key handlers ignore events a script dispatched (`isTrusted` false), so a web
// page cannot press Save or Discard even if it got hold of the elements. There is no <form>, because a form's submit
// event is trusted even when a script triggers it with click().

import { createIcon } from './icons';
import type { NoteCaptureView, NoteMessageKind } from './messages';
import {
  CLOSE_LABEL,
  DISCARD_LABEL,
  MessageDismissTimer,
  NOTE_LABEL,
  NoteSession,
  SAVE_LABEL,
  SAVE_RESPONSE_TIMEOUT_MS,
  SAVING_STATUS,
  awaitSaveAnswer,
  isSaveKey,
  messageDismissDelay,
  saveDismissDelay,
  statusForSaveResult,
} from './note-status';
import type { NoteStatusView } from './note-status';

/** Tag of the element that hosts the in-page card's shadow root. Other content scripts can find (or hide) it by this. */
export const NOTE_CARD_HOST_TAG = 'capture-to-drive-note-card';

export interface NoteViewCallbacks {
  /**
   * Sends the note to the background and resolves with its answer (any shape; it is validated here). Throws, or
   * rejects with NoteNotSentError, when the request could not be sent at all.
   */
  save(note: string): Promise<unknown>;
  /** Tells the background to delete the capture. Fire and forget. */
  discard(): void;
  /** The user pressed Save or Discard: the note field is done with, so focus can go back to the page. */
  onSettled?(): void;
  /**
   * Remove the UI now: right after Discard, 2 s after a saved or still-uploading final status, or when the user closes
   * a save that ended in an error (Close or Esc; an error never goes by itself).
   */
  onFinished(): void;
}

export interface MessageViewCallbacks {
  /** Remove the UI now: Close, Esc, or (information only) the 6-second timer. */
  onFinished(): void;
}

export interface MountedView {
  /** The view's root element; the caller puts it in the page. */
  element: HTMLElement;
  /** Moves focus to the view's first control (the note field). */
  focus(): void;
  /** Esc: discards (note view, before Save), closes (message view; note view after an error), nothing while saving. */
  cancel(): void;
  /** The note typed so far while the user has not pressed Save or Discard; undefined after that. */
  unsentNote(): string | undefined;
  /** Stops the view's timers; it never calls back after this. */
  destroy(): void;
}

let idCounter = 0;

function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== '') node.className = className;
  node.append(...children);
  return node;
}

/** A button label followed by a decorative key hint; the key itself goes in aria-keyshortcuts. */
function buttonWithKey(
  doc: Document,
  options: { className: string; label: string; key: string; shortcut: string },
): HTMLButtonElement {
  const hint = element(doc, 'span', 'kbd', options.key);
  hint.setAttribute('aria-hidden', 'true');
  const button = element(doc, 'button', options.className, options.label, hint);
  button.type = 'button';
  button.setAttribute('aria-keyshortcuts', options.shortcut);
  return button;
}

/** Puts a status circle and its text in `line` (a live region), or clears it. */
function setStatus(doc: Document, line: HTMLElement, status: NoteStatusView | null): void {
  line.className = 'note-status';
  if (status === null) {
    line.replaceChildren();
    return;
  }
  line.classList.add('status', `status-${status.tone}`);
  const dot = element(doc, 'span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  line.replaceChildren(dot, status.text);
}

function decodeDataUrl(dataUrl: string): Blob | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (match === null) return undefined;
  const binary = atob(match[2] ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

/**
 * Draws the thumbnail into a canvas rather than an <img>: a data: image in a web page is subject to the page's
 * Content Security Policy (img-src), and strict sites such as banks would block it. Drawing pixels is not.
 */
async function drawThumbnail(canvas: HTMLCanvasElement, dataUrl: string): Promise<void> {
  const blob = decodeDataUrl(dataUrl);
  if (blob === undefined) throw new Error('Not a base64 data URL.');
  const bitmap = await createImageBitmap(blob);
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No 2D canvas is available.');
    context.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}

function fileIcon(doc: Document, capture: NoteCaptureView): SVGSVGElement {
  return createIcon(capture.fileKind === 'pdf' ? 'file-type-pdf' : 'file-text', doc);
}

function preview(doc: Document, capture: NoteCaptureView): HTMLElement {
  const box = element(doc, 'div', 'note-preview');
  const showIcon = () => {
    box.classList.add('note-preview-icon');
    box.replaceChildren(fileIcon(doc, capture));
  };
  if (capture.fileKind !== 'image' || capture.thumbnailDataUrl === undefined) {
    showIcon();
    return box;
  }
  const canvas = element(doc, 'canvas', 'note-thumb');
  canvas.width = 0;
  canvas.height = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Preview');
  box.append(canvas);
  drawThumbnail(canvas, capture.thumbnailDataUrl).catch(showIcon);
  return box;
}

/** The note view for one capture. The caller adds `element` to the page, then calls `focus()`. */
export function createNoteView(doc: Document, capture: NoteCaptureView, callbacks: NoteViewCallbacks): MountedView {
  const view = doc.defaultView;
  const session = new NoteSession();
  const timers = new Set<number>();
  let destroyed = false;

  const filenameId = uniqueId('note-filename');
  const noticeId = uniqueId('note-notice');
  const inputId = uniqueId('note-input');

  const root = element(doc, 'div', 'note-view');
  const describedBy: string[] = [];
  if (capture.message !== undefined && capture.message !== '') {
    const notice = element(doc, 'p', 'note-notice', capture.message);
    notice.id = noticeId;
    root.append(notice);
    describedBy.push(noticeId);
  }

  const filename = element(doc, 'p', 'note-filename', capture.filename);
  filename.id = filenameId;
  describedBy.push(filenameId);
  root.append(element(doc, 'div', 'note-file', preview(doc, capture), filename));

  const label = element(doc, 'label', 'field-label', NOTE_LABEL);
  label.htmlFor = inputId;
  const input = element(doc, 'input', 'input');
  input.id = inputId;
  input.type = 'text';
  input.autocomplete = 'off';
  // The field's description: the notice (if any) and the filename the capture will be saved as.
  input.setAttribute('aria-describedby', describedBy.join(' '));
  const field = element(doc, 'div', 'field', label, input);

  const discardButton = buttonWithKey(doc, {
    className: 'btn btn-secondary',
    label: DISCARD_LABEL,
    key: 'esc',
    shortcut: 'Escape',
  });
  const saveButton = buttonWithKey(doc, {
    className: 'btn btn-primary',
    label: SAVE_LABEL,
    key: '↵',
    shortcut: 'Enter',
  });
  const form = element(doc, 'div', 'note-form', field, element(doc, 'div', 'note-actions', discardButton, saveButton));
  root.append(form);

  // Live region: present (empty) from the start, so screen readers announce each status as it is written.
  const status = element(doc, 'p', 'note-status');
  status.setAttribute('aria-live', 'polite');
  // Only a save that ends in an error shows Close, the same plain button as the message view's. It sits outside the live
  // region, so the announcement is the error. No Esc chip: Esc closes it only while focus is inside the card.
  const closeButton = element(doc, 'button', 'btn btn-secondary', CLOSE_LABEL);
  closeButton.type = 'button';
  const closeActions = element(doc, 'div', 'note-actions', closeButton);
  closeActions.hidden = true;
  root.append(status, closeActions);

  function later(callback: () => void, ms: number): void {
    if (view === null) return;
    const timer = view.setTimeout(() => {
      timers.delete(timer);
      if (!destroyed) callback();
    }, ms);
    timers.add(timer);
  }

  async function save(): Promise<void> {
    if (!session.beginSave()) return;
    const note = input.value;
    // Hand focus back first, while the field still has it, then swap the form for the status line.
    callbacks.onSettled?.();
    form.hidden = true;
    setStatus(doc, status, SAVING_STATUS);
    // Sent but no answer (the worker stopped, or it took too long) reads as will_retry: the background has it. Never
    // sent (the extension was reloaded) reads as a failed save: nothing will upload it.
    const result = await awaitSaveAnswer(() => callbacks.save(note), SAVE_RESPONSE_TIMEOUT_MS);
    const final = statusForSaveResult(result);
    const delay = saveDismissDelay(final);
    if (destroyed || !session.finishSave(delay === null)) return;
    setStatus(doc, status, final);
    // An error stays until Close or Esc. Focus does not move, as for a message on its own: the live region speaks.
    if (delay === null) closeActions.hidden = false;
    else later(() => callbacks.onFinished(), delay);
  }

  function discard(): void {
    if (!session.beginDiscard()) return;
    callbacks.onSettled?.();
    callbacks.discard();
    callbacks.onFinished();
  }

  /** Close or Esc after a save that ended in an error. Once only, and never after destroy. */
  function close(): void {
    if (destroyed || !session.beginClose()) return;
    callbacks.onFinished();
  }

  /** Esc: discards before Save, closes after an error, and does nothing while saving or once saved. */
  function cancel(): void {
    if (session.phase === 'failed') close();
    else discard();
  }

  saveButton.addEventListener('click', (event) => {
    if (event.isTrusted) void save();
  });
  discardButton.addEventListener('click', (event) => {
    if (event.isTrusted) discard();
  });
  closeButton.addEventListener('click', (event) => {
    if (event.isTrusted) close();
  });
  input.addEventListener('keydown', (event) => {
    // Not while an input method is composing text (Enter confirms the text), and not a held Enter's repeats.
    if (!isSaveKey(event)) return;
    event.preventDefault();
    void save();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !event.isTrusted) return;
    event.preventDefault();
    cancel();
  });

  return {
    element: root,
    focus: () => input.focus({ preventScroll: true }),
    cancel,
    unsentNote: () => (session.isEditing ? input.value : undefined),
    destroy: () => {
      destroyed = true;
      for (const timer of timers) view?.clearTimeout(timer);
      timers.clear();
    },
  };
}

/**
 * A message on its own, with a Close button. An error stays until the user closes it (Close or Esc). Information
 * finishes after 6 s; that countdown pauses while the pointer is over it or focus is inside it, and starts again when
 * they leave.
 */
export function createMessageView(
  doc: Document,
  message: { message: string; kind: NoteMessageKind },
  callbacks: MessageViewCallbacks,
): MountedView {
  const view = doc.defaultView;
  let finished = false;

  const root = element(doc, 'div', 'note-view note-message-view');
  const status = element(doc, 'p', 'note-status');
  status.setAttribute('aria-live', 'polite');
  const closeButton = element(doc, 'button', 'btn btn-secondary', CLOSE_LABEL);
  closeButton.type = 'button';
  root.append(status, closeButton);

  // Written a moment after the view is in the page: a live region announces changes, not its initial content.
  view?.setTimeout(() => {
    if (finished) return;
    if (message.kind === 'error') setStatus(doc, status, { text: message.message, tone: 'attention' });
    else status.replaceChildren(message.message);
  }, 50);

  // No window, no timers: such a message simply stays.
  const countdown = new MessageDismissTimer<number>(
    view === null ? null : messageDismissDelay(message.kind),
    () => finish(),
    {
      setTimeout: (callback, ms) => view?.setTimeout(callback, ms) ?? 0,
      clearTimeout: (handle) => view?.clearTimeout(handle),
    },
  );

  function finish(): void {
    if (finished) return;
    finished = true;
    countdown.stop();
    callbacks.onFinished();
  }

  closeButton.addEventListener('click', (event) => {
    if (event.isTrusted) finish();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !event.isTrusted) return;
    event.preventDefault();
    finish();
  });
  root.addEventListener('pointerenter', () => countdown.setHovered(true));
  root.addEventListener('pointerleave', () => countdown.setHovered(false));
  root.addEventListener('focusin', () => countdown.setFocused(true));
  root.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
    countdown.setFocused(false);
  });
  countdown.start();

  return {
    element: root,
    focus: () => closeButton.focus({ preventScroll: true }),
    cancel: finish,
    unsentNote: () => undefined,
    destroy: () => {
      finished = true;
      countdown.stop();
    },
  };
}
