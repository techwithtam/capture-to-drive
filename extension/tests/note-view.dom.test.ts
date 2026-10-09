// @vitest-environment happy-dom
// The note step's UI (spec section 6.4), built by lib/note-view.ts for both the in-page card and the note window: the
// note view (file, "Note (optional)", Save and Discard, the status line, the 2 s dismissal of a saved or still-uploading
// result, the error that stays until Close or Esc) and the message view (Close, Esc, the 6 s countdown that pauses on
// hover and focus). It takes a Document, so it runs here directly.
//
// The view acts only on real user input: a click or key event a script dispatched (isTrusted false) does nothing.
// happy-dom does not implement isTrusted, so tests/helpers/dom-note.ts makes script events read false, as in a browser,
// and stamps true on the events that stand for a person.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteCaptureView } from '../lib/messages';
import { NoteNotSentError } from '../lib/note-status';
import { createMessageView, createNoteView } from '../lib/note-view';
import type { MountedView, NoteViewCallbacks } from '../lib/note-view';
import {
  accessibleText,
  buttonNamed,
  deferred,
  isHidden,
  noteInput,
  press,
  scriptClick,
  scriptPress,
  statusLine,
  statusText,
  trusted,
  useBrowserTrust,
  userClick,
  wait,
} from './helpers/dom-note';

const CAPTURE: NoteCaptureView = { captureId: 'cap-1', filename: 'Capture 2026-10-07 13.42.10.png', fileKind: 'image' };
const THUMBNAIL = 'data:image/png;base64,iVBORw0KGgo=';
const SAVED = 'Saved to Capture ✓';
const RETRY = 'Still uploading. It will finish on its own.';
const COULD_NOT_SAVE = "Couldn't save this capture. Capture it again.";

useBrowserTrust();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

interface MountedNote {
  view: MountedView;
  callbacks: {
    save: ReturnType<typeof vi.fn<NoteViewCallbacks['save']>>;
    discard: ReturnType<typeof vi.fn<() => void>>;
    onSettled: ReturnType<typeof vi.fn<() => void>>;
    onFinished: ReturnType<typeof vi.fn<() => void>>;
  };
  input: HTMLInputElement;
  saveButton: HTMLButtonElement;
  discardButton: HTMLButtonElement;
}

function mountNote(capture: Partial<NoteCaptureView> = {}, options: { withOnSettled?: boolean } = {}): MountedNote {
  const callbacks = {
    save: vi.fn<NoteViewCallbacks['save']>(async () => ({ outcome: 'saved' })),
    discard: vi.fn<() => void>(),
    onSettled: vi.fn<() => void>(),
    onFinished: vi.fn<() => void>(),
  };
  const withOnSettled = options.withOnSettled ?? true;
  const view = createNoteView(document, { ...CAPTURE, ...capture }, {
    save: callbacks.save,
    discard: callbacks.discard,
    onFinished: callbacks.onFinished,
    ...(withOnSettled ? { onSettled: callbacks.onSettled } : {}),
  });
  document.body.append(view.element);
  return { view, callbacks, input: noteInput(), saveButton: buttonNamed('Save'), discardButton: buttonNamed('Discard') };
}

describe('test setup', () => {
  it('reads isTrusted false for a script event, as a browser does, and true for one marked as real input', () => {
    expect(new MouseEvent('click').isTrusted).toBe(false);
    expect(new KeyboardEvent('keydown', { key: 'Enter' }).isTrusted).toBe(false);
    expect(trusted(new MouseEvent('click')).isTrusted).toBe(true);
  });

  it('reads isTrusted false for the event that element.click() makes', () => {
    const button = document.createElement('button');
    const seen: boolean[] = [];
    button.addEventListener('click', (event) => seen.push(event.isTrusted));

    button.click();

    expect(seen).toEqual([false]);
  });
});

describe('note step: what it shows', () => {
  it('shows the filename, a visible "Note (optional)" label for the field, and Save and Discard', () => {
    mountNote();

    expect(document.body.textContent).toContain('Capture 2026-10-07 13.42.10.png');
    const label = document.querySelector('label');
    expect(label?.textContent).toBe('Note (optional)');
    expect(label?.htmlFor).toBe(noteInput().id);
    expect(noteInput().type).toBe('text');
    expect(noteInput().value).toBe('');
    expect(isHidden(noteInput())).toBe(false);
    expect(accessibleText(buttonNamed('Save'))).toBe('Save');
    expect(accessibleText(buttonNamed('Discard'))).toBe('Discard');
  });

  it('describes the field by the filename it will be saved as', () => {
    mountNote();

    const describedBy = noteInput().getAttribute('aria-describedby')?.split(' ') ?? [];
    const described = describedBy.map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Capture 2026-10-07 13.42.10.png']);
  });

  it('shows the notice above the file and describes the field by it too', () => {
    mountNote({ message: "Selection isn't available on this page, so the visible area was captured." });

    const describedBy = noteInput().getAttribute('aria-describedby')?.split(' ') ?? [];
    const described = describedBy.map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual([
      "Selection isn't available on this page, so the visible area was captured.",
      'Capture 2026-10-07 13.42.10.png',
    ]);
  });

  it('adds no notice when the message is empty', () => {
    mountNote({ message: '' });

    expect(noteInput().getAttribute('aria-describedby')?.split(' ')).toHaveLength(1);
  });

  it('exposes the Save and Discard shortcuts without reading the key hints aloud', () => {
    const { saveButton, discardButton } = mountNote();

    expect(saveButton.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(discardButton.getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(saveButton.querySelector('[aria-hidden="true"]')?.textContent).toBe('↵');
    expect(discardButton.querySelector('[aria-hidden="true"]')?.textContent).toBe('esc');
    expect(saveButton.type).toBe('button');
    expect(discardButton.type).toBe('button');
  });

  it('has an empty polite live region ready for the status line', () => {
    mountNote();

    expect(statusLine().textContent).toBe('');
  });

  it('has no form element, which a page script could submit', () => {
    mountNote();

    expect(document.querySelector('form')).toBeNull();
  });

  it('puts the cursor in the note field when asked to take focus', () => {
    const { view, input } = mountNote();
    expect(document.activeElement).not.toBe(input);

    view.focus();

    expect(document.activeElement).toBe(input);
  });

  it('shows a file icon for a PDF and a different one for other files', () => {
    mountNote({ fileKind: 'pdf', filename: 'Report.pdf' });
    const pdfIcon = document.querySelector('.note-preview svg')?.innerHTML;
    document.body.innerHTML = '';
    mountNote({ fileKind: 'file', filename: 'Notes.txt' });
    const fileIcon = document.querySelector('.note-preview svg')?.innerHTML;

    expect(pdfIcon).toBeTruthy();
    expect(fileIcon).toBeTruthy();
    expect(pdfIcon).not.toBe(fileIcon);
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.note-preview svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a file icon when an image has no thumbnail', () => {
    mountNote({ fileKind: 'image' });

    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.note-preview svg')).not.toBeNull();
  });

  it('draws an image thumbnail into a canvas labelled Preview', async () => {
    const bitmap = { width: 320, height: 200, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => ({ drawImage })) as unknown as HTMLCanvasElement['getContext'],
    );

    mountNote({ thumbnailDataUrl: THUMBNAIL });
    await wait();

    const canvas = document.querySelector('canvas');
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toBe('Preview');
    expect([canvas?.width, canvas?.height]).toEqual([320, 200]);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to the file icon when the thumbnail cannot be decoded', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('The source image could not be decoded.'))));

    mountNote({ thumbnailDataUrl: THUMBNAIL });
    await wait();

    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.note-preview svg')).not.toBeNull();
  });

  it('falls back to the file icon when the thumbnail is not a base64 data URL', async () => {
    const decode = vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }));
    vi.stubGlobal('createImageBitmap', decode);

    mountNote({ thumbnailDataUrl: 'data:image/svg+xml,<svg/>' });
    await wait();

    expect(decode).not.toHaveBeenCalled();
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('.note-preview svg')).not.toBeNull();
  });
});

describe('note step: saving', () => {
  it('Enter saves the typed note: Saving…, then Saved to Capture ✓, then it finishes 2 s later', async () => {
    const { callbacks, input, saveButton } = mountNote();
    const answer = deferred<unknown>();
    callbacks.save.mockReturnValue(answer.promise);
    input.value = 'Receipt for the Q3 offsite';

    const event = press(input, 'Enter');

    expect(event.defaultPrevented).toBe(true);
    expect(callbacks.save).toHaveBeenCalledExactlyOnceWith('Receipt for the Q3 offsite');
    expect(statusText()).toBe('Saving…');
    expect(isHidden(input)).toBe(true);
    expect(isHidden(saveButton)).toBe(true);

    answer.resolve({ outcome: 'saved' });
    await wait();
    expect(statusText()).toBe(SAVED);
    expect(callbacks.onFinished).not.toHaveBeenCalled();

    await wait(1999);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    await wait(1);
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.discard).not.toHaveBeenCalled();
  });

  it('the Save button saves the same way', async () => {
    const { callbacks, input, saveButton } = mountNote();
    input.value = 'Invoice 4411';

    userClick(saveButton);
    await wait();

    expect(callbacks.save).toHaveBeenCalledExactlyOnceWith('Invoice 4411');
    expect(statusText()).toBe(SAVED);
  });

  it('saves an empty note when nothing was typed', async () => {
    const { callbacks, input } = mountNote();

    press(input, 'Enter');
    await wait();

    expect(callbacks.save).toHaveBeenCalledExactlyOnceWith('');
  });

  it.each([
    ['saved', { outcome: 'saved' }, SAVED, 'saved'],
    ['will_retry', { outcome: 'will_retry' }, RETRY, 'waiting'],
    ['no answer value', undefined, RETRY, 'waiting'],
    ['an answer it does not recognise', { outcome: 'lost' }, RETRY, 'waiting'],
  ])('shows the line for %s, with no Close button, and finishes 2 s later', async (_name, answer, text, tone) => {
    const { callbacks, input } = mountNote();
    callbacks.save.mockResolvedValue(answer);

    press(input, 'Enter');
    await wait();

    expect(statusText()).toBe(text);
    expect(statusLine().classList.contains(`status-${tone}`)).toBe(true);
    expect(isHidden(buttonNamed('Close'))).toBe(true);
    await wait(1999);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    await wait(1);
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(isHidden(buttonNamed('Close'))).toBe(true);
  });

  it('says it is still uploading when the background has not answered after 30 s', async () => {
    const { callbacks, input } = mountNote();
    callbacks.save.mockReturnValue(new Promise(() => undefined));

    press(input, 'Enter');
    await wait(29_999);
    expect(statusText()).toBe('Saving…');
    await wait(1);
    expect(statusText()).toBe(RETRY);
    expect(statusLine().classList.contains('status-waiting')).toBe(true);

    await wait(2000);
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });

  it('says it is still uploading when the message port closed without an answer', async () => {
    const { callbacks, input } = mountNote();
    callbacks.save.mockRejectedValue(new Error('The message port closed before a response was received.'));

    press(input, 'Enter');
    await wait();

    expect(statusText()).toBe(RETRY);
  });

  it('ignores a held Enter, then saves on a fresh press', async () => {
    const { callbacks, input } = mountNote();

    const held = press(input, 'Enter', { repeat: true });
    press(input, 'Enter', { repeat: true });
    await wait();

    expect(callbacks.save).not.toHaveBeenCalled();
    expect(held.defaultPrevented).toBe(false);
    expect(statusText()).toBe('');
    expect(isHidden(input)).toBe(false);

    press(input, 'Enter');
    await wait();

    expect(callbacks.save).toHaveBeenCalledOnce();
  });

  it('ignores the Enter that confirms text an input method is composing', async () => {
    const { callbacks, input } = mountNote();

    press(input, 'Enter', { isComposing: true });
    await wait();

    expect(callbacks.save).not.toHaveBeenCalled();
    expect(isHidden(input)).toBe(false);
  });

  it('ignores keys other than Enter in the field', async () => {
    const { callbacks, input } = mountNote();

    const letter = press(input, 'a');
    press(input, 'Tab');
    await wait();

    expect(callbacks.save).not.toHaveBeenCalled();
    expect(letter.defaultPrevented).toBe(false);
  });

  it('saves once when Enter is pressed twice or Save is clicked twice', async () => {
    const { callbacks, input, saveButton } = mountNote();
    callbacks.save.mockReturnValue(new Promise(() => undefined));

    press(input, 'Enter');
    press(input, 'Enter');
    userClick(saveButton);
    userClick(saveButton);

    expect(callbacks.save).toHaveBeenCalledOnce();
    expect(callbacks.onSettled).toHaveBeenCalledOnce();
  });

  it('hands focus back to the page while the field still has it, before showing the status', () => {
    const { view, callbacks, input } = mountNote();
    view.focus();
    const seen: Array<{ fieldFocused: boolean; formShown: boolean; status: string }> = [];
    callbacks.onSettled.mockImplementation(() => {
      seen.push({ fieldFocused: document.activeElement === input, formShown: !isHidden(input), status: statusText() });
    });
    callbacks.save.mockReturnValue(new Promise(() => undefined));

    press(input, 'Enter');

    expect(seen).toEqual([{ fieldFocused: true, formShown: true, status: '' }]);
  });

  it('works without an onSettled callback', async () => {
    const { callbacks, input } = mountNote({}, { withOnSettled: false });

    press(input, 'Enter');
    await wait();

    expect(callbacks.save).toHaveBeenCalledOnce();
    expect(statusText()).toBe(SAVED);
  });

  it('does not discard while the save is in progress or after it', async () => {
    const { callbacks, input, discardButton, view } = mountNote();
    const answer = deferred<unknown>();
    callbacks.save.mockReturnValue(answer.promise);

    press(input, 'Enter');
    press(input, 'Escape');
    userClick(discardButton);
    view.cancel();
    answer.resolve({ outcome: 'saved' });
    await wait();
    press(input, 'Escape');

    expect(callbacks.discard).not.toHaveBeenCalled();
    expect(statusText()).toBe(SAVED);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('reports the typed note as unsent until Save is pressed', () => {
    const { view, input } = mountNote();
    expect(view.unsentNote()).toBe('');

    input.value = 'half a note';
    expect(view.unsentNote()).toBe('half a note');

    press(input, 'Enter');
    expect(view.unsentNote()).toBeUndefined();
  });

  it('never calls back after destroy: a late answer writes no status and nothing finishes', async () => {
    const { view, callbacks, input } = mountNote();
    const answer = deferred<unknown>();
    callbacks.save.mockReturnValue(answer.promise);

    press(input, 'Enter');
    view.destroy();
    answer.resolve({ outcome: 'saved' });
    await wait(10_000);

    expect(statusText()).toBe('Saving…');
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('destroy cancels the pending dismissal after the final status', async () => {
    const { view, callbacks, input } = mountNote();

    press(input, 'Enter');
    await wait(1000);
    expect(statusText()).toBe(SAVED);
    view.destroy();
    await wait(10_000);

    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });
});

describe('note step: a save that ends in an error', () => {
  // An error stays until the user closes it (WCAG 2.2.1), as an error message on its own does: a Close button, and Esc.
  const HOUR_MS = 60 * 60 * 1000;
  const REJECTED = 'Mailbox key was rejected. Check Settings.';
  const REJECTED_ANSWER: NoteViewCallbacks['save'] = async () => ({ outcome: 'needs_attention', message: REJECTED });
  const ERRORS: Array<[string, NoteViewCallbacks['save'], string]> = [
    ['needs_attention with its own message', REJECTED_ANSWER, REJECTED],
    ['needs_attention without a message', async () => ({ outcome: 'needs_attention' }), COULD_NOT_SAVE],
    ['a save that was never sent (NoteNotSentError)', () => Promise.reject(new NoteNotSentError('The extension was reloaded.')), COULD_NOT_SAVE],
    ['a save that was never sent ("Extension context invalidated")', () => Promise.reject(new Error('Extension context invalidated.')), COULD_NOT_SAVE],
    [
      'a send that throws at once',
      () => {
        throw new Error('Extension context invalidated.');
      },
      COULD_NOT_SAVE,
    ],
  ];

  /** Mounts the note view and presses Save, which the background answers with `save` (needs_attention by default). */
  async function saveWithError(save: NoteViewCallbacks['save'] = REJECTED_ANSWER): Promise<MountedNote> {
    const mounted = mountNote();
    mounted.callbacks.save.mockImplementation(save);
    press(mounted.input, 'Enter');
    await wait();
    return mounted;
  }

  it.each(ERRORS)('shows %s with the attention circle and a Close button, and keeps it past 2 s', async (_name, save, text) => {
    const { callbacks } = await saveWithError(save);

    expect(statusText()).toBe(text);
    expect(statusLine().classList.contains('status-attention')).toBe(true);
    expect(isHidden(buttonNamed('Close'))).toBe(false);

    await wait(2000);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    await wait(HOUR_MS);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    expect(statusText()).toBe(text);
    expect(isHidden(buttonNamed('Close'))).toBe(false);
  });

  it('leaves nothing waiting to dismiss it', async () => {
    await saveWithError();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows Close only after the error: not while editing or while saving', async () => {
    const { callbacks, input } = mountNote();
    const answer = deferred<unknown>();
    callbacks.save.mockReturnValue(answer.promise);
    expect(isHidden(buttonNamed('Close'))).toBe(true);

    press(input, 'Enter');
    expect(statusText()).toBe('Saving…');
    expect(isHidden(buttonNamed('Close'))).toBe(true);

    answer.resolve({ outcome: 'needs_attention', message: REJECTED });
    await wait();
    expect(isHidden(buttonNamed('Close'))).toBe(false);
  });

  it('has the same plain Close button as the message view: same label and classes, no Esc key chip', async () => {
    await saveWithError();
    const message = createMessageView(document, { message: 'Nothing to capture.', kind: 'error' }, { onFinished: vi.fn<() => void>() });
    const messageClose = buttonNamed('Close', message.element);
    const close = buttonNamed('Close');

    expect(accessibleText(close)).toBe(accessibleText(messageClose));
    expect(close.className).toBe(messageClose.className);
    expect(close.outerHTML).toBe(messageClose.outerHTML);
    expect(close.type).toBe('button');
    expect(close.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(close.querySelector('.kbd')).toBeNull();
  });

  it('keeps Close out of the live region, so the announcement is the error alone', async () => {
    await saveWithError();

    expect(statusLine().contains(buttonNamed('Close'))).toBe(false);
    expect(statusText()).toBe(REJECTED);
  });

  it('a click on Close from the user finishes it, and does not discard or save again', async () => {
    const { callbacks } = await saveWithError();

    userClick(buttonNamed('Close'));

    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.discard).not.toHaveBeenCalled();
    expect(callbacks.save).toHaveBeenCalledOnce();
  });

  it.each([
    ['the Close button', () => buttonNamed('Close')],
    ['the status line', () => statusLine()],
  ])('Esc with focus on %s finishes it and keeps the browser from acting on the key', async (_name, target) => {
    const { callbacks } = await saveWithError();

    const event = press(target(), 'Escape');

    expect(event.defaultPrevented).toBe(true);
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.discard).not.toHaveBeenCalled();
  });

  it('cancel() finishes it, as Esc does: the note window sends Esc pressed anywhere in it this way', async () => {
    const { view, callbacks } = await saveWithError();

    view.cancel();

    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.discard).not.toHaveBeenCalled();
  });

  it('finishes once however many times it is closed', async () => {
    const { view, callbacks } = await saveWithError();

    userClick(buttonNamed('Close'));
    press(buttonNamed('Close'), 'Escape');
    view.cancel();
    await wait(HOUR_MS);

    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });

  it('ignores a click or Esc that a script made, and finishes for the same click from the user', async () => {
    const { callbacks } = await saveWithError();
    const close = buttonNamed('Close');

    scriptClick(close);
    scriptPress(close, 'Escape');
    scriptPress(statusLine(), 'Escape');
    await wait(2000);
    expect(callbacks.onFinished).not.toHaveBeenCalled();

    userClick(close);
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });

  it('ignores Esc while an input method is composing, and other keys', async () => {
    const { callbacks } = await saveWithError();

    press(buttonNamed('Close'), 'Escape', { isComposing: true });
    press(buttonNamed('Close'), 'Enter');
    press(buttonNamed('Close'), 'a');

    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('Esc while Saving… does nothing: no discard, no finish, and the error still arrives with its Close button', async () => {
    const { view, callbacks, input, discardButton } = mountNote();
    const answer = deferred<unknown>();
    callbacks.save.mockReturnValue(answer.promise);

    press(input, 'Enter');
    press(input, 'Escape');
    press(statusLine(), 'Escape');
    userClick(discardButton);
    view.cancel();
    userClick(buttonNamed('Close'));
    expect(statusText()).toBe('Saving…');
    expect(callbacks.onFinished).not.toHaveBeenCalled();

    answer.resolve({ outcome: 'needs_attention', message: REJECTED });
    await wait();
    expect(statusText()).toBe(REJECTED);
    expect(isHidden(buttonNamed('Close'))).toBe(false);
    expect(callbacks.onFinished).not.toHaveBeenCalled();
    expect(callbacks.discard).not.toHaveBeenCalled();

    press(statusLine(), 'Escape');
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });

  it('does not discard on Esc once the error shows: Esc closes, and the capture is not thrown away', async () => {
    const { callbacks, input } = await saveWithError();

    press(input, 'Escape');
    userClick(buttonNamed('Discard'));

    expect(callbacks.discard).not.toHaveBeenCalled();
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });

  it('does not take focus: the page element that has it keeps it, and the view never calls focus()', async () => {
    const page = document.createElement('button');
    document.body.append(page);
    const { view, callbacks, input } = mountNote();
    callbacks.save.mockResolvedValue({ outcome: 'needs_attention', message: REJECTED });
    // What the in-page card does when Save is pressed: hand focus back to the page.
    callbacks.onSettled.mockImplementation(() => page.focus());
    view.focus();
    expect(document.activeElement).toBe(input);

    press(input, 'Enter');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await wait();

    expect(statusText()).toBe(REJECTED);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(page);
    expect(view.element.contains(document.activeElement)).toBe(false);
  });

  it('never calls back after destroy: Close and Esc do nothing, and a late error shows neither status nor Close', async () => {
    const shown = await saveWithError();
    shown.view.destroy();

    userClick(buttonNamed('Close'));
    press(buttonNamed('Close'), 'Escape');
    shown.view.cancel();
    await wait(HOUR_MS);
    expect(shown.callbacks.onFinished).not.toHaveBeenCalled();

    document.body.innerHTML = '';
    const { view, callbacks, input } = mountNote();
    const answer = deferred<unknown>();
    callbacks.save.mockReturnValue(answer.promise);
    press(input, 'Enter');
    view.destroy();
    answer.resolve({ outcome: 'needs_attention', message: REJECTED });
    await wait(HOUR_MS);

    expect(statusText()).toBe('Saving…');
    expect(isHidden(buttonNamed('Close'))).toBe(true);
    userClick(buttonNamed('Close'));
    expect(callbacks.onFinished).not.toHaveBeenCalled();
  });

  it('reports no unsent note, so a card that replaces it does not save the capture again', async () => {
    const { view } = await saveWithError();

    expect(view.unsentNote()).toBeUndefined();
  });
});

describe('note step: discarding', () => {
  it('Esc in the field discards, finishes at once, and keeps the browser from acting on the key', () => {
    const { callbacks, input } = mountNote();

    const event = press(input, 'Escape');

    expect(event.defaultPrevented).toBe(true);
    expect(callbacks.discard).toHaveBeenCalledOnce();
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.save).not.toHaveBeenCalled();
  });

  it('the Discard button discards', () => {
    const { callbacks, discardButton } = mountNote();

    userClick(discardButton);

    expect(callbacks.discard).toHaveBeenCalledOnce();
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.save).not.toHaveBeenCalled();
  });

  it('Esc pressed while a button has focus discards too', () => {
    const { callbacks, saveButton } = mountNote();

    press(saveButton, 'Escape');

    expect(callbacks.discard).toHaveBeenCalledOnce();
  });

  it('cancel() discards, as Esc does', () => {
    const { view, callbacks } = mountNote();

    view.cancel();

    expect(callbacks.discard).toHaveBeenCalledOnce();
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
  });

  it('settles first, then tells the background, then finishes', () => {
    const { callbacks, input } = mountNote();
    const order: string[] = [];
    callbacks.onSettled.mockImplementation(() => order.push('settled'));
    callbacks.discard.mockImplementation(() => order.push('discard'));
    callbacks.onFinished.mockImplementation(() => order.push('finished'));

    press(input, 'Escape');

    expect(order).toEqual(['settled', 'discard', 'finished']);
  });

  it('discards only once, and a Save after Discard does nothing', () => {
    const { callbacks, input, discardButton, saveButton } = mountNote();

    press(input, 'Escape');
    press(input, 'Escape');
    userClick(discardButton);
    userClick(saveButton);
    press(input, 'Enter');

    expect(callbacks.discard).toHaveBeenCalledOnce();
    expect(callbacks.onFinished).toHaveBeenCalledOnce();
    expect(callbacks.save).not.toHaveBeenCalled();
  });

  it('ignores Esc while an input method is composing, and other keys', () => {
    const { callbacks, input } = mountNote();

    press(input, 'Escape', { isComposing: true });
    press(input, 'Backspace');

    expect(callbacks.discard).not.toHaveBeenCalled();
  });

  it('reports no unsent note after Discard', () => {
    const { view, input } = mountNote();
    input.value = 'draft';

    press(input, 'Escape');

    expect(view.unsentNote()).toBeUndefined();
  });

  it('works without an onSettled callback', () => {
    const { callbacks, input } = mountNote({}, { withOnSettled: false });

    press(input, 'Escape');

    expect(callbacks.discard).toHaveBeenCalledOnce();
  });
});

describe('note step: events a web page script makes', () => {
  it('a script click on Save does nothing, and the same click from the user saves', async () => {
    const { callbacks, saveButton, input } = mountNote();

    scriptClick(saveButton);
    await wait();
    expect(callbacks.save).not.toHaveBeenCalled();
    expect(isHidden(input)).toBe(false);
    expect(statusText()).toBe('');

    userClick(saveButton);
    await wait();
    expect(callbacks.save).toHaveBeenCalledOnce();
  });

  it('a script click on Discard does nothing, and the same click from the user discards', () => {
    const { callbacks, discardButton } = mountNote();

    scriptClick(discardButton);
    expect(callbacks.discard).not.toHaveBeenCalled();
    expect(callbacks.onFinished).not.toHaveBeenCalled();

    userClick(discardButton);
    expect(callbacks.discard).toHaveBeenCalledOnce();
  });

  it('a script Enter in the field does not save and is not stopped from doing what the page expects', async () => {
    const { callbacks, input } = mountNote();

    const scripted = scriptPress(input, 'Enter');
    await wait();

    expect(callbacks.save).not.toHaveBeenCalled();
    expect(scripted.defaultPrevented).toBe(false);

    press(input, 'Enter');
    await wait();
    expect(callbacks.save).toHaveBeenCalledOnce();
  });

  it('a script Esc does not discard, and a real Esc does', () => {
    const { callbacks, input } = mountNote();

    scriptPress(input, 'Escape');
    expect(callbacks.discard).not.toHaveBeenCalled();
    expect(callbacks.onFinished).not.toHaveBeenCalled();

    press(input, 'Escape');
    expect(callbacks.discard).toHaveBeenCalledOnce();
  });
});

describe('message view', () => {
  function mountMessage(kind: 'error' | 'info', message = 'Nothing on this page can be captured.') {
    const onFinished = vi.fn<() => void>();
    const view = createMessageView(document, { message, kind }, { onFinished });
    document.body.append(view.element);
    return { view, onFinished, closeButton: buttonNamed('Close') };
  }

  const hover = (view: MountedView) => view.element.dispatchEvent(new PointerEvent('pointerenter'));
  const unhover = (view: MountedView) => view.element.dispatchEvent(new PointerEvent('pointerleave'));

  it('shows a Close button and an empty live region, then writes the message a moment later', async () => {
    mountMessage('info', 'Saved a copy to your downloads folder.');

    expect(accessibleText(buttonNamed('Close'))).toBe('Close');
    expect(statusText()).toBe('');
    await wait(49);
    expect(statusText()).toBe('');
    await wait(1);
    expect(statusText()).toBe('Saved a copy to your downloads folder.');
  });

  it('marks an error with the attention circle and leaves information plain', async () => {
    mountMessage('error', 'This capture is no longer available. Capture it again.');
    await wait(50);
    expect(statusText()).toBe('This capture is no longer available. Capture it again.');
    expect(statusLine().classList.contains('status-attention')).toBe(true);

    document.body.innerHTML = '';
    mountMessage('info', 'Almost there.');
    await wait(50);
    expect(statusLine().classList.contains('status')).toBe(false);
  });

  it('has no note field, Save, or Discard', () => {
    mountMessage('error');

    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelectorAll('button')).toHaveLength(1);
  });

  it('the Close button finishes it', () => {
    const { closeButton, onFinished } = mountMessage('error');

    userClick(closeButton);

    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('Esc finishes it and keeps the browser from acting on the key', () => {
    const { closeButton, onFinished } = mountMessage('error');

    const event = press(closeButton, 'Escape');

    expect(event.defaultPrevented).toBe(true);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('ignores Esc while composing, and other keys', () => {
    const { closeButton, onFinished } = mountMessage('error');

    press(closeButton, 'Escape', { isComposing: true });
    press(closeButton, 'Enter');

    expect(onFinished).not.toHaveBeenCalled();
  });

  it('finishes once however many times it is closed', async () => {
    const { closeButton, view, onFinished } = mountMessage('info');

    userClick(closeButton);
    press(closeButton, 'Escape');
    view.cancel();
    await wait(60_000);

    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('cancel() closes it, as Esc does, and it has no unsent note', () => {
    const { view, onFinished } = mountMessage('error');

    expect(view.unsentNote()).toBeUndefined();
    view.cancel();

    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('a script click on Close or a script Esc does nothing', () => {
    const { closeButton, onFinished } = mountMessage('error');

    scriptClick(closeButton);
    scriptPress(closeButton, 'Escape');

    expect(onFinished).not.toHaveBeenCalled();
  });

  it('keeps an error until it is closed, however long that takes', async () => {
    const { closeButton, onFinished } = mountMessage('error');

    await wait(60 * 60 * 1000);
    expect(onFinished).not.toHaveBeenCalled();
    expect(statusText()).not.toBe('');

    userClick(closeButton);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('dismisses information after 6 s', async () => {
    const { onFinished } = mountMessage('info');

    await wait(5999);
    expect(onFinished).not.toHaveBeenCalled();
    await wait(1);
    expect(onFinished).toHaveBeenCalledOnce();
    await wait(60_000);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('pauses the countdown while the pointer is over it, and starts again from 6 s when it leaves', async () => {
    const { view, onFinished } = mountMessage('info');

    await wait(5000);
    hover(view);
    await wait(60_000);
    expect(onFinished).not.toHaveBeenCalled();

    unhover(view);
    await wait(5999);
    expect(onFinished).not.toHaveBeenCalled();
    await wait(1);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('pauses the countdown while focus is inside it, and starts again from 6 s when focus leaves', async () => {
    const { closeButton, onFinished } = mountMessage('info');

    await wait(5000);
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);
    await wait(60_000);
    expect(onFinished).not.toHaveBeenCalled();

    closeButton.blur();
    await wait(5999);
    expect(onFinished).not.toHaveBeenCalled();
    await wait(1);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('does not restart the countdown when focus moves between controls inside the message', async () => {
    const { view, closeButton, onFinished } = mountMessage('info');
    closeButton.focus();

    view.element.dispatchEvent(new FocusEvent('focusout', { relatedTarget: closeButton, bubbles: true }));
    await wait(60_000);

    expect(onFinished).not.toHaveBeenCalled();
  });

  it('stays paused until both the pointer and focus have left', async () => {
    const { view, closeButton, onFinished } = mountMessage('info');
    hover(view);
    closeButton.focus();

    unhover(view);
    await wait(60_000);
    expect(onFinished).not.toHaveBeenCalled();

    closeButton.blur();
    await wait(6000);
    expect(onFinished).toHaveBeenCalledOnce();
  });

  it('never calls back after destroy, and writes no message if it was destroyed first', async () => {
    const { view, onFinished } = mountMessage('info');

    view.destroy();
    await wait(60_000);

    expect(onFinished).not.toHaveBeenCalled();
    expect(statusText()).toBe('');
  });

  it('puts focus on Close when asked to take focus', () => {
    const { view, closeButton } = mountMessage('error');

    view.focus();

    expect(document.activeElement).toBe(closeButton);
  });
});
