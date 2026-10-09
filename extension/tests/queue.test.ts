// Upload queue (spec section 6.5): storage, single-flight processing, backoff, recovery, badge, retry alarm, and
// queue:changed broadcasts. Runs against fake-indexeddb and WXT's fake browser, with an injected clock and mailbox.
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BADGE_COLORS } from '../lib/badge';
import { closeDatabase, QUEUE_STORE, transact } from '../lib/db';
import { MAX_FILE_BYTES, saveToMailbox } from '../lib/mailbox-client';
import type { MailboxResult, MailboxSettings, SavePayload } from '../lib/mailbox-client';
import { isQueueChangedMessage } from '../lib/messages';
import type { QueueChangedMessage } from '../lib/messages';
import {
  addItem,
  backoffDelayMs,
  createQueueProcessor,
  discard,
  enqueue,
  getItem,
  installQueueProcessor,
  KEEP_ALIVE_INTERVAL_MS,
  listItems,
  OVERDUE_RECHECK_MS,
  processQueue,
  RETRY_ALARM,
  retryNow,
  UNREACHABLE_MESSAGE,
  UPLOAD_WATCHDOG_GRACE_MS,
  uploadTimeoutMs,
} from '../lib/queue';
import type { AttemptOutcome, QueueDeps, QueueProcessor, SaveFunction } from '../lib/queue';
import {
  MIB,
  MINUTE,
  NETWORK_ERROR,
  newItem,
  resetDatabase,
  rgbaOf,
  SETTINGS,
  SUCCESS,
  ticks,
  until,
} from './helpers/queue-harness';

const T0 = Date.UTC(2026, 9, 7, 20, 42, 10);
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

let time: number;
let broadcasts: QueueChangedMessage[];
let processors: QueueProcessor[];

interface OpenSave {
  payload: SavePayload;
  settings: MailboxSettings;
  timeoutMs: number;
  finish(result: MailboxResult): void;
}

/** A mailbox whose requests stay open until the test answers them. Tracks how many are open at once. */
function manualMailbox() {
  const calls: OpenSave[] = [];
  let open = 0;
  let maxOpen = 0;
  const save: SaveFunction = (payload, settings, options) =>
    new Promise<MailboxResult>((resolve) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      calls.push({
        payload,
        settings,
        timeoutMs: options.timeoutMs,
        finish(result) {
          open -= 1;
          resolve(result);
        },
      });
    });
  return {
    save,
    calls,
    maxOpen: () => maxOpen,
    /** The open request for the nth call (0-based); fails the test if it has not been made. */
    call(index: number): OpenSave {
      const call = calls[index];
      if (call === undefined) throw new Error(`No mailbox call #${index}`);
      return call;
    },
  };
}

function mailboxAnswering(...results: MailboxResult[]) {
  const save = vi.fn<SaveFunction>();
  for (const result of results) save.mockResolvedValueOnce(result);
  return save.mockResolvedValue(SUCCESS);
}

function makeQueue(overrides: Partial<QueueDeps> = {}): QueueProcessor {
  const queue = createQueueProcessor({
    save: mailboxAnswering(),
    getSettings: () => Promise.resolve(SETTINGS),
    now: () => time,
    keepAlivePing: () => Promise.resolve(),
    ...overrides,
  });
  processors.push(queue);
  return queue;
}

function savedIds(save: ReturnType<typeof vi.fn<SaveFunction>>): string[] {
  return save.mock.calls.map(([payload]) => payload.captureId);
}

function changed(captureId: string, state: QueueChangedMessage['state'], message?: string): QueueChangedMessage {
  return message === undefined
    ? { type: 'queue:changed', captureId, state }
    : { type: 'queue:changed', captureId, state, message };
}

async function badgeText(): Promise<string> {
  return fakeBrowser.action.getBadgeText({});
}

async function badgeColor(): Promise<unknown> {
  return fakeBrowser.action.getBadgeBackgroundColor({});
}

async function retryAlarmTime(): Promise<number | undefined> {
  return (await fakeBrowser.alarms.get(RETRY_ALARM))?.scheduledTime;
}

beforeEach(async () => {
  await resetDatabase();
  fakeBrowser.reset();
  time = T0;
  broadcasts = [];
  processors = [];
  fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
    if (isQueueChangedMessage(message)) broadcasts.push(message);
  });
  // Only the queue's own timers (keep-alive, upload watchdog) are faked; fake-indexeddb runs on setImmediate.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  // A drain keeps going briefly after the promise a test awaited (its last scan and badge update). Let every one
  // finish here, so none of them picks up the next test's items.
  for (const queue of processors) await queue.recover();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('backoffDelayMs', () => {
  it('waits 1, 2, 5, 10, then 30 minutes after attempts 1 to 5, and 30 minutes after every later attempt', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((attempts) => backoffDelayMs(attempts))).toEqual(
      [1, 2, 5, 10, 30, 30, 30, 30].map((minutes) => minutes * MINUTE),
    );
  });
});

describe('uploadTimeoutMs', () => {
  it.each([
    [0, 60_000],
    [1, 70_000],
    [MIB, 70_000],
    [MIB + 1, 80_000],
    [20 * MIB, 260_000],
  ])('%i bytes -> %i ms (60 s plus 10 s per started megabyte)', (bytes, expected) => {
    expect(uploadTimeoutMs(bytes)).toBe(expected);
  });
});

describe('addItem and listItems (any extension context)', () => {
  it('stores a new item as waiting, due now, with no attempts', async () => {
    const before = Date.now();
    await addItem(newItem('a'));
    const after = Date.now();

    const [item] = await listItems();
    expect(item).toMatchObject({
      captureId: 'a',
      filename: newItem('a').filename,
      mimeType: 'image/png',
      description: 'Capture ID: a',
      attempts: 0,
      status: 'waiting',
    });
    expect(item?.createdAt).toBeGreaterThanOrEqual(before);
    expect(item?.createdAt).toBeLessThanOrEqual(after);
    expect(item?.nextAttemptAt).toBe(item?.createdAt);
    expect(item?.lastError).toBeUndefined();
    expect(item?.lastMessage).toBeUndefined();
  });

  it('keeps the bytes and lists items oldest first', async () => {
    const queue = makeQueue({ getSettings: () => Promise.resolve(null) });
    await queue.enqueue(newItem('b'));
    time -= MINUTE;
    await queue.enqueue(newItem('a'));

    const items = await listItems();
    expect(items.map((item) => item.captureId)).toEqual(['a', 'b']);
    expect(await items[1]?.blob.text()).toBe('bytes of b');
  });

  it('stores only the queue item fields', async () => {
    const withExtra = { ...newItem('a'), note: 'extra' };
    await addItem(withExtra);
    expect(await getItem('a')).not.toHaveProperty('note');
  });

  it('refuses a second item with the same captureId', async () => {
    await addItem(newItem('a'));
    await expect(addItem(newItem('a'))).rejects.toThrow();
    expect(await listItems()).toHaveLength(1);
  });

  it('getItem returns undefined for an unknown captureId', async () => {
    expect(await getItem('nope')).toBeUndefined();
  });
});

describe('enqueue: success', () => {
  it('uploads right away, resolves "saved", and deletes the item', async () => {
    const save = mailboxAnswering(SUCCESS);
    const item = newItem('a');
    await expect(makeQueue({ save }).enqueue(item)).resolves.toBe('saved');

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      {
        captureId: 'a',
        filename: item.filename,
        mimeType: 'image/png',
        description: 'Capture ID: a',
        blob: expect.any(Blob),
      },
      SETTINGS,
      { timeoutMs: 70_000 },
    );
    expect(await save.mock.calls[0]?.[0].blob.text()).toBe('bytes of a');
    expect(await listItems()).toEqual([]);
  });

  it('tells pages waiting, uploading, then saved', async () => {
    await makeQueue().enqueue(newItem('a'));
    expect(broadcasts).toEqual([changed('a', 'waiting'), changed('a', 'uploading'), changed('a', 'saved')]);
  });

  it('passes a timeout of 60 s plus 10 s per started megabyte', async () => {
    const save = mailboxAnswering(SUCCESS);
    const blob = new Blob([new Uint8Array(2 * MIB + 1)]);
    await makeQueue({ save }).enqueue(newItem('a', { blob }));
    expect(save.mock.calls[0]?.[2]).toEqual({ timeoutMs: 90_000 });
  });

  it('shows the count while uploading, then clears the badge and the retry alarm', async () => {
    const mailbox = manualMailbox();
    const outcome = makeQueue({ save: mailbox.save }).enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');

    expect(await badgeText()).toBe('1');
    expect(await badgeColor()).toEqual(rgbaOf(BADGE_COLORS.count));
    expect((await getItem('a'))?.status).toBe('uploading');

    mailbox.call(0).finish(SUCCESS);
    await expect(outcome).resolves.toBe('saved');
    expect(await badgeText()).toBe('');
    expect(await retryAlarmTime()).toBeUndefined();
  });
});

describe('retry with backoff', () => {
  it('schedules attempts 1, 2, 5, 10, 30, and 30 minutes apart, with the retry alarm at the next attempt', async () => {
    const save = vi.fn<SaveFunction>().mockResolvedValue(NETWORK_ERROR);
    const queue = makeQueue({ save });
    await expect(queue.enqueue(newItem('a'))).resolves.toBe('will_retry');

    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const item = await getItem('a');
      if (item === undefined) throw new Error('item vanished');
      expect(item).toMatchObject({ status: 'waiting', attempts: attempt, lastError: 'network' });
      expect(await retryAlarmTime()).toBe(item.nextAttemptAt);
      gaps.push(item.nextAttemptAt - time);

      // One millisecond early it is still backing off.
      time = item.nextAttemptAt - 1;
      await queue.processQueue();
      expect(save).toHaveBeenCalledTimes(attempt);

      time = item.nextAttemptAt;
      await queue.processQueue();
      expect(save).toHaveBeenCalledTimes(attempt + 1);
    }
    expect(gaps).toEqual([1, 2, 5, 10, 30, 30].map((minutes) => minutes * MINUTE));
  });

  // The popup shows the last reason once an item keeps failing (Drive full, Capture folder deleted), so it is kept.
  it("keeps the item waiting with its error code, the mailbox's reason, and the count on the badge", async () => {
    const save = mailboxAnswering({ kind: 'retryable', error: 'server_error', message: 'Drive storage is full.' });
    await makeQueue({ save }).enqueue(newItem('a'));

    const item = await getItem('a');
    expect(item).toMatchObject({
      status: 'waiting',
      attempts: 1,
      lastError: 'server_error',
      lastMessage: 'Drive storage is full.',
    });
    // Pages are told the state only; the popup reads the reason from the queue.
    expect(broadcasts.at(-1)).toEqual(changed('a', 'waiting'));
    expect(await badgeText()).toBe('1');
    expect(await badgeColor()).toEqual(rgbaOf(BADGE_COLORS.count));
  });

  it("stores a plain reason for a network failure instead of the browser's wording", async () => {
    await makeQueue({ save: mailboxAnswering(NETWORK_ERROR) }).enqueue(newItem('a'));
    expect(await getItem('a')).toMatchObject({ lastError: 'network', lastMessage: UNREACHABLE_MESSAGE });
    expect(UNREACHABLE_MESSAGE).toBe("Couldn't reach Drive. Check your internet connection.");
  });

  it('keeps the newest reason from attempt to attempt', async () => {
    const save = mailboxAnswering(
      { kind: 'retryable', error: 'server_error', message: 'Drive storage is full.' },
      { kind: 'retryable', error: 'server_error', message: 'The Capture folder is missing. Run setup() again.' },
    );
    const queue = makeQueue({ save });
    await queue.enqueue(newItem('a'));
    time = (await getItem('a'))?.nextAttemptAt ?? time;
    await queue.processQueue();

    expect(await getItem('a')).toMatchObject({
      attempts: 2,
      lastMessage: 'The Capture folder is missing. Run setup() again.',
    });
  });

  it('treats a save function that throws as a transient failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const save = vi.fn<SaveFunction>().mockRejectedValueOnce(new Error('surprise')).mockResolvedValue(SUCCESS);
    await expect(makeQueue({ save }).enqueue(newItem('a'))).resolves.toBe('will_retry');
    expect(await getItem('a')).toMatchObject({
      status: 'waiting',
      attempts: 1,
      lastError: 'unexpected_error',
      lastMessage: UNREACHABLE_MESSAGE,
    });
    expect(warn).toHaveBeenCalledWith('Capture to Drive: the upload failed unexpectedly.', expect.any(Error));
  });

  it('sets the retry alarm to the earliest next attempt across items', async () => {
    const save = vi.fn<SaveFunction>().mockResolvedValue(NETWORK_ERROR);
    const queue = makeQueue({ save });
    await queue.enqueue(newItem('a'));
    time = T0 + 30 * 1000;
    await queue.enqueue(newItem('b'));
    expect(await retryAlarmTime()).toBe(T0 + MINUTE);

    time = T0 + MINUTE;
    await queue.processQueue();
    // a is now on its 2nd attempt (2 more minutes); b is still due at T0 + 90 s.
    expect(await retryAlarmTime()).toBe(T0 + 90 * 1000);
  });
});

describe('needs attention', () => {
  it('stops retrying a 404 HTML response, shows not_found, and tries once per popup Retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html>Deployment not found</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));
    const save: SaveFunction = (payload, settings, options) => saveToMailbox(payload, settings, { ...options, fetchImpl });
    const queue = makeQueue({ save });
    const message = 'Mailbox not found. Check the URL in Settings.';

    await expect(queue.enqueue(newItem('a'))).resolves.toBe('needs_attention');
    expect(await getItem('a')).toMatchObject({
      status: 'needs_attention', attempts: 1, lastError: 'not_found', lastMessage: message,
    });
    expect(broadcasts.at(-1)).toEqual(changed('a', 'needs_attention', message));
    expect(await badgeText()).toBe('!');
    expect(await retryAlarmTime()).toBeUndefined();

    time += 24 * 60 * MINUTE;
    await queue.processQueue();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(queue.handle({ type: 'queue:retry', captureId: 'a' })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await getItem('a')).toMatchObject({
      status: 'needs_attention', attempts: 2, lastError: 'not_found', lastMessage: message,
    });
    expect(await badgeText()).toBe('!');
    expect(await retryAlarmTime()).toBeUndefined();

    time += 24 * 60 * MINUTE;
    await queue.processQueue();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unauthorized', 'Mailbox key was rejected. Check Settings.'],
    ['too_large', 'Too big for the mailbox.'],
    ['bad_request', "This capture couldn't be read. Discard it and capture again."],
    ['not_found', 'Mailbox not found. Check the URL in Settings.'],
  ] as const)('%s: stops retrying and stores the UI message, not the raw one', async (error, message) => {
    const save = mailboxAnswering({ kind: 'needs_attention', error, message: 'raw text from the mailbox' });
    const queue = makeQueue({ save });
    await expect(queue.enqueue(newItem('a'))).resolves.toBe('needs_attention');

    expect(await getItem('a')).toMatchObject({ status: 'needs_attention', attempts: 1, lastError: error, lastMessage: message });
    expect(broadcasts.at(-1)).toEqual(changed('a', 'needs_attention', message));
    expect(await badgeText()).toBe('!');
    expect(await badgeColor()).toEqual(rgbaOf(BADGE_COLORS.attention));
    expect(await retryAlarmTime()).toBeUndefined();

    time += 24 * 60 * MINUTE;
    await queue.processQueue();
    expect(save).toHaveBeenCalledTimes(1);
  });

  // A file the mailbox would refuse is never sent. Capture flows check first; this guards anything that got past.
  it('marks an item over the size limit too_large without sending it', async () => {
    const save = mailboxAnswering();
    const blob = new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]);
    await expect(makeQueue({ save }).enqueue(newItem('a', { blob }))).resolves.toBe('needs_attention');

    expect(save).not.toHaveBeenCalled();
    expect(await getItem('a')).toMatchObject({
      status: 'needs_attention',
      lastError: 'too_large',
      lastMessage: 'Too big for the mailbox.',
    });
    expect(broadcasts.at(-1)).toEqual(changed('a', 'needs_attention', 'Too big for the mailbox.'));
    expect(await badgeText()).toBe('!');
  });

  it('still sends an item of exactly the size limit', async () => {
    const save = mailboxAnswering(SUCCESS);
    const blob = new Blob([new Uint8Array(MAX_FILE_BYTES)]);
    await expect(makeQueue({ save }).enqueue(newItem('a', { blob }))).resolves.toBe('saved');
    expect(save).toHaveBeenCalledOnce();
  });

  it('shows "!" while any item needs attention, and still schedules the waiting ones', async () => {
    const save = mailboxAnswering({ kind: 'needs_attention', error: 'too_large' }, NETWORK_ERROR);
    const queue = makeQueue({ save });
    await queue.enqueue(newItem('a'));
    await queue.enqueue(newItem('b'));

    expect(await badgeText()).toBe('!');
    expect(await retryAlarmTime()).toBe(T0 + MINUTE);
  });
});

describe('single flight', () => {
  it('uploads one item at a time, oldest first, and resolves each enqueue after its own attempt', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const outcomes: Record<string, AttemptOutcome> = {};
    const enqueued = ['a', 'b', 'c'].map((id) => {
      const done = queue.enqueue(newItem(id)).then((outcome) => {
        outcomes[id] = outcome;
      });
      time += 1;
      return done;
    });

    await until(() => mailbox.calls.length === 1, 'the first upload');
    await ticks(20);
    expect(mailbox.calls.map((call) => call.payload.captureId)).toEqual(['a']);
    expect(outcomes).toEqual({});

    mailbox.call(0).finish(SUCCESS);
    await until(() => mailbox.calls.length === 2, 'the second upload');
    expect(outcomes).toEqual({ a: 'saved' });
    expect(mailbox.call(1).payload.captureId).toBe('b');

    mailbox.call(1).finish(NETWORK_ERROR);
    await until(() => mailbox.calls.length === 3, 'the third upload');
    expect(outcomes).toEqual({ a: 'saved', b: 'will_retry' });
    expect(mailbox.call(2).payload.captureId).toBe('c');

    mailbox.call(2).finish({ kind: 'needs_attention', error: 'unauthorized' });
    await Promise.all(enqueued);
    expect(outcomes).toEqual({ a: 'saved', b: 'will_retry', c: 'needs_attention' });
    expect(mailbox.maxOpen()).toBe(1);
  });

  it('stays single-flight when processQueue, retryNow, and recover re-enter during an upload', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const outcome = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');

    const reentered = [
      queue.processQueue(),
      queue.processQueue(),
      queue.retryNow(),
      queue.retryNow('a'),
      queue.recover(),
      queue.handle({ type: 'queue:kick' }),
    ];
    await ticks(20);
    expect(mailbox.calls).toHaveLength(1);
    // Neither retryNow('a') nor recover() touches the upload in flight.
    expect((await getItem('a'))?.status).toBe('uploading');

    mailbox.call(0).finish(SUCCESS);
    await expect(outcome).resolves.toBe('saved');
    await Promise.all(reentered);
    expect(mailbox.calls).toHaveLength(1);
    expect(mailbox.maxOpen()).toBe(1);
  });

  it('a capture enqueued during an upload waits its turn', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const first = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the first upload');

    time += 1;
    let secondOutcome: AttemptOutcome | undefined;
    const second = queue.enqueue(newItem('b')).then((outcome) => {
      secondOutcome = outcome;
    });
    await ticks(20);
    expect(mailbox.calls).toHaveLength(1);
    expect(secondOutcome).toBeUndefined();

    mailbox.call(0).finish(NETWORK_ERROR);
    await expect(first).resolves.toBe('will_retry');
    await until(() => mailbox.calls.length === 2, 'the second upload');
    expect(secondOutcome).toBeUndefined();

    mailbox.call(1).finish(SUCCESS);
    await second;
    expect(secondOutcome).toBe('saved');
  });

  it('an older item whose backoff has ended goes before a newer capture', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const first = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the first upload');
    mailbox.call(0).finish(NETWORK_ERROR);
    await first;

    time = T0 + 2 * MINUTE;
    const second = queue.enqueue(newItem('b'));
    await until(() => mailbox.calls.length === 2, 'the retry of a');
    expect(mailbox.call(1).payload.captureId).toBe('a');

    mailbox.call(1).finish(SUCCESS);
    await until(() => mailbox.calls.length === 3, 'the upload of b');
    expect(mailbox.call(2).payload.captureId).toBe('b');
    mailbox.call(2).finish(SUCCESS);
    await expect(second).resolves.toBe('saved');
  });

  it('a capture that arrives while the drain is finishing up is not dropped', async () => {
    const save = mailboxAnswering(SUCCESS, SUCCESS);
    const queue = makeQueue({ save });
    // Hold the drain in its final badge and alarm update (the second alarm clear: the first follows a's result).
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clearAlarm = fakeBrowser.alarms.clear.bind(fakeBrowser.alarms);
    let clears = 0;
    vi.spyOn(fakeBrowser.alarms, 'clear').mockImplementation(async (name?: string) => {
      clears += 1;
      if (clears === 2) await held;
      return clearAlarm(name);
    });

    await expect(queue.enqueue(newItem('a'))).resolves.toBe('saved');
    await until(() => clears === 2, 'the final alarm update');

    time += 1;
    const second = queue.enqueue(newItem('b'));
    await until(() => broadcasts.some((message) => message.captureId === 'b'), 'b to be stored');
    release();

    await expect(second).resolves.toBe('saved');
    expect(savedIds(save)).toEqual(['a', 'b']);
  });

  it('items still backing off do not block a new capture', async () => {
    const save = mailboxAnswering(NETWORK_ERROR, SUCCESS);
    const queue = makeQueue({ save });
    await expect(queue.enqueue(newItem('a'))).resolves.toBe('will_retry');

    time += 10 * 1000;
    await expect(queue.enqueue(newItem('b'))).resolves.toBe('saved');
    expect(savedIds(save)).toEqual(['a', 'b']);
    expect(await getItem('a')).toMatchObject({ status: 'waiting', attempts: 1 });
  });
});

describe('settings missing', () => {
  it('leaves the capture waiting without trying, then uploads once settings exist', async () => {
    const save = mailboxAnswering(SUCCESS);
    let settings: MailboxSettings | null = null;
    const queue = makeQueue({ save, getSettings: () => Promise.resolve(settings) });

    await expect(queue.enqueue(newItem('a'))).resolves.toBe('will_retry');
    expect(save).not.toHaveBeenCalled();
    expect(await getItem('a')).toMatchObject({ status: 'waiting', attempts: 0, nextAttemptAt: T0 });
    expect(await badgeText()).toBe('1');
    // It is overdue but cannot go yet, so the alarm checks back later instead of firing right away.
    expect(await retryAlarmTime()).toBe(T0 + OVERDUE_RECHECK_MS);

    settings = SETTINGS;
    await queue.processQueue();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await listItems()).toEqual([]);
  });
});

describe('service-worker restart', () => {
  it('keeps items and puts an interrupted upload back in line after its backoff', async () => {
    const mailbox = manualMailbox();
    const before = makeQueue({ save: mailbox.save });
    const interrupted = before.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');
    expect((await getItem('a'))?.status).toBe('uploading');

    // The worker stops mid-upload. IndexedDB keeps its data; the next worker starts from scratch.
    await closeDatabase();
    broadcasts = [];
    const save = mailboxAnswering(SUCCESS);
    const after = makeQueue({ save });
    await after.recover();

    expect(await getItem('a')).toMatchObject({ status: 'waiting', attempts: 1, nextAttemptAt: T0 + MINUTE });
    expect(save).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([changed('a', 'waiting')]);
    expect(await badgeText()).toBe('1');
    expect(await retryAlarmTime()).toBe(T0 + MINUTE);

    time = T0 + MINUTE;
    await after.processQueue();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await listItems()).toEqual([]);

    // A late answer to the old worker's request must not bring the item back.
    mailbox.call(0).finish(NETWORK_ERROR);
    await interrupted;
    expect(await listItems()).toEqual([]);
  });

  it('leaves waiting and needs-attention items exactly as they were', async () => {
    const save = mailboxAnswering({ kind: 'needs_attention', error: 'unauthorized' }, NETWORK_ERROR);
    const before = makeQueue({ save });
    await before.enqueue(newItem('a'));
    await before.enqueue(newItem('b'));
    const stored = await listItems();

    await closeDatabase();
    fakeBrowser.action.resetState();
    await makeQueue().recover();

    expect(await listItems()).toEqual(stored);
    expect(await badgeText()).toBe('!');
  });
});

describe('broadcasts', () => {
  it('swallows "Receiving end does not exist" when no page is open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error(NO_RECEIVER));

    await expect(makeQueue().enqueue(newItem('a'))).resolves.toBe('saved');
    await ticks(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs any other broadcast error without stopping the upload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('boom'));

    await expect(makeQueue().enqueue(newItem('a'))).resolves.toBe('saved');
    await ticks(5);
    expect(warn).toHaveBeenCalled();
  });

  it('does not wait for a page that never answers', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(() => new Promise<never>(() => undefined));
    await expect(makeQueue().enqueue(newItem('a'))).resolves.toBe('saved');
  });

  it('survives sendMessage throwing synchronously', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    await expect(makeQueue().enqueue(newItem('a'))).resolves.toBe('saved');
  });
});

describe('badge failures', () => {
  it('never stop an upload', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.action, 'setBadgeText').mockRejectedValue(new Error('no toolbar'));
    await expect(makeQueue().enqueue(newItem('a'))).resolves.toBe('saved');
    expect(await listItems()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });
});

describe('retryNow', () => {
  it('retries a needs-attention item right away and clears its message', async () => {
    const save = mailboxAnswering({ kind: 'needs_attention', error: 'unauthorized' }, NETWORK_ERROR);
    const queue = makeQueue({ save });
    await queue.enqueue(newItem('a'));
    broadcasts = [];

    await queue.retryNow('a');
    expect(save).toHaveBeenCalledTimes(2);
    const item = await getItem('a');
    expect(item).toMatchObject({ status: 'waiting', attempts: 2, lastError: 'network' });
    // The needs-attention message is gone; the failed retry left its own reason.
    expect(item?.lastMessage).toBe(UNREACHABLE_MESSAGE);
    expect(broadcasts).toEqual([changed('a', 'waiting'), changed('a', 'uploading'), changed('a', 'waiting')]);
    expect(await badgeText()).toBe('1');
  });

  it('clears a needs-attention message as soon as the item is retried', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const first = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the first upload');
    mailbox.call(0).finish({ kind: 'needs_attention', error: 'unauthorized' });
    await first;

    const retry = queue.retryNow('a');
    await until(() => mailbox.calls.length === 2, 'the retry to start');
    expect((await getItem('a'))?.lastMessage).toBeUndefined();
    mailbox.call(1).finish(SUCCESS);
    await retry;
  });

  it("keeps a waiting item's last reason while it is retried, until the attempt replaces it", async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const first = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the first upload');
    mailbox.call(0).finish({ kind: 'retryable', error: 'server_error', message: 'Drive storage is full.' });
    await first;

    const retry = queue.retryNow();
    await until(() => mailbox.calls.length === 2, 'the retry to start');
    expect(await getItem('a')).toMatchObject({ status: 'uploading', lastMessage: 'Drive storage is full.' });
    mailbox.call(1).finish({ kind: 'retryable', error: 'timeout', message: 'The mailbox did not answer in time.' });
    await retry;
    expect(await getItem('a')).toMatchObject({ status: 'waiting', lastMessage: 'The mailbox did not answer in time.' });
  });

  it('without an id, makes every waiting item due now and leaves needs-attention items alone', async () => {
    const save = mailboxAnswering(NETWORK_ERROR, { kind: 'needs_attention', error: 'too_large' }, NETWORK_ERROR);
    const queue = makeQueue({ save });
    await queue.enqueue(newItem('a'));
    await queue.enqueue(newItem('b'));
    time += 1;
    await queue.enqueue(newItem('c'));
    expect(save).toHaveBeenCalledTimes(3);

    save.mockResolvedValue(SUCCESS);
    await queue.retryNow();
    expect(savedIds(save)).toEqual(['a', 'b', 'c', 'a', 'c']);
    expect((await listItems()).map((item) => [item.captureId, item.status])).toEqual([['b', 'needs_attention']]);
  });

  it('does nothing for an unknown item', async () => {
    const save = mailboxAnswering();
    await expect(makeQueue({ save }).retryNow('nope')).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([]);
  });
});

describe('discard', () => {
  it('removes the item, tells pages, and clears the badge and the retry alarm', async () => {
    const queue = makeQueue({ save: mailboxAnswering(NETWORK_ERROR) });
    await queue.enqueue(newItem('a'));
    expect(await retryAlarmTime()).toBe(T0 + MINUTE);

    await queue.discard('a');
    expect(await listItems()).toEqual([]);
    expect(broadcasts.at(-1)).toEqual(changed('a', 'discarded'));
    expect(await badgeText()).toBe('');
    expect(await retryAlarmTime()).toBeUndefined();
  });

  it('keeps the badge right for what is left', async () => {
    const queue = makeQueue({ save: mailboxAnswering({ kind: 'needs_attention', error: 'too_large' }, NETWORK_ERROR) });
    await queue.enqueue(newItem('a'));
    await queue.enqueue(newItem('b'));
    expect(await badgeText()).toBe('!');

    await queue.discard('a');
    expect(await badgeText()).toBe('1');
    expect(await badgeColor()).toEqual(rgbaOf(BADGE_COLORS.count));
  });

  it('refuses to discard an item that is uploading, leaves it alone, and lets the upload finish', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const outcome = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');
    const before = await getItem('a');
    const sent = broadcasts.length;

    await expect(queue.discard('a')).resolves.toBe(false);
    expect(await getItem('a')).toEqual(before);
    expect(before?.status).toBe('uploading');
    expect(broadcasts).toHaveLength(sent);
    expect(await badgeText()).toBe('1');

    mailbox.call(0).finish(SUCCESS);
    await expect(outcome).resolves.toBe('saved');
    expect(await listItems()).toEqual([]);
    expect(broadcasts.map((message) => message.state)).not.toContain('discarded');
    expect(broadcasts.at(-1)).toEqual(changed('a', 'saved'));
  });

  it('refuses the queue:discard request for an item that is uploading, and carries out any other', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const outcome = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');

    await expect(queue.handle({ type: 'queue:discard', captureId: 'a' })).resolves.toBe(false);
    expect((await getItem('a'))?.status).toBe('uploading');
    await expect(queue.handle({ type: 'queue:discard', captureId: 'nope' })).resolves.toBe(true);

    mailbox.call(0).finish(NETWORK_ERROR);
    await outcome;
    await expect(queue.handle({ type: 'queue:discard', captureId: 'a' })).resolves.toBe(true);
    expect(await listItems()).toEqual([]);
  });

  it('discards the item again once its failed attempt is over', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const outcome = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');
    await expect(queue.discard('a')).resolves.toBe(false);

    mailbox.call(0).finish(NETWORK_ERROR);
    await expect(outcome).resolves.toBe('will_retry');
    expect((await getItem('a'))?.status).toBe('waiting');

    await expect(queue.discard('a')).resolves.toBe(true);
    expect(await listItems()).toEqual([]);
    expect(broadcasts.at(-1)).toEqual(changed('a', 'discarded'));
    expect(await badgeText()).toBe('');
    expect(await retryAlarmTime()).toBeUndefined();
  });

  // The check and the delete share one transaction, so a discard that races the drain's claim has exactly two possible
  // outcomes: removed before the claim (never uploaded), or refused after it (uploading, and it still lands). Whatever
  // the timing, the item is never removed while its upload runs. The delays sweep the discard across the drain's steps.
  it.each([0, 1, 2, 3, 4, 6, 8])(
    'a discard %i ticks after processing starts either removes the item before its upload or is refused',
    async (delay) => {
      const mailbox = manualMailbox();
      const queue = makeQueue({ save: mailbox.save });
      const first = queue.enqueue(newItem('a'));
      await until(() => mailbox.calls.length === 1, 'the first upload to start');
      mailbox.call(0).finish(NETWORK_ERROR);
      await first;
      // Let the drain that ran that attempt go idle, then back off for a minute: the item is due again now.
      await queue.processQueue();
      time += MINUTE;

      const processing = queue.processQueue();
      await ticks(delay);
      const discarded = await queue.discard('a');

      if (discarded) {
        // Removed before it was claimed: nothing was uploaded again.
        await processing;
        expect(mailbox.calls).toHaveLength(1);
        expect(await getItem('a')).toBeUndefined();
        expect(broadcasts.at(-1)).toEqual(changed('a', 'discarded'));
      } else {
        // The claim came first: the upload runs on and the item is untouched until it finishes.
        await until(() => mailbox.calls.length === 2, 'the second upload to start');
        expect((await getItem('a'))?.status).toBe('uploading');
        mailbox.call(1).finish(SUCCESS);
        await processing;
        expect(await getItem('a')).toBeUndefined();
        expect(broadcasts.map((message) => message.state)).not.toContain('discarded');
        expect(broadcasts.at(-1)).toEqual(changed('a', 'saved'));
      }
    },
  );

  it('does not bring back an item that was removed from storage during its upload', async () => {
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save });
    const outcome = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');

    // Only a safeguard: discard refuses an upload in flight, but the record could still vanish some other way.
    await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.delete('a');
      return () => undefined;
    });
    mailbox.call(0).finish(NETWORK_ERROR);
    await outcome;
    expect(await listItems()).toEqual([]);
    expect(await badgeText()).toBe('');
    expect(broadcasts.filter((message) => message.state === 'waiting')).toEqual([changed('a', 'waiting')]);
  });

  it('is harmless for an unknown item', async () => {
    await expect(makeQueue().discard('nope')).resolves.toBe(true);
    expect(broadcasts).toEqual([]);
  });
});

describe('keep-alive', () => {
  it('pings every 20 seconds during a long upload and stops when it settles', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const mailbox = manualMailbox();
    const outcome = makeQueue({ save: mailbox.save, keepAlivePing: ping }).enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');

    expect(KEEP_ALIVE_INTERVAL_MS).toBe(20_000);
    expect(ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40_000);
    expect(ping).toHaveBeenCalledTimes(3);

    mailbox.call(0).finish(SUCCESS);
    await outcome;
    vi.advanceTimersByTime(10 * MINUTE);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('a failing ping does not disturb the upload', async () => {
    const ping = vi.fn(() => Promise.reject(new Error('worker is shutting down')));
    const mailbox = manualMailbox();
    const outcome = makeQueue({ save: mailbox.save, keepAlivePing: ping }).enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');

    vi.advanceTimersByTime(20_000);
    expect(ping).toHaveBeenCalledTimes(1);
    mailbox.call(0).finish(SUCCESS);
    await expect(outcome).resolves.toBe('saved');
  });
});

describe('upload watchdog', () => {
  it('gives up on a save that never settles, a grace period after its timeout, and stops the keep-alive', async () => {
    const ping = vi.fn(() => Promise.resolve());
    const mailbox = manualMailbox();
    const queue = makeQueue({ save: mailbox.save, keepAlivePing: ping });
    const outcome = queue.enqueue(newItem('a'));
    await until(() => mailbox.calls.length === 1, 'the upload to start');
    const deadline = mailbox.call(0).timeoutMs + UPLOAD_WATCHDOG_GRACE_MS;

    vi.advanceTimersByTime(deadline - 1);
    await ticks(5);
    expect((await getItem('a'))?.status).toBe('uploading');

    vi.advanceTimersByTime(1);
    await expect(outcome).resolves.toBe('will_retry');
    expect(await getItem('a')).toMatchObject({ status: 'waiting', attempts: 1, lastError: 'timeout' });

    const pings = ping.mock.calls.length;
    vi.advanceTimersByTime(10 * MINUTE);
    expect(ping).toHaveBeenCalledTimes(pings);
  });
});

describe('module API', () => {
  it('refuses to process in a context that has not installed the processor', async () => {
    await expect(enqueue(newItem('a'))).rejects.toThrow(/background/);
    await expect(processQueue()).rejects.toThrow(/background/);
    await expect(retryNow()).rejects.toThrow(/background/);
    await expect(discard('a')).rejects.toThrow(/background/);
    // Storage-only calls still work anywhere.
    await addItem(newItem('a'));
    expect(await listItems()).toHaveLength(1);
  });

  it('routes calls to the processor installed by the background', async () => {
    const save = mailboxAnswering(NETWORK_ERROR, SUCCESS);
    // Real clock here: addItem stamps items with Date.now(), like any page that adds them.
    processors.push(installQueueProcessor({ save, getSettings: () => Promise.resolve(SETTINGS), now: () => Date.now() }));

    await expect(enqueue(newItem('a'))).resolves.toBe('will_retry');
    await retryNow('a');
    expect(await listItems()).toEqual([]);

    await addItem(newItem('b'));
    await processQueue();
    expect(savedIds(save)).toEqual(['a', 'a', 'b']);

    await addItem(newItem('c'));
    await expect(discard('c')).resolves.toBe(true);
    expect(await listItems()).toEqual([]);
  });
});
