import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAreaCapture } from '../lib/capture-area';
import type { AreaMessageListener, CaptureAreaDeps, TabRemovedListener, TabUpdatedListener } from '../lib/capture-area';

const TAB = { id: 42, active: true, windowId: 7, title: 'Quarterly orders', url: 'https://www.example.com/orders' };
const DONE = {
  type: 'select-area:done', rect: { x: 20, y: 30, width: 100, height: 80 },
  viewportWidth: 1000, viewportHeight: 800,
} as const;
const SENDER = { tab: { id: TAB.id }, frameId: 0 };
const DATA_URL = 'data:image/png;base64,cG5n';

function harness() {
  const listeners = new Set<AreaMessageListener>();
  const removedListeners = new Set<TabRemovedListener>();
  const updatedListeners = new Set<TabUpdatedListener>();
  const crop = new Blob(['cropped'], { type: 'image/png' });
  const deps = {
    getTab: vi.fn<CaptureAreaDeps['getTab']>().mockResolvedValue(TAB),
    queryTabs: vi.fn<CaptureAreaDeps['queryTabs']>().mockResolvedValue([TAB]),
    injectOverlay: vi.fn<CaptureAreaDeps['injectOverlay']>().mockResolvedValue(undefined),
    abortOverlay: vi.fn<(tabId: number) => Promise<void>>().mockResolvedValue(undefined),
    addMessageListener: vi.fn((listener: AreaMessageListener) => { listeners.add(listener); }),
    removeMessageListener: vi.fn((listener: AreaMessageListener) => { listeners.delete(listener); }),
    addTabRemovedListener: vi.fn((listener: TabRemovedListener) => { removedListeners.add(listener); }),
    removeTabRemovedListener: vi.fn((listener: TabRemovedListener) => { removedListeners.delete(listener); }),
    addTabUpdatedListener: vi.fn((listener: TabUpdatedListener) => { updatedListeners.add(listener); }),
    removeTabUpdatedListener: vi.fn((listener: TabUpdatedListener) => { updatedListeners.delete(listener); }),
    captureVisibleTab: vi.fn<CaptureAreaDeps['captureVisibleTab']>().mockResolvedValue(DATA_URL),
    cropImage: vi.fn<CaptureAreaDeps['cropImage']>().mockResolvedValue(crop),
    startNoteStep: vi.fn<CaptureAreaDeps['startNoteStep']>().mockResolvedValue(undefined),
    showMessage: vi.fn<CaptureAreaDeps['showMessage']>().mockResolvedValue(undefined),
    keepWorkerAlive: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clock: {
      setTimeout: vi.fn((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms)),
      clearTimeout: vi.fn((id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id)),
    },
  } satisfies CaptureAreaDeps;
  const controller = createAreaCapture(deps);
  const emit = (message: unknown, sender = SENDER) => { for (const listener of listeners) listener(message, sender); };
  const removeTab = (tabId: number) => { for (const listener of removedListeners) listener(tabId); };
  const updateTab = (tabId: number, changeInfo: Parameters<TabUpdatedListener>[1]) => {
    for (const listener of updatedListeners) listener(tabId, changeInfo);
  };
  const begin = async () => {
    const result = controller.captureArea(TAB.id);
    await vi.waitFor(() => expect(deps.injectOverlay).toHaveBeenCalled());
    return { result };
  };
  const expectListenersRemoved = () => {
    expect(listeners.size).toBe(0);
    expect(removedListeners.size).toBe(0);
    expect(updatedListeners.size).toBe(0);
    expect(deps.removeTabRemovedListener).toHaveBeenCalledOnce();
    expect(deps.removeTabUpdatedListener).toHaveBeenCalledOnce();
  };
  return { deps, controller, emit, begin, listeners, removedListeners, updatedListeners, removeTab, updateTab, expectListenersRemoved, crop };
}

beforeEach(() => fakeBrowser.reset());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('captureArea', () => {
  it('waits for done, captures the correct window, crops, and passes tab metadata to the note step', async () => {
    const f = harness();
    const { result } = await f.begin();
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    f.emit(DONE);
    await result;
    expect(f.deps.getTab).toHaveBeenCalledWith(TAB.id);
    expect(f.deps.getTab).toHaveBeenCalledTimes(2);
    expect(f.deps.injectOverlay).toHaveBeenCalledWith(TAB.id);
    expect(f.deps.captureVisibleTab).toHaveBeenCalledWith(7, { format: 'png' });
    const captured = f.deps.cropImage.mock.calls[0]?.[0];
    expect(captured?.type).toBe('image/png');
    expect(await captured?.text()).toBe('png');
    expect(f.deps.cropImage).toHaveBeenCalledWith(captured, DONE.rect, { width: 1000, height: 800 });
    expect(f.deps.startNoteStep).toHaveBeenCalledWith({
      tabId: 42, blob: f.crop, mimeType: 'image/png', captureType: 'area', source: 'example.com',
      label: TAB.title, title: TAB.title, url: TAB.url,
    });
    f.expectListenersRemoved();
    expect(f.deps.clock.clearTimeout).toHaveBeenCalledTimes(2);
    expect(f.deps.abortOverlay).not.toHaveBeenCalled();
  });

  it('captures the whole visible area, with no crop and no notice, when the overlay sends visible (Enter)', async () => {
    const f = harness();
    const { result } = await f.begin();
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    f.emit({ type: 'select-area:visible' });
    await result;
    expect(f.deps.captureVisibleTab).toHaveBeenCalledWith(7, { format: 'png' });
    expect(f.deps.cropImage).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).toHaveBeenCalledExactlyOnceWith({
      tabId: 42, blob: expect.any(Blob), mimeType: 'image/png', captureType: 'visible', source: 'example.com',
      label: TAB.title, title: TAB.title, url: TAB.url,
    });
    expect(f.deps.startNoteStep.mock.calls[0]?.[0]).not.toHaveProperty('message');
    expect(await f.deps.startNoteStep.mock.calls[0]?.[0].blob.text()).toBe('png');
    expect(f.deps.getTab).toHaveBeenCalledTimes(2);
    // The overlay removed itself before it sent the message, so there is nothing to abort.
    expect(f.deps.abortOverlay).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('treats visible from a tab that is no longer active as cancel, like done', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.deps.getTab.mockResolvedValue({ ...TAB, active: false });
    f.emit({ type: 'select-area:visible' });
    await result;
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  // Like Save this PDF and linked files, a note step that cannot start says so instead of failing silently.
  it('shows the save-failed message when the note step cannot start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = harness();
    f.deps.startNoteStep.mockRejectedValue(new Error('QuotaExceededError'));
    const { result } = await f.begin();
    f.emit(DONE);
    await result;
    expect(f.deps.startNoteStep).toHaveBeenCalledOnce();
    expect(f.deps.showMessage).toHaveBeenCalledExactlyOnceWith(42, "Couldn't save this capture. Capture it again.", 'error');
    expect(error).toHaveBeenCalledWith(
      'Capture to Drive: Opening the area note step failed.',
      expect.objectContaining({ message: 'QuotaExceededError' }),
    );
    f.expectListenersRemoved();
  });

  it('shows the save-failed message when the note step for the visible area cannot start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = harness();
    f.deps.startNoteStep.mockRejectedValue(new Error('QuotaExceededError'));
    const { result } = await f.begin();
    f.emit({ type: 'select-area:visible' });
    await result;
    expect(f.deps.showMessage).toHaveBeenCalledExactlyOnceWith(42, "Couldn't save this capture. Capture it again.", 'error');
  });

  it('shows the exact error if the visible capture fails', async () => {
    const f = harness();
    f.deps.captureVisibleTab.mockRejectedValue(new Error('Blocked'));
    const { result } = await f.begin();
    f.emit({ type: 'select-area:visible' });
    await result;
    expect(f.deps.showMessage).toHaveBeenCalledWith(42, "This page can't be captured.", 'error');
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('re-reads the tab after done and uses its fresh window, title, and URL', async () => {
    const f = harness();
    const fresh = { ...TAB, windowId: 9, title: 'Updated orders', url: 'https://www.updated.example/orders' };
    const { result } = await f.begin();
    expect(f.deps.getTab).toHaveBeenCalledTimes(1);
    f.deps.getTab.mockResolvedValue(fresh);
    f.emit(DONE);
    await result;
    expect(f.deps.getTab).toHaveBeenNthCalledWith(2, TAB.id);
    expect(f.deps.captureVisibleTab).toHaveBeenCalledWith(9, { format: 'png' });
    expect(f.deps.startNoteStep).toHaveBeenCalledWith({
      tabId: TAB.id, blob: f.crop, mimeType: 'image/png', captureType: 'area', source: 'updated.example',
      label: fresh.title, title: fresh.title, url: fresh.url,
    });
    f.expectListenersRemoved();
  });

  it('treats a tab that is no longer active after done as cancel', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.deps.getTab.mockResolvedValue({ ...TAB, active: false });
    f.emit(DONE);
    await result;
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    expect(f.deps.abortOverlay).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('treats a tab that disappears before the fresh lookup as cancel', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.deps.getTab.mockRejectedValue(new Error('No tab with this id'));
    f.emit(DONE);
    await result;
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    expect(f.deps.abortOverlay).toHaveBeenCalledWith(TAB.id);
    f.expectListenersRemoved();
  });

  it('cancels immediately when the selected tab closes and ignores late done', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.removeTab(TAB.id);
    await result;
    f.emit(DONE);
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    expect(f.deps.clock.clearTimeout).toHaveBeenCalledTimes(2);
    expect(f.deps.abortOverlay).toHaveBeenCalledWith(TAB.id);
    f.expectListenersRemoved();
  });

  it('keeps waiting across a same-document URL change and captures after done', async () => {
    const f = harness();
    const { result } = await f.begin();
    const fresh = { ...TAB, url: `${TAB.url}#details` };
    f.deps.getTab.mockResolvedValue(fresh);
    f.updateTab(TAB.id, { url: fresh.url });
    await Promise.resolve();
    expect(f.listeners.size).toBe(1);
    expect(f.deps.abortOverlay).not.toHaveBeenCalled();
    f.emit(DONE);
    await result;
    expect(f.deps.startNoteStep).toHaveBeenCalledWith(expect.objectContaining({ url: fresh.url }));
    expect(f.deps.abortOverlay).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('cancels and aborts the overlay when the selected tab starts loading', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.updateTab(TAB.id, { status: 'loading' });
    await result;
    f.emit(DONE);
    expect(f.deps.abortOverlay).toHaveBeenCalledExactlyOnceWith(TAB.id);
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    expect(f.deps.clock.clearTimeout).toHaveBeenCalledTimes(2);
    f.expectListenersRemoved();
  });

  it('ignores lifecycle events for other tabs and non-navigation updates', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.removeTab(99);
    f.updateTab(99, { url: 'https://example.com/next', status: 'loading' });
    f.updateTab(TAB.id, { status: 'complete' });
    f.updateTab(TAB.id, {});
    expect(f.listeners.size).toBe(1);
    f.emit(DONE);
    await result;
    expect(f.deps.startNoteStep).toHaveBeenCalledOnce();
    f.expectListenersRemoved();
  });

  it('listens before injecting so an immediate done message is received', async () => {
    const f = harness();
    f.deps.injectOverlay.mockImplementation(async () => { f.emit(DONE); });
    await f.controller.captureArea(42);
    expect(f.deps.startNoteStep).toHaveBeenCalledOnce();
  });

  it('cancel removes the listener and timer without capturing or opening a note', async () => {
    const f = harness();
    const { result } = await f.begin();
    f.emit({ type: 'select-area:cancel' });
    await result;
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    f.expectListenersRemoved();
    expect(f.deps.clock.clearTimeout).toHaveBeenCalledTimes(2);
    expect(f.deps.abortOverlay).not.toHaveBeenCalled();
  });

  it('times out after exactly two minutes and ignores late results', async () => {
    vi.useFakeTimers();
    const f = harness();
    const result = f.controller.captureArea(42);
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    f.emit(DONE);
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.abortOverlay).toHaveBeenCalledExactlyOnceWith(TAB.id);
    f.expectListenersRemoved();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also times out when injection never settles', async () => {
    vi.useFakeTimers();
    const f = harness();
    f.deps.injectOverlay.mockImplementation(() => new Promise(() => undefined));
    const result = f.controller.captureArea(42);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toBeUndefined();
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.abortOverlay).toHaveBeenCalledWith(TAB.id);
  });

  it.each(['rejected', 'thrown'] as const)('ignores a %s abort delivery when the tab starts loading', async (failure) => {
    const f = harness();
    if (failure === 'rejected') f.deps.abortOverlay.mockRejectedValue(new Error('No receiver'));
    else f.deps.abortOverlay.mockImplementation(() => { throw new Error('Extension unloaded'); });
    const { result } = await f.begin();
    f.updateTab(TAB.id, { status: 'loading' });
    await expect(result).resolves.toBeUndefined();
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('keeps the MV3 worker alive only during the bounded selection wait', async () => {
    vi.useFakeTimers();
    const f = harness();
    const result = f.controller.captureArea(42);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.deps.keepWorkerAlive).toHaveBeenCalledTimes(2);
    f.emit({ type: 'select-area:cancel' });
    await result;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.deps.keepWorkerAlive).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to the visible PNG on injection failure with the exact notice', async () => {
    const f = harness();
    f.deps.injectOverlay.mockRejectedValue(new Error('Cannot script this page'));
    await f.controller.captureArea(42);
    expect(f.deps.captureVisibleTab).toHaveBeenCalledWith(7, { format: 'png' });
    expect(f.deps.cropImage).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).toHaveBeenCalledWith({
      tabId: 42, blob: expect.any(Blob), mimeType: 'image/png', captureType: 'visible', source: 'example.com',
      label: TAB.title, title: TAB.title, url: TAB.url,
      message: "Selection isn't available on this page, so the visible area was captured.",
    });
    expect(await f.deps.startNoteStep.mock.calls[0]?.[0].blob.text()).toBe('png');
    expect(f.deps.getTab).toHaveBeenCalledTimes(2);
    f.expectListenersRemoved();
  });

  it('does not capture another tab when injection fails after the selected tab becomes inactive', async () => {
    const f = harness();
    f.deps.injectOverlay.mockRejectedValue(new Error('Cannot script this page'));
    f.deps.getTab.mockResolvedValueOnce(TAB).mockResolvedValue({ ...TAB, active: false });
    await f.controller.captureArea(TAB.id);
    expect(f.deps.getTab).toHaveBeenCalledTimes(2);
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    expect(f.deps.showMessage).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('uses fresh tab metadata for the visible fallback', async () => {
    const f = harness();
    const fresh = { ...TAB, windowId: 9, title: 'Moved tab', url: 'https://fresh.example/orders' };
    f.deps.injectOverlay.mockRejectedValue(new Error('Cannot script this page'));
    f.deps.getTab.mockResolvedValueOnce(TAB).mockResolvedValue(fresh);
    await f.controller.captureArea(TAB.id);
    expect(f.deps.captureVisibleTab).toHaveBeenCalledWith(fresh.windowId, { format: 'png' });
    expect(f.deps.startNoteStep).toHaveBeenCalledWith(expect.objectContaining({ title: fresh.title, url: fresh.url }));
  });

  it('aborts the overlay if the initial tab lookup fails', async () => {
    const f = harness();
    f.deps.getTab.mockRejectedValue(new Error('No tab with this id'));
    await f.controller.captureArea(TAB.id);
    expect(f.deps.abortOverlay).toHaveBeenCalledWith(TAB.id);
    expect(f.deps.injectOverlay).not.toHaveBeenCalled();
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each(['selected', 'fallback'] as const)('shows the exact error if captureVisibleTab fails for %s', async (path) => {
    const f = harness();
    f.deps.captureVisibleTab.mockRejectedValue(new Error('Blocked'));
    if (path === 'fallback') f.deps.injectOverlay.mockRejectedValue(new Error('Cannot script'));
    const { result } = await f.begin();
    if (path === 'selected') f.emit(DONE);
    await result;
    expect(f.deps.showMessage).toHaveBeenCalledWith(42, "This page can't be captured.", 'error');
    expect(f.deps.startNoteStep).not.toHaveBeenCalled();
    f.expectListenersRemoved();
  });

  it('reports a crop failure and releases the selection listener', async () => {
    const f = harness();
    f.deps.cropImage.mockRejectedValue(new Error('Cannot decode'));
    const { result } = await f.begin();
    f.emit(DONE);
    await result;
    expect(f.deps.showMessage).toHaveBeenCalledWith(42, "This page can't be captured.", 'error');
    f.expectListenersRemoved();
  });

  it.each([
    { tab: { id: 99 }, frameId: 0 }, { tab: { id: 42 }, frameId: 1 },
    { frameId: 0 }, { tab: { id: 42 } },
  ])('ignores done, visible, and cancel from another tab or a non-top frame: %j', async (sender) => {
    const f = harness();
    const { result } = await f.begin();
    for (const listener of f.listeners) {
      listener(DONE, sender);
      listener({ type: 'select-area:visible' }, sender);
      listener({ type: 'select-area:cancel' }, sender);
    }
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(1);
    f.emit({ type: 'select-area:cancel' });
    await result;
  });

  it.each([
    null, { type: 'note:save' }, { ...DONE, viewportWidth: 0 }, { ...DONE, viewportHeight: Infinity },
    { ...DONE, rect: { ...DONE.rect, width: 7 } }, { ...DONE, rect: { ...DONE.rect, x: NaN } },
  ])('ignores malformed selection messages %j', async (message) => {
    const f = harness();
    const { result } = await f.begin();
    f.emit(message);
    expect(f.listeners.size).toBe(1);
    f.emit({ type: 'select-area:cancel' });
    await result;
    expect(f.deps.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('a second trigger aborts the first overlay before injecting its replacement and captures only once', async () => {
    const f = harness();
    const first = f.controller.captureArea(42);
    await vi.waitFor(() => expect(f.deps.injectOverlay).toHaveBeenCalledTimes(1));
    const second = f.controller.captureArea(42);
    await vi.waitFor(() => expect(f.deps.injectOverlay).toHaveBeenCalledTimes(2));
    await first;
    expect(f.deps.abortOverlay).toHaveBeenCalledExactlyOnceWith(TAB.id);
    expect(f.deps.abortOverlay.mock.invocationCallOrder[0]).toBeLessThan(f.deps.injectOverlay.mock.invocationCallOrder[1]!);
    expect(f.listeners.size).toBe(1);
    f.emit(DONE);
    await second;
    expect(f.deps.startNoteStep).toHaveBeenCalledOnce();
    expect(f.deps.abortOverlay).toHaveBeenCalledOnce();
  });

  it('waits for a delayed abort delivery before showing the replacement overlay', async () => {
    const f = harness();
    let delivered: () => void = () => undefined;
    f.deps.abortOverlay.mockImplementation(() => new Promise<void>((resolve) => { delivered = resolve; }));
    const { result: first } = await f.begin();
    const second = f.controller.captureArea(TAB.id);
    await vi.waitFor(() => expect(f.deps.abortOverlay).toHaveBeenCalledOnce());
    expect(f.deps.injectOverlay).toHaveBeenCalledTimes(1);
    delivered();
    await vi.waitFor(() => expect(f.deps.injectOverlay).toHaveBeenCalledTimes(2));
    await first;
    f.emit(DONE);
    await second;
    expect(f.deps.startNoteStep).toHaveBeenCalledOnce();
  });

  it('serializes simultaneous triggers after their tab lookups', async () => {
    const f = harness();
    const first = f.controller.captureArea(TAB.id);
    const second = f.controller.captureArea(TAB.id);
    await vi.waitFor(() => expect(f.deps.injectOverlay).toHaveBeenCalledTimes(2));
    await first;
    expect(f.deps.abortOverlay).toHaveBeenCalledExactlyOnceWith(TAB.id);
    expect(f.listeners.size).toBe(1);
    f.emit(DONE);
    await second;
    expect(f.deps.startNoteStep).toHaveBeenCalledOnce();
  });
});

describe('active-tab command path and browser defaults', () => {
  it('uses the active tab of the last focused window', async () => {
    const f = harness();
    const result = f.controller.captureAreaInActiveTab();
    await vi.waitFor(() => expect(f.deps.injectOverlay).toHaveBeenCalledWith(42));
    f.emit({ type: 'select-area:cancel' });
    await result;
    expect(f.deps.queryTabs).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(f.deps.getTab).toHaveBeenCalledWith(42);
  });

  it('does nothing when the active tab has no id', async () => {
    const f = harness();
    f.deps.queryTabs.mockResolvedValue([{ windowId: 7, active: true }]);
    await f.controller.captureAreaInActiveTab();
    expect(f.deps.injectOverlay).not.toHaveBeenCalled();
  });

  it('default injection uses the runtime bundle and top frame only', async () => {
    const script = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    const f = harness();
    const controller = createAreaCapture({ ...f.deps, injectOverlay: undefined });
    const result = controller.captureArea(42);
    await vi.waitFor(() => expect(script).toHaveBeenCalled());
    f.emit({ type: 'select-area:cancel' });
    await result;
    expect(script).toHaveBeenCalledWith({ target: { tabId: 42, frameIds: [0] }, files: ['content-scripts/select-area.js'] });
  });

  it('default abort sends the message to frame zero only', async () => {
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    const f = harness();
    const controller = createAreaCapture({ ...f.deps, abortOverlay: undefined });
    const result = controller.captureArea(TAB.id);
    await vi.waitFor(() => expect(f.deps.injectOverlay).toHaveBeenCalled());
    f.updateTab(TAB.id, { status: 'loading' });
    await result;
    expect(send).toHaveBeenCalledExactlyOnceWith(TAB.id, { type: 'select-area:abort' }, { frameId: 0 });
  });
});
