// @vitest-environment happy-dom
// The note window (entrypoints/note/): the note step in a small popup window, for tabs that cannot host the in-page
// card. The test mounts the real note.html and runs the real main.ts against WXT's fake browser. A stand-in for the
// background answers note:get / note:save / note:discard, and the test checks what the window shows, what it sends,
// and when it closes itself: 2 s after a saved or still-uploading result, never by itself after an error. Time is faked
// (the 2 s, 6 s, 10 s and 30 s waits).
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { isNoteRequestMessage } from '../lib/messages';
import type { NoteCaptureView, NoteRequestMessage } from '../lib/messages';
import { byId, mountPage, unmountPage } from './helpers/dom';
import {
  accessibleText,
  buttonNamed,
  deferred,
  isHidden,
  noteInput,
  press,
  scriptClick,
  scriptPress,
  statusText,
  useBrowserTrust,
  userClick,
  wait,
} from './helpers/dom-note';

const CAPTURE: NoteCaptureView = { captureId: 'cap-1', filename: 'Capture 2026-10-07 13.42.10.png', fileKind: 'image' };
const SAVED = 'Saved to Capture ✓';
const RETRY = 'Still uploading. It will finish on its own.';
const GONE = 'This capture is no longer available. Capture it again.';

type Handler = (message: NoteRequestMessage) => unknown;
type Handlers = Partial<Record<NoteRequestMessage['type'], Handler>>;

let closeWindow: MockInstance<() => void>;
let sent: NoteRequestMessage[];
let runtimeId: string;
let documentListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }>;

useBrowserTrust();

beforeEach(() => {
  fakeBrowser.reset();
  vi.useFakeTimers();
  vi.resetModules();
  sent = [];
  runtimeId = fakeBrowser.runtime.id;
  documentListeners = [];
  // main.ts adds a keydown listener to the document, which unmountPage() does not clear. Remove them after each test,
  // so an earlier test's window does not answer the next test's Esc.
  const addToDocument = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      documentListeners.push({ type, listener, options });
      addToDocument(type, listener, options);
    },
  );
  closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
});

afterEach(() => {
  // fakeBrowser.reset() does not restore a runtime.id that a test took away.
  Object.defineProperty(fakeBrowser.runtime, 'id', { value: runtimeId, configurable: true, writable: true });
  for (const { type, listener, options } of documentListeners) document.removeEventListener(type, listener, options);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  unmountPage();
  history.replaceState(null, '', '/');
});

/** Stands in for the background: records the note requests and answers each type with its handler (none: no answer). */
function stubBackground(handlers: Handlers): void {
  fakeBrowser.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    if (!isNoteRequestMessage(message)) return undefined;
    sent.push(message);
    const handler = handlers[message.type];
    if (handler === undefined) return true; // received, never answered
    void Promise.resolve(handler(message)).then(sendResponse);
    return true;
  });
}

/** Opens note.html with this query string, the way the background opens the window. */
async function openWindow(search: string): Promise<void> {
  mountPage('note');
  history.replaceState(null, '', `/note.html${search}`);
  await import('../entrypoints/note/main');
  await wait();
}

/**
 * Opens the note window for capture "cap-1" with the stand-in background in place. It answers note:get with CAPTURE
 * unless a test passes its own handler for it.
 */
async function openNoteStep(handlers: Handlers = {}): Promise<void> {
  stubBackground({ 'note:get': () => ({ capture: CAPTURE }), ...handlers });
  await openWindow('?id=cap-1');
}

describe('note window: the note step', () => {
  it('asks the background for the capture named in the address and shows it', async () => {
    await openNoteStep();

    expect(sent).toEqual([{ type: 'note:get', captureId: 'cap-1' }]);
    expect(document.querySelector('h1')?.textContent).toBe('Add a note');
    expect(byId('app').tagName).toBe('MAIN');
    expect(byId('app').textContent).toContain('Capture 2026-10-07 13.42.10.png');
    expect(document.querySelector('label')?.textContent).toBe('Note (optional)');
    expect(accessibleText(buttonNamed('Save'))).toBe('Save');
    expect(accessibleText(buttonNamed('Discard'))).toBe('Discard');
  });

  it('puts the cursor in the note field', async () => {
    await openNoteStep();

    expect(document.activeElement).toBe(noteInput());
  });

  it('shows only the heading until the background answers', async () => {
    const answer = deferred<unknown>();
    await openNoteStep({ 'note:get': () => answer.promise });
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelector('h1')?.textContent).toBe('Add a note');

    answer.resolve({ capture: CAPTURE });
    await wait();
    expect(noteInput()).toBe(document.activeElement);
  });

  it('shows the notice and a file icon for a PDF', async () => {
    await openNoteStep({
      'note:get': () => ({
        capture: { ...CAPTURE, fileKind: 'pdf', filename: 'Report.pdf', message: 'Saved as a PDF of the whole page.' },
      }),
    });

    expect(byId('app').textContent).toContain('Saved as a PDF of the whole page.');
    expect(byId('app').textContent).toContain('Report.pdf');
    expect(document.querySelector('.note-preview svg')).not.toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('shows the filename and notice as text, never as markup', async () => {
    await openNoteStep({
      'note:get': () => ({ capture: { ...CAPTURE, filename: '<img src=x onerror=alert(1)>.png', message: '<b>bold</b>' } }),
    });

    expect(byId('app').textContent).toContain('<img src=x onerror=alert(1)>.png');
    expect(byId('app').textContent).toContain('<b>bold</b>');
    expect(document.querySelector('main img, main b')).toBeNull();
  });
});

describe('note window: saving', () => {
  it('saves the typed note with Enter: Saving…, Saved to Capture ✓, and the window closes 2 s later', async () => {
    const answer = deferred<unknown>();
    await openNoteStep({ 'note:save': () => answer.promise });
    noteInput().value = 'Receipt for the Q3 offsite';

    press(noteInput(), 'Enter');
    await wait();

    expect(sent).toEqual([
      { type: 'note:get', captureId: 'cap-1' },
      { type: 'note:save', captureId: 'cap-1', note: 'Receipt for the Q3 offsite' },
    ]);
    expect(statusText()).toBe('Saving…');
    expect(isHidden(noteInput())).toBe(true);

    answer.resolve({ outcome: 'saved' });
    await wait();
    expect(statusText()).toBe(SAVED);
    expect(closeWindow).not.toHaveBeenCalled();

    await wait(1999);
    expect(closeWindow).not.toHaveBeenCalled();
    await wait(1);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('saves with the Save button too, and sends an empty note when nothing was typed', async () => {
    await openNoteStep({ 'note:save': () => ({ outcome: 'saved' }) });

    userClick(buttonNamed('Save'));
    await wait();

    expect(sent.at(-1)).toEqual({ type: 'note:save', captureId: 'cap-1', note: '' });
    expect(statusText()).toBe(SAVED);
  });

  it('shows the will_retry line, with no Close button, and closes 2 s later', async () => {
    await openNoteStep({ 'note:save': () => ({ outcome: 'will_retry' }) });

    press(noteInput(), 'Enter');
    await wait();
    expect(statusText()).toBe(RETRY);
    expect(isHidden(buttonNamed('Close'))).toBe(true);

    await wait(1999);
    expect(closeWindow).not.toHaveBeenCalled();
    await wait(1);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('says it is still uploading when the background does not answer within 30 s, then closes', async () => {
    await openNoteStep();

    press(noteInput(), 'Enter');
    await wait(29_999);
    expect(statusText()).toBe('Saving…');
    await wait(1);
    expect(statusText()).toBe(RETRY);

    await wait(2000);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('does not discard when Esc is pressed after Save', async () => {
    await openNoteStep({ 'note:save': () => ({ outcome: 'saved' }) });

    press(noteInput(), 'Enter');
    await wait();
    press(document.body, 'Escape');
    await wait(2000);

    expect(sent.map((message) => message.type)).toEqual(['note:get', 'note:save']);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('ignores a click on Save that a script made', async () => {
    await openNoteStep({ 'note:save': () => ({ outcome: 'saved' }) });

    scriptClick(buttonNamed('Save'));
    scriptPress(noteInput(), 'Enter');
    await wait();

    expect(sent.map((message) => message.type)).toEqual(['note:get']);
    expect(statusText()).toBe('');
  });
});

describe('note window: a save that ends in an error', () => {
  // An error stays until the user closes it (WCAG 2.2.1): the window stays open until Close or Esc.
  const HOUR_MS = 60 * 60 * 1000;
  const REJECTED = 'Mailbox key was rejected. Check Settings.';
  const COULD_NOT_SAVE = "Couldn't save this capture. Capture it again.";

  /** Opens the note step and presses Save; the background answers needs_attention. */
  async function saveWithError(): Promise<void> {
    await openNoteStep({ 'note:save': () => ({ outcome: 'needs_attention', message: REJECTED }) });
    press(noteInput(), 'Enter');
    await wait();
  }

  it.each([
    ['needs_attention with its message', { outcome: 'needs_attention', message: REJECTED }, REJECTED],
    ['needs_attention without one', { outcome: 'needs_attention' }, COULD_NOT_SAVE],
  ])('shows the line for %s and keeps the window open, with a Close button', async (_name, answer, text) => {
    await openNoteStep({ 'note:save': () => answer });

    press(noteInput(), 'Enter');
    await wait();

    expect(statusText()).toBe(text);
    expect(document.querySelector('[aria-live="polite"]')?.classList.contains('status-attention')).toBe(true);
    expect(isHidden(buttonNamed('Close'))).toBe(false);
    await wait(2000);
    expect(closeWindow).not.toHaveBeenCalled();
    await wait(HOUR_MS);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(statusText()).toBe(text);
  });

  it('keeps the window open when the extension was reloaded and the window can no longer reach it', async () => {
    await openNoteStep();
    Object.defineProperty(fakeBrowser.runtime, 'id', { value: undefined, configurable: true, writable: true });

    press(noteInput(), 'Enter');
    await wait();

    expect(statusText()).toBe(COULD_NOT_SAVE);
    expect(sent.filter((message) => message.type === 'note:save')).toEqual([]);
    expect(isHidden(buttonNamed('Close'))).toBe(false);
    await wait(HOUR_MS);
    expect(closeWindow).not.toHaveBeenCalled();

    userClick(buttonNamed('Close'));
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('closes the window when Close is pressed, without discarding the capture', async () => {
    await saveWithError();

    userClick(buttonNamed('Close'));
    await wait(HOUR_MS);

    expect(closeWindow).toHaveBeenCalledOnce();
    expect(sent.map((message) => message.type)).toEqual(['note:get', 'note:save']);
  });

  it('closes the window on Esc anywhere in it, without discarding the capture', async () => {
    await saveWithError();

    const event = press(document.body, 'Escape');
    await wait(HOUR_MS);

    expect(event.defaultPrevented).toBe(true);
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(sent.map((message) => message.type)).toEqual(['note:get', 'note:save']);
  });

  it('closes the window once when Esc is pressed on the Close button itself', async () => {
    await saveWithError();

    press(buttonNamed('Close'), 'Escape');
    userClick(buttonNamed('Close'));
    await wait(HOUR_MS);

    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('does not close for a Close click or an Esc that a script made, or a composing input method sent', async () => {
    await saveWithError();

    scriptClick(buttonNamed('Close'));
    scriptPress(document.body, 'Escape');
    scriptPress(buttonNamed('Close'), 'Escape');
    press(document.body, 'Escape', { isComposing: true });
    await wait(10_000);

    expect(closeWindow).not.toHaveBeenCalled();
    expect(sent.map((message) => message.type)).toEqual(['note:get', 'note:save']);
  });

  it('does nothing harmful on Esc while Saving…, and the error that follows still stays until Close', async () => {
    const answer = deferred<unknown>();
    await openNoteStep({ 'note:save': () => answer.promise });

    press(noteInput(), 'Enter');
    await wait();
    press(document.body, 'Escape');
    press(noteInput(), 'Escape');
    await wait(1000);
    expect(statusText()).toBe('Saving…');
    expect(isHidden(buttonNamed('Close'))).toBe(true);
    expect(closeWindow).not.toHaveBeenCalled();

    answer.resolve({ outcome: 'needs_attention', message: REJECTED });
    await wait(HOUR_MS);
    expect(statusText()).toBe(REJECTED);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(sent.map((message) => message.type)).toEqual(['note:get', 'note:save']);

    userClick(buttonNamed('Close'));
    expect(closeWindow).toHaveBeenCalledOnce();
  });
});

describe('note window: discarding', () => {
  it('Discard tells the background, and the window closes once the background has answered', async () => {
    const answer = deferred<unknown>();
    await openNoteStep({ 'note:discard': () => answer.promise });

    userClick(buttonNamed('Discard'));
    await wait();

    expect(sent.at(-1)).toEqual({ type: 'note:discard', captureId: 'cap-1' });
    expect(closeWindow).not.toHaveBeenCalled();

    answer.resolve({ ok: true });
    await wait();
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('closes anyway 2 s after Discard when the background does not answer', async () => {
    await openNoteStep();

    userClick(buttonNamed('Discard'));
    await wait(1999);
    expect(closeWindow).not.toHaveBeenCalled();
    await wait(1);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('closes only once after Discard, however long it waits', async () => {
    await openNoteStep({ 'note:discard': () => ({ ok: true }) });

    userClick(buttonNamed('Discard'));
    await wait(60_000);

    expect(closeWindow).toHaveBeenCalledOnce();
    expect(sent.filter((message) => message.type === 'note:discard')).toHaveLength(1);
  });

  it('Esc in the note field discards once', async () => {
    await openNoteStep({ 'note:discard': () => ({ ok: true }) });

    press(noteInput(), 'Escape');
    press(noteInput(), 'Escape');
    await wait();

    expect(sent.filter((message) => message.type === 'note:discard')).toEqual([{ type: 'note:discard', captureId: 'cap-1' }]);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('Esc anywhere in the window discards, even when focus is on the page background', async () => {
    await openNoteStep({ 'note:discard': () => ({ ok: true }) });
    noteInput().blur();

    const event = press(document.body, 'Escape');
    await wait();

    expect(event.defaultPrevented).toBe(true);
    expect(sent.at(-1)).toEqual({ type: 'note:discard', captureId: 'cap-1' });
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('does not discard for an Esc that a script made or a composing input method sent', async () => {
    await openNoteStep({ 'note:discard': () => ({ ok: true }) });

    scriptPress(document.body, 'Escape');
    press(document.body, 'Escape', { isComposing: true });
    scriptClick(buttonNamed('Discard'));
    await wait(10_000);

    expect(sent.map((message) => message.type)).toEqual(['note:get']);
    expect(closeWindow).not.toHaveBeenCalled();
  });
});

describe('note window: the capture is gone', () => {
  async function expectGoneMessage(): Promise<void> {
    await wait(50);
    expect(statusText()).toBe(GONE);
    expect(document.querySelector('h1')?.textContent).toBe('Capture to Drive');
    expect(document.title).toBe('Capture to Drive');
    expect(document.querySelector('input')).toBeNull();
    expect(accessibleText(buttonNamed('Close'))).toBe('Close');
  }

  it('says so when the background reports the capture is no longer pending', async () => {
    await openNoteStep({ 'note:get': () => ({ capture: null }) });

    await expectGoneMessage();
  });

  it('marks it as an error and keeps it until it is closed', async () => {
    await openNoteStep({ 'note:get': () => ({ capture: null }) });
    await wait(50);

    expect(document.querySelector('[aria-live="polite"]')?.classList.contains('status-attention')).toBe(true);
    await wait(60 * 60 * 1000);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it('closes the window when Close is pressed', async () => {
    await openNoteStep({ 'note:get': () => ({ capture: null }) });

    userClick(buttonNamed('Close'));

    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('closes the window on Esc anywhere in it', async () => {
    await openNoteStep({ 'note:get': () => ({ capture: null }) });

    press(document.body, 'Escape');

    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('does not close for a Close click or an Esc that a script made', async () => {
    await openNoteStep({ 'note:get': () => ({ capture: null }) });

    scriptClick(buttonNamed('Close'));
    scriptPress(document.body, 'Escape');

    expect(closeWindow).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', undefined],
    ['an empty object', {}],
    ['a capture without a filename', { capture: { captureId: 'cap-1', fileKind: 'image' } }],
    ['a capture of an unknown kind', { capture: { ...CAPTURE, fileKind: 'video' } }],
    ['a thumbnail that is not an image data URL', { capture: { ...CAPTURE, thumbnailDataUrl: 'https://example.com/a.png' } }],
  ])('says so when the background answers with %s', async (_name, answer) => {
    await openNoteStep({ 'note:get': () => answer });

    await expectGoneMessage();
  });

  it('says so when the background has not answered after 10 s', async () => {
    stubBackground({});
    await openWindow('?id=cap-1');
    await wait(9_999);
    expect(document.querySelector('button')).toBeNull();

    await wait(1);
    await expectGoneMessage();
  });

  it('says so when nothing is listening for the request', async () => {
    await openWindow('?id=cap-1');

    await expectGoneMessage();
  });

  it('says so, without asking the background, when the address names no capture', async () => {
    stubBackground({ 'note:get': () => ({ capture: CAPTURE }) });

    await openWindow('');

    await expectGoneMessage();
    expect(sent).toEqual([]);
  });

  it('says so when the capture id is empty', async () => {
    stubBackground({ 'note:get': () => ({ capture: CAPTURE }) });

    await openWindow('?id=');

    await expectGoneMessage();
    expect(sent).toEqual([]);
  });
});

describe('note window: a message on its own', () => {
  it('shows an informational message without contacting the background, and closes after 6 s', async () => {
    stubBackground({});

    await openWindow('?message=Saved%20a%20copy%20to%20your%20downloads%20folder.&kind=info');
    await wait(50);

    expect(statusText()).toBe('Saved a copy to your downloads folder.');
    expect(document.querySelector('h1')?.textContent).toBe('Capture to Drive');
    expect(sent).toEqual([]);
    await wait(5900);
    expect(closeWindow).not.toHaveBeenCalled();
    await wait(50);
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it.each([
    ['an error', '?message=Selection%20failed.&kind=error'],
    ['no kind', '?message=Selection%20failed.'],
    ['an unknown kind', '?message=Selection%20failed.&kind=warning'],
  ])('keeps a message with %s until it is closed', async (_name, search) => {
    await openWindow(search);
    await wait(50);

    expect(statusText()).toBe('Selection failed.');
    await wait(60 * 60 * 1000);
    expect(closeWindow).not.toHaveBeenCalled();

    userClick(buttonNamed('Close'));
    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('shows the message as text, never as markup', async () => {
    await openWindow('?message=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&kind=error');
    await wait(50);

    expect(statusText()).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('main img')).toBeNull();
  });

  it('closes on Esc anywhere in the window', async () => {
    await openWindow('?message=Selection%20failed.&kind=error');

    press(document.body, 'Escape');

    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('shows the note step when the address names both a capture and a message', async () => {
    stubBackground({ 'note:get': () => ({ capture: CAPTURE }) });

    await openWindow('?id=cap-1&message=Ignored');

    expect(noteInput()).toBe(document.activeElement);
    expect(byId('app').textContent).not.toContain('Ignored');
  });

  it('says the capture is gone when the address names neither a capture nor a message', async () => {
    await openWindow('?message=');
    await wait(50);

    expect(statusText()).toBe(GONE);
  });
});
