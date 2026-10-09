import { browser } from 'wxt/browser';
import { CAPTURE_CLOCK, cancelUnreadBody, filenameFromUrl, logCaptureError, readCaptureBody, withDownloadTimeout } from './capture-download';
import type { CaptureClock } from './capture-download';
import { filenameFromContentDisposition } from './content-disposition';
import { sourceFromUrl, stripExtension } from './filename';
import { showMessage, startNoteStep } from './note-step';
import type { StartNoteStepInput } from './note-step';
import { SAVE_FAILED_TEXT } from './note-status';
import { TOO_BIG_MESSAGE } from './upload-batch';

export interface LinkCaptureDeps {
  fetch: typeof fetch;
  startNoteStep: typeof startNoteStep;
  showMessage: typeof showMessage;
  clock: CaptureClock;
  menus: {
    remove(id: string | number): Promise<void>;
    create(properties: Parameters<typeof browser.contextMenus.create>[0]): string | number;
  };
}

interface LinkInfo {
  linkUrl?: string;
}

interface LinkTab {
  id?: number;
  title?: string;
}

const LINK_DOWNLOAD_FAILED = "Couldn't download that file. It may need you to be logged in.";

export function createLinkCapture(overrides: Partial<LinkCaptureDeps> = {}) {
  const deps: LinkCaptureDeps = {
    fetch: (input, init) => fetch(input, init),
    startNoteStep,
    showMessage,
    clock: CAPTURE_CLOCK,
    menus: browser.contextMenus,
    ...overrides,
  };

  return {
    async registerMenu(): Promise<void> {
      try {
        await deps.menus.remove('save-linked-file');
      } catch {
        // First install has no existing item to remove.
      }
      deps.menus.create({
        id: 'save-linked-file',
        title: 'Save linked file to Capture',
        contexts: ['link'],
      });
    },

    async captureLink(info: LinkInfo, tab?: LinkTab): Promise<void> {
      const tabId = tab?.id !== undefined && tab.id >= 0 ? tab.id : undefined;
      let input: StartNoteStepInput;
      try {
        const url = info.linkUrl;
        if (url === undefined || !['http:', 'https:'].includes(new URL(url).protocol)) {
          throw new Error('Unsupported link');
        }
        const result = await withDownloadTimeout(async (signal) => {
          const response = await deps.fetch(url, { credentials: 'include', signal });
          if (!response.ok) {
            cancelUnreadBody(response);
            throw new Error(`File request failed (HTTP ${response.status})`);
          }
          const mimeType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
          if (mimeType === 'text/html') {
            cancelUnreadBody(response);
            return { kind: 'html' } as const;
          }
          const body = await readCaptureBody(response, signal);
          if (body.kind !== 'file') return body;
          return { kind: 'file', response, bytes: body.bytes, mimeType } as const;
        }, deps.clock);
        if (result.kind === 'html') {
          await deps.showMessage(tabId, 'That link opens a web page, not a file.', 'error');
          return;
        }
        if (result.kind === 'too-big') {
          await deps.showMessage(tabId, TOO_BIG_MESSAGE, 'error');
          return;
        }
        if (result.kind === 'not-pdf') throw new Error('File body could not be read');
        const name = filenameFromContentDisposition(result.response.headers.get('Content-Disposition')) ??
          (filenameFromUrl(result.response.url || url, '') || filenameFromUrl(url, 'file'));
        input = {
          tabId,
          blob: new Blob([result.bytes], { type: result.mimeType }),
          mimeType: result.mimeType,
          captureType: 'link',
          source: sourceFromUrl(url),
          label: stripExtension(name),
          title: tab?.title,
          url,
          originalFilename: name,
        };
      } catch (error) {
        logCaptureError('Downloading a linked file', error);
        await deps.showMessage(tabId, LINK_DOWNLOAD_FAILED, 'error');
        return;
      }
      try {
        await deps.startNoteStep(input);
      } catch (error) {
        logCaptureError('Opening the linked-file note step', error);
        await deps.showMessage(tabId, SAVE_FAILED_TEXT, 'error');
      }
    },
  };
}

export function registerLinkedFileMenu(): Promise<void> {
  return createLinkCapture().registerMenu();
}

export function captureLink(info: LinkInfo, tab?: LinkTab): Promise<void> {
  return createLinkCapture().captureLink(info, tab);
}
