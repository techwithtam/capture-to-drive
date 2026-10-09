// Note step in the background (spec section 6.4): startNoteStep stores the capture as pending and shows the in-page
// card (or the note window when the tab cannot host it); note:get / note:save / note:discard move the capture on.
// Browser APIs, the queue, and the thumbnail are injected, so every branch is driven directly; the pending store is
// the real one on fake-indexeddb.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteCardMessage, NoteSaveResponse } from '../lib/messages';
import { QUEUE_STORE, transact } from '../lib/db';
import {
  createNoteStep,
  MESSAGE_WINDOW_SIZE,
  NOTE_WINDOW_SIZE,
  REQUESTED_SAVE_MAX_AGE_MS,
  SHOW_CARD_TIMEOUT_MS,
} from '../lib/note-step';
import type { NoteStepDeps, StartNoteStepInput } from '../lib/note-step';
import { MAX_FILE_BYTES } from '../lib/mailbox-client';
import { NOTE_GONE_TEXT, SAVE_FAILED_TEXT } from '../lib/note-status';
import { getPending, listPending, putPending } from '../lib/pending-store';
import type { PendingRecord } from '../lib/pending-store';
import { addItem, getItem, listItems } from '../lib/queue';
import type { AttemptOutcome, NewQueueItem, QueueItem } from '../lib/queue';
import type { Settings } from '../lib/settings';
import { resetDatabase, ticks } from './helpers/queue-harness';

const SETTINGS: Settings = { mailboxUrl: 'https://script.google.com/macros/s/TEST/exec', key: 'test-key', name: 'Alex' };
// 2026-10-07 13:42:10 local time, so filename and description assertions do not depend on the machine's time zone.
const CAPTURED_AT = new Date(2026, 9, 7, 13, 42, 10).getTime();
const THUMBNAIL = 'data:image/png;base64,iVBORw0KGgo=';
const VISIBLE_AREA = "Selection isn't available on this page, so the visible area was captured.";

interface Harness {
  deps: NoteStepDeps;
  enqueue: ReturnType<typeof vi.fn<(item: NewQueueItem) => Promise<AttemptOutcome>>>;
  injectCard: ReturnType<typeof vi.fn<(tabId: number) => Promise<void>>>;
  sendToCard: ReturnType<typeof vi.fn<(tabId: number, message: NoteCardMessage) => Promise<unknown>>>;
  openWindow: ReturnType<typeof vi.fn<(query: string, size: { width: number; height: number }) => Promise<void>>>;
  openOptionsPage: ReturnType<typeof vi.fn<() => Promise<void>>>;
  makeThumbnail: ReturnType<typeof vi.fn<(blob: Blob) => Promise<string>>>;
  addToQueue: ReturnType<typeof vi.fn<(item: NewQueueItem) => Promise<void>>>;
  processQueue: ReturnType<typeof vi.fn<() => Promise<void>>>;
  queueItems: Map<string, QueueItem>;
}

function harness(overrides: Partial<NoteStepDeps> = {}): Harness {
  let nextId = 0;
  const queueItems = new Map<string, QueueItem>();
  const h = {
    enqueue: vi.fn(async (_item: NewQueueItem): Promise<AttemptOutcome> => 'saved'),
    injectCard: vi.fn(async (_tabId: number) => undefined),
    sendToCard: vi.fn(async (_tabId: number, _message: NoteCardMessage): Promise<unknown> => ({ ok: true })),
    openWindow: vi.fn(async (_query: string, _size: { width: number; height: number }) => undefined),
    openOptionsPage: vi.fn(async () => undefined),
    makeThumbnail: vi.fn(async (_blob: Blob) => THUMBNAIL),
    addToQueue: vi.fn(async (item: NewQueueItem) => {
      if (queueItems.has(item.captureId)) throw new DOMException('Key already exists in the object store.', 'ConstraintError');
      queueItems.set(item.captureId, queueItem(item));
    }),
    processQueue: vi.fn(async () => undefined),
    queueItems,
  };
  const deps: NoteStepDeps = {
    getSettings: async () => SETTINGS,
    openOptionsPage: h.openOptionsPage,
    enqueue: h.enqueue,
    getQueueItem: async (captureId) => queueItems.get(captureId),
    now: () => CAPTURED_AT,
    newCaptureId: () => {
      nextId += 1;
      return `capture-${nextId}`;
    },
    makeThumbnail: h.makeThumbnail,
    injectCard: h.injectCard,
    sendToCard: h.sendToCard,
    openWindow: h.openWindow,
    addToQueue: h.addToQueue,
    processQueue: h.processQueue,
    showCardTimeoutMs: SHOW_CARD_TIMEOUT_MS,
    ...overrides,
  };
  return { ...h, deps };
}

function areaCapture(overrides: Partial<StartNoteStepInput> = {}): StartNoteStepInput {
  return {
    tabId: 7,
    blob: new Blob(['png bytes'], { type: 'image/png' }),
    mimeType: 'image/png',
    captureType: 'area',
    source: 'costco.com',
    label: 'Orders | Costco',
    title: 'Orders | Costco',
    url: 'https://www.costco.com/OrderStatusCmd',
    ...overrides,
  };
}

function pendingRecord(captureId: string, overrides: Partial<PendingRecord> = {}): PendingRecord {
  return {
    captureId,
    capturedAt: CAPTURED_AT,
    blob: new Blob([`bytes of ${captureId}`], { type: 'image/png' }),
    mimeType: 'image/png',
    filename: `2026-10-07 13.42 Alex - costco.com - ${captureId}.png`,
    meta: { title: 'Orders | Costco', url: 'https://www.costco.com/OrderStatusCmd', captureType: 'area', capturedBy: 'Alex' },
    fileKind: 'image',
    ...overrides,
  };
}

const EXPECTED_FILENAME = '2026-10-07 13.42 Alex - costco.com - Orders Costco.png';

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startNoteStep', () => {
  it('opens Settings and stores nothing when settings are missing', async () => {
    const h = harness({ getSettings: async () => null });
    await createNoteStep(h.deps).start(areaCapture());

    expect(h.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(await listPending()).toEqual([]);
    expect(h.injectCard).not.toHaveBeenCalled();
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  // One check for every capture flow, screenshots included, before anything is stored.
  it('turns a capture over the size limit away with the size message, and stores nothing', async () => {
    const h = harness();
    const blob = new Blob([new Uint8Array(MAX_FILE_BYTES + 1)], { type: 'image/png' });
    await createNoteStep(h.deps).start(areaCapture({ blob }));

    expect(h.sendToCard).toHaveBeenCalledExactlyOnceWith(7, {
      type: 'note:message',
      message: 'Too big for the mailbox (max 20 MB). Drag it into Drive directly.',
      kind: 'error',
    });
    expect(await listPending()).toEqual([]);
    expect(h.makeThumbnail).not.toHaveBeenCalled();
    expect(h.sendToCard.mock.calls.some(([, message]) => message.type === 'note:show')).toBe(false);
  });

  it('shows the size message in the note window when there is no tab', async () => {
    const h = harness();
    const blob = new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]);
    await createNoteStep(h.deps).start(areaCapture({ tabId: undefined, blob, mimeType: 'application/pdf' }));

    expect(h.openWindow).toHaveBeenCalledExactlyOnceWith(
      new URLSearchParams({ message: 'Too big for the mailbox (max 20 MB). Drag it into Drive directly.', kind: 'error' }).toString(),
      MESSAGE_WINDOW_SIZE,
    );
    expect(await listPending()).toEqual([]);
  });

  it('accepts a capture of exactly the size limit', async () => {
    const h = harness();
    const blob = new Blob([new Uint8Array(MAX_FILE_BYTES)], { type: 'application/pdf' });
    await createNoteStep(h.deps).start(areaCapture({ blob, mimeType: 'application/pdf' }));
    expect((await listPending()).map((record) => record.captureId)).toEqual(['capture-1']);
  });

  it('stores the capture as a pending record with everything the save needs', async () => {
    const h = harness();
    const blob = new Blob(['png bytes'], { type: 'image/png' });
    await createNoteStep(h.deps).start(areaCapture({ blob, message: VISIBLE_AREA, captureType: 'visible' }));

    const record = await getPending('capture-1');
    expect(record).toMatchObject({
      captureId: 'capture-1',
      capturedAt: CAPTURED_AT,
      mimeType: 'image/png',
      filename: EXPECTED_FILENAME,
      meta: {
        title: 'Orders | Costco',
        url: 'https://www.costco.com/OrderStatusCmd',
        captureType: 'visible',
        capturedBy: 'Alex',
      },
      fileKind: 'image',
      thumbnailDataUrl: THUMBNAIL,
      message: VISIBLE_AREA,
    });
    expect(await record?.blob.text()).toBe('png bytes');
    expect(h.makeThumbnail).toHaveBeenCalledWith(blob);
  });

  it('builds the filename with the Settings name, the original filename, and the MIME type', async () => {
    const h = harness({ getSettings: async () => ({ ...SETTINGS, name: 'Mai' }) });
    await createNoteStep(h.deps).start(
      areaCapture({
        mimeType: 'application/pdf',
        blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
        captureType: 'pdf',
        source: 'irs.gov',
        label: 'f1040',
        originalFilename: 'f1040.pdf',
      }),
    );

    const record = await getPending('capture-1');
    expect(record?.filename).toBe('2026-10-07 13.42 Mai - irs.gov - f1040.pdf');
    expect(record?.meta.capturedBy).toBe('Mai');
    expect(record?.fileKind).toBe('pdf');
    expect(record?.thumbnailDataUrl).toBeUndefined();
  });

  it('makes thumbnails for images only', async () => {
    const h = harness();
    const step = createNoteStep(h.deps);
    await step.start(areaCapture({ mimeType: 'application/pdf', captureType: 'page-pdf' }));
    await step.start(areaCapture({ mimeType: 'text/csv', captureType: 'link' }));

    expect(h.makeThumbnail).not.toHaveBeenCalled();
    expect((await getPending('capture-2'))?.fileKind).toBe('file');
  });

  it('still shows the card, without a thumbnail, when the image cannot be decoded', async () => {
    const h = harness();
    h.makeThumbnail.mockRejectedValue(new Error('The source image could not be decoded.'));
    await createNoteStep(h.deps).start(areaCapture({ mimeType: 'image/svg+xml' }));

    expect((await getPending('capture-1'))?.thumbnailDataUrl).toBeUndefined();
    expect(h.sendToCard).toHaveBeenCalledWith(7, {
      type: 'note:show',
      captureId: 'capture-1',
      filename: '2026-10-07 13.42 Alex - costco.com - Orders Costco.bin',
      fileKind: 'image',
    });
  });

  it('injects the card into the tab and sends it what to show, without opening a window', async () => {
    const h = harness();
    await createNoteStep(h.deps).start(areaCapture({ message: VISIBLE_AREA }));

    expect(h.injectCard).toHaveBeenCalledWith(7);
    expect(h.sendToCard).toHaveBeenCalledWith(7, {
      type: 'note:show',
      captureId: 'capture-1',
      filename: EXPECTED_FILENAME,
      fileKind: 'image',
      thumbnailDataUrl: THUMBNAIL,
      message: VISIBLE_AREA,
    });
    expect(h.injectCard.mock.invocationCallOrder[0]).toBeLessThan(h.sendToCard.mock.invocationCallOrder[0] ?? 0);
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  it('stores the capture before making the thumbnail, then adds the thumbnail to it', async () => {
    const h = harness();
    let storedBeforeThumbnail: PendingRecord | undefined;
    h.makeThumbnail.mockImplementation(async () => {
      storedBeforeThumbnail = await getPending('capture-1');
      return THUMBNAIL;
    });
    await createNoteStep(h.deps).start(areaCapture());

    expect(storedBeforeThumbnail?.captureId).toBe('capture-1');
    expect(storedBeforeThumbnail?.thumbnailDataUrl).toBeUndefined();
    expect((await getPending('capture-1'))?.thumbnailDataUrl).toBe(THUMBNAIL);
  });

  it('keeps the capture when making the thumbnail throws synchronously', async () => {
    const h = harness();
    h.makeThumbnail.mockImplementation(() => {
      throw new Error('OffscreenCanvas is not defined');
    });
    await createNoteStep(h.deps).start(areaCapture());
    expect((await getPending('capture-1'))?.captureId).toBe('capture-1');
    expect(h.sendToCard).toHaveBeenCalledTimes(1);
  });

  it('stores the pending record before showing anything', async () => {
    const h = harness();
    let storedWhenShown: PendingRecord | undefined;
    h.injectCard.mockImplementation(async () => {
      storedWhenShown = await getPending('capture-1');
    });
    await createNoteStep(h.deps).start(areaCapture());
    expect(storedWhenShown?.captureId).toBe('capture-1');
  });

  it('opens the note window when there is no tab', async () => {
    const h = harness();
    await createNoteStep(h.deps).start(areaCapture({ tabId: undefined }));

    expect(h.injectCard).not.toHaveBeenCalled();
    expect(h.openWindow).toHaveBeenCalledWith('id=capture-1', NOTE_WINDOW_SIZE);
    expect(NOTE_WINDOW_SIZE.width).toBe(420);
  });

  it('opens the note window when the card script cannot be injected (browser pages, the web store)', async () => {
    const h = harness();
    h.injectCard.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    await createNoteStep(h.deps).start(areaCapture());

    expect(h.sendToCard).not.toHaveBeenCalled();
    expect(h.openWindow).toHaveBeenCalledWith('id=capture-1', NOTE_WINDOW_SIZE);
  });

  it('opens the note window when the card cannot be reached', async () => {
    const h = harness();
    h.sendToCard.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    await createNoteStep(h.deps).start(areaCapture());
    expect(h.openWindow).toHaveBeenCalledWith('id=capture-1', NOTE_WINDOW_SIZE);
  });

  it.each([[{ ok: false }], [undefined], ['yes']])('opens the note window when the card answers %j', async (answer) => {
    const h = harness();
    h.sendToCard.mockResolvedValue(answer);
    await createNoteStep(h.deps).start(areaCapture());
    expect(h.openWindow).toHaveBeenCalledTimes(1);
  });

  it('opens the note window when injection hangs (page blocked by a dialog), and never shows the card late', async () => {
    // A short real timeout: fake timers would also freeze fake-indexeddb's own scheduling.
    const h = harness({ showCardTimeoutMs: 20 });
    let finishInjection: () => void = () => undefined;
    h.injectCard.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInjection = resolve;
        }),
    );
    await createNoteStep(h.deps).start(areaCapture());
    expect(h.openWindow).toHaveBeenCalledWith('id=capture-1', NOTE_WINDOW_SIZE);

    finishInjection();
    await ticks(5);
    expect(h.sendToCard).not.toHaveBeenCalled();
  });

  it('waits 5 seconds for the card by default', () => {
    expect(SHOW_CARD_TIMEOUT_MS).toBe(5000);
  });

  it('gives every capture its own id', async () => {
    const h = harness();
    const step = createNoteStep(h.deps);
    await step.start(areaCapture());
    await step.start(areaCapture());
    expect((await listPending()).map((record) => record.captureId)).toEqual(['capture-1', 'capture-2']);
  });

  it('rejects, and shows nothing, when the capture cannot be stored', async () => {
    const h = harness({ newCaptureId: () => 'taken' });
    await putPending(pendingRecord('taken'));
    await expect(createNoteStep(h.deps).start(areaCapture())).rejects.toThrow();
    expect(h.injectCard).not.toHaveBeenCalled();
    expect(h.openWindow).not.toHaveBeenCalled();
  });
});

describe('showMessage', () => {
  it('shows the message in the card', async () => {
    const h = harness();
    await createNoteStep(h.deps).showMessage(7, "This page can't be saved. Try Select area instead.", 'error');

    expect(h.injectCard).toHaveBeenCalledWith(7);
    expect(h.sendToCard).toHaveBeenCalledWith(7, {
      type: 'note:message',
      message: "This page can't be saved. Try Select area instead.",
      kind: 'error',
    });
    expect(h.openWindow).not.toHaveBeenCalled();
  });

  it('falls back to the note window with the message when the tab cannot host the card', async () => {
    const h = harness();
    h.injectCard.mockRejectedValue(new Error('Cannot access contents of the page.'));
    await createNoteStep(h.deps).showMessage(7, 'That link opens a web page, not a file.', 'error');

    const [query, size] = h.openWindow.mock.calls[0] ?? [];
    const params = new URLSearchParams(query);
    expect(params.get('message')).toBe('That link opens a web page, not a file.');
    expect(params.get('kind')).toBe('error');
    expect(params.has('id')).toBe(false);
    expect(size).toEqual(MESSAGE_WINDOW_SIZE);
  });

  it('opens the note window when there is no tab', async () => {
    const h = harness();
    await createNoteStep(h.deps).showMessage(undefined, 'Saved for later.', 'info');
    expect(h.injectCard).not.toHaveBeenCalled();
    expect(new URLSearchParams(h.openWindow.mock.calls[0]?.[0]).get('kind')).toBe('info');
  });
});

describe('note:get', () => {
  it('returns what the note UI shows for a pending capture', async () => {
    await putPending(pendingRecord('a', { thumbnailDataUrl: THUMBNAIL, message: VISIBLE_AREA }));
    const step = createNoteStep(harness().deps);

    expect(await step.handle({ type: 'note:get', captureId: 'a' })).toEqual({
      capture: {
        captureId: 'a',
        filename: '2026-10-07 13.42 Alex - costco.com - a.png',
        fileKind: 'image',
        thumbnailDataUrl: THUMBNAIL,
        message: VISIBLE_AREA,
      },
    });
  });

  it('returns null for a capture that is no longer pending', async () => {
    const step = createNoteStep(harness().deps);
    expect(await step.handle({ type: 'note:get', captureId: 'gone' })).toEqual({ capture: null });
  });
});

describe('note:save', () => {
  it('builds the description with the note, enqueues the capture, deletes the pending record, and answers saved', async () => {
    const record = pendingRecord('a');
    await putPending(record);
    const h = harness();

    const response = await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '  Costco, for taxes ' });

    expect(response).toEqual({ outcome: 'saved' });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const item = h.enqueue.mock.calls[0]?.[0];
    expect(item).toMatchObject({ captureId: 'a', filename: record.filename, mimeType: 'image/png' });
    expect(await item?.blob.text()).toBe('bytes of a');
    expect(item?.description).toBe(
      [
        'Note: Costco, for taxes',
        'Title: Orders | Costco',
        'URL: https://www.costco.com/OrderStatusCmd',
        'Captured by: Alex',
        `Captured at: ${expectedLocalIso(CAPTURED_AT)}`,
        'Capture type: area',
        'Capture ID: a',
      ].join('\n'),
    );
    expect(await getPending('a')).toBeUndefined();
  });

  it('records the Save, with the note, before queueing the capture', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    let storedWhenQueued: PendingRecord | undefined;
    h.enqueue.mockImplementation(async () => {
      storedWhenQueued = await getPending('a');
      return 'saved';
    });
    await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: 'For taxes' });
    expect(storedWhenQueued).toMatchObject({ saveRequested: true, note: 'For taxes' });
  });

  it('leaves the Note line out when the note is empty', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '   ' });
    expect(h.enqueue.mock.calls[0]?.[0].description.startsWith('Title: Orders | Costco\n')).toBe(true);
  });

  it('answers will_retry when the first attempt failed transiently', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    h.enqueue.mockResolvedValue('will_retry');
    expect(await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '' })).toEqual({
      outcome: 'will_retry',
    });
    expect(await getPending('a')).toBeUndefined();
  });

  it("answers needs_attention with the queue item's message", async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    h.enqueue.mockImplementation(async (item) => {
      h.queueItems.set(item.captureId, queueItem(item, { status: 'needs_attention', lastError: 'unauthorized', lastMessage: 'Mailbox key was rejected. Check Settings.' }));
      return 'needs_attention';
    });

    expect(await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '' })).toEqual({
      outcome: 'needs_attention',
      message: 'Mailbox key was rejected. Check Settings.',
    });
  });

  it('answers that the capture is gone when it is no longer pending', async () => {
    const h = harness();
    expect(await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'gone', note: 'x' })).toEqual({
      outcome: 'needs_attention',
      message: NOTE_GONE_TEXT,
    });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues once when Save arrives twice, and gives both the same answer', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    const step = createNoteStep(h.deps);
    const [first, second] = await Promise.all([
      step.handle({ type: 'note:save', captureId: 'a', note: 'one' }),
      step.handle({ type: 'note:save', captureId: 'a', note: 'two' }),
    ]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ outcome: 'saved' });
    expect(second).toEqual(first);
  });

  it('ignores a discard that arrives while the save is in progress', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    let finishUpload: (outcome: AttemptOutcome) => void = () => undefined;
    h.enqueue.mockImplementation(
      () =>
        new Promise<AttemptOutcome>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const step = createNoteStep(h.deps);
    const saving = step.handle({ type: 'note:save', captureId: 'a', note: 'keep me' });
    await vi.waitFor(() => expect(h.enqueue).toHaveBeenCalled());

    expect(await step.handle({ type: 'note:discard', captureId: 'a' })).toEqual({ ok: true });
    expect(await getPending('a')).toBeDefined();
    finishUpload('saved');
    expect(await saving).toEqual({ outcome: 'saved' });
    expect(await getPending('a')).toBeUndefined();
  });

  it('keeps the pending record and answers with a failure when the capture cannot be queued', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await putPending(pendingRecord('a'));
    const h = harness();
    h.enqueue.mockRejectedValue(new Error('QuotaExceededError'));

    const response: NoteSaveResponse = await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '' });
    expect(response).toEqual({ outcome: 'needs_attention', message: SAVE_FAILED_TEXT });
    expect(await getPending('a')).toBeDefined();
    expect(error).toHaveBeenCalled();
  });

  it('clears the Save request when the save failed, so the next start does not quietly queue a second copy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await putPending(pendingRecord('a'));
    const h = harness();
    h.enqueue.mockRejectedValue(new Error('QuotaExceededError'));
    const step = createNoteStep(h.deps);

    await step.handle({ type: 'note:save', captureId: 'a', note: 'told to capture again' });
    const kept = await getPending('a');
    expect(kept?.saveRequested).toBeUndefined();
    expect(kept?.note).toBeUndefined();

    // The next worker start leaves it alone; the 24-hour cleanup will delete it like any abandoned capture.
    expect(await step.recoverPending()).toEqual({ requeued: 0, deleted: 0 });
    expect(h.addToQueue).not.toHaveBeenCalled();
  });

  it('treats a capture the queue already holds as queued (a repeated save after a worker restart)', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    h.queueItems.set('a', queueItem({ captureId: 'a', filename: 'a.png', mimeType: 'image/png', description: '', blob: new Blob() }));
    h.enqueue.mockRejectedValue(new DOMException('Key already exists in the object store.', 'ConstraintError'));

    expect(await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '' })).toEqual({
      outcome: 'will_retry',
    });
    expect(await getPending('a')).toBeUndefined();
  });

  it('uses the capture time and name stored with the capture, not the current ones', async () => {
    await putPending(pendingRecord('a', { capturedAt: CAPTURED_AT, meta: { captureType: 'pdf', capturedBy: 'Mai' } }));
    const h = harness({ now: () => CAPTURED_AT + 5 * 60_000, getSettings: async () => SETTINGS });
    await createNoteStep(h.deps).handle({ type: 'note:save', captureId: 'a', note: '' });

    expect(h.enqueue.mock.calls[0]?.[0].description).toBe(
      ['Captured by: Mai', `Captured at: ${expectedLocalIso(CAPTURED_AT)}`, 'Capture type: pdf', 'Capture ID: a'].join('\n'),
    );
  });
});

describe('note:discard', () => {
  it('deletes the pending record', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    expect(await createNoteStep(h.deps).handle({ type: 'note:discard', captureId: 'a' })).toEqual({ ok: true });
    expect(await getPending('a')).toBeUndefined();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('keeps a capture whose Save was already requested (Save came first, even across a worker restart)', async () => {
    await putPending(pendingRecord('a', { saveRequested: true, note: 'keep me' }));
    const h = harness();
    expect(await createNoteStep(h.deps).handle({ type: 'note:discard', captureId: 'a' })).toEqual({ ok: true });
    expect(await getPending('a')).toMatchObject({ saveRequested: true });
  });

  it('is fine with a capture that is already gone', async () => {
    expect(await createNoteStep(harness().deps).handle({ type: 'note:discard', captureId: 'gone' })).toEqual({ ok: true });
  });
});

describe('recoverPending (worker start)', () => {
  const day = 24 * 60 * 60 * 1000;

  it('deletes pending captures older than 24 hours', async () => {
    await putPending(pendingRecord('old', { capturedAt: CAPTURED_AT - day - 1 }));
    await putPending(pendingRecord('new', { capturedAt: CAPTURED_AT - 1000 }));
    const h = harness();
    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 0, deleted: 1 });
    expect((await listPending()).map((record) => record.captureId)).toEqual(['new']);
    expect(h.processQueue).not.toHaveBeenCalled();
  });

  it('queues a capture whose Save was requested but never queued (the worker stopped in between)', async () => {
    await putPending(pendingRecord('a', { saveRequested: true, note: 'For taxes' }));
    await putPending(pendingRecord('b'));
    const h = harness();

    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 1, deleted: 0 });

    expect(h.addToQueue).toHaveBeenCalledTimes(1);
    const item = h.addToQueue.mock.calls[0]?.[0];
    expect(item).toMatchObject({ captureId: 'a', filename: pendingRecord('a').filename, mimeType: 'image/png' });
    expect(item?.description.split('\n')[0]).toBe('Note: For taxes');
    expect(item?.description).toContain(`Captured at: ${expectedLocalIso(CAPTURED_AT)}`);
    expect(await item?.blob.text()).toBe('bytes of a');
    expect(await getPending('a')).toBeUndefined();
    expect(await getPending('b')).toBeDefined();
    expect(h.processQueue).toHaveBeenCalledTimes(1);
  });

  it('queues a requested capture before the 24-hour cleanup, so an old one is saved, not deleted', async () => {
    await putPending(pendingRecord('old-requested', { capturedAt: CAPTURED_AT - 3 * day, saveRequested: true, note: '' }));
    await putPending(pendingRecord('old-abandoned', { capturedAt: CAPTURED_AT - 3 * day }));
    const h = harness();
    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 1, deleted: 1 });
    expect(h.queueItems.has('old-requested')).toBe(true);
    expect(await listPending()).toEqual([]);
  });

  it('only deletes the pending copy when the queue already holds the capture (queued, then the worker stopped)', async () => {
    await putPending(pendingRecord('a', { saveRequested: true, note: 'x' }));
    const h = harness();
    h.queueItems.set('a', queueItem({ captureId: 'a', filename: 'a.png', mimeType: 'image/png', description: '', blob: new Blob() }));

    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 0, deleted: 0 });
    expect(await getPending('a')).toBeUndefined();
    expect(h.queueItems.get('a')?.description).toBe('');
  });

  it('only deletes the pending copy when the queue holds the capture, whatever error adding it reports', async () => {
    await putPending(pendingRecord('a', { saveRequested: true, note: 'x' }));
    const h = harness();
    h.queueItems.set('a', queueItem({ captureId: 'a', filename: 'a.png', mimeType: 'image/png', description: 'first', blob: new Blob() }));
    // What lib/db.ts reported before it passed IndexedDB's own error through.
    h.addToQueue.mockRejectedValue(new Error('IndexedDB transaction failed.'));

    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 0, deleted: 0 });
    expect(await getPending('a')).toBeUndefined();
  });

  it('with the real queue store: a capture queued before the stop is not added twice', async () => {
    await addItem({ captureId: 'a', filename: 'a.png', mimeType: 'image/png', description: 'queued before the stop', blob: new Blob(['x']) });
    await putPending(pendingRecord('a', { saveRequested: true, note: 'x' }));
    const step = createNoteStep(harness({ addToQueue: addItem, getQueueItem: getItem }).deps);

    expect(await step.recoverPending()).toEqual({ requeued: 0, deleted: 0 });
    expect(await getPending('a')).toBeUndefined();
    expect((await listItems()).map((item) => item.description)).toEqual(['queued before the stop']);
  });

  it('with the real queue store: a queue item the user discarded after the stop does not come back', async () => {
    await addItem({ captureId: 'a', filename: 'a.png', mimeType: 'image/png', description: 'queued before the stop', blob: new Blob(['x']) });
    await putPending(pendingRecord('a', { saveRequested: true, note: 'x' }));
    const deps = harness({ addToQueue: addItem, getQueueItem: getItem }).deps;

    // Worker start 1, then the user discards the queue item (or it uploads and leaves the queue).
    await createNoteStep(deps).recoverPending();
    await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.delete('a');
      return () => undefined;
    });
    // Worker start 2.
    expect(await createNoteStep(deps).recoverPending()).toEqual({ requeued: 0, deleted: 0 });
    expect(await listItems()).toEqual([]);
  });

  it('deletes, with a warning, a requested save it has not managed to queue for 7 days', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(REQUESTED_SAVE_MAX_AGE_MS).toBe(7 * day);
    await putPending(pendingRecord('stuck', { capturedAt: CAPTURED_AT - 7 * day - 1, saveRequested: true, note: 'x' }));
    await putPending(pendingRecord('broken', { capturedAt: Number.NaN, saveRequested: true, note: 'x' }));
    await putPending(pendingRecord('recent', { capturedAt: CAPTURED_AT - 6 * day, saveRequested: true, note: 'y' }));
    const h = harness();

    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 1, deleted: 2 });
    expect(h.addToQueue.mock.calls.map(([item]) => item.captureId)).toEqual(['recent']);
    expect(await listPending()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps a requested capture it could not queue, for the next worker start, and still cleans up the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await putPending(pendingRecord('a', { capturedAt: CAPTURED_AT - 3 * day, saveRequested: true, note: 'x' }));
    await putPending(pendingRecord('old', { capturedAt: CAPTURED_AT - 3 * day }));
    const h = harness();
    h.addToQueue.mockRejectedValue(new Error('QuotaExceededError'));

    expect(await createNoteStep(h.deps).recoverPending()).toEqual({ requeued: 0, deleted: 1 });
    expect(await getPending('a')).toMatchObject({ saveRequested: true });
    expect(error).toHaveBeenCalled();
  });

  it('does not run alongside a save of the same capture', async () => {
    await putPending(pendingRecord('a'));
    const h = harness();
    let finishUpload: (outcome: AttemptOutcome) => void = () => undefined;
    h.enqueue.mockImplementation(
      () =>
        new Promise<AttemptOutcome>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const step = createNoteStep(h.deps);
    const saving = step.handle({ type: 'note:save', captureId: 'a', note: 'live' });
    await vi.waitFor(() => expect(h.enqueue).toHaveBeenCalled());

    // The record is marked requested now, but this worker is still saving it.
    expect(await step.recoverPending()).toEqual({ requeued: 0, deleted: 0 });
    expect(h.addToQueue).not.toHaveBeenCalled();
    finishUpload('saved');
    await saving;
  });
});

function queueItem(item: NewQueueItem, overrides: Partial<QueueItem> = {}): QueueItem {
  return { ...item, createdAt: CAPTURED_AT, attempts: 1, nextAttemptAt: CAPTURED_AT, status: 'waiting', ...overrides };
}

/** The local ISO time buildDescription writes (same algorithm, checked independently in description.test.ts). */
function expectedLocalIso(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
