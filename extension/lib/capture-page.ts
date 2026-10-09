// Whole page capture (spec section 6.3 flow B). The background attaches the debugger to the tab, asks for the page as
// a PDF (selectable text, backgrounds kept), always detaches, and hands the PDF to the note step. Background only.
//
// Page.printToPDF returns the whole page with no height limit. Measured printing times were about 0.2 s warm
// and 12 s on one cold start. The browser's "started debugging this browser" bar showed for about 5 s after detach.
// There is no full-page PNG fallback: the capture type `page-image` stays unused.
import { browser } from 'wxt/browser';
import { sourceFromUrl } from './filename';
import { showMessage, startNoteStep } from './note-step';
import type { StartNoteStepInput } from './note-step';
import { SAVE_FAILED_TEXT } from './note-status';
import { KEEP_ALIVE_INTERVAL_MS } from './queue';
import { checkFileSize } from './upload-batch';

export const PAGE_CANT_BE_SAVED_TEXT = "This page can't be saved. Try Select area instead.";

/** The Chrome DevTools Protocol version `debugger.attach` asks for. */
const PROTOCOL_VERSION = '1.3';

/**
 * Maximum time for attaching, printing, and detaching. After this deadline the debugger is released so the tab
 * can be captured again even if the browser never answers.
 */
export const PRINT_TIMEOUT_MS = 120_000;

/**
 * Characters of base64 turned into bytes per `atob` call. A page PDF can be tens of MB, and one `atob` over all of it
 * would hold the whole binary string next to the base64 text. Must be a multiple of 4 so no chunk splits a group.
 */
export const BASE64_CHUNK_CHARS = 1024 * 1024;

type Target = { tabId: number };

/** The slice of `browser.debugger` that this capture uses. */
export interface DebuggerApi {
  attach(target: Target, requiredVersion: string): Promise<void>;
  detach(target: Target): Promise<void>;
  sendCommand(target: Target, method: string, params?: Record<string, unknown>): Promise<object | undefined>;
}

export interface PageCaptureDeps {
  debugger: DebuggerApi;
  getTab(tabId: number): Promise<{ title?: string; url?: string }>;
  startNoteStep(input: StartNoteStepInput): Promise<void>;
  showMessage(tabId: number | undefined, message: string, kind: 'error' | 'info'): Promise<void>;
  /** A cheap extension API call, repeated during a print so the browser does not stop the worker mid-capture. */
  keepAlivePing(): Promise<unknown>;
}

const DEFAULT_DEPS: PageCaptureDeps = {
  debugger: {
    attach: (target, requiredVersion) => browser.debugger.attach(target, requiredVersion),
    detach: (target) => browser.debugger.detach(target),
    sendCommand: (target, method, params) => browser.debugger.sendCommand(target, method, params),
  },
  getTab: (tabId) => browser.tabs.get(tabId),
  startNoteStep,
  showMessage,
  keepAlivePing: () => browser.runtime.getPlatformInfo(),
};

function logFailure(what: string, error: unknown): void {
  console.error(`Capture to Drive: ${what} failed.`, error);
}

/**
 * The number of bytes that `base64` decodes to, worked out from its length alone. Throws RangeError unless the text
 * is a whole number of 4-character groups, which is how the browser sends it.
 */
export function decodedByteLength(base64: string): number {
  if (base64.length % 4 !== 0) throw new RangeError('Base64 text must be a multiple of 4 characters long.');
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return (base64.length / 4) * 3 - padding;
}

/** Decodes base64 into bytes, one chunk of characters at a time. Throws if the text is not valid base64. */
export function decodeBase64(base64: string, chunkChars: number = BASE64_CHUNK_CHARS): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(chunkChars) || chunkChars <= 0 || chunkChars % 4 !== 0) {
    throw new RangeError('The chunk size must be a positive multiple of 4.');
  }
  const bytes = new Uint8Array(decodedByteLength(base64));
  let written = 0;
  for (let start = 0; start < base64.length; start += chunkChars) {
    const binary = atob(base64.slice(start, start + chunkChars));
    for (let i = 0; i < binary.length; i += 1) bytes[written + i] = binary.charCodeAt(i);
    written += binary.length;
  }
  if (written !== bytes.length) throw new RangeError('The base64 text did not decode to the expected size.');
  return bytes;
}

/** The base64 PDF in a `Page.printToPDF` result, or undefined when the result has none. */
function pdfDataFrom(result: object | undefined): string | undefined {
  if (result === undefined || result === null || !('data' in result)) return undefined;
  return typeof result.data === 'string' && result.data !== '' ? result.data : undefined;
}

/**
 * The PDF as a Blob, or the message to show instead: too big for the mailbox, or not a PDF the browser could hand over.
 * Only the Blob leaves this function, so the base64 text and the byte array can be freed before the note step starts.
 */
function pdfFromBase64(base64: string): { blob: Blob } | { error: string } {
  try {
    // Measure first: an oversize PDF is turned away without building its bytes.
    const tooBig = checkFileSize(decodedByteLength(base64));
    if (tooBig !== null) return { error: tooBig };
    return { blob: new Blob([decodeBase64(base64)], { type: 'application/pdf' }) };
  } catch (error) {
    logFailure('Reading the page as a PDF', error);
    return { error: PAGE_CANT_BE_SAVED_TEXT };
  }
}

/**
 * Builds the whole page capture. Returns a function that captures one tab: it resolves once the note step is showing
 * (or an error message is), and rejects only when the error message itself cannot be shown.
 */
export function createPageCapture(overrides: Partial<PageCaptureDeps> = {}): (tabId: number) => Promise<void> {
  const deps: PageCaptureDeps = { ...DEFAULT_DEPS, ...overrides };
  // Tabs being captured. A cold first print can take about 12 s with no other sign of progress, so a second request
  // for the same tab would otherwise fail to attach and put a misleading error on screen.
  const inFlight = new Set<number>();

  function keepWorkerAwake(): void {
    try {
      deps.keepAlivePing().catch(() => undefined);
    } catch {
      // The ping only keeps the worker awake; if it fails there is nothing to do.
    }
  }

  /**
   * The page as base64 PDF data, or undefined when it could not be printed. Gives up after PRINT_TIMEOUT_MS, pings the
   * worker meanwhile so the browser does not stop it, never leaves the debugger attached, and never throws: a page that
   * cannot be attached to or printed is an ordinary outcome, not a bug.
   */
  async function printPage(tabId: number): Promise<string | undefined> {
    const target = { tabId };
    const keepAlive = setInterval(keepWorkerAwake, KEEP_ALIVE_INTERVAL_MS);
    // True once the debugger is attached, and once the capture is over (finished or given up on).
    let attached = false;
    let over = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => {
      deadline = setTimeout(() => {
        logFailure(over ? 'Detaching the debugger' : 'Printing the page', new Error('It took too long.'));
        resolve(undefined);
      }, PRINT_TIMEOUT_MS);
    });

    async function detachQuietly(): Promise<void> {
      try {
        await deps.debugger.detach(target);
      } catch (error) {
        // The user may have closed the debugging bar, which already detached. The PDF is unaffected.
        logFailure('Detaching the debugger', error);
      }
    }

    async function attachAndPrint(): Promise<string | undefined> {
      try {
        await deps.debugger.attach(target, PROTOCOL_VERSION);
      } catch (error) {
        // Restricted pages, the web store, a page another debugger already holds. Nothing was attached, so no detach.
        logFailure('Attaching the debugger', error);
        return undefined;
      }
      attached = true;
      if (over) {
        // The attach finished after the capture was given up on. Nobody will use this session, so close it.
        await detachQuietly();
        return undefined;
      }
      try {
        return pdfDataFrom(await deps.debugger.sendCommand(target, 'Page.printToPDF', { printBackground: true }));
      } catch (error) {
        logFailure('Printing the page', error);
        return undefined;
      }
    }

    try {
      return await Promise.race([attachAndPrint(), expired]);
    } finally {
      over = true;
      // `attached` is read before any await, so a late attach (see attachAndPrint) and this detach never both run.
      // A detach that hangs is called once and then waited for only until the deadline.
      if (attached) await Promise.race([detachQuietly(), expired]);
      clearTimeout(deadline);
      clearInterval(keepAlive);
    }
  }

  /** The page as a PDF Blob, or the message to show instead. Nothing but the Blob outlives this call. */
  async function printToBlob(tabId: number): Promise<{ blob: Blob } | { error: string }> {
    const base64 = await printPage(tabId);
    if (base64 === undefined) return { error: PAGE_CANT_BE_SAVED_TEXT };
    return pdfFromBase64(base64);
  }

  async function capture(tabId: number): Promise<void> {
    let tab: { title?: string; url?: string };
    try {
      tab = await deps.getTab(tabId);
    } catch (error) {
      // The tab closed after the click. No page is left to show a card in, so the message goes to a window.
      logFailure('Finding the tab', error);
      await deps.showMessage(undefined, PAGE_CANT_BE_SAVED_TEXT, 'error');
      return;
    }

    const pdf = await printToBlob(tabId);
    if ('error' in pdf) {
      await deps.showMessage(tabId, pdf.error, 'error');
      return;
    }

    // The debugger is detached by now, so the card does not appear while a debugging session is still open.
    try {
      await deps.startNoteStep({
        tabId,
        blob: pdf.blob,
        mimeType: 'application/pdf',
        captureType: 'page-pdf',
        source: sourceFromUrl(tab.url ?? ''),
        label: tab.title,
        title: tab.title,
        url: tab.url,
      });
    } catch (error) {
      // The capture could not be stored or shown (storage full, no window). Say so, as the other flows do.
      logFailure('Opening the whole page note step', error);
      await deps.showMessage(tabId, SAVE_FAILED_TEXT, 'error');
    }
  }

  return async (tabId) => {
    if (inFlight.has(tabId)) return;
    inFlight.add(tabId);
    try {
      await capture(tabId);
    } finally {
      inFlight.delete(tabId);
    }
  };
}

let pageCapture: ReturnType<typeof createPageCapture> | undefined;

/** Background only. Saves the whole page in the tab as a PDF and starts the note step. */
export function capturePage(tabId: number): Promise<void> {
  pageCapture ??= createPageCapture();
  return pageCapture(tabId);
}
