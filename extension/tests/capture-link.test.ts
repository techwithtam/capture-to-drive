import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkCapture } from '../lib/capture-link';
import type { LinkCaptureDeps } from '../lib/capture-link';
import { MAX_FILE_BYTES } from '../lib/mailbox-client';
import type { showMessage, startNoteStep } from '../lib/note-step';

const TAB = { id: 42, title: 'Downloads page' };
const LINK = 'https://www.example.com/files/Quarterly%20report.csv?token=fake#download';
const FAILURE = "Couldn't download that file. It may need you to be logged in.";
const TOO_BIG = 'Too big for the mailbox (max 20 MB). Drag it into Drive directly.';
const MENU = { id: 'save-linked-file', title: 'Save linked file to Capture', contexts: ['link'] };

function harness() {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('a,b\n1,2', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
  }));
  const start = vi.fn<typeof startNoteStep>().mockResolvedValue(undefined);
  const message = vi.fn<typeof showMessage>().mockResolvedValue(undefined);
  const menus: LinkCaptureDeps['menus'] = fakeBrowser.contextMenus;
  const remove = vi.spyOn(menus, 'remove').mockResolvedValue(undefined);
  const create = vi.spyOn(menus, 'create').mockReturnValue('save-linked-file');
  const clock = {
    setTimeout: vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
    clearTimeout: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
  };
  return { fetchImpl, start, message, remove, create, clock, capture: createLinkCapture({
    fetch: fetchImpl, startNoteStep: start, showMessage: message, menus, clock,
  }) };
}

beforeEach(() => { fakeBrowser.reset(); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('linked file menu registration', () => {
  it('removes the old item before creating only the link menu', async () => {
    const h = harness();
    await h.capture.registerMenu();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith('save-linked-file');
    expect(h.create).toHaveBeenCalledExactlyOnceWith(MENU);
    expect(h.remove.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0] ?? 0);
  });

  it('creates on first install when removal rejects because the item does not exist', async () => {
    const h = harness();
    h.remove.mockRejectedValue(new Error('Cannot find menu item'));
    await expect(h.capture.registerMenu()).resolves.toBeUndefined();
    expect(h.create).toHaveBeenCalledExactlyOnceWith(MENU);
  });

  it('can reinstall without duplicate menu IDs', async () => {
    const h = harness();
    const ids = new Set<string>();
    h.remove.mockImplementation(async (id) => { ids.delete(String(id)); });
    h.create.mockImplementation((properties) => {
      const id = properties.id ?? '';
      if (ids.has(id)) throw new Error('Duplicate ID');
      ids.add(id);
      return id;
    });
    await h.capture.registerMenu();
    await expect(h.capture.registerMenu()).resolves.toBeUndefined();
    expect([...ids]).toEqual(['save-linked-file']);
    expect(h.remove).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledTimes(2);
  });
});

describe('captureLink', () => {
  it('fetches with credentials and keeps the file bytes, content type, and exact note payload', async () => {
    const h = harness();
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.fetchImpl).toHaveBeenCalledExactlyOnceWith(LINK, {
      credentials: 'include', signal: expect.any(AbortSignal),
    });
    expect(h.start).toHaveBeenCalledExactlyOnceWith({
      tabId: TAB.id, blob: expect.any(Blob), mimeType: 'text/csv', captureType: 'link',
      source: 'example.com', label: 'Quarterly report', title: TAB.title, url: LINK,
      originalFilename: 'Quarterly report.csv',
    });
    const blob = h.start.mock.calls[0]?.[0].blob;
    expect(blob?.type).toBe('text/csv');
    expect(await blob?.text()).toBe('a,b\n1,2');
    expect(h.clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(h.clock.clearTimeout).toHaveBeenCalledTimes(2);
    expect(h.message).not.toHaveBeenCalled();
  });

  it.each(['text/html', 'text/html; charset=utf-8', ' Text/HTML ; charset=UTF-8 '])('rejects HTML media type %s before reading the body', async (contentType) => {
    const h = harness();
    const response = new Response('<html>Page</html>', { headers: { 'Content-Type': contentType } });
    const read = vi.spyOn(response, 'arrayBuffer');
    const cancel = vi.spyOn(response.body!, 'cancel');
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, 'That link opens a web page, not a file.', 'error');
    expect(h.start).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 500])('rejects HTTP %i', async (status) => {
    const h = harness();
    const response = new Response('Error', { status, headers: { 'Content-Type': 'text/html' } });
    const cancel = vi.spyOn(response.body!, 'cancel');
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'body'] as const)('handles %s failure', async (phase) => {
    const h = harness();
    if (phase === 'network') h.fetchImpl.mockRejectedValue(new Error('Offline'));
    else {
      const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('Read failed')); } }));
      h.fetchImpl.mockResolvedValue(response);
    }
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'body'] as const)('times out a stalled %s and ignores late bytes', async (phase) => {
    vi.useFakeTimers();
    const h = harness();
    let finish: () => void = () => undefined;
    if (phase === 'fetch') {
      h.fetchImpl.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(new Response('file')); }));
    } else {
      let cancelled = false;
      const response = new Response(new ReadableStream({
        start(controller) { finish = () => { if (!cancelled) controller.enqueue(new Uint8Array(4)); }; },
        cancel() { cancelled = true; },
      }));
      h.fetchImpl.mockResolvedValue(response);
    }
    const result = h.capture.captureLink({ linkUrl: LINK }, TAB);
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

  it.each([MAX_FILE_BYTES, MAX_FILE_BYTES + 1])('enforces the size cap for %i bytes', async (size) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(new Uint8Array(size)));
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    if (size > MAX_FILE_BYTES) {
      expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, TOO_BIG, 'error');
      expect(h.start).not.toHaveBeenCalled();
    } else {
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.message).not.toHaveBeenCalled();
    }
  });

  it.each([
    'javascript:alert(1)', 'data:application/pdf;base64,AAAA', 'blob:https://example.com/fake',
    'file:///home/alex/file.pdf', 'ftp://example.com/file.pdf', 'chrome://settings',
    'mailto:test@example.com', 'not a URL', '', undefined,
  ])('rejects unsupported URL %s without fetching', async (linkUrl) => {
    const h = harness();
    await h.capture.captureLink({ linkUrl }, TAB);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: -1 }, {}])('opens the note window without a tab for %j', async (tab) => {
    const h = harness();
    await h.capture.captureLink({ linkUrl: LINK }, tab);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.start.mock.calls[0]?.[0].tabId).toBeUndefined();
    expect(h.message).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: -1 }])('shows failures via the note window without a tab for %j', async (tab) => {
    const h = harness();
    h.fetchImpl.mockRejectedValue(new Error('Offline'));
    await h.capture.captureLink({ linkUrl: LINK }, tab);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(undefined, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a huge Content-Length without reading its body', async () => {
    const h = harness();
    const cancel = vi.fn();
    const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'Content-Length': '5000000000' },
    });
    const read = vi.spyOn(response, 'arrayBuffer');
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, TOO_BIG, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each([null, new Uint8Array(0)])('rejects an empty linked-file body %s', async (body) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(body));
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, FAILURE, 'error');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('reports and logs a note-step failure separately from a download failure', async () => {
    const h = harness();
    const error = new Error('Pending store failed');
    h.start.mockRejectedValue(error);
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.message).toHaveBeenCalledExactlyOnceWith(TAB.id, "Couldn't save this capture. Capture it again.", 'error');
    expect(console.error).toHaveBeenCalledWith('Capture to Drive: Opening the linked-file note step failed.', error);
  });

  it('logs the actual download error with context and removes URL query strings', async () => {
    const h = harness();
    h.fetchImpl.mockRejectedValue(new TypeError('Network failed for https://example.com/file.csv?token=private-test'));
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    const [context, error] = vi.mocked(console.error).mock.calls[0] ?? [];
    expect(context).toBe('Capture to Drive: Downloading a linked file failed.');
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain('Network failed for https://example.com/file.csv');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-test');
    expect((error as Error).stack).not.toContain('private-test');
  });

  it.each([' Text/CSV ; charset=UTF-8 ', 'APPLICATION/PDF; version=1.7'])('normalizes MIME type %s to its media type', async (contentType) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response('file', { headers: { 'Content-Type': contentType } }));
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    const mimeType = contentType.split(';')[0]?.trim().toLowerCase();
    expect(h.start.mock.calls[0]?.[0].mimeType).toBe(mimeType);
    expect(h.start.mock.calls[0]?.[0].blob.type).toBe(mimeType);
  });

  it.each([
    [null, 'https://cdn.example.com/Final%20report.csv?token=fake', 'Final report.csv'],
    ['attachment; filename="Server.csv"', 'https://cdn.example.com/redirected.csv', 'Server.csv'],
    [null, 'https://cdn.example.com/', 'Quarterly report.csv'],
  ])('uses Content-Disposition then redirected URL then original URL for %s / %s', async (header, finalUrl, originalFilename) => {
    const h = harness();
    const response = new Response('file', { headers: header === null ? {} : { 'Content-Disposition': header } });
    Object.defineProperty(response, 'url', { value: finalUrl });
    h.fetchImpl.mockResolvedValue(response);
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    expect(h.start.mock.calls[0]?.[0]).toMatchObject({ originalFilename, url: LINK, source: 'example.com' });
  });

  it.each([
    ['attachment; filename="Server report.xlsx"', LINK, 'Server report.xlsx', 'Server report'],
    ["attachment; filename=ignored.csv; filename*=UTF-8''Final%20report.csv", LINK, 'Final report.csv', 'Final report'],
    [null, LINK, 'Quarterly report.csv', 'Quarterly report'],
    [null, 'https://example.com/', 'file', 'file'],
    [null, 'https://example.com/folder/', 'file', 'file'],
    [null, 'http://example.com/download', 'download', 'download'],
    [null, 'https://example.com/bad%ZZ.csv', 'bad%ZZ.csv', 'bad%ZZ'],
  ])('chooses filename %s for %s', async (header, linkUrl, originalFilename, label) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(new Uint8Array([0, 1, 255]), {
      headers: header === null ? {} : { 'Content-Disposition': header },
    }));
    await h.capture.captureLink({ linkUrl }, TAB);
    expect(h.start.mock.calls[0]?.[0]).toMatchObject({ originalFilename, label });
  });

  it.each([null, ''])('falls back to application/octet-stream for missing content type %s', async (contentType) => {
    const h = harness();
    h.fetchImpl.mockResolvedValue(new Response(new Uint8Array([0, 1, 255]), {
      headers: contentType === null ? {} : { 'Content-Type': contentType },
    }));
    await h.capture.captureLink({ linkUrl: LINK }, TAB);
    const payload = h.start.mock.calls[0]?.[0];
    expect(payload?.mimeType).toBe('application/octet-stream');
    expect(payload?.blob.type).toBe('application/octet-stream');
    expect(new Uint8Array(await payload?.blob.arrayBuffer() ?? new ArrayBuffer(0))).toEqual(new Uint8Array([0, 1, 255]));
  });
});
