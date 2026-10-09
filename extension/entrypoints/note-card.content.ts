// In-page note card (spec section 6.4). The background (lib/note-step.ts) injects this script on demand with
// scripting.executeScript, then drives it with tabs.sendMessage: `note:show` shows the note step for a capture,
// `note:message` shows a message on its own. Everything the card shows comes in the message, because content scripts
// cannot read the extension's IndexedDB. The card answers `{ ok }` so the background knows whether to open the note
// window instead.
//
// The card lives in a closed shadow root on a <capture-to-drive-note-card> element appended to <html>, with the design
// system's stylesheets adopted into it, so page styles cannot reach in and ours cannot leak out. Closed, because the
// card holds the user's filename (with their name), their note as typed, and the capture's thumbnail: page script
// gets `host.shadowRoot === null` and cannot read them or press the buttons (which also ignore untrusted events).
// Key presses inside the card stop at the card, so typing a note never triggers the page's own shortcuts; keys
// pressed in the page are never handled by the card.
//
// Every injection runs main() again. WXT's ContentScriptContext invalidates the previous run when a new one starts,
// and the previous run then removes its listener and its card. A card the user had not acted on yet is saved with
// whatever they typed (a capture is only thrown away by Discard), so a tab never shows two cards or loses a capture.

import componentsCss from '@/assets/components.css?raw';
import noteViewCss from '@/assets/note-view.css?raw';
import tokensCss from '@/assets/tokens.css?raw';
import { browser } from 'wxt/browser';
import { isNoteCardMessage } from '@/lib/messages';
import type { NoteCardMessage, NoteCardResponse } from '@/lib/messages';
import { NOTE_DIALOG_LABEL } from '@/lib/note-status';
import { sendNoteRequest } from '@/lib/note-transport';
import { createMessageView, createNoteView, NOTE_CARD_HOST_TAG } from '@/lib/note-view';
import type { MountedView } from '@/lib/note-view';

const STYLE_TEXT = [tokensCss, componentsCss, noteViewCss].join('\n');
/** How long the fade-out runs before the card is removed (a little over --dur-fast). */
const LEAVE_MS = 150;
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

interface ShownCard {
  host: HTMLElement;
  /** The closed shadow root: only this script holds a reference to it. */
  shadow: ShadowRoot;
  card: HTMLElement;
  view: MountedView;
  /** Set for the note step; undefined for a message on its own. */
  captureId: string | undefined;
  /** What had focus before the card took it, to give focus back to. */
  previousFocus: Element | null;
  removed: boolean;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

let sheet: CSSStyleSheet | null = null;

function adoptStyles(shadow: ShadowRoot): void {
  try {
    if (sheet === null) {
      const fresh = new CSSStyleSheet();
      fresh.replaceSync(STYLE_TEXT);
      sheet = fresh;
    }
    // Constructed stylesheets are not blocked by a page's style-src policy, unlike a <style> element.
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = STYLE_TEXT;
    shadow.append(style);
  }
}

export default defineContentScript({
  registration: 'runtime',
  matches: ['<all_urls>'],
  main(ctx) {
    let current: ShownCard | null = null;

    /** Hands focus back to the page if it is in the card: to what had it before, or nowhere. */
    function restoreFocus(shown: ShownCard): void {
      if (document.activeElement !== shown.host) return;
      const previous = shown.previousFocus;
      if ((previous instanceof HTMLElement || previous instanceof SVGElement) && previous !== document.body && previous.isConnected) {
        previous.focus({ preventScroll: true });
        if (document.activeElement !== shown.host) return;
      }
      const inner = shown.shadow.activeElement;
      if (inner instanceof HTMLElement) inner.blur();
    }

    function close(shown: ShownCard, options: { saveUnsent: boolean; animate: boolean }): void {
      if (shown.removed) return;
      shown.removed = true;
      if (current === shown) current = null;

      const unsent = shown.view.unsentNote();
      if (options.saveUnsent && unsent !== undefined && shown.captureId !== undefined) {
        // Replaced before the user acted: keep the capture, with the note typed so far.
        sendNoteRequest({ type: 'note:save', captureId: shown.captureId, note: unsent }).catch(() => undefined);
      }
      shown.view.destroy();
      restoreFocus(shown);

      if (!options.animate || prefersReducedMotion()) {
        shown.host.remove();
        return;
      }
      shown.card.classList.add('is-leaving');
      window.setTimeout(() => shown.host.remove(), LEAVE_MS);
    }

    function show(message: NoteCardMessage): boolean {
      if (current !== null) close(current, { saveUnsent: true, animate: false });
      // A card left behind by a run whose extension context is gone (the extension was reloaded) goes too.
      for (const stray of document.querySelectorAll(NOTE_CARD_HOST_TAG)) stray.remove();

      const root = document.documentElement;
      // XML and other non-HTML documents cannot host the card: the background opens the note window instead.
      if (!(root instanceof HTMLElement)) return false;

      const host = document.createElement(NOTE_CARD_HOST_TAG);
      const shadow = host.attachShadow({ mode: 'closed' });
      adoptStyles(shadow);
      const card = document.createElement('div');
      card.className = 'note-card';
      if (message.type === 'note:show') {
        // A non-modal dialog that takes focus. A message on its own is announced through its live region instead.
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-label', NOTE_DIALOG_LABEL);
      }
      for (const type of KEY_EVENTS) card.addEventListener(type, (event) => event.stopPropagation());

      const captureId = message.type === 'note:show' ? message.captureId : undefined;
      // The callbacks run later, once `shown` below exists.
      const finish = () => close(shown, { saveUnsent: false, animate: true });
      const view =
        message.type === 'note:show'
          ? createNoteView(document, message, {
              save: (note) => sendNoteRequest({ type: 'note:save', captureId: message.captureId, note }),
              discard: () => {
                sendNoteRequest({ type: 'note:discard', captureId: message.captureId }).catch(() => undefined);
              },
              onSettled: () => restoreFocus(shown),
              onFinished: finish,
            })
          : createMessageView(document, message, { onFinished: finish });
      const shown: ShownCard = {
        host,
        shadow,
        card,
        view,
        captureId,
        previousFocus: document.activeElement,
        removed: false,
      };

      card.append(shown.view.element);
      shadow.append(card);
      root.append(host);
      current = shown;
      // The note field takes focus (spec: autofocused); a message does not interrupt what the user is doing.
      if (message.type === 'note:show') shown.view.focus();
      return true;
    }

    const listener = (message: unknown, _sender: unknown, sendResponse: (response: NoteCardResponse) => void) => {
      if (!isNoteCardMessage(message)) return undefined;
      let ok = false;
      try {
        ok = show(message);
      } catch (error) {
        console.warn('Capture to Drive: the note card could not be shown here.', error);
      }
      sendResponse({ ok });
      return undefined;
    };

    browser.runtime.onMessage.addListener(listener);
    ctx.onInvalidated(() => {
      try {
        browser.runtime.onMessage.removeListener(listener);
      } catch {
        // The extension context is already gone, and the listener with it.
      }
      if (current !== null) close(current, { saveUnsent: true, animate: false });
    });
  },
});
