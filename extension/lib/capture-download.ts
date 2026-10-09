import { browser } from 'wxt/browser';
import { MAX_FILE_BYTES } from './mailbox-client';

export interface CaptureClock {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export const CAPTURE_CLOCK: CaptureClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export const DOWNLOAD_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_MS = 20_000;
// isPdfBytes accepts a four-byte signature after up to 1,024 leading bytes.
const PDF_PREFIX_BYTES = 1028;

/** The deadline covers the response and body. A late download cannot reach the note step. */
export async function withDownloadTimeout<T>(
  download: (signal: AbortSignal) => Promise<T>,
  clock: CaptureClock,
  keepAlivePing: () => Promise<unknown> = () => browser.runtime.getPlatformInfo(),
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const keepAlive = () => {
    if (!active) return;
    try {
      void keepAlivePing().catch(() => undefined);
    } catch {
      // A failed keepalive ping does not change the download's deadline.
    }
    keepAliveTimer = clock.setTimeout(keepAlive, KEEP_ALIVE_MS);
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      controller.abort();
      reject(new Error('Download timed out'));
    }, DOWNLOAD_TIMEOUT_MS);
  });
  keepAliveTimer = clock.setTimeout(keepAlive, KEEP_ALIVE_MS);
  try {
    return await Promise.race([download(controller.signal), deadline]);
  } finally {
    active = false;
    if (timer !== undefined) clock.clearTimeout(timer);
    if (keepAliveTimer !== undefined) clock.clearTimeout(keepAliveTimer);
  }
}

/** Best effort: cancellation must not delay the user-facing rejection. */
export function cancelUnreadBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The body may already have been closed or cancelled by fetch's abort signal.
  }
}

export type CaptureBodyResult =
  | { kind: 'file'; bytes: ArrayBuffer }
  | { kind: 'too-big' }
  | { kind: 'not-pdf' };

/** Stores at most the mailbox cap; optional PDF sniffing only examines the accumulated prefix. */
export async function readCaptureBody(
  response: Response,
  signal: AbortSignal,
  acceptPdfPrefix?: (prefix: Uint8Array) => boolean,
): Promise<CaptureBodyResult> {
  const declaredLength = response.headers.get('Content-Length')?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_FILE_BYTES) {
    cancelUnreadBody(response);
    return { kind: 'too-big' };
  }
  if (signal.aborted) {
    cancelUnreadBody(response);
    throw new Error('Download aborted');
  }
  if (!response.body) throw new Error('Download body is empty');

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const prefix = new Uint8Array(PDF_PREFIX_BYTES);
  let prefixLength = 0;
  let pdfAccepted = acceptPdfPrefix === undefined;
  let total = 0;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Download aborted');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('Download aborted');
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        cancel();
        return { kind: 'too-big' };
      }
      if (!pdfAccepted && acceptPdfPrefix) {
        const part = value.subarray(0, PDF_PREFIX_BYTES - prefixLength);
        prefix.set(part, prefixLength);
        prefixLength += part.byteLength;
        pdfAccepted = acceptPdfPrefix(prefix.subarray(0, prefixLength));
        if (!pdfAccepted && prefixLength === PDF_PREFIX_BYTES) {
          cancel();
          return { kind: 'not-pdf' };
        }
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error('Download body is empty');
    if (!pdfAccepted) {
      cancel();
      return { kind: 'not-pdf' };
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: 'file', bytes: bytes.buffer };
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Preserve error details while omitting URL query strings from messages and stacks. */
export function logCaptureError(context: string, error: unknown): void {
  const redact = (text: string) => text.replace(/([a-z][a-z\d+.-]*:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1');
  let safeError = error;
  if (error instanceof Error) {
    const message = redact(error.message);
    const stack = error.stack === undefined ? undefined : redact(error.stack);
    if (message !== error.message || stack !== error.stack) {
      const cleaned = error instanceof TypeError ? new TypeError(message) : new Error(message);
      cleaned.name = error.name;
      cleaned.stack = stack;
      safeError = cleaned;
    }
  } else {
    safeError = redact(String(error));
  }
  console.error(`Capture to Drive: ${context} failed.`, safeError);
}

/** The final path component, without query or fragment. Malformed escapes remain readable. */
export function filenameFromUrl(url: string, fallback: string): string {
  const segment = new URL(url).pathname.split('/').at(-1) ?? '';
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    name = segment;
  }
  return name.trim() || fallback;
}
