// The background's capture:page listener (spec section 6.3 flow B): the popup asks, the worker captures. Runs the real
// entry point against WXT's fake browser, with the capture itself mocked out (tests/capture-page.test.ts covers it).
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import background from '../entrypoints/background';
import { captureArea } from '../lib/capture-area';
import { capturePage } from '../lib/capture-page';
import { processQueue } from '../lib/queue';
import { resetDatabase, ticks } from './helpers/queue-harness';

vi.mock('../lib/capture-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/capture-page')>()),
  capturePage: vi.fn(),
}));

// Select area has its own wiring test; here it only needs to show that capture:area reaches its own listener.
vi.mock('../lib/capture-area', () => ({ captureArea: vi.fn(), captureAreaInActiveTab: vi.fn() }));

const capture = vi.mocked(capturePage);

async function startWorker(): Promise<void> {
  background.main();
  // Let the start-up recovery pass finish.
  await ticks(30);
}

beforeEach(async () => {
  fakeBrowser.reset();
  // fakeBrowser leaves contextMenus unimplemented; these tests exercise the whole page wiring.
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation(() => undefined);
  // WXT's fake browser does not implement commands events yet; area wiring has its own listener test.
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(() => undefined);
  await resetDatabase();
  capture.mockReset();
  capture.mockResolvedValue(undefined);
  vi.mocked(captureArea).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Wait for the worker's processor to go idle, so its drain does not run into the next test.
  await processQueue();
});

describe('capture:page', () => {
  it('captures the whole page in the tab the popup named', async () => {
    await startWorker();

    await fakeBrowser.runtime.sendMessage({ type: 'capture:page', tabId: 42 });
    expect(capture).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('does not make the popup wait for the capture', async () => {
    await startWorker();
    // A first print can take 12 s; the popup closes itself right after asking.
    capture.mockReturnValue(new Promise<void>(() => undefined));

    await expect(fakeBrowser.runtime.sendMessage({ type: 'capture:page', tabId: 42 })).resolves.toBeUndefined();
  });

  it('logs a capture that fails instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    capture.mockRejectedValue(new Error('window could not be opened'));
    await startWorker();

    await fakeBrowser.runtime.sendMessage({ type: 'capture:page', tabId: 42 });
    await ticks(5);

    expect(error).toHaveBeenCalledWith(
      'Capture to Drive: The whole page capture failed.',
      expect.objectContaining({ message: 'window could not be opened' }),
    );
  });

  it('ignores a request that comes from a tab, such as a content script in a web page', async () => {
    await startWorker();
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/' });

    // The listener is called directly, with the sender the browser would give a content script.
    await fakeBrowser.runtime.onMessage.trigger({ type: 'capture:page', tabId: 42 }, { tab, frameId: 0 }, () => undefined);
    await ticks(5);

    expect(capture).not.toHaveBeenCalled();
  });

  it('ignores a request from an extension page open in a tab', async () => {
    await startWorker();
    const tab = await fakeBrowser.tabs.create({ url: 'chrome-extension://test-extension-id/upload.html' });

    await fakeBrowser.runtime.onMessage.trigger({ type: 'capture:page', tabId: 42 }, { tab }, () => undefined);
    await ticks(5);

    expect(capture).not.toHaveBeenCalled();
  });

  it('accepts a request from a sender with no tab, which is how the popup reaches the worker', async () => {
    await startWorker();

    await fakeBrowser.runtime.onMessage.trigger({ type: 'capture:page', tabId: 42 }, { id: 'test-extension-id' }, () => undefined);

    expect(capture).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.each([[{ type: 'capture:page' }], [{ type: 'capture:page', tabId: '42' }], [{ type: 'capture:area', tabId: 42 }]])(
    'ignores %j',
    async (message) => {
      await startWorker();

      await fakeBrowser.runtime.sendMessage(message);
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it('leaves capture:area to the Select area listener', async () => {
    await startWorker();

    await fakeBrowser.runtime.sendMessage({ type: 'capture:area', tabId: 42 });
    expect(captureArea).toHaveBeenCalledExactlyOnceWith(42);
    expect(capture).not.toHaveBeenCalled();
  });

  it('leaves the queue and note-step requests to their own listeners', async () => {
    await startWorker();

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:kick' })).resolves.toEqual({ ok: true });
    await expect(fakeBrowser.runtime.sendMessage({ type: 'note:get', captureId: 'missing' })).resolves.toEqual({
      capture: null,
    });
    expect(capture).not.toHaveBeenCalled();
  });
});
