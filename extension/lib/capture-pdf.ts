import { browser } from 'wxt/browser';
import { CAPTURE_CLOCK, cancelUnreadBody, filenameFromUrl, logCaptureError, readCaptureBody, withDownloadTimeout } from './capture-download';
import type { CaptureClock } from './capture-download';
import { filenameFromContentDisposition } from './content-disposition';
import { sourceFromUrl, stripExtension } from './filename';
import { showMessage, startNoteStep } from './note-step';
import type { StartNoteStepInput } from './note-step';
import { SAVE_FAILED_TEXT } from './note-status';
import { isPdfBytes, isPdfContentType, isPdfTab, pdfStatusFromUrl } from './pdf-detect';
import type { PdfTabStatus } from './pdf-detect';
import { TOO_BIG_MESSAGE } from './upload-batch';

interface PdfCaptureTab {
  id?: number;
  url?: string;
  title?: string;
}

export interface PdfCaptureDeps {
  getTab(tabId: number): Promise<PdfCaptureTab>;
  isPdfTab: typeof isPdfTab;
  fetch: typeof fetch;
  startNoteStep: typeof startNoteStep;
  showMessage: typeof showMessage;
  clock: CaptureClock;
}

const PDF_DOWNLOAD_FAILED = "Couldn't download this PDF. It may need you to be logged in. Download it, then use Upload files.";

export function createPdfCapture(overrides: Partial<PdfCaptureDeps> = {}) {
  const deps: PdfCaptureDeps = {
    getTab: (tabId) => browser.tabs.get(tabId),
    isPdfTab,
    fetch: (input, init) => fetch(input, init),
    startNoteStep,
    showMessage,
    clock: CAPTURE_CLOCK,
    ...overrides,
  };

  return {
    async pdfTabStatus(tabId: number): Promise<PdfTabStatus> {
      try {
        return await deps.isPdfTab(await deps.getTab(tabId));
      } catch (error) {
        logCaptureError('Checking PDF tab status', error);
        return 'not-pdf';
      }
    },

    async capturePdf(tabId: number): Promise<void> {
      let input: StartNoteStepInput;
      try {
        const tab = await deps.getTab(tabId);
        const url = tab.url;
        if (pdfStatusFromUrl(url) === 'local-file') {
          await deps.showMessage(tabId, 'Local file? Use Upload files.', 'info');
          return;
        }
        if (url === undefined || !['http:', 'https:'].includes(new URL(url).protocol)) {
          throw new Error('Unsupported PDF URL');
        }
        const { response, result } = await withDownloadTimeout(async (signal) => {
          const response = await deps.fetch(url, { credentials: 'include', signal });
          if (!response.ok) {
            cancelUnreadBody(response);
            throw new Error(`PDF request failed (HTTP ${response.status})`);
          }
          const result = await readCaptureBody(response, signal,
            isPdfContentType(response.headers.get('Content-Type')) ? undefined : isPdfBytes);
          return { response, result };
        }, deps.clock);
        if (result.kind === 'too-big') {
          await deps.showMessage(tabId, TOO_BIG_MESSAGE, 'error');
          return;
        }
        if (result.kind === 'not-pdf') {
          throw new Error('Response is not a PDF');
        }
        const name = filenameFromContentDisposition(response.headers.get('Content-Disposition')) ??
          (filenameFromUrl(response.url || url, '') || filenameFromUrl(url, 'document'));
        const originalFilename = stripExtension(name) === name ? `${name}.pdf` : name;
        input = {
          tabId,
          blob: new Blob([result.bytes], { type: 'application/pdf' }),
          mimeType: 'application/pdf',
          captureType: 'pdf',
          source: sourceFromUrl(url),
          label: stripExtension(originalFilename),
          title: tab.title,
          url,
          originalFilename,
        };
      } catch (error) {
        logCaptureError('Downloading this PDF', error);
        await deps.showMessage(tabId, PDF_DOWNLOAD_FAILED, 'error');
        return;
      }
      try {
        await deps.startNoteStep(input);
      } catch (error) {
        logCaptureError('Opening the PDF note step', error);
        await deps.showMessage(tabId, SAVE_FAILED_TEXT, 'error');
      }
    },
  };
}

export function pdfTabStatus(tabId: number): Promise<PdfTabStatus> {
  return createPdfCapture().pdfTabStatus(tabId);
}

export function capturePdf(tabId: number): Promise<void> {
  return createPdfCapture().capturePdf(tabId);
}
