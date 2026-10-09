import { browser } from 'wxt/browser';
import { cropImage } from './crop';
import { sourceFromUrl } from './filename';
import { isSelectAreaMessage } from './messages';
import type { SelectAreaDoneMessage } from './messages';
import { showMessage, startNoteStep } from './note-step';
import { SAVE_FAILED_TEXT } from './note-status';
import { SELECTION_TIMEOUT_MS } from './selection-rect';

export const VISIBLE_FALLBACK_MESSAGE = "Selection isn't available on this page, so the visible area was captured.";
export const CAPTURE_FAILED_MESSAGE = "This page can't be captured.";

interface CaptureTab {
  id?: number;
  active: boolean;
  windowId: number;
  title?: string;
  url?: string;
}

export type AreaMessageListener = (message: unknown, sender: { tab?: { id?: number }; frameId?: number }) => void;
export type TabRemovedListener = (tabId: number) => void;
export type TabUpdatedListener = (tabId: number, changeInfo: { url?: string; status?: string }) => void;

export interface CaptureAreaDeps {
  getTab: (tabId: number) => Promise<CaptureTab>;
  queryTabs: (query: { active: true; lastFocusedWindow: true }) => Promise<CaptureTab[]>;
  injectOverlay: (tabId: number) => Promise<void>;
  abortOverlay: (tabId: number) => Promise<void>;
  addMessageListener: (listener: AreaMessageListener) => void;
  removeMessageListener: (listener: AreaMessageListener) => void;
  addTabRemovedListener: (listener: TabRemovedListener) => void;
  removeTabRemovedListener: (listener: TabRemovedListener) => void;
  addTabUpdatedListener: (listener: TabUpdatedListener) => void;
  removeTabUpdatedListener: (listener: TabUpdatedListener) => void;
  captureVisibleTab: (windowId: number, options: { format: 'png' }) => Promise<string>;
  cropImage: typeof cropImage;
  startNoteStep: typeof startNoteStep;
  showMessage: typeof showMessage;
  keepWorkerAlive: () => Promise<void>;
  clock: {
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  };
}

const DEFAULTS: CaptureAreaDeps = {
  getTab: (tabId) => browser.tabs.get(tabId),
  queryTabs: (query) => browser.tabs.query(query),
  injectOverlay: async (tabId) => {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      // Chrome accepts relative bundle paths; WXT's generated literals require a leading slash.
      files: ['content-scripts/select-area.js' as '/content-scripts/select-area.js'],
    });
  },
  abortOverlay: async (tabId) => {
    await browser.tabs.sendMessage(tabId, { type: 'select-area:abort' }, { frameId: 0 });
  },
  addMessageListener: (listener) => browser.runtime.onMessage.addListener(listener),
  removeMessageListener: (listener) => browser.runtime.onMessage.removeListener(listener),
  addTabRemovedListener: (listener) => browser.tabs.onRemoved.addListener(listener),
  removeTabRemovedListener: (listener) => browser.tabs.onRemoved.removeListener(listener),
  addTabUpdatedListener: (listener) => browser.tabs.onUpdated.addListener(listener),
  removeTabUpdatedListener: (listener) => browser.tabs.onUpdated.removeListener(listener),
  captureVisibleTab: (windowId, options) => browser.tabs.captureVisibleTab(windowId, options),
  cropImage,
  startNoteStep,
  showMessage,
  keepWorkerAlive: async () => { await browser.runtime.getPlatformInfo(); },
  clock: {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  },
};

// `visible` is the user's own choice (Enter in the overlay): the whole visible area, with no notice. `fallback` is the
// overlay being unavailable on the page, which does get a notice.
type SelectionResult = { kind: 'done'; message: SelectAreaDoneMessage } | { kind: 'cancel' } |
  { kind: 'abort' } | { kind: 'fallback' } | { kind: 'visible' };

/** captureVisibleTab returns inline PNG bytes; decode locally without fetching a URL. */
function capturedPng(dataUrl: string): Blob {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('The screenshot is not a PNG.');
  const binary = atob(dataUrl.slice(prefix.length));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

export function createAreaCapture(overrides: Partial<CaptureAreaDeps> = {}) {
  // Undefined overrides keep the production default, useful when testing one browser adapter.
  const deps = { ...DEFAULTS };
  for (const key of Object.keys(overrides) as (keyof CaptureAreaDeps)[]) {
    if (overrides[key] !== undefined) Object.assign(deps, { [key]: overrides[key] });
  }
  const pending = new Map<number, () => Promise<void>>();

  async function abortOverlay(tabId: number): Promise<void> {
    try {
      await deps.abortOverlay(tabId);
    } catch {
      // Closed, loading, and restricted tabs may have no selection receiver.
    }
  }

  async function captureArea(tabId: number): Promise<void> {
    while (pending.has(tabId)) await pending.get(tabId)?.();
    let tab: CaptureTab;
    try {
      tab = await deps.getTab(tabId);
    } catch {
      await abortOverlay(tabId);
      await deps.showMessage(tabId, CAPTURE_FAILED_MESSAGE, 'error');
      return;
    }
    // A concurrent trigger may have started another wait while the tab lookup was in flight.
    while (pending.has(tabId)) await pending.get(tabId)?.();

    let finish: (result: SelectionResult) => void = () => undefined;
    let settled = false;
    let abortDelivery = Promise.resolve();
    let markCleaned: () => void = () => undefined;
    const cleaned = new Promise<void>((resolve) => { markCleaned = resolve; });
    const result = new Promise<SelectionResult>((resolve) => {
      finish = (value) => {
        if (settled) return;
        settled = true;
        if (value.kind === 'abort' || value.kind === 'fallback') abortDelivery = abortOverlay(tabId);
        resolve(value);
      };
    });
    const abort = () => {
      finish({ kind: 'abort' });
      return cleaned;
    };
    const listener: AreaMessageListener = (message, sender) => {
      if (sender.tab?.id !== tabId || sender.frameId !== 0 || !isSelectAreaMessage(message)) return;
      switch (message.type) {
        case 'select-area:done':
          finish({ kind: 'done', message });
          break;
        case 'select-area:visible':
          finish({ kind: 'visible' });
          break;
        case 'select-area:cancel':
          finish({ kind: 'cancel' });
          break;
      }
    };
    const removedListener: TabRemovedListener = (removedTabId) => {
      if (removedTabId === tabId) void abort();
    };
    const updatedListener: TabUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'loading') void abort();
    };
    pending.set(tabId, abort);
    deps.addMessageListener(listener);
    deps.addTabRemovedListener(removedListener);
    deps.addTabUpdatedListener(updatedListener);
    const timer = deps.clock.setTimeout(() => { void abort(); }, SELECTION_TIMEOUT_MS);
    // Extension API calls reset Chrome's 30s idle timer. Stop this bounded pulse with the selection.
    const pulse = () => {
      if (settled) return;
      void deps.keepWorkerAlive().catch(() => undefined);
      heartbeat = deps.clock.setTimeout(pulse, 20_000);
    };
    let heartbeat = deps.clock.setTimeout(pulse, 20_000);
    let selection: SelectionResult;
    try {
      // Do not await injection: even a stalled browser API must respect the selection deadline.
      try {
        void deps.injectOverlay(tabId).catch(() => finish({ kind: 'fallback' }));
      } catch {
        finish({ kind: 'fallback' });
      }
      selection = await result;
    } finally {
      deps.removeMessageListener(listener);
      deps.removeTabRemovedListener(removedListener);
      deps.removeTabUpdatedListener(updatedListener);
      deps.clock.clearTimeout(timer);
      deps.clock.clearTimeout(heartbeat);
      // Deliver the old abort before a repeated trigger injects a new overlay in the same frame.
      await abortDelivery;
      if (pending.get(tabId) === abort) pending.delete(tabId);
      markCleaned();
    }
    if (selection.kind === 'cancel' || selection.kind === 'abort') return;
    try {
      tab = await deps.getTab(tabId);
    } catch {
      await abortOverlay(tabId);
      return;
    }
    // This also guards the fallback: captureVisibleTab captures the active tab in this window.
    if (!tab.active) return;

    let blob: Blob;
    try {
      blob = capturedPng(await deps.captureVisibleTab(tab.windowId, { format: 'png' }));
      if (selection.kind === 'done') {
        const { rect, viewportWidth, viewportHeight } = selection.message;
        blob = await deps.cropImage(blob, rect, { width: viewportWidth, height: viewportHeight });
      }
    } catch {
      await deps.showMessage(tabId, CAPTURE_FAILED_MESSAGE, 'error');
      return;
    }
    const url = tab.url ?? '';
    try {
      await deps.startNoteStep({
        tabId, blob, mimeType: 'image/png', captureType: selection.kind === 'done' ? 'area' : 'visible',
        source: sourceFromUrl(url), label: tab.title, title: tab.title, url,
        ...(selection.kind === 'fallback' ? { message: VISIBLE_FALLBACK_MESSAGE } : {}),
      });
    } catch (error) {
      // The capture could not be stored or shown (storage full, no window). Say so, as the other flows do.
      console.error('Capture to Drive: Opening the area note step failed.', error);
      await deps.showMessage(tabId, SAVE_FAILED_TEXT, 'error');
    }
  }

  async function captureAreaInActiveTab(): Promise<void> {
    const [tab] = await deps.queryTabs({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) await captureArea(tab.id);
  }

  return { captureArea, captureAreaInActiveTab };
}

const areaCapture = createAreaCapture();
export const captureArea = areaCapture.captureArea;
export const captureAreaInActiveTab = areaCapture.captureAreaInActiveTab;
