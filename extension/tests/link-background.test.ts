import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import background from '../entrypoints/background';
import { captureLink, registerLinkedFileMenu } from '../lib/capture-link';

vi.mock('../lib/capture-link', () => ({ captureLink: vi.fn(), registerLinkedFileMenu: vi.fn() }));
vi.mock('../lib/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue')>()),
  installQueueProcessor: () => ({
    processQueue: vi.fn().mockResolvedValue(undefined), recover: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../lib/note-step', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/note-step')>()),
  recoverPendingCaptures: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  // WXT's fake browser does not implement commands events yet; area wiring has its own listener test.
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(() => undefined);
  vi.mocked(registerLinkedFileMenu).mockResolvedValue(undefined);
  vi.mocked(captureLink).mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

// fakeBrowser does not implement contextMenus event triggering. Capture its registered listener.
function startWorker() {
  type ClickListener = Parameters<typeof fakeBrowser.contextMenus.onClicked.addListener>[0];
  let onClick: ClickListener = () => undefined;
  const addListener = vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation((listener) => {
    onClick = listener;
  });
  background.main();
  return { onClick, addListener };
}

describe('linked-file background listeners', () => {
  it('registers the click listener synchronously on worker start', () => {
    const { addListener } = startWorker();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(registerLinkedFileMenu).not.toHaveBeenCalled();
  });

  it('creates the menu on install and update', async () => {
    startWorker();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.0.9' });
    expect(registerLinkedFileMenu).toHaveBeenCalledTimes(2);
  });

  it('passes the clicked link and its tab to the handler', async () => {
    const { onClick } = startWorker();
    const info = { menuItemId: 'save-linked-file', editable: false, linkUrl: 'https://example.com/file.pdf' };
    const tab = { ...await fakeBrowser.tabs.create({ url: 'https://example.com/' }), title: 'Downloads' };
    onClick(info, tab);
    expect(captureLink).toHaveBeenCalledExactlyOnceWith(info, tab);
  });

  it('ignores other context menu items', async () => {
    const { onClick } = startWorker();
    onClick({ menuItemId: 'other', editable: false });
    expect(captureLink).not.toHaveBeenCalled();
  });
});
