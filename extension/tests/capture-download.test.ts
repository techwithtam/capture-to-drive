import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOWNLOAD_TIMEOUT_MS, readCaptureBody, withDownloadTimeout } from '../lib/capture-download';
import { MAX_FILE_BYTES } from '../lib/mailbox-client';
import { isPdfBytes } from '../lib/pdf-detect';

const clock = {
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
};

beforeEach(() => { fakeBrowser.reset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function streamedResponse(chunks: Uint8Array<ArrayBuffer>[]) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>) => {
    const chunk = chunks[index++];
    if (chunk) controller.enqueue(chunk); else controller.close();
  });
  const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
  const read = vi.fn();
  const body: { getReader(): ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> } = response.body!;
  const getReader = body.getReader.bind(body);
  vi.spyOn(body, 'getReader').mockImplementation(() => {
    const reader = getReader();
    const originalRead = reader.read.bind(reader);
    vi.spyOn(reader, 'read').mockImplementation(() => { read(); return originalRead(); });
    return reader;
  });
  return { response, cancel, pull, read };
}

describe('bounded capture body reader', () => {
  it('cancels a huge declared body without acquiring a reader or pulling bytes', async () => {
    const { response, cancel, pull } = streamedResponse([new Uint8Array(1)]);
    response.headers.set('Content-Length', '5000000000');
    const getReader = vi.spyOn(response.body!, 'getReader');
    await expect(readCaptureBody(response, new AbortController().signal)).resolves.toEqual({ kind: 'too-big' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([undefined, '1'])('cancels a stream immediately after crossing the cap, with Content-Length %s', async (length) => {
    const { response, cancel, pull, read } = streamedResponse([
      new Uint8Array(MAX_FILE_BYTES), new Uint8Array(1), new Uint8Array(10),
    ]);
    if (length !== undefined) response.headers.set('Content-Length', length);
    await expect(readCaptureBody(response, new AbortController().signal)).resolves.toEqual({ kind: 'too-big' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(pull).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('accepts an exact-cap stream and preserves bytes across chunks', async () => {
    const first = new Uint8Array(MAX_FILE_BYTES - 1); first[0] = 123;
    const { response, cancel, pull } = streamedResponse([first, new Uint8Array([255])]);
    response.headers.set('Content-Length', String(MAX_FILE_BYTES));
    const result = await readCaptureBody(response, new AbortController().signal);
    expect(result.kind).toBe('file');
    if (result.kind !== 'file') throw new Error('Expected a file');
    expect(result.bytes.byteLength).toBe(MAX_FILE_BYTES);
    expect(new Uint8Array(result.bytes)[0]).toBe(123);
    expect(new Uint8Array(result.bytes).at(-1)).toBe(255);
    expect(cancel).not.toHaveBeenCalled();
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it('recognizes a PDF signature split across chunks after the maximum allowed prefix', async () => {
    const prefix = new Uint8Array(1024);
    const { response, cancel } = streamedResponse([prefix, new TextEncoder().encode('%P'), new TextEncoder().encode('DF-body')]);
    const result = await readCaptureBody(response, new AbortController().signal, isPdfBytes);
    expect(result.kind).toBe('file');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels a non-PDF once the sniffing prefix is complete and never reads the remaining body', async () => {
    const { response, cancel, pull, read } = streamedResponse([new Uint8Array(1028), new Uint8Array(MAX_FILE_BYTES)]);
    await expect(readCaptureBody(response, new AbortController().signal, isPdfBytes)).resolves.toEqual({ kind: 'not-pdf' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('cancels the reader when the deadline aborts a stalled body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
    const ping = vi.fn().mockResolvedValue(undefined);
    const result = withDownloadTimeout(signal => readCaptureBody(response, signal), clock, ping);
    const failed = expect(result).rejects.toThrow('Download timed out');
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    await failed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('download deadline and worker keepalive', () => {
  it('uses browser.runtime.getPlatformInfo for the default keepalive', async () => {
    vi.useFakeTimers();
    const runtime: { getPlatformInfo(): Promise<unknown> } = fakeBrowser.runtime;
    const ping = vi.spyOn(runtime, 'getPlatformInfo').mockResolvedValue(undefined);
    let finish: () => void = () => undefined;
    const result = withDownloadTimeout(() => new Promise<void>(resolve => { finish = resolve; }), clock);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(1);
    finish(); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pings every 20 seconds until completion and clears both timers', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(undefined);
    let finish: () => void = () => undefined;
    const result = withDownloadTimeout(() => new Promise<void>(resolve => { finish = resolve; }), clock, ping);
    await vi.advanceTimersByTimeAsync(19_999); expect(ping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); expect(ping).toHaveBeenCalledTimes(2);
    finish(); await result;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(ping).toHaveBeenCalledTimes(2);
  });

  it.each(['throw', 'reject'])('continues the deadline when keepalive pings %s', async (failure) => {
    vi.useFakeTimers();
    const ping = vi.fn(() => {
      if (failure === 'throw') throw new Error('Platform info unavailable');
      return Promise.reject(new Error('Platform info unavailable'));
    });
    const result = withDownloadTimeout(() => new Promise(() => undefined), clock, ping);
    const failed = expect(result).rejects.toThrow('Download timed out');
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS); await failed;
    expect(ping).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears keepalive and deadline after an early download failure', async () => {
    vi.useFakeTimers();
    await expect(withDownloadTimeout(async () => { throw new Error('Offline'); }, clock)).rejects.toThrow('Offline');
    expect(vi.getTimerCount()).toBe(0);
  });
});
