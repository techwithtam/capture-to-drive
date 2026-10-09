// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueChangedMessage } from '../lib/messages';
import type { Settings } from '../lib/settings';
import {
  ALL_QUEUED_MESSAGE,
  ANNOUNCEMENT_PREFIX_LIFETIME_MS,
  START_FAILED_MESSAGE,
} from '../lib/upload-batch';
import { byId, mountPage, settle, unmountPage } from './helpers/dom';
import { deferred, SETTINGS, trackPageListeners } from './helpers/dom-pages';
import { until } from './helpers/queue-harness';

let removePageListeners: () => void;
let queue: typeof import('../lib/queue');
let sendMessage: ReturnType<typeof stubQueueReplies>;

function stubQueueReplies() {
  return vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({ ok: true }));
}

function transferFiles(files: readonly File[]): DataTransfer {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  // Browsers report Files even while the file payload is unavailable during dragenter or dragover.
  Object.defineProperty(transfer, 'types', { value: ['Files'] });
  return transfer;
}

function drag(target: HTMLElement, type: string, transfer = transferFiles([])): Event & { readonly dataTransfer: DataTransfer } {
  // happy-dom has DataTransfer but no DragEvent constructor.
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { readonly dataTransfer: DataTransfer };
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  target.dispatchEvent(event);
  return event;
}

function chooseFiles(files: readonly File[]): void {
  const input = byId<HTMLInputElement>('file-input');
  input.files = transferFiles(files).files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function fileRows(): HTMLLIElement[] {
  return Array.from(byId('file-list').querySelectorAll('li'));
}

function rowNamed(name: string): HTMLLIElement {
  const row = fileRows().find((element) => element.querySelector('.file-name')?.textContent === name);
  if (row === undefined) throw new Error(`No upload row for ${name}`);
  return row;
}

function statusOf(name: string): HTMLElement {
  const status = rowNamed(name).querySelector<HTMLElement>('.file-status');
  if (status === null) throw new Error(`No status for ${name}`);
  return status;
}

function visibleStatus(name: string): string {
  const status = statusOf(name).cloneNode(true) as HTMLElement;
  status.querySelectorAll('.visually-hidden').forEach((prefix) => prefix.remove());
  return status.textContent ?? '';
}

async function broadcast(name: string, state: QueueChangedMessage['state'], message?: string): Promise<void> {
  const item = (await queue.listItems()).find((record) => record.filename.endsWith(` - ${name}`));
  if (item === undefined) throw new Error(`No queued file for ${name}`);
  const change: QueueChangedMessage = { type: 'queue:changed', captureId: item.captureId, state, message };
  await fakeBrowser.runtime.onMessage.trigger(change, {}, () => undefined);
}

/**
 * Holds back storing the files named in `held`: a held file is written to the queue only once `release` is called with
 * its name, and its row keeps saying Adding… until then. Other files are stored at once.
 */
function holdStores(held: readonly string[]): (name: string) => void {
  const gates = new Map(held.map((name) => [name, deferred<void>()]));
  const addItem = queue.addItem;
  vi.spyOn(queue, 'addItem').mockImplementation(async (item) => {
    const gate = [...gates].find(([name]) => item.filename.endsWith(` - ${name}`))?.[1];
    if (gate !== undefined) await gate.promise;
    await addItem(item);
  });
  return (name) => {
    const gate = gates.get(name);
    if (gate === undefined) throw new Error(`${name} is not held`);
    gate.resolve();
  };
}

/**
 * Records what the file list's live region would read out: the text of each row status that changes while no
 * `aria-live="off"` sits between it and the live list. A new row is an addition to the list, not a change to a status,
 * so it is not recorded.
 */
function watchAnnouncements(): { spoken: string[]; stop: () => void } {
  const spoken: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') continue;
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const status = target?.closest<HTMLElement>('.file-status');
      if (status === null || status === undefined) continue;
      if (status.closest('[aria-live]')?.getAttribute('aria-live') === 'off') continue;
      const text = status.textContent ?? '';
      if (spoken.at(-1) !== text) spoken.push(text);
    }
  });
  observer.observe(byId('file-list'), { childList: true, subtree: true, characterData: true });
  return { spoken, stop: () => observer.disconnect() };
}

function pageMessageText(): string {
  return byId('page-message').textContent ?? '';
}

async function loadPage(settings: Settings | null = SETTINGS): Promise<void> {
  if (settings !== null) await fakeBrowser.storage.local.set({ settings });
  await import('../entrypoints/upload/main');
  await settle();
}

async function batchStored(items = 1): Promise<void> {
  await until(async () => (await queue.listItems()).length === items, 'the batch files to be stored');
  await settle();
}

beforeEach(async () => {
  fakeBrowser.reset();
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  queue = await import('../lib/queue');
  sendMessage = stubQueueReplies();
  mountPage('upload');
  removePageListeners = trackPageListeners();
});

afterEach(async () => {
  removePageListeners();
  await (await import('../lib/db')).closeDatabase();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  unmountPage();
});

describe('Upload files page', () => {
  it('asks for Settings before showing the upload controls', async () => {
    const openSettings = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockResolvedValue(undefined);
    await loadPage(null);

    expect(byId('loading').hidden).toBe(true);
    expect(byId('settings-required').hidden).toBe(false);
    expect(byId('settings-required').textContent).toContain('Set up your mailbox in Settings to upload files.');
    expect(byId('upload-controls').hidden).toBe(true);
    expect(byId('file-results').hidden).toBe(true);
    byId('open-settings').click();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('reveals the controls when Settings are saved and storage reports the change', async () => {
    await loadPage(null);
    expect(byId('upload-controls').hidden).toBe(true);
    expect(byId('settings-required').hidden).toBe(false);

    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await settle();
    expect(byId('upload-controls').hidden).toBe(false);
    expect(byId('settings-required').hidden).toBe(true);
    expect(byId('loading').hidden).toBe(true);
  });

  it('reveals the controls on window focus after Settings are saved', async () => {
    // Suppress storage notifications so only the focus listener can reveal the controls.
    vi.spyOn(fakeBrowser.storage.onChanged, 'addListener').mockImplementation(() => undefined);
    await loadPage(null);
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await settle();
    expect(byId('upload-controls').hidden).toBe(true);
    expect(byId('settings-required').hidden).toBe(false);

    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(byId('upload-controls').hidden).toBe(false);
    expect(byId('settings-required').hidden).toBe(true);
    expect(byId('loading').hidden).toBe(true);
  });

  it('announces a settings load failure and hides the loading indicator', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('Storage unavailable'));
    await loadPage(null);
    expect(byId('page-message').textContent).toBe("Couldn't load your saved settings. Reload this page.");
    expect(byId('page-message').getAttribute('aria-live')).toBe('polite');
    expect(byId('upload-controls').hidden).toBe(true);
    expect(byId('loading').hidden).toBe(true);
  });

  it('announces an Open Settings failure with the popup fallback', async () => {
    vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockRejectedValue(new Error('Options unavailable'));
    await loadPage(null);
    byId('open-settings').click();
    await settle();
    expect(byId('page-message').textContent).toBe("Couldn't open Settings. Open them from the extension popup.");
    expect(byId('page-message').getAttribute('aria-live')).toBe('polite');
  });

  it('offers a labelled, focusable Choose files picker for multiple files', async () => {
    await loadPage();
    const input = byId<HTMLInputElement>('file-input');
    expect(byId('upload-controls').hidden).toBe(false);
    expect(byId('settings-required').hidden).toBe(true);
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.labels?.[0]?.textContent?.trim()).toBe('Choose files');
    input.focus();
    expect(document.activeElement).toBe(input);

    chooseFiles([new File(['hello'], 'invoice.txt', { type: 'text/plain' })]);
    expect(visibleStatus('invoice.txt')).toBe('Adding\u2026');
    expect(rowNamed('invoice.txt').querySelector('.file-size')?.textContent).toBe('5 bytes');
    expect(byId('file-results').hidden).toBe(false);
    expect(input.value).toBe('');
    expect(input.files).toHaveLength(0);
    await batchStored();
    expect(await queue.listItems()).toHaveLength(1);
    expect(visibleStatus('invoice.txt')).toBe('Waiting');
  });

  it('stores dropped files with one note for the whole batch', async () => {
    await loadPage();
    const note = byId<HTMLTextAreaElement>('note');
    note.value = 'Receipts for October';
    expect(note.labels?.[0]?.textContent).toBe('Note (optional)');
    expect(note.getAttribute('aria-describedby')).toBe('note-hint');
    expect(byId('note-hint').textContent).toBe('Applies to every file you choose or drop next.');

    const drop = drag(byId('drop-zone'), 'drop', transferFiles([
      new File(['one'], 'first.txt', { type: 'text/plain' }),
      new File(['two'], 'second.txt', { type: 'text/plain' }),
    ]));
    expect(drop.defaultPrevented).toBe(true);
    expect(fileRows().map((row) => row.querySelector('.file-name')?.textContent)).toEqual(['first.txt', 'second.txt']);
    expect(fileRows().map((row) => row.querySelector('.file-status')?.textContent)).toEqual(['Adding\u2026', 'Adding\u2026']);
    note.value = 'A note for the next batch';
    await batchStored(2);
    expect(visibleStatus('first.txt')).toBe('Waiting');
    expect(visibleStatus('second.txt')).toBe('Waiting');

    const records = await queue.listItems();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.description).toContain('Note: Receipts for October\n');
      expect(record.description).toContain('Captured by: Alex\n');
      expect(record.description).not.toContain('A note for the next batch');
      expect(record.mimeType).toBe('text/plain');
    }
    expect(await (await import('../lib/pending-store')).listPending()).toEqual([]);
  });

  it('keeps the drop highlight during nested drags and clears it after a drop', async () => {
    await loadPage();
    const zone = byId('drop-zone');
    drag(zone, 'dragenter');
    drag(byId('upload-icon'), 'dragenter');
    drag(byId('upload-icon'), 'dragleave');
    expect(zone.classList.contains('drag-over')).toBe(true);
    drag(zone, 'dragleave');
    expect(zone.classList.contains('drag-over')).toBe(false);

    drag(zone, 'dragenter');
    const transfer = transferFiles([new File(['x'], 'dropped.txt')]);
    expect(drag(zone, 'dragover', transfer).defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    drag(zone, 'drop', transfer);
    expect(zone.classList.contains('drag-over')).toBe(false);
    await batchStored();
  });

  it('cancels file drags and drops outside the zone and resets the drag depth', async () => {
    await loadPage();
    const zone = byId('drop-zone');
    const transfer = transferFiles([new File(['x'], 'outside.txt')]);
    expect(transfer.types).toEqual(['Files']);
    drag(zone, 'dragenter');
    drag(byId('upload-icon'), 'dragenter');
    expect(zone.classList.contains('drag-over')).toBe(true);
    expect(drag(document.body, 'dragover', transfer).defaultPrevented).toBe(true);
    const drop = drag(document.body, 'drop', transfer);
    expect(drop.defaultPrevented).toBe(true);
    expect(zone.classList.contains('drag-over')).toBe(false);

    drag(zone, 'dragenter');
    drag(zone, 'dragleave');
    expect(zone.classList.contains('drag-over')).toBe(false);
    expect(fileRows()).toHaveLength(0);
    expect(await queue.listItems()).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('kicks after the first stored file and again after the batch without waiting for the first reply', async () => {
    await loadPage();
    const secondStore = deferred<void>();
    const firstReply = deferred<{ ok: boolean }>();
    const addItem = queue.addItem;
    let stores = 0;
    vi.spyOn(queue, 'addItem').mockImplementation(async (item) => {
      stores += 1;
      if (stores === 2) await secondStore.promise;
      await addItem(item);
    });
    sendMessage.mockImplementationOnce(() => firstReply.promise);
    chooseFiles([new File(['a'], 'first.txt'), new File(['b'], 'second.txt')]);
    try {
      await until(() => sendMessage.mock.calls.length === 1, 'the first stored file kick');
      expect(await queue.listItems()).toHaveLength(1);
      expect(sendMessage).toHaveBeenNthCalledWith(1, { type: 'queue:kick' });
      secondStore.resolve(undefined);
      await until(() => sendMessage.mock.calls.length === 2, 'the final batch kick');
      expect(await queue.listItems()).toHaveLength(2);
      expect(sendMessage).toHaveBeenNthCalledWith(2, { type: 'queue:kick' });
    } finally {
      secondStore.resolve(undefined);
      firstReply.resolve({ ok: true });
      await settle();
    }
  });

  it('updates each row from queue broadcasts through Waiting, Uploading, Saved and Failed', async () => {
    await loadPage();
    chooseFiles([new File(['a'], 'first.txt'), new File(['b'], 'second.txt')]);
    await batchStored(2);
    expect(statusOf('first.txt').classList.contains('status-waiting')).toBe(true);
    await broadcast('first.txt', 'uploading');
    expect(visibleStatus('first.txt')).toBe('Uploading');
    expect(statusOf('first.txt').classList.contains('status-uploading')).toBe(true);
    expect(statusOf('first.txt').classList.contains('status-waiting')).toBe(false);
    expect(visibleStatus('second.txt')).toBe('Waiting');
    await broadcast('first.txt', 'waiting');
    expect(visibleStatus('first.txt')).toBe('Waiting');
    expect(statusOf('first.txt').classList.contains('status-waiting')).toBe(true);
    await broadcast('first.txt', 'saved');
    await broadcast('second.txt', 'needs_attention', 'Mailbox key was rejected. Check Settings.');
    expect(visibleStatus('first.txt')).toBe('Saved ✓');
    expect(statusOf('first.txt').classList.contains('status-saved')).toBe(true);
    expect(visibleStatus('second.txt')).toBe('Failed: Mailbox key was rejected. Check Settings.');
    expect(statusOf('second.txt').classList.contains('status-attention')).toBe(true);
    expect(statusOf('second.txt').classList.contains('status-saved')).toBe(false);
  });

  it('announces row changes with the file name without rereading the whole list', async () => {
    await loadPage();
    chooseFiles([new File(['x'], 'invoice.txt')]);
    await batchStored();
    const list = byId('file-list');
    expect(list.getAttribute('aria-live')).toBe('polite');
    expect(list.getAttribute('aria-relevant')).toBe('additions text removals');
    // Omitted aria-atomic means false, so changes are announced without repeating all the rows.
    expect(list.getAttribute('aria-atomic')).toBeNull();
    // Adding… became Waiting when the file was stored. That change is not read out, so it carries no file name.
    expect(statusOf('invoice.txt').textContent).toBe('Waiting');
    expect(statusOf('invoice.txt').querySelector('.visually-hidden')).toBeNull();
    expect(statusOf('invoice.txt').querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await broadcast('invoice.txt', 'uploading');
    expect(statusOf('invoice.txt').textContent).toBe('invoice.txt: Uploading');
    await vi.advanceTimersByTimeAsync(Math.floor(ANNOUNCEMENT_PREFIX_LIFETIME_MS / 2));
    await broadcast('invoice.txt', 'saved');
    expect(statusOf('invoice.txt').textContent).toBe('invoice.txt: Saved ✓');
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_PREFIX_LIFETIME_MS - 1);
    expect(statusOf('invoice.txt').textContent).toBe('invoice.txt: Saved ✓');
    await vi.advanceTimersByTimeAsync(1);
    expect(statusOf('invoice.txt').textContent).toBe('Saved ✓');
  });

  it('uses a readable failure when the background supplies no reason', async () => {
    await loadPage();
    chooseFiles([new File(['x'], 'invoice.txt')]);
    await batchStored();
    await broadcast('invoice.txt', 'needs_attention');
    expect(visibleStatus('invoice.txt')).toBe('Failed: Upload needs attention.');
  });

  it('ignores unrelated messages and removes discarded rows', async () => {
    await loadPage();
    chooseFiles([new File(['x'], 'invoice.txt')]);
    await batchStored();
    await fakeBrowser.runtime.onMessage.trigger({ type: 'other:changed' }, {}, () => undefined);
    await fakeBrowser.runtime.onMessage.trigger({ type: 'queue:changed', captureId: crypto.randomUUID(), state: 'saved' }, {}, () => undefined);
    expect(visibleStatus('invoice.txt')).toBe('Waiting');
    await broadcast('invoice.txt', 'discarded');
    expect(fileRows()).toHaveLength(0);
    expect(byId('file-results').hidden).toBe(true);
  });

  it('refuses empty and oversized files immediately and stores the valid file in the same batch', async () => {
    await loadPage();
    const oversized = new File(['x'], 'large.zip');
    // A reported size avoids allocating a 20 MB payload for a file the page never stores.
    Object.defineProperty(oversized, 'size', { value: 20 * 1024 * 1024 + 1 });
    chooseFiles([new File([], 'empty.txt'), oversized, new File(['ok'], 'valid.txt')]);
    expect(visibleStatus('empty.txt')).toBe('Failed: This file is empty.');
    expect(visibleStatus('large.zip')).toBe('Failed: Too big for the mailbox (max 20 MB). Drag it into Drive directly.');
    expect(visibleStatus('valid.txt')).toBe('Adding\u2026');
    expect(rowNamed('large.zip').querySelector('.file-size')?.textContent).toBe('20 MB');
    await batchStored();
    expect(visibleStatus('valid.txt')).toBe('Waiting');
    const records = await queue.listItems();
    expect(records).toHaveLength(1);
    expect(records[0]?.filename).toMatch(/ - valid\.txt$/);
  });

  it('does not kick the queue when every file is refused', async () => {
    await loadPage();
    chooseFiles([new File([], 'empty.txt')]);
    await settle();
    expect(visibleStatus('empty.txt')).toBe('Failed: This file is empty.');
    expect(await queue.listItems()).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('shows a per-file storage failure while continuing the batch', async () => {
    await loadPage();
    vi.spyOn(queue, 'addItem').mockRejectedValueOnce(new Error('Disk unavailable'));
    chooseFiles([new File(['x'], 'failed.txt'), new File(['y'], 'kept.txt')]);
    await batchStored();
    expect(visibleStatus('failed.txt')).toBe("Failed: Couldn't queue this file. Choose it again.");
    expect(statusOf('failed.txt').textContent).toBe("failed.txt: Failed: Couldn't queue this file. Choose it again.");
    expect(visibleStatus('kept.txt')).toBe('Waiting');
    expect(await queue.listItems()).toHaveLength(1);
    // Not every file is queued, even though the last one was stored, so the page does not say so.
    expect(pageMessageText()).toBe('');
  });

  it('shows Adding… until a file is stored, then Waiting', async () => {
    await loadPage();
    const release = holdStores(['invoice.txt']);
    chooseFiles([new File(['x'], 'invoice.txt')]);
    await settle();
    // Not stored yet: nothing is in the queue, and the row is new, so it is announced whole without a spoken file name.
    expect(await queue.listItems()).toEqual([]);
    expect(visibleStatus('invoice.txt')).toBe('Adding\u2026');
    expect(statusOf('invoice.txt').textContent).toBe('Adding\u2026');
    expect(statusOf('invoice.txt').classList.contains('status-uploading')).toBe(true);
    expect(statusOf('invoice.txt').classList.contains('status-waiting')).toBe(false);
    expect(statusOf('invoice.txt').querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');

    release('invoice.txt');
    await batchStored();
    expect(await queue.listItems()).toHaveLength(1);
    expect(visibleStatus('invoice.txt')).toBe('Waiting');
    expect(statusOf('invoice.txt').textContent).toBe('Waiting');
    expect(statusOf('invoice.txt').classList.contains('status-waiting')).toBe(true);
    expect(statusOf('invoice.txt').classList.contains('status-uploading')).toBe(false);
  });

  // A big batch would otherwise read out one "name: Waiting" per file. The row's arrival and the "Every file is queued"
  // line already say what matters.
  it('does not read out Adding… turning into Waiting, but still reads out Uploading, Saved ✓ and Failed with the file name', async () => {
    await loadPage();
    const announcements = watchAnnouncements();
    try {
      chooseFiles([new File(['a'], 'first.txt'), new File(['b'], 'second.txt'), new File(['c'], 'third.txt')]);
      await batchStored(3);
      expect(['first.txt', 'second.txt', 'third.txt'].map(visibleStatus)).toEqual(['Waiting', 'Waiting', 'Waiting']);
      expect(announcements.spoken).toEqual([]);
      // Quiet: the status is switched off for the live region, and no spoken file name is added.
      expect(statusOf('first.txt').getAttribute('aria-live')).toBe('off');
      expect(statusOf('first.txt').querySelector('.visually-hidden')).toBeNull();
      expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);

      await broadcast('first.txt', 'uploading');
      await settle();
      expect(announcements.spoken).toEqual(['first.txt: Uploading']);
      expect(statusOf('first.txt').hasAttribute('aria-live')).toBe(false);
      await broadcast('first.txt', 'saved');
      await broadcast('second.txt', 'needs_attention', 'Mailbox key was rejected. Check Settings.');
      await settle();
      expect(announcements.spoken).toEqual([
        'first.txt: Uploading',
        'first.txt: Saved \u2713',
        'second.txt: Failed: Mailbox key was rejected. Check Settings.',
      ]);
      expect(statusOf('third.txt').getAttribute('aria-live')).toBe('off');
    } finally {
      announcements.stop();
    }
  });

  it('reads out a store failure with the file name, as before', async () => {
    await loadPage();
    vi.spyOn(queue, 'addItem').mockRejectedValueOnce(new Error('Disk unavailable'));
    const announcements = watchAnnouncements();
    try {
      chooseFiles([new File(['x'], 'failed.txt')]);
      await settle();
      expect(announcements.spoken).toEqual(["failed.txt: Failed: Couldn't queue this file. Choose it again."]);
      expect(statusOf('failed.txt').hasAttribute('aria-live')).toBe(false);
    } finally {
      announcements.stop();
    }
  });

  it('keeps a newer state when the background reports on a file before its store call returns', async () => {
    await loadPage();
    const stored = deferred<void>();
    const addItem = queue.addItem;
    vi.spyOn(queue, 'addItem').mockImplementation(async (item) => {
      await addItem(item);
      await stored.promise;
    });
    chooseFiles([new File(['x'], 'invoice.txt')]);
    await until(async () => (await queue.listItems()).length === 1, 'the file to be written');
    expect(visibleStatus('invoice.txt')).toBe('Adding\u2026');
    await broadcast('invoice.txt', 'uploading');
    expect(visibleStatus('invoice.txt')).toBe('Uploading');

    stored.resolve();
    await settle();
    expect(visibleStatus('invoice.txt')).toBe('Uploading');
    expect(statusOf('invoice.txt').classList.contains('status-uploading')).toBe(true);
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
  });

  it('says every file is queued once the last file is stored, without waiting for the final queue kick', async () => {
    await loadPage();
    const release = holdStores(['second.txt']);
    const finalKick = deferred<{ ok: boolean }>();
    sendMessage.mockImplementation(() => finalKick.promise);
    chooseFiles([new File(['a'], 'first.txt'), new File(['b'], 'second.txt')]);
    try {
      await until(async () => (await queue.listItems()).length === 1, 'the first file to be stored');
      await settle();
      expect(visibleStatus('first.txt')).toBe('Waiting');
      expect(visibleStatus('second.txt')).toBe('Adding\u2026');
      expect(pageMessageText()).toBe('');

      release('second.txt');
      await batchStored(2);
      expect(visibleStatus('second.txt')).toBe('Waiting');
      expect(pageMessageText()).toBe('Every file is queued. You can close this tab.');
      // The kick that follows the last file has not been answered yet, and the line did not wait for it.
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      finalKick.resolve({ ok: true });
      await settle();
    }
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
  });

  it('puts the line in the one page message live region, in a plain tone, so it is read out once', async () => {
    await loadPage();
    const message = byId('page-message');
    expect(message.getAttribute('aria-live')).toBe('polite');
    expect(message.closest('[aria-live]')).toBe(message);
    expect(message.classList.contains('page-message-ok')).toBe(false);

    chooseFiles([new File(['x'], 'invoice.txt')]);
    await batchStored();
    expect(message.textContent).toBe(ALL_QUEUED_MESSAGE);
    expect(message.classList.contains('page-message-ok')).toBe(true);
    expect(byId('file-list').textContent).not.toContain('Every file is queued');
    expect(message.getAttribute('aria-live')).toBe('polite');
    expect(message.closest('[aria-live]')).toBe(message);

    // Any other page message goes back to the error tone.
    vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockRejectedValue(new Error('Options unavailable'));
    byId('open-settings').click();
    await settle();
    expect(message.textContent).toBe("Couldn't open Settings. Open them from the extension popup.");
    expect(message.classList.contains('page-message-ok')).toBe(false);
  });

  it('counts a file refused on the spot as done, so the line follows the last stored file', async () => {
    await loadPage();
    const release = holdStores(['valid.txt']);
    chooseFiles([new File([], 'empty.txt'), new File(['ok'], 'valid.txt')]);
    await settle();
    expect(visibleStatus('empty.txt')).toBe('Failed: This file is empty.');
    expect(visibleStatus('valid.txt')).toBe('Adding\u2026');
    expect(pageMessageText()).toBe('');

    release('valid.txt');
    await batchStored();
    expect(visibleStatus('empty.txt')).toBe('Failed: This file is empty.');
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
  });

  it('says nothing about the queue when every file is refused', async () => {
    await loadPage();
    const oversized = new File(['x'], 'large.zip');
    Object.defineProperty(oversized, 'size', { value: 20 * 1024 * 1024 + 1 });
    chooseFiles([new File([], 'empty.txt'), oversized]);
    await settle();
    expect(visibleStatus('empty.txt')).toBe('Failed: This file is empty.');
    expect(visibleStatus('large.zip')).toContain('Failed: Too big for the mailbox');
    expect(pageMessageText()).toBe('');
    expect(byId('page-message').classList.contains('page-message-ok')).toBe(false);
  });

  it('clears the line as soon as the next batch starts, and says it again once that batch is stored', async () => {
    await loadPage();
    chooseFiles([new File(['x'], 'first.txt')]);
    await batchStored();
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);

    const release = holdStores(['second.txt']);
    chooseFiles([new File(['y'], 'second.txt')]);
    expect(pageMessageText()).toBe('');
    expect(byId('page-message').classList.contains('page-message-ok')).toBe(false);
    await settle();
    expect(visibleStatus('second.txt')).toBe('Adding\u2026');
    expect(pageMessageText()).toBe('');

    release('second.txt');
    await batchStored(2);
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
  });

  it('forgets a file that could not be stored once the next batch starts, and says every file is queued for that batch', async () => {
    await loadPage();
    vi.spyOn(queue, 'addItem').mockRejectedValueOnce(new Error('Disk unavailable'));
    chooseFiles([new File(['x'], 'failed.txt')]);
    await settle();
    expect(visibleStatus('failed.txt')).toBe("Failed: Couldn't queue this file. Choose it again.");
    expect(pageMessageText()).toBe('');

    chooseFiles([new File(['y'], 'kept.txt')]);
    await batchStored();
    expect(visibleStatus('kept.txt')).toBe('Waiting');
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
  });

  it('keeps quiet after a batch of refused files that follows a stored one', async () => {
    await loadPage();
    chooseFiles([new File(['x'], 'first.txt')]);
    await batchStored();
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);

    chooseFiles([new File([], 'empty.txt')]);
    await settle();
    expect(pageMessageText()).toBe('');
  });

  it('waits for every file on the page when a second batch is dropped before the first is stored', async () => {
    await loadPage();
    const release = holdStores(['first.txt']);
    chooseFiles([new File(['a'], 'first.txt')]);
    await settle();
    chooseFiles([new File(['b'], 'second.txt')]);
    await batchStored(1);
    expect(visibleStatus('second.txt')).toBe('Waiting');
    expect(visibleStatus('first.txt')).toBe('Adding\u2026');
    expect(pageMessageText()).toBe('');

    release('first.txt');
    await batchStored(2);
    expect(visibleStatus('first.txt')).toBe('Waiting');
    expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
  });

  describe('when the final queue kick fails', () => {
    const GUIDANCE = "Couldn't start the upload. Use Retry now in the extension popup.";

    it.each(['refused', 'rejected'] as const)('keeps the line and adds the retry guidance after a %s kick', async (failure) => {
      await loadPage();
      if (failure === 'refused') sendMessage.mockImplementation(async () => ({ ok: false }));
      else sendMessage.mockRejectedValue(new Error('Worker unavailable'));
      chooseFiles([new File(['x'], 'invoice.txt')]);
      await batchStored();
      expect(visibleStatus('invoice.txt')).toBe('Waiting');
      expect(await queue.listItems()).toHaveLength(1);
      expect(pageMessageText()).toBe(`Every file is queued. You can close this tab. ${GUIDANCE}`);
      expect(byId('page-message').getAttribute('aria-live')).toBe('polite');
    });

    it('adds the guidance to the line already read out, so the line is not read twice, and shows the problem as one', async () => {
      await loadPage();
      const finalKick = deferred<{ ok: boolean }>();
      sendMessage.mockImplementation(() => finalKick.promise);
      chooseFiles([new File(['x'], 'invoice.txt')]);
      await batchStored();
      const message = byId('page-message');
      const line = message.firstChild;
      expect(message.textContent).toBe(ALL_QUEUED_MESSAGE);
      expect(message.classList.contains('page-message-ok')).toBe(true);

      finalKick.resolve({ ok: false });
      await settle();
      expect(message.textContent).toBe(`${ALL_QUEUED_MESSAGE} ${START_FAILED_MESSAGE}`);
      // The line's own text was kept, and only the guidance was added after it, in the error tone.
      expect(message.firstChild).toBe(line);
      expect(line?.isConnected).toBe(true);
      const problem = message.querySelector('.field-error');
      expect(problem?.textContent).toBe(` ${GUIDANCE}`);
      expect(message.classList.contains('page-message-ok')).toBe(true);
    });

    it('shows the retry guidance on its own when a file was not stored, since not every file is queued', async () => {
      await loadPage();
      sendMessage.mockImplementation(async () => ({ ok: false }));
      vi.spyOn(queue, 'addItem').mockRejectedValueOnce(new Error('Disk unavailable'));
      chooseFiles([new File(['x'], 'failed.txt'), new File(['y'], 'kept.txt')]);
      await batchStored();
      expect(visibleStatus('failed.txt')).toBe("Failed: Couldn't queue this file. Choose it again.");
      expect(visibleStatus('kept.txt')).toBe('Waiting');
      expect(pageMessageText()).toBe("Files are queued. Couldn't start the upload. Use Retry now in the extension popup.");
      expect(byId('page-message').classList.contains('page-message-ok')).toBe(false);
    });

    it('clears the combined message as soon as the next batch starts', async () => {
      await loadPage();
      sendMessage.mockImplementationOnce(async () => ({ ok: false }));
      chooseFiles([new File(['x'], 'first.txt')]);
      await batchStored();
      expect(pageMessageText()).toBe(`${ALL_QUEUED_MESSAGE} ${START_FAILED_MESSAGE}`);

      chooseFiles([new File(['y'], 'second.txt')]);
      expect(pageMessageText()).toBe('');
      expect(byId('page-message').classList.contains('page-message-ok')).toBe(false);
      await batchStored(2);
      expect(pageMessageText()).toBe(ALL_QUEUED_MESSAGE);
    });
  });

  it('cancels a link dropped outside the drop zone, so the tab does not navigate away', async () => {
    await loadPage();
    const transfer = new DataTransfer();
    transfer.setData('text/uri-list', 'https://example.com/');
    Object.defineProperty(transfer, 'types', { value: ['text/uri-list'] });
    const event = drag(document.body, 'drop', transfer);
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels files dropped onto the Note field, so the browser does not open them', async () => {
    await loadPage();
    const event = drag(byId('note'), 'drop', transferFiles([new File(['x'], 'invoice.pdf')]));
    expect(event.defaultPrevented).toBe(true);
  });

  // The document's drop handler cancels only file drops, so native text insertion into Note still works.
  it('allows text dropped into Note', async () => {
    await loadPage();
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'Receipt details');
    Object.defineProperty(transfer, 'types', { value: ['text/plain'] });
    const event = drag(byId('note'), 'drop', transfer);
    expect(event.dataTransfer.types).toEqual(['text/plain']);
    expect(event.cancelable).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });
});
