// @vitest-environment happy-dom
// The two content scripts that draw on top of a web page: the in-page note card (entrypoints/note-card.content.ts) and
// the Select area overlay (entrypoints/select-area.content.ts). Each test starts the real script with WXT's own
// ContentScriptContext, as WXT does on every injection, and drives it the way the background and the user do: with
// runtime messages, key presses, and pointer events. The scripts keep their UI in closed shadow roots on purpose, so
// the page cannot reach it; to look inside, the tests record the root that attachShadow returns (a spy on the
// platform call, with no change to the product code).
//
// Both scripts ignore events a page script dispatched (isTrusted false). happy-dom has no Event.isTrusted of its own,
// so tests/helpers/dom-note.ts makes script events read false, as in a browser, and stamps true on a person's events.
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import noteCard from '../entrypoints/note-card.content';
import selectArea from '../entrypoints/select-area.content';
import { isNoteRequestMessage, isSelectAreaMessage } from '../lib/messages';
import type { NoteRequestMessage } from '../lib/messages';
import {
  accessibleText,
  buttonNamed,
  noteInput,
  press,
  scriptPress,
  statusText,
  trusted,
  useBrowserTrust,
  userClick,
  wait,
} from './helpers/dom-note';

const NOTE_CARD = 'capture-to-drive-note-card';
const SELECT_AREA = 'capture-to-drive-select-area';
const THUMBNAIL = 'data:image/png;base64,iVBORw0KGgo=';
const SHOW_CAPTURE = {
  type: 'note:show',
  captureId: 'cap-1',
  filename: 'Capture 2026-10-07 13.42.10.png',
  fileKind: 'image',
} as const;

useBrowserTrust();

let contexts: ContentScriptContext[];
let shadowRoots: ShadowRoot[];
let attachShadow: MockInstance<Element['attachShadow']>;
let sentToBackground: unknown[];
/** What the background answers to note:save. */
let saveAnswer: unknown;
/** Listeners that tests add to the page use this signal, so a failing test cannot leave one behind for the next. */
let pageListeners: AbortController;

beforeEach(() => {
  fakeBrowser.reset();
  pageListeners = new AbortController();
  vi.useFakeTimers();
  contexts = [];
  shadowRoots = [];
  sentToBackground = [];
  saveAnswer = { outcome: 'saved' };
  // WXT logs "context invalidated" at debug level; keep it out of the test output.
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  const realAttachShadow = Element.prototype.attachShadow;
  attachShadow = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = realAttachShadow.call(this, init);
    shadowRoots.push(root);
    return root;
  });
  document.body.innerHTML = '<button id="page-button">Page button</button><input id="page-field" aria-label="Page field">';
  // Records every runtime message the scripts send. Note requests are answered like the background does.
  fakeBrowser.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
    sentToBackground.push(message);
    if (!isNoteRequestMessage(message)) return undefined;
    sendResponse(message.type === 'note:save' ? saveAnswer : { ok: true });
    return true;
  });
});

afterEach(() => {
  pageListeners.abort();
  // Invalidating a context is what WXT does when a script is replaced: it removes the script's listeners and UI.
  for (const context of contexts) context.notifyInvalidated();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.querySelectorAll(`${NOTE_CARD}, ${SELECT_AREA}`).forEach((node) => node.remove());
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

/** A context like the one WXT hands a script. Creating one invalidates an earlier context of the same script. */
function newContext(name: string): ContentScriptContext {
  const context = new ContentScriptContext(name);
  contexts.push(context);
  return context;
}

/** The closed shadow root of the newest element with this tag. */
function rootOf(tag: string): ShadowRoot {
  const found = [...shadowRoots].reverse().find((root) => root.host.localName === tag);
  if (found === undefined) throw new Error(`No shadow root was attached to a ${tag}`);
  return found;
}

function inRoot<T extends Element>(root: ShadowRoot, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}`);
  return found;
}

function pageButton(): HTMLButtonElement {
  return inDocument<HTMLButtonElement>('#page-button');
}

function inDocument<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}`);
  return found;
}

/** The note requests the card or window sent to the background. */
function noteRequests(): NoteRequestMessage[] {
  return sentToBackground.filter(isNoteRequestMessage);
}

describe('note card', () => {
  /** What the background does: send a card message to the tab, and read the card's answer. */
  function deliver(message: unknown): unknown[] {
    const sendResponse = vi.fn();
    void fakeBrowser.runtime.onMessage.trigger(message, {}, sendResponse);
    return sendResponse.mock.calls.map(([response]) => response);
  }

  function startCard(): ContentScriptContext {
    const context = newContext('note-card');
    void noteCard.main(context);
    return context;
  }

  const cardHosts = () => document.querySelectorAll(NOTE_CARD);
  const cardRoot = () => rootOf(NOTE_CARD);
  const cardInput = () => noteInput(cardRoot());
  const cardStatus = () => statusText(cardRoot());
  const cardButton = (name: string) => buttonNamed(name, cardRoot());

  describe('showing a capture', () => {
    it('adds a card to the page and answers { ok: true }', () => {
      startCard();

      const responses = deliver(SHOW_CAPTURE);

      expect(responses).toEqual([{ ok: true }]);
      expect(cardHosts()).toHaveLength(1);
      expect(cardHosts()[0]?.parentElement).toBe(document.documentElement);
    });

    it('keeps the card out of the page: the host has no shadowRoot, no children, and no text', () => {
      startCard();

      deliver({ ...SHOW_CAPTURE, message: 'Selection is not available here.', thumbnailDataUrl: THUMBNAIL });

      const host = inDocument(NOTE_CARD);
      expect(host.shadowRoot).toBeNull();
      expect(host.children).toHaveLength(0);
      expect(host.innerHTML).toBe('');
      expect(host.textContent).toBe('');
      expect(document.documentElement.textContent).not.toContain('Capture 2026-10-07');
      expect(document.documentElement.textContent).not.toContain('Selection is not available');
      expect(document.querySelector('canvas, input[aria-describedby]')).toBeNull();
      // Nothing about the capture sits in an attribute of the host either (title, aria-*, data-*), or anywhere in the
      // page's own markup, where a page script could read it.
      const pageMarkup = document.documentElement.outerHTML;
      for (const secret of ['Capture 2026-10-07', 'Selection is not available', 'cap-1', THUMBNAIL]) {
        expect(pageMarkup, `the page markup contains ${secret}`).not.toContain(secret);
      }
    });

    it('does not let the page attach a shadow root of its own to read the card', () => {
      startCard();
      deliver(SHOW_CAPTURE);

      expect(() => inDocument(NOTE_CARD).attachShadow({ mode: 'open' })).toThrow();
      expect(inDocument(NOTE_CARD).shadowRoot).toBeNull();
    });

    it('shows a dialog named Capture to Drive with the filename and the note field, and focuses the field', () => {
      pageButton().focus();
      startCard();

      deliver(SHOW_CAPTURE);

      const card = inRoot(cardRoot(), '.note-card');
      expect(card.getAttribute('role')).toBe('dialog');
      expect(card.getAttribute('aria-label')).toBe('Capture to Drive');
      expect(card.textContent).toContain('Capture 2026-10-07 13.42.10.png');
      expect(inRoot(cardRoot(), 'label').textContent).toBe('Note (optional)');
      expect(accessibleText(cardButton('Save'))).toBe('Save');
      expect(accessibleText(cardButton('Discard'))).toBe('Discard');
      expect(document.activeElement).toBe(inDocument(NOTE_CARD));
      expect(cardRoot().activeElement).toBe(cardInput());
    });

    it('styles the card with an adopted stylesheet, which a page content security policy cannot block', () => {
      startCard();

      deliver(SHOW_CAPTURE);

      expect(cardRoot().adoptedStyleSheets).toHaveLength(1);
      expect(cardRoot().querySelector('style')).toBeNull();
    });

    it('falls back to a style element when constructed stylesheets are not available', async () => {
      vi.resetModules();
      const fresh = (await import('../entrypoints/note-card.content')).default;
      vi.spyOn(CSSStyleSheet.prototype, 'replaceSync').mockImplementation(() => {
        throw new DOMException('Constructed stylesheets are not supported.', 'NotSupportedError');
      });
      void fresh.main(newContext('note-card'));

      deliver(SHOW_CAPTURE);

      expect(inRoot(cardRoot(), 'style').textContent).toContain('.note-card');
      expect(inRoot(cardRoot(), '.note-card')).not.toBeNull();
    });

    it('answers a note:show for a PDF with a file icon in the card', () => {
      startCard();

      deliver({ ...SHOW_CAPTURE, fileKind: 'pdf', filename: 'Report.pdf' });

      expect(cardRoot().textContent).toContain('Report.pdf');
      expect(cardRoot().querySelector('.note-preview svg')).not.toBeNull();
    });

    it('shows the filename as text, never as markup', () => {
      startCard();

      deliver({ ...SHOW_CAPTURE, filename: '<img src=x onerror=alert(1)>.png' });

      expect(cardRoot().textContent).toContain('<img src=x onerror=alert(1)>.png');
      expect(cardRoot().querySelector('img')).toBeNull();
      expect(document.querySelector('img')).toBeNull();
    });
  });

  describe('messages it ignores or cannot show', () => {
    it.each([
      ['a message of another kind', { type: 'select-area:abort' }],
      ['a note:show without a filename', { type: 'note:show', captureId: 'cap-1', fileKind: 'image' }],
      ['a note:show with a thumbnail that is not an image data URL', { ...SHOW_CAPTURE, thumbnailDataUrl: 'https://example.com/a.png' }],
      ['a note:message of an unknown kind', { type: 'note:message', message: 'Hi', kind: 'warning' }],
      ['a string', 'note:show'],
      ['null', null],
    ])('does not answer or show anything for %s', (_name, message) => {
      startCard();

      expect(deliver(message)).toEqual([]);
      expect(cardHosts()).toHaveLength(0);
    });

    it('answers { ok: false } when the page cannot hold the card (a document that is not HTML)', () => {
      startCard();
      const svgRoot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const documentElement = vi.spyOn(document, 'documentElement', 'get').mockReturnValue(svgRoot as unknown as HTMLElement);

      expect(deliver(SHOW_CAPTURE)).toEqual([{ ok: false }]);

      documentElement.mockRestore();
      expect(cardHosts()).toHaveLength(0);
    });

    it('answers { ok: false } and warns when the card cannot be built here', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      startCard();
      attachShadow.mockImplementation(() => {
        throw new DOMException('Shadow roots are blocked.', 'NotSupportedError');
      });

      expect(deliver(SHOW_CAPTURE)).toEqual([{ ok: false }]);

      expect(warn).toHaveBeenCalledOnce();
      expect(cardHosts()).toHaveLength(0);
    });
  });

  describe('a message on its own', () => {
    it('answers { ok: true }, shows the message a moment later, and leaves focus where it was', async () => {
      pageButton().focus();
      startCard();

      expect(deliver({ type: 'note:message', message: 'Nothing on this page can be captured.', kind: 'error' })).toEqual([{ ok: true }]);
      expect(cardStatus()).toBe('');
      await wait(50);

      expect(cardStatus()).toBe('Nothing on this page can be captured.');
      expect(document.activeElement).toBe(pageButton());
      expect(inRoot(cardRoot(), '.note-card').getAttribute('role')).toBeNull();
      expect(accessibleText(cardButton('Close'))).toBe('Close');
    });

    it('keeps an error until it is closed, and removes it when Close is pressed', async () => {
      startCard();
      deliver({ type: 'note:message', message: 'Nothing on this page can be captured.', kind: 'error' });

      await wait(60 * 60 * 1000);
      expect(cardHosts()).toHaveLength(1);

      userClick(cardButton('Close'));
      await wait(150);
      expect(cardHosts()).toHaveLength(0);
    });

    it('removes information after 6 s, plus the short fade', async () => {
      startCard();
      deliver({ type: 'note:message', message: 'Saved a copy to your downloads folder.', kind: 'info' });

      await wait(5999);
      expect(cardHosts()).toHaveLength(1);
      await wait(1);
      expect(inRoot(cardRoot(), '.note-card').classList.contains('is-leaving')).toBe(true);
      await wait(150);
      expect(cardHosts()).toHaveLength(0);
    });

    it('keeps the capture of an untouched note card that a message replaces, by saving what was typed', async () => {
      startCard();
      deliver(SHOW_CAPTURE);
      cardInput().value = 'typed so far';

      deliver({ type: 'note:message', message: 'Heads up.', kind: 'info' });
      await wait();

      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: 'typed so far' }]);
      expect(cardHosts()).toHaveLength(1);
    });
  });

  describe('saving and discarding', () => {
    it('Enter saves the typed note: Saving…, Saved to Capture ✓, then the card fades out 2 s later', async () => {
      startCard();
      deliver(SHOW_CAPTURE);
      cardInput().value = 'Receipt for the Q3 offsite';

      press(cardInput(), 'Enter');

      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: 'Receipt for the Q3 offsite' }]);
      expect(cardStatus()).toBe('Saving…');
      await wait();
      expect(cardStatus()).toBe('Saved to Capture ✓');

      await wait(1999);
      expect(cardHosts()).toHaveLength(1);
      expect(inRoot(cardRoot(), '.note-card').classList.contains('is-leaving')).toBe(false);
      await wait(1);
      expect(inRoot(cardRoot(), '.note-card').classList.contains('is-leaving')).toBe(true);
      await wait(149);
      expect(cardHosts()).toHaveLength(1);
      await wait(1);
      expect(cardHosts()).toHaveLength(0);
    });

    it('the Save button saves too', async () => {
      startCard();
      deliver(SHOW_CAPTURE);

      userClick(cardButton('Save'));
      await wait();

      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: '' }]);
      expect(cardStatus()).toBe('Saved to Capture ✓');
    });

    it('removes the card at once, without the fade, when the user prefers reduced motion', async () => {
      vi.spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({ matches: query.includes('reduce'), media: query })) as typeof window.matchMedia);
      startCard();
      deliver(SHOW_CAPTURE);

      press(cardInput(), 'Enter');
      await wait(2000);

      expect(cardHosts()).toHaveLength(0);
    });

    it('Esc discards the capture and the card fades out', async () => {
      startCard();
      deliver(SHOW_CAPTURE);

      const event = press(cardInput(), 'Escape');

      expect(event.defaultPrevented).toBe(true);
      expect(noteRequests()).toEqual([{ type: 'note:discard', captureId: 'cap-1' }]);
      expect(inRoot(cardRoot(), '.note-card').classList.contains('is-leaving')).toBe(true);
      await wait(150);
      expect(cardHosts()).toHaveLength(0);
    });

    it('the Discard button discards the capture', async () => {
      startCard();
      deliver(SHOW_CAPTURE);

      userClick(cardButton('Discard'));
      await wait(150);

      expect(noteRequests()).toEqual([{ type: 'note:discard', captureId: 'cap-1' }]);
      expect(cardHosts()).toHaveLength(0);
    });

    it('gives focus back to the page element that had it when Save is pressed', () => {
      pageButton().focus();
      startCard();
      deliver(SHOW_CAPTURE);
      expect(document.activeElement).toBe(inDocument(NOTE_CARD));

      press(cardInput(), 'Enter');

      expect(document.activeElement).toBe(pageButton());
    });

    it('gives focus back to the page element that had it when the card is discarded', () => {
      pageButton().focus();
      startCard();
      deliver(SHOW_CAPTURE);

      press(cardInput(), 'Escape');

      expect(document.activeElement).toBe(pageButton());
    });

    it('lets go of focus when the element that had it is gone', () => {
      pageButton().focus();
      startCard();
      deliver(SHOW_CAPTURE);
      pageButton().remove();

      press(cardInput(), 'Escape');

      expect(document.activeElement).not.toBe(inDocument(NOTE_CARD));
    });
  });

  describe('a save that ends in an error', () => {
    const REJECTED = 'Mailbox key was rejected. Check Settings.';

    /** Shows the note step and presses Save; the background answers needs_attention. */
    async function saveWithError(): Promise<void> {
      saveAnswer = { outcome: 'needs_attention', message: REJECTED };
      startCard();
      deliver(SHOW_CAPTURE);
      press(cardInput(), 'Enter');
      await wait();
    }

    it('keeps the card, with a Close button, until the user closes it, then fades it out', async () => {
      await saveWithError();
      expect(cardStatus()).toBe(REJECTED);

      await wait(60 * 60 * 1000);
      expect(cardHosts()).toHaveLength(1);
      expect(inRoot(cardRoot(), '.note-card').classList.contains('is-leaving')).toBe(false);

      userClick(cardButton('Close'));
      expect(inRoot(cardRoot(), '.note-card').classList.contains('is-leaving')).toBe(true);
      await wait(150);
      expect(cardHosts()).toHaveLength(0);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: '' }]);
    });

    it('closes on Esc pressed inside the card, and leaves an Esc pressed in the page alone', async () => {
      await saveWithError();

      press(pageButton(), 'Escape');
      await wait(150);
      expect(cardHosts()).toHaveLength(1);

      const event = press(cardButton('Close'), 'Escape');
      expect(event.defaultPrevented).toBe(true);
      await wait(150);
      expect(cardHosts()).toHaveLength(0);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: '' }]);
    });

    it('cannot be closed by a page script, which only reaches the host, and still closes for the user', async () => {
      await saveWithError();
      const host = inDocument<HTMLElement>(NOTE_CARD);

      host.click();
      scriptPress(host, 'Escape');
      cardButton('Close').click();
      scriptPress(cardButton('Close'), 'Escape');
      await wait(10_000);
      expect(cardHosts()).toHaveLength(1);

      userClick(cardButton('Close'));
      await wait(150);
      expect(cardHosts()).toHaveLength(0);
    });

    it('does not take focus: the page element that had it keeps it', async () => {
      pageButton().focus();
      await saveWithError();

      expect(cardStatus()).toBe(REJECTED);
      expect(document.activeElement).toBe(pageButton());
    });

    it('is replaced by the next capture without saving or discarding anything for it', async () => {
      await saveWithError();

      deliver({ ...SHOW_CAPTURE, captureId: 'cap-2', filename: 'Second.png' });

      expect(cardHosts()).toHaveLength(1);
      expect(cardRoot().textContent).toContain('Second.png');
      expect(cardRoot().textContent).not.toContain(REJECTED);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: '' }]);
    });

    it('is taken away by a second injection of the script, sending nothing more', async () => {
      await saveWithError();

      const second = newContext('note-card');

      expect(cardHosts()).toHaveLength(0);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: '' }]);
      void noteCard.main(second);
      expect(deliver(SHOW_CAPTURE)).toEqual([{ ok: true }]);
      expect(cardHosts()).toHaveLength(1);
    });
  });

  describe('keys stay with their own side', () => {
    it('key presses inside the card never reach the page', () => {
      startCard();
      deliver(SHOW_CAPTURE);
      const targets: Array<[string, EventTarget]> = [
        ['document', document],
        ['html', document.documentElement],
        ['body', document.body],
        ['window', window],
      ];
      const heard = targets.map(([name, target]) => {
        const listener = vi.fn();
        for (const type of ['keydown', 'keyup', 'keypress']) target.addEventListener(type, listener, { signal: pageListeners.signal });
        return { name, listener };
      });
      const typed = (type: string, key: string) => new KeyboardEvent(type, { key, bubbles: true, composed: true });

      for (const type of ['keydown', 'keyup', 'keypress']) cardInput().dispatchEvent(typed(type, 'j'));
      cardInput().dispatchEvent(typed('keydown', ' '));

      for (const { name, listener } of heard) expect(listener, `${name} heard a key from the card`).not.toHaveBeenCalled();

      // The same keys from the page itself do reach those listeners, so the checks above can fail.
      for (const type of ['keydown', 'keyup', 'keypress']) inDocument('#page-field').dispatchEvent(typed(type, 'j'));
      for (const { name, listener } of heard) expect(listener, `${name} heard a key from the page`).toHaveBeenCalledTimes(3);
    });

    it('typing in the card still reaches the card: the note field takes the text', () => {
      startCard();
      deliver(SHOW_CAPTURE);

      cardInput().value = 'j k l';
      press(cardInput(), 'j');

      expect(cardInput().value).toBe('j k l');
      expect(noteRequests()).toEqual([]);
    });

    it('keys pressed in the page neither save, discard, nor change the card', async () => {
      pageButton().focus();
      startCard();
      deliver(SHOW_CAPTURE);
      cardInput().value = 'keep me';

      press(document.body, 'Escape');
      press(document, 'Escape');
      press(pageButton(), 'Escape');
      press(document.documentElement, 'Enter');
      press(inDocument('#page-field'), 'Enter');
      await wait(10_000);

      expect(noteRequests()).toEqual([]);
      expect(cardHosts()).toHaveLength(1);
      expect(cardInput().value).toBe('keep me');
    });
  });

  describe('what a page script cannot do', () => {
    it('cannot press Save or Discard with synthetic keys or clicks, and the card still works for the user', async () => {
      startCard();
      deliver(SHOW_CAPTURE);
      // All a page can reach is the host element, which is also document.activeElement while the card has focus.
      const host = inDocument<HTMLElement>(NOTE_CARD);
      expect(document.activeElement).toBe(host);

      scriptPress(host, 'Enter');
      scriptPress(host, 'Escape');
      host.click();
      // If a page did get hold of the inside, the card still ignores a script's events.
      scriptPress(cardInput(), 'Enter');
      scriptPress(cardInput(), 'Escape');
      cardButton('Save').click();
      cardButton('Discard').click();
      await wait(10_000);

      expect(noteRequests()).toEqual([]);
      expect(cardHosts()).toHaveLength(1);

      cardInput().value = 'still here';
      press(cardInput(), 'Enter');
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: 'still here' }]);
    });
  });

  describe('a second card or a second injection', () => {
    it('a second capture replaces the first card and saves what was typed in it', () => {
      startCard();
      deliver(SHOW_CAPTURE);
      cardInput().value = 'half a note';

      deliver({ ...SHOW_CAPTURE, captureId: 'cap-2', filename: 'Second.png' });

      expect(cardHosts()).toHaveLength(1);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: 'half a note' }]);
      expect(cardRoot().textContent).toContain('Second.png');
      expect(cardRoot().textContent).not.toContain('Capture 2026-10-07');
    });

    it('does not save the first capture again if the user had already pressed Save', async () => {
      startCard();
      deliver(SHOW_CAPTURE);
      press(cardInput(), 'Enter');
      await wait();

      deliver({ ...SHOW_CAPTURE, captureId: 'cap-2', filename: 'Second.png' });

      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: '' }]);
      expect(cardHosts()).toHaveLength(1);
    });

    it('does not save or discard anything for the first card if it was a message', () => {
      startCard();
      deliver({ type: 'note:message', message: 'Heads up.', kind: 'error' });

      deliver(SHOW_CAPTURE);

      expect(noteRequests()).toEqual([]);
      expect(cardHosts()).toHaveLength(1);
    });

    it('removes a card left behind by an earlier run of the script', () => {
      const stray = document.createElement(NOTE_CARD);
      document.body.append(stray);
      startCard();

      deliver(SHOW_CAPTURE);

      expect(stray.isConnected).toBe(false);
      expect(cardHosts()).toHaveLength(1);
    });

    it('a second injection removes the old card, keeps its capture, and leaves one listener', () => {
      startCard();
      deliver(SHOW_CAPTURE);
      cardInput().value = 'half a note';

      // WXT builds a context for the new run, which invalidates the old one, then calls main.
      const second = newContext('note-card');

      expect(cardHosts()).toHaveLength(0);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: 'half a note' }]);
      void noteCard.main(second);
      expect(deliver(SHOW_CAPTURE)).toEqual([{ ok: true }]);
      expect(cardHosts()).toHaveLength(1);
    });

    it('an invalidated script stops answering and takes its card away, saving what was typed', () => {
      const context = startCard();
      deliver(SHOW_CAPTURE);
      cardInput().value = 'typed before the extension updated';

      context.notifyInvalidated();

      expect(cardHosts()).toHaveLength(0);
      expect(noteRequests()).toEqual([{ type: 'note:save', captureId: 'cap-1', note: 'typed before the extension updated' }]);
      expect(deliver(SHOW_CAPTURE)).toEqual([]);
    });

    it('an invalidated script does not save a note the user already settled', async () => {
      const context = startCard();
      deliver(SHOW_CAPTURE);
      press(cardInput(), 'Escape');
      await wait(150);

      context.notifyInvalidated();

      expect(noteRequests()).toEqual([{ type: 'note:discard', captureId: 'cap-1' }]);
    });
  });
});

describe('select area overlay', () => {
  const HINT = 'Drag to select. Enter for the whole view. Esc to cancel.';

  function startOverlay(): ContentScriptContext {
    const context = newContext('select-area');
    void selectArea.main(context);
    return context;
  }

  const overlayHosts = () => document.querySelectorAll(SELECT_AREA);
  const overlayRoot = () => rootOf(SELECT_AREA);
  const selectionMessages = () => sentToBackground.filter((message) => isSelectAreaMessage(message));

  /** The `select-area:done` message for a selection of this size, in the 1024 by 768 window happy-dom starts with. */
  function done(x: number, y: number, width: number, height: number) {
    return { type: 'select-area:done', rect: { x, y, width, height }, viewportWidth: 1024, viewportHeight: 768 };
  }

  /** Two animation frames: the overlay gets this long to leave the screen before the capture is requested. */
  async function frames(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) await wait(16);
  }

  function pointer(type: string, x: number, y: number, init: PointerEventInit = {}, options: { trusted?: boolean } = {}): PointerEvent {
    const event = new PointerEvent(type, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    });
    if (options.trusted ?? true) trusted(event);
    (document.querySelector(SELECT_AREA) ?? document.body).dispatchEvent(event);
    return event;
  }

  /** Where a key press goes: the element with focus (the overlay while it is open). */
  function keyTarget(): EventTarget {
    return document.activeElement ?? document.body;
  }

  /** Where the selection rectangle is drawn: left, top, width, height. */
  function borderBox(): string[] {
    const { style } = inRoot<HTMLElement>(overlayRoot(), '.selection-border');
    return [style.left, style.top, style.width, style.height];
  }

  function drag(from: [number, number], to: [number, number]): void {
    pointer('pointerdown', from[0], from[1]);
    pointer('pointermove', to[0], to[1]);
    pointer('pointerup', to[0], to[1]);
  }

  describe('opening', () => {
    it('covers the page with a dialog that explains how to select, and takes focus', () => {
      pageButton().focus();

      startOverlay();

      const host = inDocument(SELECT_AREA);
      expect(host.parentElement).toBe(document.documentElement);
      expect(host.shadowRoot).toBeNull();
      const overlay = inRoot(overlayRoot(), '.selection-overlay');
      expect(overlay.getAttribute('role')).toBe('dialog');
      expect(overlay.getAttribute('aria-modal')).toBe('true');
      expect(overlay.getAttribute('aria-label')).toBe('Select area');
      const hint = inRoot(overlayRoot(), '.selection-hint');
      expect(hint.textContent).toBe(HINT);
      expect(hint.getAttribute('role')).toBe('status');
      expect(overlay.getAttribute('aria-describedby')).toBe(hint.id);
      expect(document.activeElement).toBe(host);
      expect(selectionMessages()).toEqual([]);
    });

    it('shows no selection rectangle until the user starts dragging', () => {
      startOverlay();

      expect(inRoot(overlayRoot(), '.selection-border').hasAttribute('hidden')).toBe(true);
    });

    it('styles the overlay with an adopted stylesheet', () => {
      startOverlay();

      expect(overlayRoot().adoptedStyleSheets).toHaveLength(1);
    });

    it('falls back to a style element when constructed stylesheets are not available', () => {
      vi.spyOn(CSSStyleSheet.prototype, 'replaceSync').mockImplementation(() => {
        throw new DOMException('Constructed stylesheets are not supported.', 'NotSupportedError');
      });

      startOverlay();

      expect(inRoot(overlayRoot(), 'style').textContent).toContain('.selection-overlay');
    });

    it('removes an overlay left behind by an earlier run', () => {
      const stray = document.createElement(SELECT_AREA);
      document.body.append(stray);

      startOverlay();

      expect(stray.isConnected).toBe(false);
      expect(overlayHosts()).toHaveLength(1);
    });
  });

  describe('dragging a selection', () => {
    it('removes the overlay when the pointer is released, then asks for the capture after two animation frames', async () => {
      startOverlay();

      drag([100, 100], [300, 250]);

      expect(overlayHosts()).toHaveLength(0);
      expect(selectionMessages()).toEqual([]);
      await frames(1);
      expect(selectionMessages()).toEqual([]);
      await frames(1);
      expect(selectionMessages()).toEqual([
        done(100, 100, 200, 150),
      ]);
      expect(isSelectAreaMessage(selectionMessages()[0])).toBe(true);
    });

    it('selects the same area whichever direction the user drags', async () => {
      startOverlay();

      drag([300, 250], [100, 100]);
      await frames(2);

      expect(selectionMessages()).toEqual([
        done(100, 100, 200, 150),
      ]);
    });

    it('keeps the selection inside the window when the pointer leaves it', async () => {
      startOverlay();

      drag([-50, -20], [5000, 5000]);
      await frames(2);

      expect(selectionMessages()).toEqual([
        done(0, 0, 1024, 768),
      ]);
    });

    it('shows the selection rectangle while the pointer is down', () => {
      startOverlay();

      pointer('pointerdown', 100, 100);
      pointer('pointermove', 300, 250);

      const border = inRoot<HTMLElement>(overlayRoot(), '.selection-border');
      expect(border.hasAttribute('hidden')).toBe(false);
      expect([border.style.left, border.style.top, border.style.width, border.style.height]).toEqual(['100px', '100px', '200px', '150px']);
      expect(overlayHosts()).toHaveLength(1);
    });

    // Only listeners added after the overlay opened, and bubble-phase ones, are shut out. A listener the page added
    // earlier on window, or in the capture phase on the document, runs before the overlay's own and still hears the
    // drag.
    it('stops the drag before page listeners added later on the document, and default-prevents it', () => {
      startOverlay();
      const pageHeard = vi.fn();
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        document.addEventListener(type, pageHeard, { capture: true, signal: pageListeners.signal });
      }

      const down = pointer('pointerdown', 100, 100);
      const move = pointer('pointermove', 200, 200);
      const up = pointer('pointerup', 200, 200);

      expect(pageHeard).not.toHaveBeenCalled();
      expect([down.defaultPrevented, move.defaultPrevented, up.defaultPrevented]).toEqual([true, true, true]);
    });

    it('ignores a drag smaller than 8 px and lets the user try again', async () => {
      startOverlay();

      drag([100, 100], [107, 300]);
      expect(overlayHosts()).toHaveLength(1);
      expect(inRoot(overlayRoot(), '.selection-border').hasAttribute('hidden')).toBe(true);
      await frames(5);
      expect(selectionMessages()).toEqual([]);

      drag([100, 100], [108, 108]);
      await frames(2);
      expect(selectionMessages()).toEqual([
        done(100, 100, 8, 8),
      ]);
    });

    it('gives focus back to the page when the capture is taken', () => {
      pageButton().focus();
      startOverlay();
      expect(document.activeElement).toBe(inDocument(SELECT_AREA));

      drag([100, 100], [300, 250]);

      expect(document.activeElement).toBe(pageButton());
    });

    it.each([
      ['a right-button press', 'pointerdown', { button: 2 }],
      ['a press by a second finger', 'pointerdown', { isPrimary: false, pointerId: 2 }],
    ])('does not start a selection on %s', async (_name, type, init) => {
      startOverlay();

      pointer(type, 100, 100, init);
      pointer('pointermove', 300, 300, init);
      pointer('pointerup', 300, 300, init);
      await frames(3);

      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);
      expect(inRoot(overlayRoot(), '.selection-border').hasAttribute('hidden')).toBe(true);
    });

    it('follows only the pointer that started the selection', async () => {
      startOverlay();

      pointer('pointerdown', 100, 100);
      pointer('pointerdown', 500, 500, { pointerId: 2, isPrimary: false });
      pointer('pointermove', 900, 700, { pointerId: 2, isPrimary: false });
      pointer('pointerup', 900, 700, { pointerId: 2, isPrimary: false });
      expect(overlayHosts()).toHaveLength(1);

      pointer('pointerup', 300, 250);
      await frames(2);
      expect(selectionMessages()).toEqual([
        done(100, 100, 200, 150),
      ]);
    });

    it('cancels when the browser cancels the drag, and ignores another pointer being cancelled', () => {
      startOverlay();
      pointer('pointerdown', 100, 100);

      pointer('pointercancel', 100, 100, { pointerId: 2 });
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);

      pointer('pointercancel', 100, 100);
      expect(overlayHosts()).toHaveLength(0);
      expect(selectionMessages()).toEqual([{ type: 'select-area:cancel' }]);
    });

    it('ignores a pointercancel that a page script dispatched in the middle of a drag', async () => {
      startOverlay();
      pointer('pointerdown', 100, 100);

      pointer('pointercancel', 100, 100, {}, { trusted: false });
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);

      pointer('pointerup', 300, 250);
      await frames(2);
      expect(selectionMessages()).toHaveLength(1);
    });

    it('ignores a pointermove that a page script dispatched in the middle of a drag', () => {
      startOverlay();
      pointer('pointerdown', 100, 100);
      expect(borderBox()).toEqual(['100px', '100px', '0px', '0px']);

      pointer('pointermove', 600, 500, {}, { trusted: false });
      expect(borderBox()).toEqual(['100px', '100px', '0px', '0px']);

      pointer('pointermove', 300, 250);
      expect(borderBox()).toEqual(['100px', '100px', '200px', '150px']);
    });

    it('ignores a pointerup that a page script dispatched in the middle of a drag, so it cannot choose the area', async () => {
      startOverlay();
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 300, 250);

      pointer('pointerup', 600, 500, {}, { trusted: false });
      await frames(5);
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);
      expect(borderBox()).toEqual(['100px', '100px', '200px', '150px']);

      pointer('pointerup', 300, 250);
      await frames(2);
      expect(selectionMessages()).toEqual([done(100, 100, 200, 150)]);
    });

    it('ignores pointer events a page script dispatched, and accepts the same drag from the user', async () => {
      startOverlay();

      const options = { trusted: false };
      pointer('pointerdown', 100, 100, {}, options);
      pointer('pointermove', 300, 250, {}, options);
      pointer('pointerup', 300, 250, {}, options);
      pointer('pointercancel', 300, 250, {}, options);
      await frames(5);
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);
      expect(inRoot(overlayRoot(), '.selection-border').hasAttribute('hidden')).toBe(true);

      drag([100, 100], [300, 250]);
      await frames(2);
      expect(selectionMessages()).toHaveLength(1);
    });
  });

  describe('the keyboard', () => {
    it('Enter with no drag captures the whole visible area, after two animation frames', async () => {
      pageButton().focus();
      startOverlay();

      const event = press(keyTarget(), 'Enter');

      expect(event.defaultPrevented).toBe(true);
      expect(overlayHosts()).toHaveLength(0);
      expect(document.activeElement).toBe(pageButton());
      await frames(1);
      expect(selectionMessages()).toEqual([]);
      await frames(1);
      expect(selectionMessages()).toEqual([{ type: 'select-area:visible' }]);
    });

    it('Esc cancels at once: the overlay goes, focus returns, and the background hears about it', () => {
      pageButton().focus();
      startOverlay();

      const event = press(keyTarget(), 'Escape');

      expect(event.defaultPrevented).toBe(true);
      expect(overlayHosts()).toHaveLength(0);
      expect(document.activeElement).toBe(pageButton());
      expect(selectionMessages()).toEqual([{ type: 'select-area:cancel' }]);
    });

    it('does nothing more once it has finished: a second Esc or Enter sends nothing', async () => {
      startOverlay();
      press(keyTarget(), 'Escape');

      press(document.body, 'Escape');
      press(document.body, 'Enter');
      await frames(3);

      expect(selectionMessages()).toEqual([{ type: 'select-area:cancel' }]);
    });

    it('keeps Tab from moving focus to the page underneath', () => {
      startOverlay();
      const overlayHost = inDocument(SELECT_AREA);

      const event = press(overlayHost, 'Tab');

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(overlayHost);
      expect(overlayHosts()).toHaveLength(1);
    });

    // Same limit as for the pointer: window listeners, and capture-phase listeners added earlier, still hear the keys.
    it('stops Enter, Esc, and Tab before page listeners added later on the document or on the body', () => {
      startOverlay();
      const pageHeard = vi.fn();
      document.addEventListener('keydown', pageHeard, { capture: true, signal: pageListeners.signal });
      document.body.addEventListener('keydown', pageHeard, { signal: pageListeners.signal });

      press(keyTarget(), 'Tab');
      press(keyTarget(), 'Enter', { repeat: true });
      press(keyTarget(), 'Escape');

      expect(pageHeard).not.toHaveBeenCalled();
    });

    it.each([
      ['a held Enter', { repeat: true }],
      ['the Enter that confirms composed text', { isComposing: true }],
    ])('ignores %s', async (_name, init) => {
      startOverlay();

      press(keyTarget(), 'Enter', init);
      await frames(3);

      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);
    });

    it('ignores Enter while a drag is under way, and the drag still completes', async () => {
      startOverlay();
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 300, 250);

      const event = press(keyTarget(), 'Enter');
      await frames(3);

      expect(event.defaultPrevented).toBe(true);
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);

      pointer('pointerup', 300, 250);
      await frames(2);
      expect(selectionMessages()).toEqual([
        done(100, 100, 200, 150),
      ]);
    });

    it('Esc during a drag cancels the whole selection', async () => {
      startOverlay();
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 300, 250);

      press(keyTarget(), 'Escape');
      pointer('pointerup', 300, 250);
      await frames(3);

      expect(overlayHosts()).toHaveLength(0);
      expect(selectionMessages()).toEqual([{ type: 'select-area:cancel' }]);
    });

    it('ignores Enter, Esc, and Tab that a page script dispatched, and accepts the same keys from the user', async () => {
      startOverlay();

      scriptPress(keyTarget(), 'Enter');
      scriptPress(keyTarget(), 'Escape');
      const tab = scriptPress(keyTarget(), 'Tab');
      await frames(3);

      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);
      expect(tab.defaultPrevented).toBe(false);

      press(keyTarget(), 'Enter');
      await frames(2);
      expect(selectionMessages()).toEqual([{ type: 'select-area:visible' }]);
    });

    it('lets other keys through to the page', () => {
      startOverlay();

      const event = press(keyTarget(), 'a');

      expect(event.defaultPrevented).toBe(false);
      expect(overlayHosts()).toHaveLength(1);
    });
  });

  describe('being stopped from outside', () => {
    function abortFrom(sender: { id?: string }, message: unknown = { type: 'select-area:abort' }): Promise<unknown[]> {
      return fakeBrowser.runtime.onMessage.trigger(message, sender, () => undefined);
    }

    it('the background can abort it: the overlay goes, focus returns, and nothing is sent back', async () => {
      pageButton().focus();
      startOverlay();

      await abortFrom({ id: fakeBrowser.runtime.id });

      expect(overlayHosts()).toHaveLength(0);
      expect(document.activeElement).toBe(pageButton());
      await frames(5);
      expect(selectionMessages()).toEqual([]);
    });

    it('stops listening for keys and pointers after an abort', async () => {
      startOverlay();
      await abortFrom({ id: fakeBrowser.runtime.id });

      press(document.body, 'Escape');
      press(document.body, 'Enter');
      drag([100, 100], [300, 250]);
      await frames(5);

      expect(selectionMessages()).toEqual([]);
    });

    it.each([
      ['another extension', { id: 'some-other-extension' }],
      ['a web page or a sender without an id', {}],
    ])('ignores an abort from %s', async (_name, sender) => {
      startOverlay();

      await abortFrom(sender);

      expect(overlayHosts()).toHaveLength(1);
    });

    it.each([
      ['a message of another kind', { type: 'select-area:cancel' }],
      ['something that is not a message', 'select-area:abort'],
    ])('ignores %s from the extension', async (_name, message) => {
      startOverlay();

      await abortFrom({ id: fakeBrowser.runtime.id }, message);

      expect(overlayHosts()).toHaveLength(1);
    });

    it('cancels itself after 2 minutes without a selection', async () => {
      startOverlay();

      await wait(119_999);
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);

      await wait(1);
      expect(overlayHosts()).toHaveLength(0);
      expect(selectionMessages()).toEqual([{ type: 'select-area:cancel' }]);
    });

    it.each([
      [
        'chosen an area',
        async () => {
          drag([100, 100], [300, 250]);
          await frames(2);
        },
        [done(100, 100, 200, 150)],
      ],
      [
        'cancelled with Esc',
        async () => {
          press(keyTarget(), 'Escape');
        },
        [{ type: 'select-area:cancel' }],
      ],
      [
        'been aborted by the background',
        async () => {
          await abortFrom({ id: fakeBrowser.runtime.id });
        },
        [],
      ],
    ])('sends nothing more once the user has %s, even after the time-out has passed', async (_name, finish, expected) => {
      startOverlay();
      await finish();

      await wait(10 * 60 * 1000);

      expect(selectionMessages()).toEqual(expected);
    });

    it('a second injection removes the old overlay without a message, and only the new one answers Esc', () => {
      startOverlay();

      // WXT builds a context for the new run, which invalidates the old one, then calls main.
      const second = newContext('select-area');
      expect(overlayHosts()).toHaveLength(0);
      void selectArea.main(second);
      expect(overlayHosts()).toHaveLength(1);
      expect(selectionMessages()).toEqual([]);

      press(keyTarget(), 'Escape');

      expect(selectionMessages()).toEqual([{ type: 'select-area:cancel' }]);
    });

    it('an invalidated script takes its overlay away and sends nothing', async () => {
      pageButton().focus();
      const context = startOverlay();

      context.notifyInvalidated();
      press(document.body, 'Escape');
      await wait(10 * 60 * 1000);

      expect(overlayHosts()).toHaveLength(0);
      expect(document.activeElement).toBe(pageButton());
      expect(selectionMessages()).toEqual([]);
    });
  });

  describe('sending to the background', () => {
    it('still closes when the extension has gone and the message cannot be sent', () => {
      vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(() => {
        throw new Error('Extension context invalidated.');
      });
      startOverlay();

      expect(() => press(keyTarget(), 'Escape')).not.toThrow();

      expect(overlayHosts()).toHaveLength(0);
    });

    it('does not fail when the background answers with an error', async () => {
      vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Could not establish connection.'));
      startOverlay();

      press(keyTarget(), 'Escape');
      await wait();

      expect(overlayHosts()).toHaveLength(0);
    });
  });

  describe('a note card on the page', () => {
    function pageWithCard(style = ''): HTMLElement {
      const card = document.createElement(NOTE_CARD);
      if (style !== '') card.setAttribute('style', style);
      document.documentElement.append(card);
      return card;
    }

    /** True when the element is shown: no inline display:none on it or an ancestor. */
    function isShown(element: Element): boolean {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        if (node instanceof HTMLElement && node.style.getPropertyValue('display') === 'none') return false;
      }
      return true;
    }

    const htmlChildren = () => [...document.documentElement.children].map((child) => child.localName);

    it('hides the card while the user selects, so it is not in the screenshot, and shows it again on Esc', () => {
      const card = pageWithCard();

      startOverlay();
      expect(isShown(card)).toBe(false);

      press(keyTarget(), 'Escape');
      expect(isShown(card)).toBe(true);
      expect(htmlChildren()).toEqual(['head', 'body', NOTE_CARD]);
    });

    it('shows the card again when the background aborts the selection', async () => {
      const card = pageWithCard();
      startOverlay();

      await fakeBrowser.runtime.onMessage.trigger({ type: 'select-area:abort' }, { id: fakeBrowser.runtime.id }, () => undefined);

      expect(isShown(card)).toBe(true);
      expect(htmlChildren()).toEqual(['head', 'body', NOTE_CARD]);
    });

    it('shows the card again when the selection times out', async () => {
      const card = pageWithCard();
      startOverlay();

      await wait(120_000);

      expect(isShown(card)).toBe(true);
    });

    it('gives the card back the display style it had', () => {
      const card = pageWithCard('display: flex');
      startOverlay();
      expect(isShown(card)).toBe(false);

      press(keyTarget(), 'Escape');

      expect(card.style.getPropertyValue('display')).toBe('flex');
      expect(isShown(card)).toBe(true);
    });

    it('keeps the card hidden if the script is replaced just after the drag, while the capture is still to be taken', async () => {
      const card = pageWithCard();
      const context = startOverlay();
      drag([100, 100], [300, 250]);

      context.notifyInvalidated();
      await frames(2);

      expect(isShown(card)).toBe(false);
      expect(overlayHosts()).toHaveLength(0);
      expect(selectionMessages()).toEqual([]);
    });

    it('keeps the card hidden once the capture is taken, and cleans up when the card is removed', async () => {
      const card = pageWithCard();
      startOverlay();

      drag([100, 100], [300, 250]);
      await frames(2);
      expect(isShown(card)).toBe(false);

      card.remove();
      await wait();
      expect(htmlChildren()).toEqual(['head', 'body']);
    });
  });
});
