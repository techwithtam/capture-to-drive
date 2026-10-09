import { browser } from 'wxt/browser';
import tokensCss from '@/assets/tokens.css?raw';
import componentsCss from '@/assets/components.css?raw';
import selectionCss from '@/assets/select-area.css?raw';
import { isSelectAreaAbortMessage } from '@/lib/messages';
import type { SelectAreaMessage } from '@/lib/messages';
import { NOTE_CARD_HOST_TAG } from '@/lib/note-view';
import { isValidSelection, normalizeSelection, SELECTION_TIMEOUT_MS } from '@/lib/selection-rect';
import type { Point, SelectionRect } from '@/lib/selection-rect';

const HOST_TAG = 'capture-to-drive-select-area';
const STYLE_TEXT = [tokensCss, componentsCss, selectionCss].join('\n');

function send(message: SelectAreaMessage): void {
  try {
    void browser.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The extension was unloaded while the overlay was open.
  }
}

export default defineContentScript({
  registration: 'runtime',
  matches: ['<all_urls>'],
  main(ctx) {
    // WXT invalidates the previous run first; remove a host left by an unloaded extension too.
    for (const stray of document.querySelectorAll(HOST_TAG)) stray.remove();
    const previousFocus = document.activeElement;
    const hiddenCards = [...document.querySelectorAll<HTMLElement>(NOTE_CARD_HOST_TAG)].map((card) => {
      const display = card.style.getPropertyValue('display');
      const priority = card.style.getPropertyPriority('display');
      card.style.setProperty('display', 'none', 'important');
      // The card's important :host reset wins even over its inline display. A hidden ancestor
      // suppresses it without reaching into the note view's shadow root or changing its API.
      const wrapper = document.createElement('div');
      wrapper.style.setProperty('display', 'none', 'important');
      card.before(wrapper);
      wrapper.append(card);
      const observer = new MutationObserver(() => {
        if (card.parentElement === wrapper) return;
        observer.disconnect();
        wrapper.remove();
      });
      observer.observe(wrapper, { childList: true });
      return { card, display, priority, wrapper, observer };
    });

    const host = document.createElement(HOST_TAG);
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE_TEXT);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = STYLE_TEXT;
      shadow.append(style);
    }
    const overlay = document.createElement('div');
    overlay.className = 'selection-overlay';
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog');
    // The page behind is dimmed and cannot be used until the selection is made or cancelled.
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Select area');
    overlay.setAttribute('aria-describedby', 'selection-hint');
    const dim = Array.from({ length: 4 }, () => {
      const panel = document.createElement('div');
      panel.className = 'selection-dim';
      panel.setAttribute('aria-hidden', 'true');
      return panel;
    });
    const border = document.createElement('div');
    border.className = 'selection-border';
    border.hidden = true;
    border.setAttribute('aria-hidden', 'true');
    const hint = document.createElement('div');
    hint.id = 'selection-hint';
    hint.className = 'selection-hint';
    hint.textContent = 'Drag to select. Enter for the whole view. Esc to cancel.';
    // Read with the dialog (aria-describedby) and exposed as a status for assistive technology.
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    overlay.append(...dim, border, hint);
    shadow.append(overlay);
    document.documentElement.append(host);
    overlay.focus({ preventScroll: true });

    const events = new AbortController();
    let start: Point | null = null;
    let pointerId: number | null = null;
    let finished = false;
    let captured = false;
    const timer = window.setTimeout(cancel, SELECTION_TIMEOUT_MS);
    const abortListener = (message: unknown, sender: { id?: string }): void => {
      if (finished || sender.id === undefined || sender.id !== browser.runtime.id || !isSelectAreaAbortMessage(message)) return;
      finished = true;
      remove(true);
    };
    browser.runtime.onMessage.addListener(abortListener);

    function remove(restoreCard: boolean): void {
      events.abort();
      window.clearTimeout(timer);
      try {
        browser.runtime.onMessage.removeListener(abortListener);
      } catch {
        // DOM cleanup still runs if the extension was unloaded.
      }
      host.remove();
      if (restoreCard) {
        for (const { card, display, priority, wrapper, observer } of hiddenCards) {
          observer.disconnect();
          if (display === '') card.style.removeProperty('display');
          else card.style.setProperty('display', display, priority);
          if (card.parentElement === wrapper) wrapper.replaceWith(card);
          else wrapper.remove();
        }
      }
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    }

    function cancel(): void {
      if (finished) return;
      finished = true;
      remove(true);
      send({ type: 'select-area:cancel' });
    }

    function point(event: PointerEvent): Point {
      return { x: Math.max(0, Math.min(window.innerWidth, event.clientX)), y: Math.max(0, Math.min(window.innerHeight, event.clientY)) };
    }

    function place(element: HTMLElement, rect: SelectionRect): void {
      Object.assign(element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }

    function draw(rect: SelectionRect): void {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const panels = [
        { x: 0, y: 0, width, height: rect.y },
        { x: 0, y: rect.y, width: rect.x, height: rect.height },
        { x: rect.x + rect.width, y: rect.y, width: width - rect.x - rect.width, height: rect.height },
        { x: 0, y: rect.y + rect.height, width, height: height - rect.y - rect.height },
      ];
      dim.forEach((panel, index) => place(panel, panels[index]!));
      place(border, rect);
    }
    draw({ x: 0, y: 0, width: 0, height: 0 });

    document.addEventListener('pointerdown', (event) => {
      if (!event.isTrusted || finished || event.button !== 0 || !event.isPrimary || start !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      start = point(event);
      pointerId = event.pointerId;
      overlay.setPointerCapture(pointerId);
      border.hidden = false;
      draw(normalizeSelection(start, start));
    }, { capture: true, signal: events.signal });

    document.addEventListener('pointermove', (event) => {
      if (!event.isTrusted || finished || start === null || event.pointerId !== pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      draw(normalizeSelection(start, point(event)));
    }, { capture: true, signal: events.signal });

    document.addEventListener('pointerup', (event) => {
      if (!event.isTrusted || finished || start === null || event.pointerId !== pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = normalizeSelection(start, point(event));
      start = null;
      if (pointerId !== null && overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId);
      pointerId = null;
      if (!isValidSelection(rect)) {
        border.hidden = true;
        draw({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      finished = true;
      captured = true;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      remove(false);
      // The compositor gets two frames to remove the overlay before captureVisibleTab runs.
      ctx.requestAnimationFrame(() => ctx.requestAnimationFrame(() => {
        send({ type: 'select-area:done', rect, viewportWidth, viewportHeight });
      }));
    }, { capture: true, signal: events.signal });

    document.addEventListener('keydown', (event) => {
      if (!event.isTrusted || finished) return;
      if (event.key === 'Tab') {
        // The overlay is modal and has nothing else to focus: keep Tab from moving focus to the page underneath it.
        event.preventDefault();
        event.stopImmediatePropagation();
        overlay.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Enter') {
        // The keyboard route to a capture: the whole visible area. Not while a drag is under way, and not on key repeat.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || event.isComposing || start !== null) return;
        finished = true;
        captured = true;
        remove(false);
        // The compositor gets two frames to remove the overlay before captureVisibleTab runs.
        ctx.requestAnimationFrame(() => ctx.requestAnimationFrame(() => send({ type: 'select-area:visible' })));
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    }, { capture: true, signal: events.signal });

    document.addEventListener('pointercancel', (event) => {
      if (event.isTrusted && event.pointerId === pointerId) cancel();
    }, { capture: true, signal: events.signal });

    ctx.onInvalidated(() => {
      finished = true;
      remove(!captured);
    });
  },
});
