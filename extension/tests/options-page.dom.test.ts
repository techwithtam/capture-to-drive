// @vitest-environment happy-dom
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../lib/settings';
import { byId, mountPage, settle, unmountPage } from './helpers/dom';
import { deferred, jsonResponse, SETTINGS, trackPageListeners } from './helpers/dom-pages';

const FIELD_IDS = ['mailbox-url', 'secret-key', 'your-name'] as const;
const URL_ERROR = "That doesn't look like a mailbox URL. It should start with https://script.google.com/ and end in /exec.";
const UNREACHABLE = "Couldn't reach the mailbox. Check the URL and your connection.";

let removePageListeners: () => void;
let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;

function fillForm(settings: Settings = SETTINGS): void {
  for (const [id, value] of [
    ['mailbox-url', settings.mailboxUrl],
    ['secret-key', settings.key],
    ['your-name', settings.name],
  ] as const) {
    byId<HTMLInputElement>(id).value = value;
    byId(id).dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function save(): void {
  const button = byId('settings-form').querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button === null) throw new Error('No Save button');
  button.click();
}

function expectFieldError(id: typeof FIELD_IDS[number], message: string): void {
  expect(byId(`${id}-error`).hidden).toBe(false);
  expect(byId(`${id}-error`).textContent).toBe(message);
  expect(byId(id).getAttribute('aria-invalid')).toBe('true');
  expect(byId(id).getAttribute('aria-describedby')?.split(' ')).toContain(`${id}-error`);
}

async function loadPage(): Promise<void> {
  await import('../entrypoints/options/main');
  await settle();
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.resetModules();
  vi.spyOn(fakeBrowser.commands, 'getAll').mockImplementation(async () => []);
  fetchStub = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchStub);
  mountPage('options');
  removePageListeners = trackPageListeners();
});

afterEach(() => {
  removePageListeners();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  unmountPage();
});

describe('Settings page', () => {
  it('starts with an empty labelled form and no errors or connection request', async () => {
    await loadPage();
    expect(FIELD_IDS.map((id) => byId<HTMLInputElement>(id).value)).toEqual(['', '', '']);
    expect(FIELD_IDS.map((id) => byId<HTMLInputElement>(id).labels?.[0]?.textContent)).toEqual(['Mailbox URL', 'Secret key', 'Your name']);
    for (const id of FIELD_IDS) {
      expect(byId(`${id}-error`).hidden).toBe(true);
      expect(byId(id).hasAttribute('aria-invalid')).toBe(false);
    }
    expect(byId<HTMLInputElement>('secret-key').type).toBe('password');
    expect(byId('status').textContent).toBe('');
    expect(byId('status').getAttribute('aria-live')).toBe('polite');
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('reports all missing fields and focuses the URL when Save is pressed on the empty form', async () => {
    await loadPage();
    save();
    expectFieldError('mailbox-url', 'Enter the mailbox URL.');
    expectFieldError('secret-key', 'Enter the secret key.');
    expectFieldError('your-name', 'Enter your name.');
    expect(document.activeElement).toBe(byId('mailbox-url'));
    expect(byId('status').textContent).toBe('Settings not saved. Check the fields above.');
    expect(byId('status').querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    ['mailbox-url', { mailboxUrl: 'https://example.com/exec' }, URL_ERROR],
    ['secret-key', { key: '  ' }, 'Enter the secret key.'],
    ['your-name', { name: '' }, 'Enter your name.'],
    ['your-name', { name: 'a'.repeat(31) }, 'Use 30 characters or fewer.'],
    ['your-name', { name: '///' }, 'Use letters or numbers in your name.'],
  ] as const)('shows the inline error and focuses %s for %j', async (id, invalid, message) => {
    await loadPage();
    fillForm({ ...SETTINGS, ...invalid });
    save();
    expectFieldError(id, message);
    expect(document.activeElement).toBe(byId(id));
    for (const other of FIELD_IDS.filter((field) => field !== id)) {
      expect(byId(`${other}-error`).hidden).toBe(true);
      expect(byId(other).hasAttribute('aria-invalid')).toBe(false);
    }
    expect(byId('status').textContent).toBe('Settings not saved. Check the fields above.');
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('clears the edited field error and the old status while keeping other errors', async () => {
    await loadPage();
    save();
    const url = byId<HTMLInputElement>('mailbox-url');
    url.value = SETTINGS.mailboxUrl;
    url.dispatchEvent(new Event('input', { bubbles: true }));
    expect(byId('mailbox-url-error').hidden).toBe(true);
    expect(byId('mailbox-url-error').textContent).toBe('');
    expect(url.hasAttribute('aria-invalid')).toBe(false);
    expect(byId('status').textContent).toBe('');
    expectFieldError('secret-key', 'Enter the secret key.');
    expectFieldError('your-name', 'Enter your name.');
  });

  it('loads saved settings into all three fields', async () => {
    await fakeBrowser.storage.local.set({ settings: SETTINGS });
    await loadPage();
    expect(FIELD_IDS.map((id) => byId<HTMLInputElement>(id).value)).toEqual([SETTINGS.mailboxUrl, SETTINGS.key, SETTINGS.name]);
    expect(byId('status').textContent).toBe('');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('stores trimmed form values and displays the values that were stored', async () => {
    await loadPage();
    fillForm({ mailboxUrl: ` ${SETTINGS.mailboxUrl} `, key: ' test-key ', name: ' Alex ' });
    save();
    await settle();
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({ settings: SETTINGS });
    expect(FIELD_IDS.map((id) => byId<HTMLInputElement>(id).value)).toEqual([SETTINGS.mailboxUrl, SETTINGS.key, SETTINGS.name]);
  });

  it('saves valid settings locally without a network request and shows Saved', async () => {
    await loadPage();
    fillForm();
    save();
    await settle();

    expect(await fakeBrowser.storage.local.get('settings')).toEqual({ settings: SETTINGS });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(byId('status').textContent).toBe('Saved.');
  });

  it('announces a storage error when saving fails', async () => {
    await loadPage();
    fillForm();
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('Storage unavailable'));
    save();
    await settle();
    expect(byId('status').textContent).toBe("Couldn't save your settings. Try again.");
    expect(byId('status').getAttribute('aria-live')).toBe('polite');
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
  });

  it('announces a load error without filling the form', async () => {
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValue(new Error('Storage unavailable'));
    await loadPage();
    expect(byId('status').textContent).toBe("Couldn't load your saved settings. Reload this page.");
    expect(FIELD_IDS.map((id) => byId<HTMLInputElement>(id).value)).toEqual(['', '', '']);
  });

  it('checks only URL and key for Test connection and focuses the first missing field', async () => {
    await loadPage();
    byId('test-connection').click();
    expectFieldError('mailbox-url', 'Enter the mailbox URL.');
    expectFieldError('secret-key', 'Enter the secret key.');
    expect(byId('your-name-error').hidden).toBe(true);
    expect(document.activeElement).toBe(byId('mailbox-url'));
    expect(byId('status').textContent).toBe('');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('pings with a URL and key even without a name, announces progress, then Connected', async () => {
    await loadPage();
    const reply = deferred<Response>();
    fetchStub.mockReturnValue(reply.promise);
    fillForm({ ...SETTINGS, name: '' });
    const button = byId<HTMLButtonElement>('test-connection');
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Testing…');
    expect(byId('status').textContent).toBe('Testing connection…');
    expect(byId('status').classList.contains('status-uploading')).toBe(true);
    expect(fetchStub).toHaveBeenCalledWith(SETTINGS.mailboxUrl, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ v: 1, action: 'ping', key: SETTINGS.key }),
    }));
    reply.resolve(jsonResponse({ ok: true }));
    await settle();
    expect(byId('status').textContent).toBe('Connected ✓');
    expect(byId('status').classList.contains('status-saved')).toBe(true);
    expect(byId('status').classList.contains('status-uploading')).toBe(false);
    expect(byId('status').querySelector('.status-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Test connection');
    expect(document.activeElement).toBe(button);
    expect(byId('your-name-error').hidden).toBe(true);
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
  });

  it.each([
    ['unauthorized', { ok: false, error: 'unauthorized', message: 'Debug detail' }, 'Mailbox key was rejected. Check the key.'],
    ['not_found', { ok: false, error: 'not_found' }, 'Mailbox not found. Check that the URL ends in /exec.'],
    ['bad_request', { ok: false, error: 'bad_request' }, "The mailbox didn't accept the test. Check the URL and key."],
    ['too_large', { ok: false, error: 'too_large' }, "The mailbox didn't accept the test. Check the URL and key."],
    ['unexpected_response', { other: 'data' }, "That URL didn't answer like a mailbox. Check that it ends in /exec."],
    ['server_error', { ok: false, error: 'server_error' }, 'The mailbox had a problem. Try again in a minute.'],
    ['unknown_error', { ok: false }, 'The mailbox had a problem. Try again in a minute.'],
  ] as const)('announces the connection failure for %s and restores the Test button', async (_error, body, message) => {
    await loadPage();
    fillForm();
    fetchStub.mockResolvedValue(jsonResponse(body));
    byId('test-connection').click();
    await settle();
    expect(byId('status').textContent).toBe(message);
    expect(byId('status').classList.contains('status-attention')).toBe(true);
    expect(byId('status').classList.contains('status-saved')).toBe(false);
    expect(byId('status').getAttribute('aria-live')).toBe('polite');
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(false);
    expect(document.activeElement).toBe(byId('test-connection'));
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
  });

  it.each([
    [404, 'Mailbox not found. Check that the URL ends in /exec.'],
    [200, "That URL didn't answer like a mailbox. Check that it ends in /exec."],
    [400, "That URL didn't answer like a mailbox. Check that it ends in /exec."],
    [500, "That URL didn't answer like a mailbox. Check that it ends in /exec."],
    [503, "That URL didn't answer like a mailbox. Check that it ends in /exec."],
  ] as const)('explains HTTP %i with an HTML body without showing server details', async (status, message) => {
    await loadPage();
    fillForm();
    fetchStub.mockResolvedValue(new Response('<html>Server detail</html>', {
      status,
      headers: { 'Content-Type': 'text/html' },
    }));
    byId('test-connection').click();
    await settle();
    expect(byId('status').textContent).toBe(message);
    expect(byId('status').textContent).not.toContain('Server detail');
    expect(byId('status').classList.contains('status-attention')).toBe(true);
    expect(byId('status').getAttribute('aria-live')).toBe('polite');
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(false);
    expect(document.activeElement).toBe(byId('test-connection'));
  });

  it('announces a network failure', async () => {
    await loadPage();
    fillForm();
    fetchStub.mockRejectedValue(new TypeError('Failed to fetch'));
    byId('test-connection').click();
    await settle();
    expect(byId('status').textContent).toBe(UNREACHABLE);
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(false);
    expect(document.activeElement).toBe(byId('test-connection'));
  });

  it('aborts a stalled ping after 60 seconds and announces the timeout', async () => {
    await loadPage();
    fillForm();
    vi.useFakeTimers();
    fetchStub.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    byId('test-connection').click();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(byId('status').textContent).toBe('Testing connection…');
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(byId('status').textContent).toBe(UNREACHABLE);
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(false);
    expect(document.activeElement).toBe(byId('test-connection'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps focus where the user moved while a ping was pending', async () => {
    await loadPage();
    fillForm();
    const reply = deferred<Response>();
    fetchStub.mockReturnValue(reply.promise);
    byId('test-connection').click();
    byId('your-name').focus();
    reply.resolve(jsonResponse({ ok: false, error: 'unauthorized' }));
    await settle();
    expect(document.activeElement).toBe(byId('your-name'));
    expect(byId('status').textContent).toBe('Mailbox key was rejected. Check the key.');
  });

  it('does not show an old connection result after the form changes', async () => {
    await loadPage();
    fillForm();
    const reply = deferred<Response>();
    fetchStub.mockReturnValue(reply.promise);
    byId('test-connection').click();
    const key = byId<HTMLInputElement>('secret-key');
    key.value = 'another-key';
    key.dispatchEvent(new Event('input', { bubbles: true }));
    expect(byId('status').textContent).toBe('');
    reply.resolve(jsonResponse({ ok: true }));
    await settle();
    expect(byId('status').textContent).toBe('');
    expect(byId<HTMLButtonElement>('test-connection').disabled).toBe(false);
  });

  it.each([
    ['Chrome', 'Chrome/140.0', 'chrome'],
    ['Edge', 'Chrome/140.0 Edg/140.0', 'edge'],
  ] as const)('opens the %s shortcuts page from Change keyboard shortcut', async (_browser, userAgent, scheme) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    const createTab = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue(undefined);
    await loadPage();
    byId('change-shortcut').click();
    expect(createTab).toHaveBeenCalledOnce();
    expect(createTab).toHaveBeenCalledWith({ url: `${scheme}://extensions/shortcuts` });
    await settle();
    expect(byId('status').textContent).toBe('');
  });

  it.each([
    ['Chrome', 'Chrome/140.0', 'chrome'],
    ['Edge', 'Chrome/140.0 Edg/140.0', 'edge'],
  ] as const)('shows the %s shortcuts address when opening the page fails', async (_browser, userAgent, scheme) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValue(new Error('Tabs unavailable'));
    await loadPage();
    byId('change-shortcut').click();
    await settle();
    expect(byId('status').textContent).toBe(`Couldn't open the shortcuts page. Type ${scheme}://extensions/shortcuts in the address bar.`);
    expect(byId('status').getAttribute('aria-live')).toBe('polite');
    expect(byId('status').classList.contains('status-attention')).toBe(true);
  });

  it.each([
    ['Alt+Shift+S', ['Alt', 'Shift', 'S']],
    ['⌥⇧S', ['⌥', '⇧', 'S']],
  ] as const)('shows one key chip per key for the Select area shortcut %s', async (shortcut, keys) => {
    vi.spyOn(fakeBrowser.commands, 'getAll').mockImplementation(async () => [
      { name: 'other-command', shortcut: 'Ctrl+X' },
      { name: 'select-area', shortcut },
    ]);
    await loadPage();
    const chips = byId('current-shortcut');
    expect(chips.hidden).toBe(false);
    expect(Array.from(chips.querySelectorAll('kbd'), (key) => key.textContent)).toEqual(keys);
  });

  it.each([
    ['no commands', []],
    ['no Select area command', [{ name: 'other-command', shortcut: 'Ctrl+X' }]],
    ['an unset shortcut', [{ name: 'select-area', shortcut: '' }]],
  ] as const)('hides shortcut chips when the browser reports %s', async (_case, commands) => {
    vi.spyOn(fakeBrowser.commands, 'getAll').mockImplementation(async () => commands);
    await loadPage();
    expect(byId('current-shortcut').hidden).toBe(true);
    expect(byId('current-shortcut').querySelectorAll('kbd')).toHaveLength(0);
  });
});
