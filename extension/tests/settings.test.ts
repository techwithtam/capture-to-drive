// Settings validation and storage (spec section 6.6). Storage runs against WXT's in-memory fake browser.
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSettings, saveSettings, validateMailboxConnection, validateSettings } from '../lib/settings';
import type { Settings } from '../lib/settings';

const VALID_URL = 'https://script.google.com/macros/s/TEST/exec';
const URL_ERROR =
  "That doesn't look like a mailbox URL. It should start with https://script.google.com/ and end in /exec.";
const VALID: Settings = { mailboxUrl: VALID_URL, key: 'test-key', name: 'Alex' };

function validate(overrides: Partial<Settings> = {}) {
  return validateSettings({ ...VALID, ...overrides });
}

/** The errors of a failed validation; fails the test if validation unexpectedly passed. */
function errorsOf(overrides: Partial<Settings>): Partial<Record<keyof Settings, string>> {
  const result = validate(overrides);
  if (result.ok) throw new Error(`Expected validation to fail for ${JSON.stringify(overrides)}`);
  return result.errors;
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('validateSettings: valid input', () => {
  it('accepts a complete, valid set of settings', () => {
    expect(validate()).toEqual({ ok: true, value: VALID });
  });

  it('trims whitespace around every field', () => {
    const result = validateSettings({ mailboxUrl: `  ${VALID_URL}\n`, key: '  test-key \t', name: '  Alex  ' });
    expect(result).toEqual({ ok: true, value: VALID });
  });

  it.each([
    'https://script.google.com/a/macros/example.com/s/TEST/exec',
    'https://script.google.com/a/macros/my-school.example.org/s/TEST-id_2/exec',
    'https://script.google.com/a/macros/localhost/s/TEST/exec',
  ])('accepts the Google Workspace form %s', (mailboxUrl) => {
    expect(validate({ mailboxUrl })).toEqual({ ok: true, value: { ...VALID, mailboxUrl } });
  });

  it('accepts any deployment id made of letters, digits, dashes, and underscores', () => {
    const mailboxUrl = 'https://script.google.com/macros/s/TEST-id_2/exec';
    expect(validate({ mailboxUrl })).toEqual({ ok: true, value: { ...VALID, mailboxUrl } });
  });
});

describe('validateSettings: mailbox URL', () => {
  it('rejects an empty URL', () => {
    expect(errorsOf({ mailboxUrl: '' }).mailboxUrl).toBe('Enter the mailbox URL.');
    expect(errorsOf({ mailboxUrl: '   ' }).mailboxUrl).toBe('Enter the mailbox URL.');
  });

  it.each([
    ['plain http', 'http://script.google.com/macros/s/TEST/exec'],
    ['another host', 'https://example.com/macros/s/TEST/exec'],
    ['a look-alike host', 'https://script.google.com.evil.example/macros/s/TEST/exec'],
    ['a test deployment (/dev)', 'https://script.google.com/macros/s/TEST/dev'],
    ['no /exec ending', 'https://script.google.com/macros/s/TEST'],
    ['a trailing slash', 'https://script.google.com/macros/s/TEST/exec/'],
    ['a query string', 'https://script.google.com/macros/s/TEST/exec?x=1'],
    ['an extra path segment', 'https://script.google.com/macros/s/TEST/extra/exec'],
    ['an empty deployment id', 'https://script.google.com/macros/s//exec'],
    ['a Workspace URL missing /s/', 'https://script.google.com/a/macros/example.com/TEST/exec'],
    ['a Workspace URL with an extra segment', 'https://script.google.com/a/macros/example.com/s/TEST/extra/exec'],
    ['a Workspace test deployment (/dev)', 'https://script.google.com/a/macros/example.com/s/TEST/dev'],
    ['a Workspace URL with a trailing slash', 'https://script.google.com/a/macros/example.com/s/TEST/exec/'],
    ['a Workspace URL with a query string', 'https://script.google.com/a/macros/example.com/s/TEST/exec?x=1'],
    ['a Workspace URL with no domain', 'https://script.google.com/a/macros//s/TEST/exec'],
    ['a Workspace URL with no deployment id', 'https://script.google.com/a/macros/example.com/s//exec'],
    ['a Workspace URL with spaces in the domain', 'https://script.google.com/a/macros/exa mple.com/s/TEST/exec'],
    ['a Workspace URL with an underscore in the domain', 'https://script.google.com/a/macros/exa_mple.com/s/TEST/exec'],
    ['a domain path without /a/', 'https://script.google.com/macros/example.com/s/TEST/exec'],
    ['the consumer path under /a/', 'https://script.google.com/a/macros/s/TEST/exec'],
    ['a Workspace path on another host', 'https://example.com/a/macros/example.com/s/TEST/exec'],
    ['a Workspace path over plain http', 'http://script.google.com/a/macros/example.com/s/TEST/exec'],
    ['text that is not a URL', 'not a url'],
  ])('rejects %s', (_label, mailboxUrl) => {
    expect(errorsOf({ mailboxUrl }).mailboxUrl).toBe(URL_ERROR);
  });
});

describe('validateSettings: secret key', () => {
  it('rejects an empty or whitespace-only key', () => {
    expect(errorsOf({ key: '' }).key).toBe('Enter the secret key.');
    expect(errorsOf({ key: ' \t\n ' }).key).toBe('Enter the secret key.');
  });

  it('keeps characters inside the key untouched', () => {
    const result = validate({ key: 'a b+c/d=' });
    expect(result).toEqual({ ok: true, value: { ...VALID, key: 'a b+c/d=' } });
  });
});

describe('validateSettings: name', () => {
  it('rejects an empty or whitespace-only name', () => {
    expect(errorsOf({ name: '' }).name).toBe('Enter your name.');
    expect(errorsOf({ name: '   ' }).name).toBe('Enter your name.');
  });

  it('accepts 30 characters and rejects 31', () => {
    const thirty = 'a'.repeat(30);
    expect(validate({ name: thirty })).toEqual({ ok: true, value: { ...VALID, name: thirty } });
    expect(errorsOf({ name: 'a'.repeat(31) }).name).toBe('Use 30 characters or fewer.');
  });

  it('measures the limit after trimming', () => {
    const padded = `  ${'a'.repeat(30)}  `;
    expect(validate({ name: padded })).toEqual({ ok: true, value: { ...VALID, name: 'a'.repeat(30) } });
  });

  it('counts whole characters, so an emoji is one character', () => {
    expect(validate({ name: '😀'.repeat(30) }).ok).toBe(true);
    expect(errorsOf({ name: '😀'.repeat(31) }).name).toBe('Use 30 characters or fewer.');
  });

  it.each(['///', '...', ':*?"<>|', '\\ / .'])(
    'rejects %j, which is empty after filename sanitizing',
    (name) => {
      expect(errorsOf({ name }).name).toBe('Use letters or numbers in your name.');
    },
  );

  it('accepts a name that only partly sanitizes away', () => {
    expect(validate({ name: 'Alex/Casey' })).toEqual({ ok: true, value: { ...VALID, name: 'Alex/Casey' } });
  });
});

describe('validateSettings: several problems at once', () => {
  it('reports every invalid field and no value', () => {
    const result = validateSettings({ mailboxUrl: '', key: '', name: '' });
    expect(result).toEqual({
      ok: false,
      errors: { mailboxUrl: 'Enter the mailbox URL.', key: 'Enter the secret key.', name: 'Enter your name.' },
    });
  });

  it('reports only the fields that are invalid', () => {
    expect(Object.keys(errorsOf({ key: '' }))).toEqual(['key']);
  });
});

describe('validateMailboxConnection', () => {
  it('validates just the URL and key, so Test connection works before a name is entered', () => {
    expect(validateMailboxConnection({ mailboxUrl: ` ${VALID_URL} `, key: ' test-key ' })).toEqual({
      ok: true,
      value: { mailboxUrl: VALID_URL, key: 'test-key' },
    });
  });

  it('reports URL and key errors with the same wording as validateSettings', () => {
    const result = validateMailboxConnection({ mailboxUrl: 'nope', key: '' });
    expect(result).toEqual({
      ok: false,
      errors: { mailboxUrl: URL_ERROR, key: 'Enter the secret key.' },
    });
  });
});

describe('getSettings and saveSettings', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await getSettings()).toBeNull();
  });

  it('round-trips saved settings through chrome.storage.local under the key "settings"', async () => {
    await saveSettings(VALID);
    expect(await getSettings()).toEqual(VALID);
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({ settings: VALID });
  });

  it('replaces earlier settings on a second save', async () => {
    await saveSettings(VALID);
    const updated: Settings = { ...VALID, key: 'other-key', name: 'Casey' };
    await saveSettings(updated);
    expect(await getSettings()).toEqual(updated);
  });

  it('stores only the three settings fields', async () => {
    const withExtra = { ...VALID, extra: 'ignored' } as Settings;
    await saveSettings(withExtra);
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({ settings: VALID });
  });

  it('does not touch other storage keys', async () => {
    await fakeBrowser.storage.local.set({ other: 1 });
    await saveSettings(VALID);
    expect(await fakeBrowser.storage.local.get('other')).toEqual({ other: 1 });
  });

  it.each([
    ['a missing key', { mailboxUrl: VALID_URL, name: 'Alex' }],
    ['an empty key', { mailboxUrl: VALID_URL, key: '', name: 'Alex' }],
    ['a blank name', { mailboxUrl: VALID_URL, key: 'test-key', name: '   ' }],
    ['a missing URL', { key: 'test-key', name: 'Alex' }],
    ['a URL that is not a mailbox URL', { mailboxUrl: 'https://example.com', key: 'test-key', name: 'Alex' }],
    ['a field of the wrong type', { mailboxUrl: VALID_URL, key: 42, name: 'Alex' }],
    ['an empty object', {}],
    ['a string', 'settings'],
    ['null', null],
    ['an array', [VALID]],
  ])('returns null for stored settings with %s', async (_label, stored) => {
    await fakeBrowser.storage.local.set({ settings: stored });
    expect(await getSettings()).toBeNull();
  });

  it('returns trimmed values if the stored ones carry stray whitespace', async () => {
    await fakeBrowser.storage.local.set({ settings: { mailboxUrl: `${VALID_URL} `, key: ' test-key', name: ' Alex ' } });
    expect(await getSettings()).toEqual(VALID);
  });
});
