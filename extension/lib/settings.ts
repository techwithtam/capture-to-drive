// Settings (spec section 6.6): the mailbox URL, secret key, and user name, validated here and stored in
// chrome.storage.local under the key "settings". Safe to import from any extension context (popup, options, background).

import { browser } from 'wxt/browser';
import { sanitize } from './filename';
import type { MailboxSettings } from './mailbox-client';

export interface Settings extends MailboxSettings {
  name: string;
}

type FieldErrors<T> = Partial<Record<keyof T, string>>;

export type ConnectionValidation =
  | { ok: true; value: MailboxSettings }
  | { ok: false; errors: FieldErrors<MailboxSettings> };

export type SettingsValidation = { ok: true; value: Settings } | { ok: false; errors: FieldErrors<Settings> };

const STORAGE_KEY = 'settings';
const MAX_NAME_LENGTH = 30;

// Two forms of the deployed web app URL, where <id> is the deployment id (letters, digits, "-", "_"):
//   https://script.google.com/macros/s/<id>/exec                    (personal Google account)
//   https://script.google.com/a/macros/<domain>/s/<id>/exec         (Google Workspace; domain: letters, digits, ".", "-")
const MAILBOX_URL_PATTERN =
  /^https:\/\/script\.google\.com\/(?:macros\/s|a\/macros\/[A-Za-z0-9.-]+\/s)\/[A-Za-z0-9_-]+\/exec$/;

const ERROR_URL_EMPTY = 'Enter the mailbox URL.';
const ERROR_URL_INVALID =
  "That doesn't look like a mailbox URL. It should start with https://script.google.com/ and end in /exec.";
const ERROR_KEY_EMPTY = 'Enter the secret key.';
const ERROR_NAME_EMPTY = 'Enter your name.';
const ERROR_NAME_TOO_LONG = `Use ${MAX_NAME_LENGTH} characters or fewer.`;
const ERROR_NAME_UNUSABLE = 'Use letters or numbers in your name.';

function mailboxUrlError(mailboxUrl: string): string | undefined {
  if (mailboxUrl === '') return ERROR_URL_EMPTY;
  return MAILBOX_URL_PATTERN.test(mailboxUrl) ? undefined : ERROR_URL_INVALID;
}

function keyError(key: string): string | undefined {
  return key === '' ? ERROR_KEY_EMPTY : undefined;
}

function nameError(name: string): string | undefined {
  if (name === '') return ERROR_NAME_EMPTY;
  // Counted in whole characters (code points), so an emoji is one character.
  if (Array.from(name).length > MAX_NAME_LENGTH) return ERROR_NAME_TOO_LONG;
  // The name goes into every filename. One that sanitizes away to nothing (for example "///") would leave a blank gap.
  return sanitize(name) === '' ? ERROR_NAME_UNUSABLE : undefined;
}

/**
 * Validates only what a mailbox call needs (URL and key), so Test connection works before a name is entered.
 * Fields are trimmed; the trimmed values are returned on success.
 */
export function validateMailboxConnection(input: MailboxSettings): ConnectionValidation {
  const mailboxUrl = input.mailboxUrl.trim();
  const key = input.key.trim();

  const errors: FieldErrors<MailboxSettings> = {};
  const urlProblem = mailboxUrlError(mailboxUrl);
  if (urlProblem !== undefined) errors.mailboxUrl = urlProblem;
  const keyProblem = keyError(key);
  if (keyProblem !== undefined) errors.key = keyProblem;

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { mailboxUrl, key } };
}

/** Validates all three fields. Fields are trimmed; on success the trimmed settings are returned and nothing else changes. */
export function validateSettings(input: { mailboxUrl: string; key: string; name: string }): SettingsValidation {
  const connection = validateMailboxConnection(input);
  const name = input.name.trim();

  const errors: FieldErrors<Settings> = connection.ok ? {} : { ...connection.errors };
  const nameProblem = nameError(name);
  if (nameProblem !== undefined) errors.name = nameProblem;

  if (!connection.ok || nameProblem !== undefined) return { ok: false, errors };
  return { ok: true, value: { ...connection.value, name } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The saved settings, or null when none are saved or what is stored is incomplete or no longer valid. */
export async function getSettings(): Promise<Settings | null> {
  const stored: unknown = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!isRecord(stored)) return null;

  const { mailboxUrl, key, name } = stored;
  if (typeof mailboxUrl !== 'string' || typeof key !== 'string' || typeof name !== 'string') return null;

  const result = validateSettings({ mailboxUrl, key, name });
  return result.ok ? result.value : null;
}

/** Stores exactly the three settings fields. Callers validate first (see `validateSettings`). */
export async function saveSettings(settings: Settings): Promise<void> {
  const { mailboxUrl, key, name } = settings;
  await browser.storage.local.set({ [STORAGE_KEY]: { mailboxUrl, key, name } });
}
