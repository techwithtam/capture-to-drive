// Background wiring for the upload queue (startup recovery, onStartup, onInstalled, the retry alarm, and the
// queue:kick / queue:retry / queue:discard messages) and for the note step (startup cleanup of abandoned captures,
// note:get / note:save / note:discard, and the card-or-window choice). Runs the real entry point against WXT's fake
// browser with the mailbox client mocked out.
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import background from '../entrypoints/background';
import { QUEUE_STORE, transact } from '../lib/db';
import { capturePage } from '../lib/capture-page';
import { saveToMailbox } from '../lib/mailbox-client';
import type { MailboxResult } from '../lib/mailbox-client';
import { addItem, getItem, listItems, processQueue, RETRY_ALARM } from '../lib/queue';
import type { QueueItem } from '../lib/queue';
import { showMessage, startNoteStep } from '../lib/note-step';
import { getPending, listPending, putPending } from '../lib/pending-store';
import type { PendingRecord } from '../lib/pending-store';
import { saveSettings } from '../lib/settings';
import { newItem, resetDatabase, SUCCESS, ticks, until } from './helpers/queue-harness';

vi.mock('../lib/mailbox-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mailbox-client')>()),
  saveToMailbox: vi.fn(),
}));
// The whole page capture has its own tests; here it only needs to show that capture:page reaches its own listener.
vi.mock('../lib/capture-page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/capture-page')>()),
  capturePage: vi.fn(),
}));

const save = vi.mocked(saveToMailbox);

/** Writes a queue record as-is, the way an earlier service worker might have left it. */
async function putRaw(item: QueueItem): Promise<void> {
  await transact(QUEUE_STORE, 'readwrite', (store) => {
    store.put(item);
    return () => undefined;
  });
}

function storedItem(captureId: string, overrides: Partial<QueueItem>): QueueItem {
  const now = Date.now();
  return { ...newItem(captureId), createdAt: now, nextAttemptAt: now, attempts: 0, status: 'waiting', ...overrides };
}

async function startWorker(): Promise<void> {
  background.main();
  // Let the start-up recovery pass finish.
  await ticks(30);
}

async function queueIsEmpty(): Promise<boolean> {
  return (await listItems()).length === 0;
}

beforeEach(async () => {
  fakeBrowser.reset();
  // fakeBrowser leaves contextMenus unimplemented; these tests exercise queue and note wiring.
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation(() => undefined);
  const menus: {
    remove(id: string | number): Promise<void>;
    create(properties: Parameters<typeof fakeBrowser.contextMenus.create>[0]): string | number;
  } = fakeBrowser.contextMenus;
  vi.spyOn(menus, 'remove').mockResolvedValue(undefined);
  vi.spyOn(menus, 'create').mockReturnValue('save-linked-file');
  // WXT's fake browser does not implement commands events yet; area wiring has its own listener test.
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(() => undefined);
  await resetDatabase();
  save.mockReset();
  save.mockResolvedValue(SUCCESS);
  vi.mocked(capturePage).mockReset().mockResolvedValue(undefined);
  await saveSettings({ mailboxUrl: 'https://script.google.com/macros/s/TEST/exec', key: 'test-key', name: 'Alex' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Wait for the worker's processor to go idle, so its drain does not run into the next test.
  await processQueue();
});

describe('service-worker start', () => {
  // The mailbox key is in storage.local, which content scripts (running in web pages) could read by default.
  it('restricts storage.local to extension pages and the worker', async () => {
    await startWorker();
    expect(fakeBrowser.storage.local.setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('not supported'))],
    [
      'throws',
      (): Promise<void> => {
        throw new Error('not supported');
      },
    ],
  ])('still starts when restricting storage %s, and logs it', async (_name, failure) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fakeBrowser.storage.local.setAccessLevel).mockImplementation(failure);
    await addItem(newItem('a'));
    await startWorker();

    await fakeBrowser.runtime.onStartup.trigger();
    await until(queueIsEmpty, 'the queue to empty');
    expect(error).toHaveBeenCalledWith(
      'Capture to Drive: Restricting storage to extension pages failed.',
      expect.objectContaining({ message: 'not supported' }),
    );
  });

  it('still starts on a browser without storage.local.setAccessLevel', async () => {
    const local: { setAccessLevel?: unknown } = fakeBrowser.storage.local;
    const original = local.setAccessLevel;
    delete local.setAccessLevel;
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await startWorker();
      await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:kick' })).resolves.toEqual({ ok: true });
      expect(error).not.toHaveBeenCalled();
    } finally {
      local.setAccessLevel = original;
    }
  });

  it('puts an upload interrupted by a worker stop back in line and restores the badge, without uploading', async () => {
    await putRaw(storedItem('a', { status: 'uploading', attempts: 1, nextAttemptAt: Date.now() + 60_000 }));
    await startWorker();

    await until(async () => (await getItem('a'))?.status === 'waiting', 'the item to be reset');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('1');
    expect(await fakeBrowser.alarms.get(RETRY_ALARM)).toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('lifecycle events', () => {
  it('processes the queue on browser startup', async () => {
    await addItem(newItem('a'));
    await startWorker();
    expect(save).not.toHaveBeenCalled();

    await fakeBrowser.runtime.onStartup.trigger();
    await until(queueIsEmpty, 'the queue to empty');
    expect(save).toHaveBeenCalledTimes(1);
  });

  // Browser startup retries waiting captures even if their backoff has not elapsed.
  it('retries every waiting item when the browser starts, even one still backing off', async () => {
    await putRaw(
      storedItem('a', { status: 'waiting', attempts: 5, nextAttemptAt: Date.now() + 30 * 60_000, lastError: 'network' }),
    );
    await startWorker();
    expect(save).not.toHaveBeenCalled();

    await fakeBrowser.runtime.onStartup.trigger();
    await until(queueIsEmpty, 'the queue to empty');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('leaves needs-attention items for the user when the browser starts', async () => {
    await putRaw(storedItem('a', { status: 'needs_attention', attempts: 1, lastError: 'unauthorized' }));
    await startWorker();

    await fakeBrowser.runtime.onStartup.trigger();
    await ticks(30);
    expect(save).not.toHaveBeenCalled();
    expect((await getItem('a'))?.status).toBe('needs_attention');
  });

  it('processes the queue on install and update', async () => {
    await addItem(newItem('a'));
    await startWorker();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.0.9' });
    await until(queueIsEmpty, 'the queue to empty');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('processes the queue when the retry alarm fires, and ignores other alarms', async () => {
    await addItem(newItem('a'));
    await startWorker();

    await fakeBrowser.alarms.onAlarm.trigger({ name: 'something-else', scheduledTime: Date.now(), persistAcrossSessions: true });
    await ticks(30);
    expect(save).not.toHaveBeenCalled();

    await fakeBrowser.alarms.onAlarm.trigger({ name: RETRY_ALARM, scheduledTime: Date.now(), persistAcrossSessions: true });
    await until(queueIsEmpty, 'the queue to empty');
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('queue messages', () => {
  it('queue:kick processes the queue and answers once done', async () => {
    await startWorker();
    await addItem(newItem('a'));

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:kick' })).resolves.toEqual({ ok: true });
    expect(await listItems()).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('queue:retry retries a needs-attention item', async () => {
    await putRaw(storedItem('a', { status: 'needs_attention', attempts: 1, lastError: 'unauthorized' }));
    await startWorker();

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:retry', captureId: 'a' })).resolves.toEqual({ ok: true });
    expect(await listItems()).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('queue:discard removes an item without uploading it', async () => {
    await putRaw(storedItem('a', { status: 'needs_attention', attempts: 1, lastError: 'too_large' }));
    await startWorker();

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:discard', captureId: 'a' })).resolves.toEqual({
      ok: true,
    });
    expect(await listItems()).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(await fakeBrowser.action.getBadgeText({})).toBe('');
  });

  it('queue:discard also removes a waiting item that keeps failing', async () => {
    await putRaw(
      storedItem('a', {
        status: 'waiting',
        attempts: 4,
        nextAttemptAt: Date.now() + 30 * 60_000,
        lastError: 'server_error',
        lastMessage: 'Drive storage is full.',
      }),
    );
    await startWorker();
    expect(await fakeBrowser.action.getBadgeText({})).toBe('1');

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:discard', captureId: 'a' })).resolves.toEqual({
      ok: true,
    });
    expect(await listItems()).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(await fakeBrowser.action.getBadgeText({})).toBe('');
    expect(await fakeBrowser.alarms.get(RETRY_ALARM)).toBeUndefined();
  });

  it('queue:discard is refused, with ok: false and no error, for an item that is uploading', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let finishUpload: (result: MailboxResult) => void = () => undefined;
    save.mockImplementationOnce(
      () =>
        new Promise<MailboxResult>((resolve) => {
          finishUpload = resolve;
        }),
    );
    await startWorker();
    await addItem(newItem('a'));
    const kicked = fakeBrowser.runtime.sendMessage({ type: 'queue:kick' });
    await until(async () => (await getItem('a'))?.status === 'uploading', 'the upload to start');
    const before = await getItem('a');

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:discard', captureId: 'a' })).resolves.toEqual({
      ok: false,
    });
    expect(await getItem('a')).toEqual(before);
    expect(error).not.toHaveBeenCalled();

    // The upload carries on and lands: nothing was discarded.
    finishUpload({ kind: 'success', fileId: 'file-a' });
    await expect(kicked).resolves.toEqual({ ok: true });
    expect(await listItems()).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  // A killed worker leaves its upload marked `uploading`. Starting the worker resets it, so Discard is not refused for
  // an upload that no longer exists.
  describe('an item a stopped worker left marked uploading', () => {
    function stale(): QueueItem {
      return storedItem('a', {
        status: 'uploading',
        attempts: 4,
        nextAttemptAt: Date.now() + 30 * 60_000,
        lastError: 'server_error',
        lastMessage: 'Drive storage is full.',
      });
    }

    it('is reset by recovery at worker start, and then queue:discard removes it', async () => {
      await putRaw(stale());
      await startWorker();
      expect((await getItem('a'))?.status).toBe('waiting');

      await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:discard', captureId: 'a' })).resolves.toEqual({
        ok: true,
      });
      expect(await listItems()).toEqual([]);
      expect(save).not.toHaveBeenCalled();
      expect(await fakeBrowser.action.getBadgeText({})).toBe('');
    });

    it('is reset before a queue:discard that woke the worker is handled', async () => {
      await putRaw(stale());
      background.main();
      await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:discard', captureId: 'a' })).resolves.toEqual({
        ok: true,
      });
      expect(await listItems()).toEqual([]);
      expect(save).not.toHaveBeenCalled();
    });
  });

  it('answers ok: false when the request fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await startWorker();
    await addItem(newItem('a'));
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('storage is gone'));

    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:kick' })).resolves.toEqual({ ok: false });
    expect(error).toHaveBeenCalled();
  });

  it('leaves other messages to other listeners', async () => {
    await startWorker();
    await expect(fakeBrowser.runtime.sendMessage({ type: 'capture:page', tabId: 1 })).resolves.toBeUndefined();
    // It went to the whole page listener instead.
    expect(capturePage).toHaveBeenCalledExactlyOnceWith(1);
    await expect(fakeBrowser.runtime.sendMessage({ type: 'queue:discard' })).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('note step', () => {
  const HOUR = 60 * 60 * 1000;

  function pending(captureId: string, capturedAt: number): PendingRecord {
    return {
      captureId,
      capturedAt,
      blob: new Blob([`bytes of ${captureId}`], { type: 'image/png' }),
      mimeType: 'image/png',
      filename: `2026-10-07 13.42 Alex - example.com - ${captureId}.png`,
      meta: { title: 'Orders', url: 'https://example.com/orders', captureType: 'area', capturedBy: 'Alex' },
      fileKind: 'image',
    };
  }

  /** The fake browser leaves scripting and tabs.sendMessage unimplemented; these stand in for Chrome. */
  function mockCardApis() {
    const executeScript = vi
      .spyOn(fakeBrowser.scripting, 'executeScript')
      // The overloaded API types resolve to the callback form here, hence the casts.
      .mockResolvedValue([{ documentId: 'doc', frameId: 0, result: undefined }] as never);
    const sendToTab = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: true } as never);
    const createWindow = vi.spyOn(fakeBrowser.windows, 'create');
    return { executeScript, sendToTab, createWindow };
  }

  it('deletes pending captures older than 24 hours when the worker starts', async () => {
    await putPending(pending('old', Date.now() - 25 * HOUR));
    await putPending(pending('new', Date.now() - HOUR));
    await startWorker();
    await until(async () => (await listPending()).length === 1, 'the old capture to be cleaned up');
    expect((await listPending()).map((record) => record.captureId)).toEqual(['new']);
  });

  it('queues and uploads a capture whose Save was requested before the previous worker stopped', async () => {
    await putPending({ ...pending('a', Date.now() - 25 * HOUR), saveRequested: true, note: 'Saved before the stop' });
    await startWorker();

    await until(async () => save.mock.calls.length === 1, 'the recovered capture to upload');
    expect(save.mock.calls[0]?.[0]).toMatchObject({ captureId: 'a', filename: pending('a', 0).filename });
    expect(save.mock.calls[0]?.[0].description.split('\n')[0]).toBe('Note: Saved before the stop');
    await until(async () => (await listItems()).length === 0, 'the queue to empty');
    expect(await getPending('a')).toBeUndefined();
  });

  it('note:save queues the capture with its note, uploads it, and answers saved', async () => {
    await putPending(pending('a', Date.now()));
    await startWorker();

    await expect(
      fakeBrowser.runtime.sendMessage({ type: 'note:save', captureId: 'a', note: 'For taxes' }),
    ).resolves.toEqual({ outcome: 'saved' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].description.split('\n')[0]).toBe('Note: For taxes');
    expect(await getPending('a')).toBeUndefined();
    expect(await listItems()).toEqual([]);
  });

  it("note:save answers needs_attention with the queue's message when the key is rejected", async () => {
    save.mockResolvedValue({ kind: 'needs_attention', error: 'unauthorized' });
    await putPending(pending('a', Date.now()));
    await startWorker();

    await expect(fakeBrowser.runtime.sendMessage({ type: 'note:save', captureId: 'a', note: '' })).resolves.toEqual({
      outcome: 'needs_attention',
      message: 'Mailbox key was rejected. Check Settings.',
    });
  });

  it('note:get answers with what the note window shows, and note:discard deletes the capture', async () => {
    await putPending(pending('a', Date.now()));
    await startWorker();

    await expect(fakeBrowser.runtime.sendMessage({ type: 'note:get', captureId: 'a' })).resolves.toEqual({
      capture: { captureId: 'a', filename: '2026-10-07 13.42 Alex - example.com - a.png', fileKind: 'image' },
    });
    await expect(fakeBrowser.runtime.sendMessage({ type: 'note:discard', captureId: 'a' })).resolves.toEqual({ ok: true });
    expect(await getPending('a')).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('startNoteStep injects the card script into the tab and sends it the capture', async () => {
    const { executeScript, sendToTab, createWindow } = mockCardApis();
    await startWorker();

    await startNoteStep({
      tabId: 42,
      blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
      captureType: 'page-pdf',
      source: 'example.com',
      label: 'Receipt',
    });

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ['/content-scripts/note-card.js'],
      injectImmediately: true,
    });
    const [tabId, message, options] = sendToTab.mock.calls[0] ?? [];
    expect(tabId).toBe(42);
    // Only the top frame, where the card was injected, may answer.
    expect(options).toEqual({ frameId: 0 });
    expect(message).toMatchObject({ type: 'note:show', fileKind: 'pdf' });
    expect((message as { filename: string }).filename).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} Alex - example\.com - Receipt\.pdf$/);
    expect(await getPending((message as { captureId: string }).captureId)).toBeDefined();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('startNoteStep opens note.html in a popup window when the tab cannot be scripted', async () => {
    const { executeScript, createWindow } = mockCardApis();
    executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    await startWorker();

    await startNoteStep({
      tabId: 42,
      blob: new Blob(['png'], { type: 'image/png' }),
      mimeType: 'image/png',
      captureType: 'visible',
      source: 'extensions',
    });

    const records = await listPending();
    expect(records).toHaveLength(1);
    expect(createWindow).toHaveBeenCalledWith({
      url: `chrome-extension://test-extension-id/note.html?id=${records[0]?.captureId ?? ''}`,
      type: 'popup',
      width: 420,
      height: 380,
      focused: true,
    });
  });

  it('startNoteStep opens Settings instead when settings are missing', async () => {
    const { executeScript } = mockCardApis();
    const openOptionsPage = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockResolvedValue(undefined);
    await fakeBrowser.storage.local.clear();
    await startWorker();

    await startNoteStep({ tabId: 1, blob: new Blob(['x']), mimeType: 'image/png', captureType: 'area', source: 'a.com' });
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(await listPending()).toEqual([]);
  });

  it('showMessage falls back to the note window with the message', async () => {
    const { sendToTab, createWindow } = mockCardApis();
    sendToTab.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    await startWorker();

    await showMessage(42, "This page can't be saved. Try Select area instead.", 'error');
    const url = new URL((createWindow.mock.calls[0]?.[0] as { url: string }).url);
    expect(url.pathname).toBe('/note.html');
    expect(url.searchParams.get('message')).toBe("This page can't be saved. Try Select area instead.");
    expect(url.searchParams.get('kind')).toBe('error');
  });
});
