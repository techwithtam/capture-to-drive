import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPdfCapture } from '../lib/capture-pdf';
import { MAX_FILE_BYTES } from '../lib/mailbox-client';
import type { showMessage, startNoteStep } from '../lib/note-step';

const TAB = { id: 42, url: 'https://www.example.com/Receipt%20October.pdf?download=1#page=2', title: 'October receipt' };
const FAILURE = "Couldn't download this PDF. It may need you to be logged in. Download it, then use Upload files.";
const TOO_BIG = 'Too big for the mailbox (max 20 MB). Drag it into Drive directly.';

function harness() {
  const tabs: { get(tabId: number): Promise<{ id?: number; url?: string; title?: string }> } = fakeBrowser.tabs;
  const getTab = vi.spyOn(tabs, 'get').mockResolvedValue(TAB);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('%PDF-1.7\noriginal', {
    headers: { 'Content-Type': 'application/pdf; charset=binary' },
  }));
  const start = vi.fn<typeof startNoteStep>().mockResolvedValue(undefined);
  const message = vi.fn<typeof showMessage>().mockResolvedValue(undefined);
  const clock = {
    setTimeout: vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
  };
  return { getTab, fetchImpl, start, message, clock, capture: createPdfCapture({
    fetch: fetchImpl, startNoteStep: start, showMessage: message, clock,
  }) };
}

beforeEach(() => { fakeBrowser.reset(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('pdfTabStatus', () => {
  it.each([
    ['https://example.com/receipt.PDF?download=1', 'pdf'],
    ['chrome://settings', 'not-pdf'],
    ['file:///home/alex/receipt.pdf', 'local-file'],
  ] as const)('gets the tab and reports %s as %s', async (url, status) => {
    const h = harness();
    h.getTab.mockResolvedValue({ ...TAB, url });
    await expect(h.capture.pdfTabStatus(TAB.id)).resolves.toBe(status);
    expect(h.getTab).toHaveBeenCalledWith(TAB.id);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the existing content-type detection for extensionless URLs', async () => {
    const h = harness();
    h.getTab.mockResolvedValue({ ...TAB, url: 'https://example.com/download' });
    const scripting: {
      executeScript(injection: { target: { tabId: number }; func: () => string }):
        Promise<{ frameId: number; result?: unknown }[]>;
    } = fakeBrowser.scripting;
    vi.spyOn(scripting, 'executeScript').mockResolvedValue([{ frameId: 0, result: 'application/pdf' }]);
    await expect(h.capture.pdfTabStatus(TAB.id)).resolves.toBe('pdf');
  });

  it('reports a closed tab as not-pdf', async () => {
    const h = harness();
    h.getTab.mockRejectedValue(new Error('No tab'));
    await expect(h.capture.pdfTabStatus(TAB.id)).resolves.toBe('not-pdf');
  });
});

describe('capturePdf', () => {
  it('shows the local-file hint without fetching or starting a note', async () => {
    const h = harness();
    h.getTab.mockResolvedValue({ ...TAB, url: 'file:///home/alex/receipt.pdf' });
    await h.capture.capturePdf(TAB.id);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, 'Local file? Use Upload files.', 'info');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('fetches with credentials and passes the original bytes and exact metadata to the note step', async () => {
    const h = harness();
    await h.capture.capturePdf(TAB.id);
    expect(h.fetchImpl).toHaveBeenCalledExactlyOnceWith(TAB.url, {
      credentials: 'include', signal: expect.any(AbortSignal),
    });
    expect(h.start).toHaveBeenCalledExactlyOnceWith({
      tabId: TAB.id, blob: expect.any(Blob), mimeType: 'application/pdf', captureType: 'pdf',
      source: 'example.com', label: 'Receipt October', title: TAB.title, url: TAB.url,
      originalFilename: 'Receipt October.pdf',
    });
    const blob = h.start.mock.calls[0]?.[0].blob;
    expect(blob?.type).toBe('application/pdf');
    expect(await blob?.text()).toBe('%PDF-1.7\noriginal');
    expect(h.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(h.clock.clearTimeout).toHaveBeenCalledTimes(2);
    expect(h.message).not.toHaveBeenCalled();
  });

  it('accepts a PDF content type even without magic bytes', async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response('trusted by media type', { headers: { 'Content-Type': 'application/pdf' } }));
    await h.capture.capturePdf(TAB.id);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('accepts PDF magic bytes despite the wrong content type', async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response('%PDF-2.0', { headers: { 'Content-Type': 'application/octet-stream' } }));
    await h.capture.capturePdf(TAB.id);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0]?.[0].mimeType).toBe('application/pdf');
  });

  it.each([
    [200, 'text/html; charset=utf-8', '<html>Log in</html>'],
    [200, 'application/octet-stream', 'not a PDF'],
    [401, 'application/pdf', '%PDF'],
    [403, 'application/pdf', '%PDF'],
    [500, 'application/pdf', '%PDF'],
  ])('rejects status %i and media type %s', async (status, contentType, body) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': contentType } }));
    await h.capture.capturePdf(TAB.id);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['network', 'tab', 'missing URL', 'body'] as const)('handles %s failure', async (failure) => {
    const h = harness();
    if (failure === 'network') h.fetchImpl.mockRejectedValue(new Error('Offline'));
    if (failure === 'tab') h.getTab.mockRejectedValue(new Error('No tab'));
    if (failure === 'missing URL') h.getTab.mockResolvedValue({ id: TAB.id });
    if (failure === 'body') {
      const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('Read failed')); } }), {
        headers: { 'Content-Type': 'application/pdf' },
      });
      h.fetchImpl.mockResolvedValue(response);
    }
    await h.capture.capturePdf(TAB.id);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'body'] as const)('times out a stalled %s at 60 seconds and ignores its late result', async (phase) => {
    vi.useFakeTimers();
    const h = harness();
    let finish: () => void = () => undefined;
    if (phase === 'fetch') {
      h.fetchImpl.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(new Response('%PDF')); }));
    } else {
      let cancelled = false;
      const response = new Response(new ReadableStream({
        start(controller) { finish = () => { if (!cancelled) controller.enqueue(new TextEncoder().encode('%PDF')); }; },
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'application/pdf' } });
      h.fetchImpl.mockResolvedValue(response);
    }
    const result = h.capture.capturePdf(TAB.id);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.message).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([MAX_FILE_BYTES, MAX_FILE_BYTES + 1])('enforces the byte cap for %i bytes', async (size) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(new Uint8Array(size), { headers: { 'Content-Type': 'application/pdf' } }));
    await h.capture.capturePdf(TAB.id);
    if (size > MAX_FILE_BYTES) {
      expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, TOO_BIG, 'error');
      expect(h.start).not.toHaveBeenCalled();
    } else {
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.message).not.toHaveBeenCalled();
    }
  });

  it('rejects a huge Content-Length without reading its body', async () => {
    const h = harness();
    const cancel = vi.fn();
    const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '5000000000' },
    });
    const read = vi.spyOn(response, 'arrayBuffer');
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.capturePdf(TAB.id);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, TOO_BIG, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([401, 403])('cancels the unread HTTP %i body', async (status) => {
    const h = harness();
    const response = new Response('error', { status });
    const cancel = vi.spyOn(response.body!, 'cancel');
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.capturePdf(TAB.id);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
  });

  it.each([null, new Uint8Array(0)])('rejects an empty PDF body %s', async (body) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/pdf' } }));
    await h.capture.capturePdf(TAB.id);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('reports and logs a note-step failure separately from a download failure', async () => {
    const h = harness();
    const error = new Error('Pending store failed');
    h.start.mockRejectedValue(error);
    await h.capture.capturePdf(TAB.id);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, "Couldn't save this capture. Capture it again.", 'error');
    expect(console.error).toHaveBeenCalledWith('Capture to Drive: Opening the PDF note step failed.', error);
  });

  it('logs the actual download error with context and removes URL query strings', async () => {
    const h = harness();
    h.fetchImpl.mockRejectedValue(new TypeError('Network failed for https://example.com/file.pdf?token=private-test'));
    await h.capture.capturePdf(TAB.id);
    const [context, error] = vi.mocked(console.error).mock.calls[0] ?? [];
    expect(context).toBe('Capture to Drive: Downloading this PDF failed.');
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain('Network failed for https://example.com/file.pdf');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-test');
    expect((error as Error).stack).not.toContain('private-test');
  });

  it('prefers the final response URL when a PDF download redirects', async () => {
    const h = harness();
    const response = new Response('%PDF');
    Object.defineProperty(response, 'url', { value: 'https://cdn.example.com/Final%20receipt.pdf?token=fake' });
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.capturePdf(TAB.id);
    expect(h.start.mock.calls[0]?.[0]).toMatchObject({
      originalFilename: 'Final receipt.pdf', label: 'Final receipt', url: TAB.url, source: 'example.com',
    });
  });

  it.each([
    ['attachment; filename="Server receipt.PDF"', TAB.url, 'Server receipt.PDF', 'Server receipt'],
    ["attachment; filename=ignored.pdf; filename*=UTF-8''Final%20receipt.pdf", TAB.url, 'Final receipt.pdf', 'Final receipt'],
    [null, TAB.url, 'Receipt October.pdf', 'Receipt October'],
    [null, 'https://example.com/', 'document.pdf', 'document'],
    [null, 'https://example.com/folder/', 'document.pdf', 'document'],
    [null, 'https://example.com/download', 'download.pdf', 'download'],
    ['attachment; filename="Statement"', TAB.url, 'Statement.pdf', 'Statement'],
    ['attachment; filename="archive.bin"', TAB.url, 'archive.bin', 'archive'],
    [null, 'https://example.com/bad%ZZ.pdf', 'bad%ZZ.pdf', 'bad%ZZ'],
  ])('uses filename %s with URL %s', async (header, url, originalFilename, label) => {
    const h = harness();
    h.getTab.mockResolvedValue({ ...TAB, url });
    h.fetchImpl.mockResolvedValue(new Response('%PDF', {
      headers: header === null ? {} : { 'Content-Disposition': header },
    }));
    await h.capture.capturePdf(TAB.id);
    expect(h.start.mock.calls[0]?.[0]).toMatchObject({ originalFilename, label });
  });
});
