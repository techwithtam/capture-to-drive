import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import background from '../entrypoints/background';
import { capturePdf, pdfTabStatus } from '../lib/capture-pdf';
import { isCapturePdfMessage, isTabPdfStatusMessage } from '../lib/messages';
import type { PdfTabStatus } from '../lib/pdf-detect';

vi.mock('../lib/capture-pdf', () => ({ capturePdf: vi.fn(), pdfTabStatus: vi.fn() }));
vi.mock('../lib/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/queue')>()),
  installQueueProcessor: () => ({ recover: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../lib/note-step', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/note-step')>()),
  recoverPendingCaptures: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation(() => undefined);
  // WXT's fake browser does not implement commands events yet; area wiring has its own listener test.
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(() => undefined);
  background.main();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('PDF runtime messages', () => {
  it.each<PdfTabStatus>(['pdf', 'not-pdf', 'local-file'])('answers the status request with %s', async (status) => {
    vi.mocked(pdfTabStatus).mockResolvedValue(status);
    await expect(fakeBrowser.runtime.sendMessage({ type: 'tab:pdf-status', tabId: 42 })).resolves.toEqual({ status });
    expect(pdfTabStatus).toHaveBeenCalledExactlyOnceWith(42);
    expect(capturePdf).not.toHaveBeenCalled();
  });

  it('dispatches capture:pdf and answers after the note step opens', async () => {
    vi.mocked(capturePdf).mockResolvedValue(undefined);
    await expect(fakeBrowser.runtime.sendMessage({ type: 'capture:pdf', tabId: 42 })).resolves.toEqual({ ok: true });
    expect(capturePdf).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.each(['capture:pdf', 'tab:pdf-status'])('rejects content-script sender for %s', async (type) => {
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/' });
    const sendResponse = vi.fn();
    await fakeBrowser.runtime.onMessage.trigger({ type, tabId: 42 }, { tab }, sendResponse);
    expect(capturePdf).not.toHaveBeenCalled();
    expect(pdfTabStatus).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('answers ok:false when capture:pdf rejects', async () => {
    const error = new Error('Message window failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(capturePdf).mockRejectedValue(error);
    await expect(fakeBrowser.runtime.sendMessage({ type: 'capture:pdf', tabId: 42 })).resolves.toEqual({ ok: false });
    expect(log).toHaveBeenCalledWith('Capture to Drive: Saving this PDF failed.', error);
  });

  it.each([undefined, -1, 1.5, NaN, Infinity, '42'])('rejects invalid tab ID %s', (tabId) => {
    expect(isCapturePdfMessage({ type: 'capture:pdf', tabId })).toBe(false);
    expect(isTabPdfStatusMessage({ type: 'tab:pdf-status', tabId })).toBe(false);
  });

  it('guards only the two new message types', () => {
    expect(isCapturePdfMessage({ type: 'capture:pdf', tabId: 0 })).toBe(true);
    expect(isTabPdfStatusMessage({ type: 'tab:pdf-status', tabId: 42 })).toBe(true);
    expect(isCapturePdfMessage({ type: 'queue:kick', tabId: 42 })).toBe(false);
    expect(isTabPdfStatusMessage(null)).toBe(false);
  });
});
