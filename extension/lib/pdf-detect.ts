import { browser } from 'wxt/browser';

export type PdfTabStatus = 'pdf' | 'not-pdf' | 'local-file';

export interface PdfProbes {
  contentTypeViaScript(tabId: number): Promise<string | undefined>;
  contentTypeViaHead(url: string): Promise<string | undefined>;
  /** A shorter test budget; the production limit remains 1,000 ms. */
  timeoutMs?: number;
  clock?: {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}

const MAX_DETECTION_MS = 1_000;
const MAX_LEADING_BYTES = 1_024;

function createDefaultProbes(signal: AbortSignal): PdfProbes {
  return {
    async contentTypeViaScript(tabId) {
      const results = await browser.scripting.executeScript({
        target: { tabId },
        func: () => document.contentType,
      });
      const contentType: unknown = results[0]?.result;
      return typeof contentType === 'string' ? contentType : undefined;
    },
    async contentTypeViaHead(url) {
      const response = await fetch(url, { method: 'HEAD', credentials: 'include', signal });
      return response.headers.get('Content-Type') ?? undefined;
    },
  };
}

/** Resolves supported URL rules before any browser or network probe. */
export function pdfStatusFromUrl(url: string | undefined): PdfTabStatus | 'unknown' {
  if (url === undefined) return 'not-pdf';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not-pdf';
  }
  if (parsed.protocol === 'file:') return 'local-file';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'not-pdf';
  try {
    return decodeURIComponent(parsed.pathname).toLowerCase().endsWith('.pdf') ? 'pdf' : 'unknown';
  } catch {
    // A malformed path escape still leaves an HTTP tab eligible for content-type probes.
    return 'unknown';
  }
}

/** Accepts a fetched Content-Type header or a document.contentType value. */
export function isPdfContentType(contentType: string | null | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}

async function probeTab(
  tab: { id?: number; url: string },
  probes: PdfProbes,
  expired: () => boolean,
): Promise<PdfTabStatus> {
  if (tab.id !== undefined) {
    let contentType: string | undefined;
    try {
      contentType = await probes.contentTypeViaScript(tab.id);
    } catch {
      // A blocked injection falls back to HEAD within the same deadline.
    }
    if (expired()) return 'not-pdf';
    if (contentType !== undefined) return isPdfContentType(contentType) ? 'pdf' : 'not-pdf';
  }
  if (expired()) return 'not-pdf';
  try {
    const contentType = await probes.contentTypeViaHead(tab.url);
    return !expired() && isPdfContentType(contentType) ? 'pdf' : 'not-pdf';
  } catch {
    return 'not-pdf';
  }
}

/** Script first, HEAD on injection failure, with one deadline for the whole probe sequence. */
export async function isPdfTab(
  tab: { id?: number; url?: string },
  probes?: PdfProbes,
): Promise<PdfTabStatus> {
  const status = pdfStatusFromUrl(tab.url);
  if (status !== 'unknown') return status;
  if (tab.url === undefined) return 'not-pdf';

  const controller = new AbortController();
  const resolvedProbes = probes ?? createDefaultProbes(controller.signal);
  // Global browser timers require their global receiver, so never store them as object methods.
  const clock: NonNullable<PdfProbes['clock']> = resolvedProbes.clock ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const requestedTimeout = resolvedProbes.timeoutMs ?? MAX_DETECTION_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(0, Math.min(requestedTimeout, MAX_DETECTION_MS))
    : MAX_DETECTION_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PdfTabStatus>((resolve) => {
    timer = clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve('not-pdf');
    }, timeoutMs);
  });

  try {
    return await Promise.race([probeTab({ id: tab.id, url: tab.url }, resolvedProbes, () => timedOut), deadline]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
}

/** Accepts %PDF at the start or after at most 1,024 leading bytes, including a BOM. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const lastStart = Math.min(MAX_LEADING_BYTES, bytes.length - 4);
  for (let offset = 0; offset <= lastStart; offset += 1) {
    if (bytes[offset] === 0x25 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x44 && bytes[offset + 3] === 0x46) {
      return true;
    }
  }
  return false;
}
