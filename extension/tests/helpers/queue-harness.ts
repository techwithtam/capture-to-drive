// Shared helpers for the IndexedDB-backed tests (db, queue, background). Not a test file itself.
import { closeDatabase, DATABASE_NAME } from '../../lib/db';
import type { MailboxResult, MailboxSettings } from '../../lib/mailbox-client';
import type { NewQueueItem } from '../../lib/queue';

export const SETTINGS: MailboxSettings = { mailboxUrl: 'https://script.google.com/macros/s/TEST/exec', key: 'test-key' };
export const MINUTE = 60_000;
export const MIB = 1024 * 1024;

export const SUCCESS: MailboxResult = { kind: 'success', fileId: 'test-file-id' };
export const NETWORK_ERROR: MailboxResult = { kind: 'retryable', error: 'network', message: 'Failed to fetch' };

// Captured at import time, before any test installs fake timers, so polling keeps working under vi.useFakeTimers().
const realSetTimeout = globalThis.setTimeout;

/** Lets pending IndexedDB events and promise callbacks run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

export async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await tick();
}

/** Polls until `condition` holds, failing the test if it never does. */
export async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await condition()) return;
    await tick();
  }
  throw new Error(`Gave up waiting for ${what}`);
}

/** Closes this context's connection and deletes the database, so every test starts empty. */
export async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function newItem(captureId: string, overrides: Partial<NewQueueItem> = {}): NewQueueItem {
  return {
    captureId,
    filename: `2026-10-07 13.42 Alex - example.com - ${captureId}.png`,
    mimeType: 'image/png',
    description: `Capture ID: ${captureId}`,
    blob: new Blob([`bytes of ${captureId}`], { type: 'image/png' }),
    ...overrides,
  };
}

/** `#rrggbb` (as read from tokens.css) in the [r, g, b, a] form the fake browser reports badge colors in. */
export function rgbaOf(color: string | undefined): number[] {
  if (color === undefined || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Not a six-digit token color: ${color}`);
  return [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16)).concat(255);
}
