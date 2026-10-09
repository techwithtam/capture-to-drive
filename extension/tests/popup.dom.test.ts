// @vitest-environment happy-dom
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { QueueChangedMessage } from '../lib/messages';
import type { QueueItem, QueueStatus } from '../lib/queue';
import { byId, mountPage, settle, unmountPage } from './helpers/dom';

const SETTINGS = {
  mailboxUrl: 'https://script.google.com/macros/s/TEST/exec',
  key: 'test-key',
  name: 'Test User',
};
const TAB_ID = 42;
const NOT_PDF_HINT = 'Open a PDF in this tab to use this.';
const LOCAL_FILE_HINT = 'Local file? Use Upload files.';

// beforeEach resets these shared fixtures; tests can change the next background answer without replacing the stub.
let database: typeof import('../lib/db');
let pdfAnswer: unknown;
let requestAnswer: unknown;

function stubMessages() {
  return vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      throw new Error('Expected a popup message');
    }
    switch (message.type) {
      case 'tab:pdf-status':
        return pdfAnswer;
      case 'capture:area':
      case 'capture:page':
      case 'capture:pdf':
      case 'queue:retry':
      case 'queue:discard':
        return requestAnswer;
      default:
        throw new Error(`Unexpected popup message: ${String(message.type)}`);
    }
  });
}

let sendMessage: ReturnType<typeof stubMessages>;
let closePopup: MockInstance<Window['close']>;
let openOptions: MockInstance<typeof fakeBrowser.runtime.openOptionsPage>;
let documentListeners: MockInstance<Document['addEventListener']>;

beforeEach(async () => {
  fakeBrowser.reset();
  mountPage('popup');
  vi.resetModules();
  database = await import('../lib/db');
  await replaceQueue([]);
  await fakeBrowser.storage.local.set({ settings: SETTINGS });
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => [{ id: TAB_ID }]);
  vi.spyOn(fakeBrowser.commands, 'getAll').mockImplementation(async () => []);
  pdfAnswer = { status: 'not-pdf' };
  requestAnswer = { ok: true };
  sendMessage = stubMessages();
  closePopup = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  openOptions = vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockResolvedValue(undefined);
  documentListeners = vi.spyOn(document, 'addEventListener');
});

afterEach(async () => {
  // resetModules does not remove the document listener installed by the previous popup.
  for (const [type, listener, options] of documentListeners.mock.calls) {
    if (type === 'keydown') document.removeEventListener(type, listener, options);
  }
  await database.closeDatabase();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  unmountPage();
});

function queueItem(captureId: string, status: QueueStatus, extra: Partial<QueueItem> = {}): QueueItem {
  return {
    captureId,
    createdAt: 1,
    filename: `${captureId}.png`,
    mimeType: 'image/png',
    description: '',
    blob: new Blob(['capture']),
    attempts: 1,
    nextAttemptAt: 0,
    status,
    ...extra,
  };
}

async function replaceQueue(items: QueueItem[]): Promise<void> {
  await database.transact(database.QUEUE_STORE, 'readwrite', (store) => {
    store.clear();
    items.forEach((item) => store.put(item));
    return () => undefined;
  });
}

async function flush(): Promise<void> {
  if (!vi.isFakeTimers()) return settle();
  for (let round = 0; round < 10; round += 1) await vi.advanceTimersByTimeAsync(0);
}

function useFakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

async function clickAndSettle(element: HTMLElement): Promise<void> {
  element.click();
  await flush();
}

async function loadPopup(): Promise<void> {
  await import('../entrypoints/popup/main');
  await flush();
}

async function broadcast(captureId: string, state: QueueChangedMessage['state']): Promise<void> {
  const message: QueueChangedMessage = { type: 'queue:changed', captureId, state };
  await fakeBrowser.runtime.onMessage.trigger(message, {}, () => undefined);
  await flush();
}

function button(id: string): HTMLButtonElement {
  return byId<HTMLButtonElement>(id);
}

function pdfRow(): HTMLButtonElement {
  return button('command-pdf');
}

function menuRows(): HTMLButtonElement[] {
  return Array.from(byId('commands').querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

function press(key: string, target: HTMLElement = document.body, extra: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(event);
  return event;
}

function expectSelection(index: number): void {
  const rows = menuRows();
  expect(document.activeElement).toBe(rows[index]);
  expect(rows.map((row) => row.tabIndex)).toEqual(rows.map((_, i) => i === index ? 0 : -1));
}

// Hidden on a parent also removes a button from the visible controls.
function shown(element: HTMLElement): boolean {
  return element.closest('[hidden]') === null;
}

function visibleButtons(root: HTMLElement = document.body): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter(shown);
}

function attentionRow(captureId: string): HTMLLIElement {
  const row = byId('attention-list').querySelector<HTMLLIElement>(`li[data-capture-id="${captureId}"]`);
  if (row === null) throw new Error(`No upload row for ${captureId}`);
  return row;
}

function itemButton(captureId: string, label: 'Retry' | 'Discard'): HTMLButtonElement {
  const result = Array.from(attentionRow(captureId).querySelectorAll('button'))
    .find((element) => element.textContent === label);
  if (result === undefined) throw new Error(`No ${label} button for ${captureId}`);
  return result;
}

async function openProblems(items: QueueItem[]): Promise<void> {
  await replaceQueue(items);
  await loadPopup();
  await clickAndSettle(button('status-view'));
}

describe('popup setup gate', () => {
  it.each([
    ['missing settings', {}],
    ['an invalid stored shape', { settings: { mailboxUrl: SETTINGS.mailboxUrl } }],
    ['an invalid mailbox URL', { settings: { ...SETTINGS, mailboxUrl: 'https://example.com' } }],
    ['an empty key', { settings: { ...SETTINGS, key: ' ' } }],
    ['an unusable name', { settings: { ...SETTINGS, name: '///' } }],
  ])('blocks hidden captures and shows only Finish setup for %s', async (_label, stored) => {
    await fakeBrowser.storage.local.clear();
    await fakeBrowser.storage.local.set(stored);
    await loadPopup();

    expect(byId('setup').hidden).toBe(false);
    expect(byId('setup-text').textContent).toBe('Set up your mailbox to start saving to Drive.');
    expect(byId('menu').hidden).toBe(true);
    expect(visibleButtons().map((element) => element.textContent)).toEqual(['Finish setup']);
    sendMessage.mockClear();
    await clickAndSettle(button('command-area'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(closePopup).not.toHaveBeenCalled();
    await clickAndSettle(button('finish-setup'));

    expect(openOptions).toHaveBeenCalledOnce();
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it('shows the four menu rows with valid settings from storage', async () => {
    await loadPopup();

    expect(byId('setup').hidden).toBe(true);
    expect(byId('menu').hidden).toBe(false);
    expect(byId('menu').classList.contains('is-pending')).toBe(false);
    expect(byId('commands').getAttribute('role')).toBe('menu');
    expect(byId('commands').getAttribute('aria-label')).toBe('Capture');
    expect(menuRows().map((row) => row.textContent)).toEqual([
      'Select area', 'Whole page', `Save this PDF${NOT_PDF_HINT}`, 'Upload files…',
    ]);
    expect(menuRows().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('opens options when Enter is pressed on the setup gate', async () => {
    await fakeBrowser.storage.local.clear();
    await loadPopup();

    expect(press('Enter').defaultPrevented).toBe(true);
    await flush();
    expect(openOptions).toHaveBeenCalledOnce();
    expect(closePopup).toHaveBeenCalledOnce();
  });
});

describe('popup menu keyboard and shortcut hints', () => {
  it('moves with Up and Down, wraps at both ends, and reaches the disabled PDF row', async () => {
    await loadPopup();
    button('command-area').focus();

    expect(press('ArrowUp', button('command-area')).defaultPrevented).toBe(true);
    expectSelection(3);
    press('ArrowDown', button('command-upload'));
    expectSelection(0);
    press('ArrowDown', button('command-area'));
    expectSelection(1);
    press('ArrowDown', button('command-page'));
    expectSelection(2);
    expect(pdfRow().getAttribute('aria-disabled')).toBe('true');
    press('ArrowUp', pdfRow());
    expectSelection(1);
  });

  it('moves to the first and last menu rows with Home and End', async () => {
    await loadPopup();
    press('End');
    expectSelection(3);
    press('Home', button('command-upload'));
    expectSelection(0);
  });

  it('runs the row selected by the pointer when Enter is pressed before a row has focus', async () => {
    await loadPopup();
    button('command-page').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    expect(document.activeElement).toBe(document.body);
    expect(menuRows().map((row) => row.tabIndex)).toEqual([-1, 0, -1, -1]);

    expect(press('Enter').defaultPrevented).toBe(true);
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'capture:page', tabId: TAB_ID });
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it('ignores modified navigation, composing Enter, and repeated Enter', async () => {
    await loadPopup();
    button('command-area').focus();
    press('ArrowDown', button('command-area'), { ctrlKey: true });
    expectSelection(0);
    press('Enter', document.body, { isComposing: true });
    expect(press('Enter', button('command-area'), { repeat: true }).defaultPrevented).toBe(true);
    await flush();
    expect(closePopup).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'capture:area', tabId: TAB_ID });
  });

  it.each([
    ['Alt+Shift+S', ['Alt', 'Shift', 'S']],
    ['⌥⇧S', ['⌥', '⇧', 'S']],
  ])('renders shortcut chips for %s with an accessible shortcut', async (shortcut, labels) => {
    vi.spyOn(fakeBrowser.commands, 'getAll').mockImplementation(async () => [
      { name: 'whole-page', shortcut: 'Ctrl+P' },
      { name: 'select-area', shortcut },
    ]);
    await loadPopup();

    const chips = button('command-area').querySelector<HTMLElement>('.row-keys');
    expect(chips?.hidden).toBe(false);
    expect(chips?.getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(chips?.querySelectorAll('kbd') ?? []).map((key) => key.textContent)).toEqual(labels);
    expect(button('command-area').getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+S');
  });

  it('hides shortcut chips when no shortcut is configured', async () => {
    await loadPopup();
    expect(button('command-area').querySelector<HTMLElement>('.row-keys')?.hidden).toBe(true);
    expect(button('command-area').hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('opens options from Settings and closes the popup', async () => {
    await loadPopup();
    await clickAndSettle(button('open-settings'));
    expect(openOptions).toHaveBeenCalledOnce();
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it.each([
    ['Finish setup', 'finish-setup', {}],
    ['Settings', 'open-settings', { settings: SETTINGS }],
  ])('keeps the popup open after %s fails and allows a retry', async (_label, id, stored) => {
    await fakeBrowser.storage.local.clear();
    await fakeBrowser.storage.local.set(stored);
    const failure = new Error('Options page could not open');
    openOptions.mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadPopup();
    await clickAndSettle(button(id));

    expect(openOptions).toHaveBeenCalledOnce();
    expect(closePopup).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith('Capture to Drive: Opening Settings failed.', failure);

    await clickAndSettle(button(id));
    expect(openOptions).toHaveBeenCalledTimes(2);
    expect(closePopup).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('popup Save this PDF row', () => {
  it('stays disabled while checking, then enables when the background answers', async () => {
    let answer!: (value: unknown) => void;
    pdfAnswer = new Promise<unknown>((resolve) => { answer = resolve; });
    useFakeTimeouts();
    await loadPopup();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'tab:pdf-status', tabId: TAB_ID });
    expect(pdfRow().getAttribute('aria-disabled')).toBe('true');
    expect(pdfRow().hasAttribute('aria-describedby')).toBe(false);
    expect(byId('pdf-hint').textContent?.trim()).toBe('');
    await clickAndSettle(pdfRow());
    expect(closePopup).not.toHaveBeenCalled();

    answer({ status: 'pdf' });
    await flush();
    expect(pdfRow().hasAttribute('aria-disabled')).toBe(false);
    expect(byId('pdf-hint').hidden).toBe(true);
  });

  it('enables Save this PDF with no hint for a PDF tab', async () => {
    pdfAnswer = { status: 'pdf' };
    await loadPopup();

    expect(pdfRow().disabled).toBe(false);
    expect(pdfRow().hasAttribute('aria-disabled')).toBe(false);
    expect(pdfRow().hasAttribute('aria-describedby')).toBe(false);
    expect(byId('pdf-hint').hidden).toBe(true);
  });

  it.each([
    ['a non-PDF tab', { status: 'not-pdf' }, NOT_PDF_HINT],
    ['a local file', { status: 'local-file' }, LOCAL_FILE_HINT],
    ['an unavailable answer', undefined, NOT_PDF_HINT],
    ['a malformed answer', { status: 'unknown' }, NOT_PDF_HINT],
  ])('disables Save this PDF with a hint for %s', async (_label, answer, hint) => {
    pdfAnswer = answer;
    await loadPopup();

    expect(pdfRow().disabled).toBe(false);
    expect(pdfRow().getAttribute('aria-disabled')).toBe('true');
    expect(pdfRow().getAttribute('aria-describedby')).toBe('pdf-hint');
    expect(byId('pdf-hint').textContent).toBe(hint);
    expect(byId('pdf-hint').hidden).toBe(false);
    expect(byId('pdf-hint').getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the unavailable hint if the PDF check does not answer within three seconds', async () => {
    pdfAnswer = new Promise<unknown>(() => undefined);
    useFakeTimeouts();
    await loadPopup();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(pdfRow().hasAttribute('aria-describedby')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(byId('pdf-hint').textContent).toBe(NOT_PDF_HINT);
    expect(pdfRow().getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the unavailable hint without logging when the PDF status message rejects', async () => {
    sendMessage.mockRejectedValueOnce(new Error('PDF check port closed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadPopup();

    expect(sendMessage).toHaveBeenCalledWith({ type: 'tab:pdf-status', tabId: TAB_ID });
    expect(pdfRow().getAttribute('aria-disabled')).toBe('true');
    expect(pdfRow().getAttribute('aria-describedby')).toBe('pdf-hint');
    expect(byId('pdf-hint').textContent).toBe(NOT_PDF_HINT);
    expect(closePopup).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('announces the hint when a disabled PDF row is activated and sends no capture', async () => {
    await loadPopup();
    useFakeTimeouts();
    pdfRow().focus();
    pdfRow().click();
    await vi.advanceTimersByTimeAsync(50);

    expect(byId('announcer').getAttribute('aria-live')).toBe('polite');
    expect(byId('announcer').textContent).toBe(NOT_PDF_HINT);
    expect(document.activeElement).toBe(pdfRow());
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'capture:pdf', tabId: TAB_ID });
    expect(closePopup).not.toHaveBeenCalled();
  });

  it('clears and refills the live region when the disabled PDF row is pressed twice', async () => {
    await loadPopup();
    useFakeTimeouts();
    pdfRow().focus();
    pdfRow().click();
    expect(byId('announcer').textContent).toBe('');
    await vi.advanceTimersByTimeAsync(50);
    expect(byId('announcer').textContent).toBe(NOT_PDF_HINT);

    pdfRow().click();
    expect(byId('announcer').textContent).toBe('');
    await vi.advanceTimersByTimeAsync(49);
    expect(byId('announcer').textContent).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(byId('announcer').textContent).toBe(NOT_PDF_HINT);
    expect(document.activeElement).toBe(pdfRow());
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'capture:pdf', tabId: TAB_ID });
    expect(closePopup).not.toHaveBeenCalled();
  });

  it('rechecks an enabled PDF before capturing it and closing', async () => {
    pdfAnswer = { status: 'pdf' };
    await loadPopup();
    sendMessage.mockClear();
    await clickAndSettle(pdfRow());

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'tab:pdf-status', tabId: TAB_ID },
      { type: 'capture:pdf', tabId: TAB_ID },
    ]);
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it('updates the hint and keeps focus when the PDF recheck finds a local file', async () => {
    pdfAnswer = { status: 'pdf' };
    await loadPopup();
    pdfAnswer = { status: 'local-file' };
    useFakeTimeouts();
    pdfRow().focus();
    await clickAndSettle(pdfRow());
    await vi.advanceTimersByTimeAsync(50);

    expect(byId('pdf-hint').textContent).toBe(LOCAL_FILE_HINT);
    expect(byId('announcer').textContent).toBe(LOCAL_FILE_HINT);
    expect(pdfRow().getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(pdfRow());
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'capture:pdf', tabId: TAB_ID });
    expect(closePopup).not.toHaveBeenCalled();
  });
});

describe('popup queue status line', () => {
  it('shows All saved with no Retry now or View for an empty queue', async () => {
    await loadPopup();
    expect(byId('queue-status').textContent).toBe('All saved');
    expect(byId('queue-status').classList.contains('status-saved')).toBe(true);
    expect(byId('queue-status').getAttribute('aria-live')).toBe('polite');
    expect(button('status-retry').hidden).toBe(true);
    expect(button('status-view').hidden).toBe(true);
    expect(byId('attention-list').hidden).toBe(true);
  });

  it.each([1, 2])('shows %i waiting to upload and Retry now retries all items', async (count) => {
    await replaceQueue(Array.from({ length: count }, (_, i) => queueItem(`waiting-${i}`, 'waiting')));
    await loadPopup();

    expect(byId('queue-status').textContent).toBe(`${count} waiting to upload`);
    expect(byId('queue-status').classList.contains('status-waiting')).toBe(true);
    expect(button('status-retry').hidden).toBe(false);
    expect(button('status-retry').textContent).toBe('Retry now');
    expect(button('status-view').hidden).toBe(true);
    await clickAndSettle(button('status-retry'));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'queue:retry' });
    expect(closePopup).not.toHaveBeenCalled();
  });

  it('shows the uploading tone while a queued item uploads', async () => {
    await replaceQueue([queueItem('uploading', 'uploading'), queueItem('waiting', 'waiting')]);
    await loadPopup();

    expect(byId('queue-status').textContent).toBe('2 waiting to upload');
    expect(byId('queue-status').classList.contains('status-uploading')).toBe(true);
    expect(button('status-retry').hidden).toBe(false);
    expect(button('status-view').hidden).toBe(true);
  });

  it('hides View after two failed attempts with a reason', async () => {
    await replaceQueue([queueItem('waiting', 'waiting', { attempts: 2, lastMessage: 'Drive is full.' })]);
    await loadPopup();

    expect(byId('queue-status').textContent).toBe('1 waiting to upload');
    expect(button('status-retry').hidden).toBe(false);
    expect(button('status-view').hidden).toBe(true);
    expect(byId('attention-list').hidden).toBe(true);
  });

  it('shows View after three failed attempts with a reason', async () => {
    await replaceQueue([queueItem('waiting', 'waiting', { attempts: 3, lastMessage: 'Drive is full.' })]);
    await loadPopup();

    expect(byId('queue-status').textContent).toBe('1 waiting to upload');
    expect(button('status-retry').hidden).toBe(false);
    expect(button('status-view').hidden).toBe(false);
    expect(byId('attention-list').hidden).toBe(true);
    await clickAndSettle(button('status-view'));
    expect(attentionRow('waiting').textContent).toContain('Drive is full.');
  });

  it.each([
    [1, '1 needs attention'],
    [2, '2 need attention'],
  ])('shows the attention count and View ahead of waiting items: %i items', async (count, text) => {
    await replaceQueue([
      queueItem('waiting', 'waiting'),
      ...Array.from({ length: count }, (_, i) => queueItem(`problem-${i}`, 'needs_attention')),
    ]);
    await loadPopup();

    expect(byId('queue-status').textContent).toBe(text);
    expect(byId('queue-status').classList.contains('status-attention')).toBe(true);
    expect(button('status-retry').hidden).toBe(true);
    expect(button('status-view').hidden).toBe(false);
    expect(button('status-view').textContent).toBe('View');
  });

  it('shows queue unavailable when the database read fails', async () => {
    await database.closeDatabase();
    const failure = new Error('Queue storage unavailable');
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw failure; });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadPopup();

    expect(byId('queue-status').textContent).toBe("Couldn't check the upload queue.");
    expect(byId('queue-status').classList.contains('status-attention')).toBe(true);
    expect(button('status-retry').hidden).toBe(true);
    expect(button('status-view').hidden).toBe(true);
    expect(byId('attention-list').hidden).toBe(true);
    expect(error).toHaveBeenCalledWith('Capture to Drive: Reading the upload queue failed.', failure);
  });

  it('refreshes from IndexedDB after queue:changed and does not refresh for unrelated messages', async () => {
    await loadPopup();
    await replaceQueue([queueItem('changed', 'needs_attention', { lastMessage: 'Mailbox key was rejected.' })]);
    await fakeBrowser.runtime.onMessage.trigger({ type: 'unrelated' }, {}, () => undefined);
    await flush();
    expect(byId('queue-status').textContent).toBe('All saved');

    await broadcast('changed', 'needs_attention');
    expect(byId('queue-status').textContent).toBe('1 needs attention');
    expect(button('status-view').hidden).toBe(false);
    expect(byId('attention-list').hidden).toBe(true);
    button('status-view').click();
    expect(attentionRow('changed').textContent).toContain('Mailbox key was rejected.');
  });
});

describe('popup uploads with problems', () => {
  it('opens with View, labels the list, shows filenames and reasons, and closes with Hide', async () => {
    await replaceQueue([
      queueItem('a', 'needs_attention', { filename: 'invoice.pdf', lastMessage: 'Too big for the mailbox.' }),
      queueItem('b', 'needs_attention', { filename: 'photo.png' }),
    ]);
    await loadPopup();
    expect(byId('attention-list').hidden).toBe(true);
    expect(button('status-view').getAttribute('aria-controls')).toBe('attention-list');
    button('status-view').click();

    expect(byId('attention-list').hidden).toBe(false);
    expect(byId('attention-list').getAttribute('aria-label')).toBe('Uploads with problems');
    expect(button('status-view').textContent).toBe('Hide');
    expect(attentionRow('a').textContent).toContain('invoice.pdf');
    expect(attentionRow('a').textContent).toContain('Too big for the mailbox.');
    expect(attentionRow('b').textContent).toContain('photo.png');
    expect(attentionRow('b').textContent).toContain('Upload needs attention.');
    button('status-view').click();
    expect(byId('attention-list').hidden).toBe(true);
    expect(button('status-view').textContent).toBe('View');
  });

  it.each([
    ['Retry', 'queue:retry'],
    ['Discard', 'queue:discard'],
  ] as const)('sends the capture id when %s is clicked', async (label, type) => {
    await openProblems([queueItem('problem', 'needs_attention', { filename: 'invoice.pdf' })]);
    const action = itemButton('problem', label);
    expect(shown(action)).toBe(true);
    expect(action.getAttribute('aria-label')).toBe(`${label} invoice.pdf`);
    await clickAndSettle(action);
    expect(sendMessage).toHaveBeenCalledWith({ type, captureId: 'problem' });
    expect(closePopup).not.toHaveBeenCalled();
  });

  it('logs a refused Retry and keeps its row and the popup open', async () => {
    await openProblems([queueItem('problem', 'needs_attention')]);
    requestAnswer = { ok: false };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    itemButton('problem', 'Retry').focus();
    await clickAndSettle(itemButton('problem', 'Retry'));

    expect(sendMessage).toHaveBeenCalledWith({ type: 'queue:retry', captureId: 'problem' });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Capture to Drive: The queue:retry request failed.',
      expect.objectContaining({ message: 'The background could not carry out queue:retry' }),
    );
    expect(document.activeElement).toBe(itemButton('problem', 'Retry'));
    expect(byId('attention-list').hidden).toBe(false);
    expect(closePopup).not.toHaveBeenCalled();
  });

  it('keeps an uploading row with its reason and hidden Uploading now label, without action buttons', async () => {
    await openProblems([
      queueItem('uploading', 'uploading', { attempts: 4, lastMessage: 'Drive is full.' }),
    ]);
    const row = attentionRow('uploading');
    expect(byId('attention-list').hidden).toBe(false);
    expect(row.textContent).toContain('uploading.png');
    expect(row.textContent).toContain('Drive is full.');
    const label = row.querySelector<HTMLElement>('.visually-hidden');
    expect(label?.textContent).toBe('Uploading now.');
    expect(label?.hidden).toBe(false);
    expect(label?.hasAttribute('aria-hidden')).toBe(false);
    expect(visibleButtons(row)).toEqual([]);
  });

  it.each([
    ['Retry', 'saved'],
    ['Discard', 'discarded'],
  ] as const)('moves focus to the next row\'s %s when the focused row is removed', async (label, state) => {
    const first = queueItem('a', 'needs_attention');
    const next = queueItem('b', 'needs_attention');
    await openProblems([first, next]);
    itemButton('a', label).focus();
    itemButton('a', label).click();
    await replaceQueue([next]);
    await broadcast('a', state);

    expect(byId('attention-list').querySelector('[data-capture-id="a"]')).toBeNull();
    expect(document.activeElement).toBe(itemButton('b', label));
    expect(button('status-view').textContent).toBe('Hide');
  });

  it('returns focus to the selected capture row when the final problem is removed', async () => {
    await openProblems([queueItem('last', 'needs_attention')]);
    press('ArrowDown');
    itemButton('last', 'Discard').focus();
    itemButton('last', 'Discard').click();
    await replaceQueue([]);
    await broadcast('last', 'discarded');

    expect(byId('queue-status').textContent).toBe('All saved');
    expect(byId('attention-list').hidden).toBe(true);
    expect(button('status-view').hidden).toBe(true);
    expectSelection(1);
  });

  it('keeps new problems closed after the last problem clears until View is pressed again', async () => {
    await openProblems([queueItem('last', 'needs_attention')]);
    expect(byId('attention-list').hidden).toBe(false);
    await clickAndSettle(itemButton('last', 'Discard'));
    await replaceQueue([]);
    await broadcast('last', 'discarded');
    expect(byId('attention-list').hidden).toBe(true);
    expect(button('status-view').hidden).toBe(true);

    await replaceQueue([queueItem('new', 'needs_attention', { lastMessage: 'Check Settings.' })]);
    await broadcast('new', 'needs_attention');
    expect(byId('queue-status').textContent).toBe('1 needs attention');
    expect(byId('attention-list').hidden).toBe(true);
    expect(button('status-view').hidden).toBe(false);
    expect(button('status-view').textContent).toBe('View');

    await clickAndSettle(button('status-view'));
    expect(byId('attention-list').hidden).toBe(false);
    expect(button('status-view').textContent).toBe('Hide');
    expect(attentionRow('new').textContent).toContain('Check Settings.');
  });

  it('keeps focus on an unchanged item when another item updates', async () => {
    const first = queueItem('a', 'needs_attention');
    const next = queueItem('b', 'needs_attention');
    await openProblems([first, next]);
    const retry = itemButton('b', 'Retry');
    retry.focus();
    await replaceQueue([{ ...first, lastMessage: 'Check Settings.' }, next]);
    await broadcast('a', 'needs_attention');

    expect(attentionRow('a').textContent).toContain('Check Settings.');
    expect(document.activeElement).toBe(retry);
    expect(byId('attention-list').hidden).toBe(false);
  });

  it('moves a refused Discard to Hide instead of another row\'s Discard and logs no error', async () => {
    const first = queueItem('a', 'waiting', { attempts: 3, lastMessage: 'Drive is full.' });
    const next = queueItem('b', 'needs_attention');
    await openProblems([first, next]);
    requestAnswer = { ok: false };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    itemButton('a', 'Discard').focus();
    await clickAndSettle(itemButton('a', 'Discard'));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'queue:discard', captureId: 'a' });

    // The background refuses because an upload started, then broadcasts that state.
    await replaceQueue([{ ...first, status: 'uploading', attempts: 4 }, next]);
    await broadcast('a', 'uploading');
    expect(attentionRow('a').textContent).toContain('Uploading now.');
    expect(visibleButtons(attentionRow('a'))).toEqual([]);
    expect(document.activeElement).toBe(button('status-view'));
    expect(button('status-view').textContent).toBe('Hide');
    expect(error).not.toHaveBeenCalled();
    expect(closePopup).not.toHaveBeenCalled();
  });
});

describe('popup capture actions', () => {
  it.each([
    ['area', 'capture:area'],
    ['page', 'capture:page'],
  ])('sends %s for the active tab and closes once even on a double click', async (id, type) => {
    await loadPopup();
    sendMessage.mockClear();
    button(`command-${id}`).click();
    await clickAndSettle(button(`command-${id}`));

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([{ type, tabId: TAB_ID }]);
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it('opens Upload files in an extension tab and closes the popup', async () => {
    const createTab = vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async () => ({ id: 43 }));
    await loadPopup();
    sendMessage.mockClear();
    await clickAndSettle(button('command-upload'));

    expect(createTab).toHaveBeenCalledWith({ url: fakeBrowser.runtime.getURL('/upload.html') });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it('keeps the popup open when Upload files fails and allows a retry', async () => {
    const failure = new Error('Upload tab could not open');
    const createTab = vi.spyOn(fakeBrowser.tabs, 'create')
      .mockImplementation(async () => ({ id: 43 }))
      .mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadPopup();
    await clickAndSettle(button('command-upload'));

    expect(createTab).toHaveBeenCalledExactlyOnceWith({ url: fakeBrowser.runtime.getURL('/upload.html') });
    expect(closePopup).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith('Capture to Drive: The Upload files… action failed.', failure);

    await clickAndSettle(button('command-upload'));
    expect(createTab.mock.calls).toEqual([
      [{ url: fakeBrowser.runtime.getURL('/upload.html') }],
      [{ url: fakeBrowser.runtime.getURL('/upload.html') }],
    ]);
    expect(closePopup).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('closes without logging when a capture message rejects', async () => {
    await loadPopup();
    sendMessage.mockClear();
    sendMessage.mockRejectedValueOnce(new Error('Capture message port closed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await clickAndSettle(button('command-area'));

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'capture:area', tabId: TAB_ID });
    expect(closePopup).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('waits for capture delivery before closing, with a two and a half second limit', async () => {
    await loadPopup();
    requestAnswer = new Promise<unknown>(() => undefined);
    useFakeTimeouts();
    await clickAndSettle(button('command-area'));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'capture:area', tabId: TAB_ID });
    expect(closePopup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(closePopup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it('keeps the popup open and sends no capture when the active tab has no id', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation(async () => []);
    await loadPopup();
    sendMessage.mockClear();
    await clickAndSettle(button('command-page'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(closePopup).not.toHaveBeenCalled();
  });
});
