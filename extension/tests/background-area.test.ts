import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import background from '../entrypoints/background';
import { captureArea, captureAreaInActiveTab } from '../lib/capture-area';

vi.mock('../lib/capture-area', () => ({ captureArea: vi.fn(), captureAreaInActiveTab: vi.fn() }));
// Keep the real note-step exports (capture-page and the other flows import them); stub only what the worker calls.
vi.mock('../lib/note-step', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/note-step')>()),
  recoverPendingCaptures: vi.fn(async () => ({ requeued: 0, deleted: 0 })),
  handleNoteRequest: vi.fn(),
}));
vi.mock('../lib/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue')>()),
  RETRY_ALARM: 'test-retry',
  installQueueProcessor: () => ({ recover: async () => undefined, processQueue: async () => undefined, handle: vi.fn() }),
}));

const commandListener = vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(() => undefined);

beforeEach(() => {
  fakeBrowser.reset();
  // fakeBrowser leaves contextMenus unimplemented; these tests exercise area wiring only.
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation(() => undefined);
  commandListener.mockClear();
  vi.mocked(captureArea).mockReset().mockResolvedValue(undefined);
  vi.mocked(captureAreaInActiveTab).mockReset().mockResolvedValue(undefined);
  background.main();
});

describe('area capture wiring', () => {
  it('routes the popup request to captureArea', async () => {
    await fakeBrowser.runtime.sendMessage({ type: 'capture:area', tabId: 42 });
    expect(captureArea).toHaveBeenCalledWith(42);
  });

  it.each([0, 1])('ignores capture requests from content scripts in frame %s', async (frameId) => {
    const sender = { tab: await fakeBrowser.tabs.create({ url: 'https://example.com' }), frameId };
    await fakeBrowser.runtime.onMessage.trigger({ type: 'capture:area', tabId: 42 }, sender, () => undefined);
    expect(captureArea).not.toHaveBeenCalled();
  });

  it('routes only the select-area command to the active-tab path', async () => {
    commandListener.mock.calls[0]?.[0]('select-area');
    expect(captureAreaInActiveTab).toHaveBeenCalledOnce();
    commandListener.mock.calls[0]?.[0]('unrelated');
    expect(captureAreaInActiveTab).toHaveBeenCalledOnce();
  });

  it.each([{}, { type: 'capture:area' }, { type: 'capture:area', tabId: -1 }, { type: 'capture:area', tabId: 1.5 }])(
    'ignores malformed capture requests %j', async (message) => {
      await fakeBrowser.runtime.sendMessage(message);
      expect(captureArea).not.toHaveBeenCalled();
    },
  );
});
