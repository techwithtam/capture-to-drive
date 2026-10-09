// Service worker. Runs the upload queue (only this context processes it), answers note requests, and starts every
// capture: Select area (popup or shortcut), Whole page, and Save this PDF (popup), and Save linked file (context menu).
// Every listener is registered synchronously in main(), so the browser can deliver the event that woke the worker.

import { browser } from 'wxt/browser';
import { captureLink, registerLinkedFileMenu } from '@/lib/capture-link';
import { capturePage } from '@/lib/capture-page';
import { capturePdf, pdfTabStatus } from '@/lib/capture-pdf';
import {
  isCaptureAreaMessage,
  isCapturePageMessage,
  isCapturePdfMessage,
  isNoteRequestMessage,
  isQueueRequestMessage,
  isTabPdfStatusMessage,
} from '@/lib/messages';
import type { CapturePdfResponse, TabPdfStatusResponse } from '@/lib/messages';
import { captureArea, captureAreaInActiveTab } from '@/lib/capture-area';
import type { QueueRequestResponse } from '@/lib/messages';
import { handleNoteRequest, recoverPendingCaptures } from '@/lib/note-step';
import type { NoteRequestResponse } from '@/lib/note-step';
import { installQueueProcessor, RETRY_ALARM } from '@/lib/queue';

function logFailure(what: string): (error: unknown) => void {
  return (error) => {
    console.error(`Capture to Drive: ${what} failed.`, error);
  };
}

/**
 * Keeps storage.local (which holds the mailbox key) away from content scripts, which run inside web pages. No content
 * script of this extension reads storage. Set at every worker start, so it holds whether or not the browser keeps it
 * across restarts. Browsers without the API (before Chrome 102) keep the default.
 */
function restrictStorageToExtensionPages(): void {
  const local: { setAccessLevel?: unknown } = browser.storage.local;
  if (typeof local.setAccessLevel !== 'function') return;
  try {
    browser.storage.local
      .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      .catch(logFailure('Restricting storage to extension pages'));
  } catch (error) {
    logFailure('Restricting storage to extension pages')(error);
  }
}

function respond<T>(sendResponse: (response: T) => void, response: T): void {
  try {
    sendResponse(response);
  } catch {
    // The page that asked has closed; nobody is left to answer.
  }
}

export default defineBackground(() => {
  restrictStorageToExtensionPages();
  // This worker is the only context that processes the queue.
  const queue = installQueueProcessor();

  const processQueue = () => {
    queue.processQueue().catch(logFailure('Processing the upload queue'));
  };

  // A browser start retries every waiting capture at once, including ones still backing off (README: "again whenever
  // the browser starts"). Needs-attention items wait for the user.
  browser.runtime.onStartup.addListener(() => {
    queue.retryNow().catch(logFailure('Retrying the upload queue'));
  });
  browser.runtime.onInstalled.addListener(processQueue);
  browser.runtime.onInstalled.addListener(() => {
    registerLinkedFileMenu().catch(logFailure('Registering the linked-file menu'));
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'save-linked-file') return;
    captureLink(info, tab).catch(logFailure('Saving a linked file'));
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) processQueue();
  });

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: QueueRequestResponse) => void) => {
      // Not a queue request: leave it to other listeners.
      if (!isQueueRequestMessage(message)) return undefined;
      // A refused request (Discard on an item that is uploading) answers ok: false and is not an error.
      queue.handle(message).then(
        (carriedOut) => respond(sendResponse, { ok: carriedOut }),
        (error: unknown) => {
          logFailure(`The ${message.type} request`)(error);
          respond(sendResponse, { ok: false });
        },
      );
      // Answer asynchronously, once the request has been carried out.
      return true;
    },
  );

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: NoteRequestResponse) => void) => {
      // Not a note-step request: leave it to other listeners.
      if (!isNoteRequestMessage(message)) return undefined;
      // handleNoteRequest never rejects; a save answers once the capture's first upload attempt is over.
      void handleNoteRequest(message).then((response) => respond(sendResponse, response));
      return true;
    },
  );

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    // Not a whole page request: leave it to other listeners.
    if (!isCapturePageMessage(message)) return undefined;
    // Popup only. A content script running in a web page (or any extension page open in a tab) has a sender tab, and
    // must not be able to make the worker attach a debugger to a tab.
    if (sender.tab !== undefined) return undefined;
    // The popup closes itself right after asking, and a first print can take 12 s, so nothing waits for the capture.
    capturePage(message.tabId).catch(logFailure('The whole page capture'));
    return undefined;
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.tab !== undefined || !isCaptureAreaMessage(message)) return undefined;
    // The popup closes as soon as it sends the trigger; it does not wait for a selection.
    void captureArea(message.tabId).catch(logFailure('Capturing a selected area'));
    return undefined;
  });

  browser.commands.onCommand.addListener((command) => {
    if (command === 'select-area') void captureAreaInActiveTab().catch(logFailure('Capturing a selected area'));
  });

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (response: TabPdfStatusResponse) => void) => {
      if (sender.tab !== undefined || !isTabPdfStatusMessage(message)) return undefined;
      void pdfTabStatus(message.tabId).then((status) => respond(sendResponse, { status }));
      return true;
    },
  );

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (response: CapturePdfResponse) => void) => {
      if (sender.tab !== undefined || !isCapturePdfMessage(message)) return undefined;
      capturePdf(message.tabId).then(
        () => respond(sendResponse, { ok: true }),
        (error: unknown) => {
          logFailure('Saving this PDF')(error);
          respond(sendResponse, { ok: false });
        },
      );
      return true;
    },
  );

  // Every worker start: put uploads cut off by the previous worker's stop back in line, and restore the badge and
  // retry alarm (badge text does not survive a browser restart).
  queue.recover().catch(logFailure('Recovering the upload queue'));
  // Every worker start: queue captures whose Save was pressed but never queued (the previous worker stopped in between),
  // then delete captures whose note step was abandoned (tab closed) more than 24 hours ago.
  recoverPendingCaptures().catch(logFailure('Recovering pending captures'));
});
