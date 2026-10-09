// Whole page capture (spec section 6.3 flow B). The debugger API, tabs.get, startNoteStep, and showMessage are injected,
// so every path is driven directly: success, restricted pages, a failing print, an oversize PDF, a failing detach, and
// a second request for a tab that is still being captured. The base64 decoder gets its own tests, including payloads
// that span several chunks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE64_CHUNK_CHARS,
  createPageCapture,
  decodeBase64,
  decodedByteLength,
  PAGE_CANT_BE_SAVED_TEXT,
  PRINT_TIMEOUT_MS,
} from '../lib/capture-page';
import type { PageCaptureDeps } from '../lib/capture-page';
import { MAX_FILE_BYTES } from '../lib/mailbox-client';
import { isCapturePageMessage } from '../lib/messages';
import type { StartNoteStepInput } from '../lib/note-step';
import { SAVE_FAILED_TEXT } from '../lib/note-status';
import { KEEP_ALIVE_INTERVAL_MS } from '../lib/queue';

const TAB_ID = 7;
const TOO_BIG_TEXT = 'Too big for the mailbox (max 20 MB). Drag it into Drive directly.';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Every byte value in order, repeated, so a decoder that mangles any value or any chunk edge shows up. */
function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
}

interface Harness {
  deps: PageCaptureDeps;
  /** Every debugger, tab, and note-step call, in order. */
  calls: string[];
  attach: ReturnType<typeof vi.fn<PageCaptureDeps['debugger']['attach']>>;
  detach: ReturnType<typeof vi.fn<PageCaptureDeps['debugger']['detach']>>;
  sendCommand: ReturnType<typeof vi.fn<PageCaptureDeps['debugger']['sendCommand']>>;
  getTab: ReturnType<typeof vi.fn<PageCaptureDeps['getTab']>>;
  startNoteStep: ReturnType<typeof vi.fn<PageCaptureDeps['startNoteStep']>>;
  showMessage: ReturnType<typeof vi.fn<PageCaptureDeps['showMessage']>>;
  keepAlivePing: ReturnType<typeof vi.fn<PageCaptureDeps['keepAlivePing']>>;
}

function harness(overrides: Partial<PageCaptureDeps> = {}, pdfBase64 = toBase64(PDF_BYTES)): Harness {
  const calls: string[] = [];
  const attach = vi.fn<PageCaptureDeps['debugger']['attach']>(async () => {
    calls.push('attach');
  });
  const detach = vi.fn<PageCaptureDeps['debugger']['detach']>(async () => {
    calls.push('detach');
  });
  const sendCommand = vi.fn<PageCaptureDeps['debugger']['sendCommand']>(async (_target, method) => {
    calls.push(method);
    return { data: pdfBase64 };
  });
  const getTab = vi.fn<PageCaptureDeps['getTab']>(async () => ({
    title: 'Order 1234 | Example Shop',
    url: 'https://www.example.com/orders/1234?ref=email',
  }));
  const startNoteStep = vi.fn<PageCaptureDeps['startNoteStep']>(async () => {
    calls.push('startNoteStep');
  });
  const showMessage = vi.fn<PageCaptureDeps['showMessage']>(async () => {
    calls.push('showMessage');
  });
  const keepAlivePing = vi.fn<PageCaptureDeps['keepAlivePing']>(async () => undefined);
  const deps: PageCaptureDeps = {
    debugger: { attach, detach, sendCommand },
    getTab,
    startNoteStep,
    showMessage,
    keepAlivePing,
    ...overrides,
  };
  return { deps, calls, attach, detach, sendCommand, getTab, startNoteStep, showMessage, keepAlivePing };
}

function startNoteStepInput(h: Harness): StartNoteStepInput {
  const input = h.startNoteStep.mock.calls[0]?.[0];
  if (input === undefined) throw new Error('startNoteStep was not called');
  return input;
}

beforeEach(() => {
  // Failures are logged for whoever debugs the worker; keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capturing a page', () => {
  it('prints the page as a PDF with backgrounds and starts the note step with the tab details', async () => {
    const h = harness();
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.getTab).toHaveBeenCalledWith(TAB_ID);
    expect(h.attach).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID }, '1.3');
    expect(h.sendCommand).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID }, 'Page.printToPDF', {
      printBackground: true,
    });
    expect(h.showMessage).not.toHaveBeenCalled();

    expect(h.startNoteStep).toHaveBeenCalledOnce();
    expect(startNoteStepInput(h)).toEqual({
      tabId: TAB_ID,
      blob: expect.any(Blob),
      mimeType: 'application/pdf',
      captureType: 'page-pdf',
      source: 'example.com',
      label: 'Order 1234 | Example Shop',
      title: 'Order 1234 | Example Shop',
      url: 'https://www.example.com/orders/1234?ref=email',
    });
  });

  it('hands over the PDF bytes exactly as the browser produced them', async () => {
    const h = harness();
    await createPageCapture(h.deps)(TAB_ID);

    const { blob } = startNoteStepInput(h);
    expect(blob.type).toBe('application/pdf');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it('detaches before the note step starts, so the card does not wait on the debugging session', async () => {
    const h = harness();
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.calls).toEqual(['attach', 'Page.printToPDF', 'detach', 'startNoteStep']);
  });

  it('saves a PDF of exactly the size limit', async () => {
    const h = harness({}, Buffer.alloc(MAX_FILE_BYTES, 0x25).toString('base64'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.showMessage).not.toHaveBeenCalled();
    expect(startNoteStepInput(h).blob.size).toBe(MAX_FILE_BYTES);
  });

  it('leaves the source and label empty for a tab that reports no URL or title', async () => {
    const h = harness({ getTab: vi.fn(async () => ({})) });
    await createPageCapture(h.deps)(TAB_ID);

    expect(startNoteStepInput(h)).toEqual({
      tabId: TAB_ID,
      blob: expect.any(Blob),
      mimeType: 'application/pdf',
      captureType: 'page-pdf',
      source: '',
    });
  });

  it('can capture the same tab again once the first capture is over', async () => {
    const h = harness();
    const capture = createPageCapture(h.deps);
    await capture(TAB_ID);
    await capture(TAB_ID);

    expect(h.startNoteStep).toHaveBeenCalledTimes(2);
    expect(h.detach).toHaveBeenCalledTimes(2);
  });

  // Like Save this PDF and linked files, a note step that cannot start says so instead of failing silently.
  it('tells the user, after detaching, when the note step cannot start', async () => {
    const h = harness();
    h.startNoteStep.mockImplementation(async () => {
      h.calls.push('startNoteStep');
      throw new Error('quota');
    });

    await createPageCapture(h.deps)(TAB_ID);
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, SAVE_FAILED_TEXT, 'error');
    expect(SAVE_FAILED_TEXT).toBe("Couldn't save this capture. Capture it again.");
    expect(h.calls).toEqual(['attach', 'Page.printToPDF', 'detach', 'startNoteStep', 'showMessage']);
    expect(console.error).toHaveBeenCalledWith(
      'Capture to Drive: Opening the whole page note step failed.',
      expect.objectContaining({ message: 'quota' }),
    );
  });

  it('rejects only when the failure message cannot be shown either', async () => {
    const h = harness();
    h.startNoteStep.mockRejectedValue(new Error('quota'));
    h.showMessage.mockRejectedValue(new Error('no window'));

    await expect(createPageCapture(h.deps)(TAB_ID)).rejects.toThrow('no window');
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it('can capture the same tab again after the note step failed', async () => {
    const h = harness();
    h.startNoteStep.mockRejectedValueOnce(new Error('quota'));
    const capture = createPageCapture(h.deps);

    await capture(TAB_ID);
    await capture(TAB_ID);

    expect(h.attach).toHaveBeenCalledTimes(2);
    expect(h.detach).toHaveBeenCalledTimes(2);
    expect(h.startNoteStep).toHaveBeenCalledTimes(2);
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, SAVE_FAILED_TEXT, 'error');
  });

  it('can capture the same tab again after the message could not be shown', async () => {
    const h = harness();
    h.attach.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    h.showMessage.mockRejectedValueOnce(new Error('no window'));
    const capture = createPageCapture(h.deps);

    await expect(capture(TAB_ID)).rejects.toThrow('no window');
    await capture(TAB_ID);

    expect(h.startNoteStep).toHaveBeenCalledOnce();
  });
});

describe('a page that cannot be attached to', () => {
  it('tells the user to try Select area, and queues nothing', async () => {
    const h = harness();
    h.attach.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(
      TAB_ID,
      "This page can't be saved. Try Select area instead.",
      'error',
    );
    expect(PAGE_CANT_BE_SAVED_TEXT).toBe("This page can't be saved. Try Select area instead.");
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });

  it('does not detach from a session it never opened', async () => {
    const h = harness();
    h.attach.mockRejectedValue(new Error('Another debugger is already attached to the tab with id: 7.'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).not.toHaveBeenCalled();
  });

  it('treats an attach that throws instead of rejecting the same way', async () => {
    const h = harness();
    h.attach.mockImplementation(() => {
      throw new Error('Cannot attach to this target.');
    });
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, PAGE_CANT_BE_SAVED_TEXT, 'error');
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });
});

describe('a page that cannot be printed', () => {
  it('detaches, tells the user to try Select area, and queues nothing', async () => {
    const h = harness();
    h.sendCommand.mockRejectedValue(new Error('Printing failed'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID });
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, PAGE_CANT_BE_SAVED_TEXT, 'error');
    expect(h.startNoteStep).not.toHaveBeenCalled();
    // The error message goes only after the debugging session is closed.
    expect(h.calls).toEqual(['attach', 'detach', 'showMessage']);
  });

  it.each([
    ['no result', undefined],
    ['a result without data', {}],
    ['empty data', { data: '' }],
    ['data that is not text', { data: 12 }],
    ['data that is not base64', { data: '%%%%' }],
    ['data with a truncated base64 tail', { data: 'JVBERg' }],
  ])('treats %s as a failed print', async (_name, result) => {
    const h = harness();
    h.sendCommand.mockResolvedValue(result);
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, PAGE_CANT_BE_SAVED_TEXT, 'error');
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });
});

describe('a PDF over the mailbox size limit', () => {
  it('shows the size message, detaches, and queues nothing', async () => {
    const h = harness({}, Buffer.alloc(MAX_FILE_BYTES + 1, 0x25).toString('base64'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, TOO_BIG_TEXT, 'error');
    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });

  it('measures the size from the base64 text, before building the bytes', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    const h = harness({}, Buffer.alloc(MAX_FILE_BYTES + 1, 0x25).toString('base64'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(decode).not.toHaveBeenCalled();
  });
});

describe('closing the debugging session', () => {
  it('detaches exactly once when the capture succeeds', async () => {
    const h = harness();
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID });
  });

  it('still saves the capture when detach fails, because the user closed the debugging bar', async () => {
    const h = harness();
    h.detach.mockRejectedValue(new Error('Debugger is not attached to the tab with id: 7.'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.startNoteStep).toHaveBeenCalledOnce();
    expect(h.showMessage).not.toHaveBeenCalled();
  });

  it('still shows the error when both the print and detach fail', async () => {
    const h = harness();
    h.sendCommand.mockRejectedValue(new Error('Printing failed'));
    h.detach.mockRejectedValue(new Error('Debugger is not attached to the tab with id: 7.'));
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, PAGE_CANT_BE_SAVED_TEXT, 'error');
  });

  it('survives a detach that throws instead of rejecting', async () => {
    const h = harness();
    h.detach.mockImplementation(() => {
      throw new Error('boom');
    });
    await createPageCapture(h.deps)(TAB_ID);

    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.startNoteStep).toHaveBeenCalledOnce();
  });

  it('detaches when the PDF is too big, and when the data cannot be decoded', async () => {
    const tooBig = harness({}, Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64'));
    await createPageCapture(tooBig.deps)(TAB_ID);
    expect(tooBig.detach).toHaveBeenCalledOnce();

    const garbled = harness({}, '%%%%');
    await createPageCapture(garbled.deps)(TAB_ID);
    expect(garbled.detach).toHaveBeenCalledOnce();
  });
});

describe('a print that never finishes', () => {
  const PDF_DATA = { data: toBase64(PDF_BYTES) };

  /** Resolves a promise the test finishes by hand, so a call stays pending for as long as the test wants. */
  function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows 120 s, and 20 s between keep-alive pings, like the upload queue', () => {
    expect(PRINT_TIMEOUT_MS).toBe(120_000);
    expect(KEEP_ALIVE_INTERVAL_MS).toBe(20_000);
  });

  it('gives up at the timeout: detaches, shows the message, and queues nothing', async () => {
    const h = harness();
    h.sendCommand.mockReturnValue(new Promise<object | undefined>(() => undefined));
    const done = createPageCapture(h.deps)(TAB_ID);

    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS - 1);
    expect(h.detach).not.toHaveBeenCalled();
    expect(h.showMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.detach).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID });
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, PAGE_CANT_BE_SAVED_TEXT, 'error');
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });

  it('lets the tab be captured again after a timeout', async () => {
    const h = harness();
    h.sendCommand.mockReturnValueOnce(new Promise<object | undefined>(() => undefined));
    const capture = createPageCapture(h.deps);

    const first = capture(TAB_ID);
    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    await first;
    await capture(TAB_ID);

    expect(h.attach).toHaveBeenCalledTimes(2);
    expect(h.startNoteStep).toHaveBeenCalledOnce();
  });

  it('does not wait forever for a print that is only late', async () => {
    const h = harness();
    const print = pending<object | undefined>();
    h.sendCommand.mockReturnValue(print.promise);
    const done = createPageCapture(h.deps)(TAB_ID);

    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS - 1);
    print.resolve(PDF_DATA);
    await done;

    expect(h.startNoteStep).toHaveBeenCalledOnce();
    expect(h.showMessage).not.toHaveBeenCalled();
  });

  it('gives up on a detach that never finishes, after calling it once, and still saves the PDF', async () => {
    const h = harness();
    h.detach.mockReturnValue(new Promise<void>(() => undefined));
    const done = createPageCapture(h.deps)(TAB_ID);

    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS - 1);
    expect(h.startNoteStep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.startNoteStep).toHaveBeenCalledOnce();
  });

  it('gives up on an attach that never finishes, and detaches if it finishes late', async () => {
    const h = harness();
    const attaching = pending<void>();
    h.attach.mockReturnValue(attaching.promise);
    const done = createPageCapture(h.deps)(TAB_ID);

    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    await done;
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(TAB_ID, PAGE_CANT_BE_SAVED_TEXT, 'error');
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(h.detach).not.toHaveBeenCalled();

    // The session opens after the capture was given up on: it must not be left attached.
    attaching.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.detach).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_ID });
    expect(h.sendCommand).not.toHaveBeenCalled();
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });

  it('pings the worker every 20 s while the print runs, and stops when it ends', async () => {
    const h = harness();
    const print = pending<object | undefined>();
    h.sendCommand.mockReturnValue(print.promise);
    const done = createPageCapture(h.deps)(TAB_ID);

    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS - 1);
    expect(h.keepAlivePing).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.keepAlivePing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS * 2 + 5_000);
    expect(h.keepAlivePing).toHaveBeenCalledTimes(3);

    print.resolve(PDF_DATA);
    await done;
    // Neither the ping interval nor the 120 s deadline is left running.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    expect(h.keepAlivePing).toHaveBeenCalledTimes(3);
  });

  it('stops pinging when the capture times out, and when it fails', async () => {
    const stuck = harness();
    stuck.sendCommand.mockReturnValue(new Promise<object | undefined>(() => undefined));
    const done = createPageCapture(stuck.deps)(TAB_ID);
    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    await done;
    const pings = stuck.keepAlivePing.mock.calls.length;
    // 20 s, 40 s, ... up to the deadline (a ping due at the very instant of the deadline may or may not fire first).
    expect(pings).toBeGreaterThanOrEqual(PRINT_TIMEOUT_MS / KEEP_ALIVE_INTERVAL_MS - 1);
    expect(pings).toBeLessThanOrEqual(PRINT_TIMEOUT_MS / KEEP_ALIVE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    expect(stuck.keepAlivePing).toHaveBeenCalledTimes(pings);

    const failed = harness();
    failed.attach.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    await createPageCapture(failed.deps)(TAB_ID);
    await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS);
    expect(failed.keepAlivePing).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('no platform info'))],
    [
      'throws',
      (): Promise<unknown> => {
        throw new Error('no platform info');
      },
    ],
  ])('carries on when a ping %s', async (_name, ping) => {
    // Plain functions, not vi.fn: a mock records the settled result of the promise it returns, which would hide an
    // unhandled rejection.
    let pings = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = harness({
        keepAlivePing: () => {
          pings += 1;
          return ping();
        },
      });
      const print = pending<object | undefined>();
      h.sendCommand.mockReturnValue(print.promise);
      const done = createPageCapture(h.deps)(TAB_ID);

      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_INTERVAL_MS * 2);
      print.resolve(PDF_DATA);
      await done;
      // unhandledRejection fires after the microtask queue drains, so give the event loop a real turn.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(pings).toBe(2);
      expect(unhandled).toEqual([]);
      expect(h.startNoteStep).toHaveBeenCalledOnce();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a tab that is gone', () => {
  it('shows the message in the note window, and never attaches', async () => {
    const h = harness({ getTab: vi.fn(async () => Promise.reject(new Error('No tab with id: 7.'))) });
    await createPageCapture(h.deps)(TAB_ID);

    // There is no page left to host the card, so the message goes to the window (no tab id).
    expect(h.showMessage).toHaveBeenCalledExactlyOnceWith(undefined, PAGE_CANT_BE_SAVED_TEXT, 'error');
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.detach).not.toHaveBeenCalled();
    expect(h.startNoteStep).not.toHaveBeenCalled();
  });
});

describe('a second request while a tab is being captured', () => {
  it('is ignored, so the first capture is not interrupted by an attach that fails', async () => {
    let finishPrint: (result: object) => void = () => undefined;
    const h = harness();
    h.sendCommand.mockImplementation(
      () =>
        new Promise<object>((resolve) => {
          finishPrint = resolve;
        }),
    );
    const capture = createPageCapture(h.deps);

    const first = capture(TAB_ID);
    await vi.waitFor(() => expect(h.sendCommand).toHaveBeenCalledOnce());
    await capture(TAB_ID);

    expect(h.attach).toHaveBeenCalledOnce();
    expect(h.showMessage).not.toHaveBeenCalled();

    finishPrint({ data: toBase64(PDF_BYTES) });
    await first;
    expect(h.startNoteStep).toHaveBeenCalledOnce();
  });

  it('does not block a different tab', async () => {
    let finishPrint: (result: object) => void = () => undefined;
    const h = harness();
    h.sendCommand.mockImplementationOnce(
      () =>
        new Promise<object>((resolve) => {
          finishPrint = resolve;
        }),
    );
    const capture = createPageCapture(h.deps);

    const first = capture(TAB_ID);
    await vi.waitFor(() => expect(h.sendCommand).toHaveBeenCalledOnce());
    await capture(TAB_ID + 1);
    expect(h.startNoteStep).toHaveBeenCalledOnce();

    finishPrint({ data: toBase64(PDF_BYTES) });
    await first;
    expect(h.startNoteStep).toHaveBeenCalledTimes(2);
  });

  it('is accepted again after a capture that failed', async () => {
    const h = harness();
    h.attach.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    const capture = createPageCapture(h.deps);

    await capture(TAB_ID);
    await capture(TAB_ID);

    expect(h.startNoteStep).toHaveBeenCalledOnce();
  });
});

describe('decodedByteLength', () => {
  it.each([
    ['', 0],
    ['QQ==', 1],
    ['QUI=', 2],
    ['QUJD', 3],
    ['QUJDRA==', 4],
  ])('counts the bytes in %j', (base64, length) => {
    expect(decodedByteLength(base64)).toBe(length);
  });

  it.each([['QUJ'], ['Q'], ['QUJDR']])('rejects %j, whose length is not a multiple of 4', (base64) => {
    expect(() => decodedByteLength(base64)).toThrow(RangeError);
  });
});

describe('decodeBase64', () => {
  it('decodes empty text to no bytes', () => {
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])('decodes %i bytes, with and without padding', (length) => {
    const bytes = patternBytes(length);
    expect(decodeBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('decodes every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index);
    expect(decodeBase64(toBase64(bytes))).toEqual(bytes);
  });

  it.each([4, 8, 12, 16, 400])('decodes across chunk boundaries with %i characters per chunk', (chunkChars) => {
    // 1003 bytes: 1340 characters, a final chunk shorter than the others, and "=" padding in the last chunk.
    const bytes = patternBytes(1003);
    expect(decodeBase64(toBase64(bytes), chunkChars)).toEqual(bytes);
  });

  // About 1.9 MB. toEqual compares a typed array element by element (about 3 s, which timed out under parallel load),
  // so the bytes are compared in one call; the generous timeout only guards a very slow machine.
  it('decodes a payload larger than one default chunk', { timeout: 20_000 }, () => {
    expect(BASE64_CHUNK_CHARS % 4).toBe(0);
    // Two and a half chunks, with a final chunk that ends in padding.
    const bytes = patternBytes(Math.floor(((BASE64_CHUNK_CHARS * 5) / 2 / 4) * 3) - 2);
    const base64 = toBase64(bytes);
    expect(base64.length).toBeGreaterThan(BASE64_CHUNK_CHARS * 2);
    expect(base64.endsWith('=')).toBe(true);
    const decoded = decodeBase64(base64);
    expect(decoded.length).toBe(bytes.length);
    expect(Buffer.compare(decoded, bytes)).toBe(0);
  });

  it('never decodes more than one chunk of characters at a time', () => {
    const decode = vi.spyOn(globalThis, 'atob');
    decodeBase64(toBase64(patternBytes(1003)), 16);

    const sizes = decode.mock.calls.map(([chunk]) => chunk.length);
    expect(Math.max(...sizes)).toBe(16);
    expect(sizes.length).toBe(Math.ceil(1340 / 16));
  });

  it.each([['%%%%'], ['QUJ'], ['QU=D'], ['QUJD QUJD']])('rejects %j', (base64) => {
    expect(() => decodeBase64(base64)).toThrow();
  });

  it.each([0, -4, 3, 6, 1.5, Number.NaN])('rejects a chunk size of %s', (chunkChars) => {
    expect(() => decodeBase64('QUJD', chunkChars)).toThrow(RangeError);
  });
});

describe('isCapturePageMessage', () => {
  it.each([[{ type: 'capture:page', tabId: 7 }], [{ type: 'capture:page', tabId: 0 }]])('accepts %j', (message) => {
    expect(isCapturePageMessage(message)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    ['capture:page'],
    [{}],
    [{ type: 'capture:page' }],
    [{ type: 'capture:page', tabId: '7' }],
    [{ type: 'capture:page', tabId: -1 }],
    [{ type: 'capture:page', tabId: 1.5 }],
    [{ type: 'capture:page', tabId: Number.NaN }],
    [{ type: 'capture:area', tabId: 7 }],
    [{ type: 'capture:pdf', tabId: 7 }],
    [{ type: 'queue:kick' }],
  ])('rejects %j', (message) => {
    expect(isCapturePageMessage(message)).toBe(false);
  });
});
