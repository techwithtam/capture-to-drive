import { describe, expect, it, vi } from 'vitest';
import { toLocalIsoString } from '../lib/description';
import { MAX_FILE_BYTES } from '../lib/mailbox-client';
import type { QueueChangedMessage } from '../lib/messages';
import {
  ADDING_ROW_STATE,
  ALL_QUEUED_MESSAGE,
  ANNOUNCEMENT_PREFIX_LIFETIME_MS,
  buildUploadRecord,
  checkFileSize,
  formatFileSize,
  rowStateFromBroadcast,
  SOME_QUEUED_MESSAGE,
  START_FAILED_MESSAGE,
  statusAnnouncementPrefix,
  storeBatch,
  uploadRejection,
  WAITING_ROW_STATE,
} from '../lib/upload-batch';

const capturedAt = new Date(2026, 9, 7, 13, 42, 10);
const captureId = 'test-upload-id';

describe('checkFileSize', () => {
  it.each([0, 1, MAX_FILE_BYTES - 1, MAX_FILE_BYTES])('accepts %i bytes', (bytes) => {
    expect(checkFileSize(bytes)).toBeNull();
  });

  it.each([MAX_FILE_BYTES + 1, MAX_FILE_BYTES * 2])('rejects %i bytes with the exact mailbox message', (bytes) => {
    expect(checkFileSize(bytes)).toBe('Too big for the mailbox (max 20 MB). Drag it into Drive directly.');
  });
});

// Spec 6.3 D.4 and D.5: rejected files show "Failed: reason" immediately. Empty files are rejected before they
// reach the mailbox, where they would receive a less useful bad_request response ("capture it again").
describe('uploadRejection', () => {
  it.each([1, MAX_FILE_BYTES - 1, MAX_FILE_BYTES])('accepts %i bytes', (bytes) => {
    expect(uploadRejection(bytes)).toBeNull();
  });

  it.each([MAX_FILE_BYTES + 1, MAX_FILE_BYTES * 2])('rejects %i bytes with the Failed: size message', (bytes) => {
    expect(uploadRejection(bytes)).toBe('Failed: Too big for the mailbox (max 20 MB). Drag it into Drive directly.');
  });

  it('rejects an empty file on the spot', () => {
    expect(uploadRejection(0)).toBe('Failed: This file is empty.');
  });
});

// Closing the tab right after a drop could leave stored files waiting for the next alarm or browser start.
describe('storeBatch', () => {
  function recorder(options: { failStore?: Set<string>; kick?: () => Promise<void> } = {}) {
    const events: string[] = [];
    const deps = {
      store: vi.fn(async (item: string) => {
        events.push(`store ${item}`);
        if (options.failStore?.has(item)) throw new Error('quota');
      }),
      kick: vi.fn(async () => {
        events.push('kick');
        await options.kick?.();
      }),
      onStored: vi.fn((item: string) => {
        events.push(`stored ${item}`);
      }),
      onStoreFailed: vi.fn((item: string) => {
        events.push(`failed ${item}`);
      }),
    };
    return { events, deps };
  }

  it('asks the background to start right after the first file is stored, and again after the batch', async () => {
    const { events, deps } = recorder();
    await expect(storeBatch(['a', 'b', 'c'], deps)).resolves.toEqual({ stored: 3, started: true });
    expect(events).toEqual(['store a', 'stored a', 'kick', 'store b', 'stored b', 'store c', 'stored c', 'kick']);
  });

  it('does not wait for the early start, which only finishes once the uploads have run', async () => {
    let finishEarly: () => void = () => undefined;
    let kicks = 0;
    const { events, deps } = recorder({
      kick: () => {
        kicks += 1;
        return kicks === 1 ? new Promise<void>((resolve) => { finishEarly = resolve; }) : Promise.resolve();
      },
    });
    await expect(storeBatch(['a', 'b'], deps)).resolves.toEqual({ stored: 2, started: true });
    expect(events).toEqual(['store a', 'stored a', 'kick', 'store b', 'stored b', 'kick']);
    finishEarly();
  });

  it('sends one start for a single file', async () => {
    const { events, deps } = recorder();
    await storeBatch(['a'], deps);
    expect(events).toEqual(['store a', 'stored a', 'kick']);
  });

  it('starts after the first file that was stored, and reports the ones that were not', async () => {
    const { events, deps } = recorder({ failStore: new Set(['a']) });
    await expect(storeBatch(['a', 'b', 'c'], deps)).resolves.toEqual({ stored: 2, started: true });
    expect(events).toEqual(['store a', 'failed a', 'store b', 'stored b', 'kick', 'store c', 'stored c', 'kick']);
  });

  // The page turns Adding… into Waiting on this call, so it has to come as soon as the file is in the queue.
  it('reports each file as stored before the next one is started on, and never reports a failed one as stored', async () => {
    const { events, deps } = recorder({ failStore: new Set(['b']) });
    await storeBatch(['a', 'b', 'c'], deps);
    expect(deps.onStored.mock.calls).toEqual([['a'], ['c']]);
    expect(deps.onStoreFailed.mock.calls).toEqual([['b']]);
    expect(events.indexOf('stored a')).toBe(events.indexOf('store a') + 1);
  });

  it('reports the last file as stored before the final start is asked for, which can take the whole upload', async () => {
    let finishFinalStart: () => void = () => undefined;
    let kicks = 0;
    const { events, deps } = recorder({
      kick: () => {
        kicks += 1;
        return kicks === 2 ? new Promise<void>((resolve) => { finishFinalStart = resolve; }) : Promise.resolve();
      },
    });
    const batch = storeBatch(['a', 'b'], deps);
    await vi.waitFor(() => expect(events).toEqual(['store a', 'stored a', 'kick', 'store b', 'stored b', 'kick']));
    finishFinalStart();
    await expect(batch).resolves.toEqual({ stored: 2, started: true });
  });

  it('sends nothing when no file could be stored', async () => {
    const { events, deps } = recorder({ failStore: new Set(['a', 'b']) });
    await expect(storeBatch(['a', 'b'], deps)).resolves.toEqual({ stored: 0, started: null });
    expect(deps.kick).not.toHaveBeenCalled();
    expect(events).toEqual(['store a', 'failed a', 'store b', 'failed b']);
    expect(deps.onStored).not.toHaveBeenCalled();
  });

  it('reports a final start that failed, and swallows a failed early one', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { deps } = recorder({ kick: () => Promise.reject(new Error('no background')) });
      await expect(storeBatch(['a', 'b'], deps)).resolves.toEqual({ stored: 2, started: false });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('survives a kick that throws instead of rejecting', async () => {
    const { deps } = recorder();
    deps.kick.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    await expect(storeBatch(['a', 'b'], deps)).resolves.toEqual({ stored: 2, started: false });
  });
});

describe('buildUploadRecord', () => {
  it('builds an upload filename and description and keeps the original file bytes', async () => {
    const file = new File(['original bytes'], 'statement-sept.pdf', { type: 'application/pdf' });
    const record = buildUploadRecord({ file, capturedAt, captureId, name: 'Alex', note: 'For taxes' });

    expect(record).toEqual({
      captureId,
      filename: '2026-10-07 13.42 Alex - upload - statement-sept.pdf',
      mimeType: 'application/pdf',
      description: [
        'Note: For taxes',
        'Captured by: Alex',
        `Captured at: ${toLocalIsoString(capturedAt)}`,
        'Capture type: upload',
        `Capture ID: ${captureId}`,
      ].join('\n'),
      blob: file,
    });
    expect(record.blob).toBe(file);
    expect(await record.blob.text()).toBe('original bytes');
  });

  it('uses the MIME type for the extension and strips only the final original extension', () => {
    const file = new File(['image'], 'receipt.final.data', { type: 'image/png' });
    const record = buildUploadRecord({ file, capturedAt, captureId, name: 'Alex' });
    expect(record.filename).toBe('2026-10-07 13.42 Alex - upload - receipt.final.png');
    expect(record.mimeType).toBe('image/png');
    expect(record.description).toContain('Captured by: Alex\n');
    expect(record.description).not.toContain('Note:');
    expect(record.description).not.toContain('Title:');
    expect(record.description).not.toContain('URL:');
  });

  it('falls back to application/octet-stream and preserves an unrecognised original extension', () => {
    const file = new File(['bytes'], 'archive.backup.zip');
    const record = buildUploadRecord({ file, capturedAt, captureId, name: 'Alex' });
    expect(record.mimeType).toBe('application/octet-stream');
    expect(record.filename).toBe('2026-10-07 13.42 Alex - upload - archive.backup.zip');
  });

  it('uses bin for a file without a MIME type or extension and omits a blank note', () => {
    const file = new File([], 'README');
    const record = buildUploadRecord({ file, capturedAt, captureId, name: 'Alex', note: ' \n ' });
    expect(record.filename).toBe('2026-10-07 13.42 Alex - upload - README.bin');
    expect(record.mimeType).toBe('application/octet-stream');
    expect(record.description).not.toContain('Note:');
  });

  it('uses the supplied capture ID and timestamp for every record in a batch', () => {
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];
    const records = files.map((file, index) =>
      buildUploadRecord({ file, capturedAt, captureId: `test-id-${index}`, name: 'Alex', note: 'Shared note' }),
    );
    expect(records.map((record) => record.captureId)).toEqual(['test-id-0', 'test-id-1']);
    for (const record of records) {
      expect(record.description).toContain('Note: Shared note\n');
      expect(record.description).toContain(`Captured at: ${toLocalIsoString(capturedAt)}\n`);
      expect(record.description).toContain(`Capture ID: ${record.captureId}`);
    }
  });
});

describe('statusAnnouncementPrefix', () => {
  // A status change on an upload row is read out alone, so the spoken-only prefix names the file it belongs to.
  it('puts the file name and a colon before the status text', () => {
    expect(`${statusAnnouncementPrefix('invoice.pdf')}Saved ✓`).toBe('invoice.pdf: Saved ✓');
    expect(`${statusAnnouncementPrefix('2026 plan (final).xlsx')}Uploading`).toBe('2026 plan (final).xlsx: Uploading');
  });

  it('contains no em dash', () => {
    expect(statusAnnouncementPrefix('a.png')).not.toContain('\u2014');
  });

  it('is taken out of the row after a few seconds: long enough to be read out, short enough not to be read twice', () => {
    expect(ANNOUNCEMENT_PREFIX_LIFETIME_MS).toBeGreaterThanOrEqual(3000);
    expect(ANNOUNCEMENT_PREFIX_LIFETIME_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('rowStateFromBroadcast', () => {
  it.each([
    ['waiting', 'status-waiting', 'Waiting'],
    ['uploading', 'status-uploading', 'Uploading'],
    ['saved', 'status-saved', 'Saved ✓'],
  ] as const)('maps %s to its status circle and exact text', (state, className, text) => {
    expect(rowStateFromBroadcast({ type: 'queue:changed', captureId, state })).toEqual({ className, text });
  });

  it('shows the UI-ready needs_attention message as the failure reason', () => {
    const message: QueueChangedMessage = {
      type: 'queue:changed', captureId, state: 'needs_attention',
      message: 'Mailbox key was rejected. Check Settings.',
    };
    expect(rowStateFromBroadcast(message)).toEqual({
      className: 'status-attention', text: 'Failed: Mailbox key was rejected. Check Settings.',
    });
  });

  it.each([undefined, ''])('has a readable failure reason when the message is %j', (message) => {
    expect(rowStateFromBroadcast({ type: 'queue:changed', captureId, state: 'needs_attention', message })).toEqual({
      className: 'status-attention', text: 'Failed: Upload needs attention.',
    });
  });

  it('maps discarded to removal', () => {
    expect(rowStateFromBroadcast({ type: 'queue:changed', captureId, state: 'discarded' })).toBeNull();
  });
});

// A new row says "Adding…" until the file is stored, then "Waiting". Only the existing status circles are used.
describe('upload row states and messages', () => {
  it('starts a row as Adding… with the in-progress ring, and turns it into the Waiting ring', () => {
    expect(ADDING_ROW_STATE).toEqual({ className: 'status-uploading', text: 'Adding\u2026' });
    expect(WAITING_ROW_STATE).toEqual({ className: 'status-waiting', text: 'Waiting' });
    expect(rowStateFromBroadcast({ type: 'queue:changed', captureId, state: 'waiting' })).toEqual(WAITING_ROW_STATE);
  });

  it('hands out a copy of the Waiting state, so a row can never change the shared one', () => {
    const state = rowStateFromBroadcast({ type: 'queue:changed', captureId, state: 'waiting' });
    expect(state).not.toBe(WAITING_ROW_STATE);
  });

  it('says exactly when it is safe to close the tab, and what to do if the upload could not start', () => {
    expect(ALL_QUEUED_MESSAGE).toBe('Every file is queued. You can close this tab.');
    expect(SOME_QUEUED_MESSAGE).toBe('Files are queued.');
    expect(`${SOME_QUEUED_MESSAGE} ${START_FAILED_MESSAGE}`).toBe(
      "Files are queued. Couldn't start the upload. Use Retry now in the extension popup.",
    );
  });

  it('uses the ellipsis character and no em dash', () => {
    for (const text of [ADDING_ROW_STATE.text, ALL_QUEUED_MESSAGE, SOME_QUEUED_MESSAGE, START_FAILED_MESSAGE]) {
      expect(text).not.toContain('\u2014');
    }
    expect(ADDING_ROW_STATE.text.endsWith('\u2026')).toBe(true);
    expect(ADDING_ROW_STATE.text).not.toContain('...');
  });
});

describe('formatFileSize', () => {
  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [1023, '1023 bytes'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1 MB'],
    [Math.round(2.25 * 1024 * 1024), '2.3 MB'],
    [MAX_FILE_BYTES, '20 MB'],
    [1024 * 1024 * 1024, '1 GB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});
