// Toolbar popup logic (spec sections 6.3, 6.5, 6.6): commands, Save this PDF state, status line, needs-attention list,
// keyboard selection, and the refresh that keeps the status line live.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QueueItem, QueueStatus } from '../lib/queue';
import {
  ALL_SAVED_TEXT,
  ATTENTION_FALLBACK_MESSAGE,
  ATTENTION_LIST_LABEL,
  COMMANDS_MENU_LABEL,
  DELIVERY_WAIT_MS,
  DISCARD_LABEL,
  FINISH_SETUP_LABEL,
  HIDE_LABEL,
  LOCAL_FILE_HINT,
  NOT_PDF_HINT,
  POPUP_COMMANDS,
  QUEUE_UNAVAILABLE_STATUS,
  REASON_AFTER_FAILED_ATTEMPTS,
  RETRY_LABEL,
  RETRY_NOW_LABEL,
  SETUP_TEXT,
  UPLOADING_NOW_LABEL,
  VIEW_LABEL,
  ariaKeyShortcuts,
  attentionEntries,
  captureMessage,
  coalesce,
  commandEnabled,
  confirmPdfCapture,
  discardMessage,
  disabledRowAnnouncement,
  focusIndexAfterActionsLost,
  focusMoveAfterRender,
  isNavigationKey,
  keepExpanded,
  moveSelection,
  pdfRecheckAnnouncement,
  pdfRowStateFromResponse,
  pdfRowView,
  retryMessage,
  rovingTabIndex,
  statusLine,
} from '../lib/popup-model';
import type { PdfRowState, PopupCommandId } from '../lib/popup-model';

let nextId = 0;

function item(status: QueueStatus, extra: Partial<QueueItem> = {}): QueueItem {
  nextId += 1;
  return {
    captureId: `capture-${nextId}`,
    createdAt: nextId,
    filename: `2026-10-07 13.42 Alex - example.com - Item ${nextId}.png`,
    mimeType: 'image/png',
    description: '',
    blob: new Blob(['x']),
    attempts: 1,
    nextAttemptAt: 0,
    status,
    ...extra,
  };
}

function items(...statuses: QueueStatus[]): QueueItem[] {
  return statuses.map((status) => item(status));
}

describe('POPUP_COMMANDS', () => {
  it('lists the four capture actions in order with the spec labels', () => {
    expect(POPUP_COMMANDS.map((command) => [command.id, command.label, command.icon])).toEqual([
      ['area', 'Select area', 'crop'],
      ['page', 'Whole page', 'file-text'],
      ['pdf', 'Save this PDF', 'file-type-pdf'],
      ['upload', 'Upload files…', 'upload'],
    ]);
  });

  it('names the menu that holds the rows', () => {
    expect(COMMANDS_MENU_LABEL).toBe('Capture');
  });
});

describe('captureMessage', () => {
  it('builds the trigger for each capture with the active tab id', () => {
    expect(captureMessage('area', 7)).toEqual({ type: 'capture:area', tabId: 7 });
    expect(captureMessage('page', 7)).toEqual({ type: 'capture:page', tabId: 7 });
    expect(captureMessage('pdf', 7)).toEqual({ type: 'capture:pdf', tabId: 7 });
  });
});

describe('queue requests', () => {
  it('retries the whole queue without an id, or one item with its id', () => {
    expect(retryMessage()).toEqual({ type: 'queue:retry' });
    expect(retryMessage()).not.toHaveProperty('captureId');
    expect(retryMessage('capture-a')).toEqual({ type: 'queue:retry', captureId: 'capture-a' });
  });

  it('discards one item by id', () => {
    expect(discardMessage('capture-a')).toEqual({ type: 'queue:discard', captureId: 'capture-a' });
  });
});

describe('statusLine', () => {
  it('reads All saved with the saved circle and no buttons when the queue is empty', () => {
    expect(statusLine([])).toEqual({ text: 'All saved', tone: 'saved', retryAll: false, view: false });
    expect(ALL_SAVED_TEXT).toBe('All saved');
  });

  it.each([
    [['waiting'], '1 waiting to upload'],
    [['waiting', 'waiting'], '2 waiting to upload'],
    [['waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting'], '12 waiting to upload'],
  ] satisfies [QueueStatus[], string][])('counts waiting items with Retry now: %j', (statuses, text) => {
    expect(statusLine(items(...statuses))).toEqual({ text, tone: 'waiting', retryAll: true, view: false });
  });

  it('counts uploading items as waiting to upload, with the uploading circle', () => {
    expect(statusLine(items('uploading'))).toEqual({
      text: '1 waiting to upload',
      tone: 'uploading',
      retryAll: true,
      view: false,
    });
    expect(statusLine(items('waiting', 'uploading', 'waiting'))).toEqual({
      text: '3 waiting to upload',
      tone: 'uploading',
      retryAll: true,
      view: false,
    });
  });

  it('says "1 needs attention" for one item and "N need attention" for more, with View', () => {
    expect(statusLine(items('needs_attention'))).toEqual({
      text: '1 needs attention',
      tone: 'attention',
      retryAll: false,
      view: true,
    });
    expect(statusLine(items('needs_attention', 'needs_attention'))).toEqual({
      text: '2 need attention',
      tone: 'attention',
      retryAll: false,
      view: true,
    });
  });

  it('puts needs attention first and counts only those items when the queue is mixed', () => {
    expect(statusLine(items('waiting', 'needs_attention', 'uploading', 'waiting'))).toEqual({
      text: '1 needs attention',
      tone: 'attention',
      retryAll: false,
      view: true,
    });
    expect(statusLine(items('needs_attention', 'waiting', 'needs_attention', 'needs_attention'))).toEqual({
      text: '3 need attention',
      tone: 'attention',
      retryAll: false,
      view: true,
    });
  });

  it('has a status for a queue that could not be read', () => {
    expect(QUEUE_UNAVAILABLE_STATUS).toEqual({
      text: "Couldn't check the upload queue.",
      tone: 'attention',
      retryAll: false,
      view: false,
    });
  });

  // A full Drive or a deleted Capture folder fails forever as server_error, so after 3 failed attempts the reason
  // can be read (View) and the item discarded, while the line still says how many are waiting.
  describe('waiting items that keep failing', () => {
    const reason = 'Drive storage is full.';

    it('adds View next to Retry now once a waiting item has failed 3 times and has a reason', () => {
      expect(REASON_AFTER_FAILED_ATTEMPTS).toBe(3);
      const line = statusLine([item('waiting', { attempts: 3, lastMessage: reason }), item('waiting')]);
      expect(line).toEqual({ text: '2 waiting to upload', tone: 'waiting', retryAll: true, view: true });
    });

    it('does not offer View before the third failed attempt, or without a reason', () => {
      expect(statusLine([item('waiting', { attempts: 2, lastMessage: reason })]).view).toBe(false);
      expect(statusLine([item('waiting', { attempts: 5 })]).view).toBe(false);
      expect(statusLine([item('waiting', { attempts: 5, lastMessage: '' })]).view).toBe(false);
    });

    it('counts only finished attempts for an item being uploaded', () => {
      // Its third attempt is under way: two have failed so far.
      expect(statusLine([item('uploading', { attempts: 3, lastMessage: reason })]).view).toBe(false);
      // Retried after three failures: the reason stays readable while the fourth attempt runs.
      expect(statusLine([item('uploading', { attempts: 4, lastMessage: reason })])).toEqual({
        text: '1 waiting to upload',
        tone: 'uploading',
        retryAll: true,
        view: true,
      });
    });
  });
});

describe('popup copy', () => {
  it('uses the spec and brief wording for buttons and the setup gate', () => {
    expect(RETRY_NOW_LABEL).toBe('Retry now');
    expect(VIEW_LABEL).toBe('View');
    expect(HIDE_LABEL).toBe('Hide');
    expect(RETRY_LABEL).toBe('Retry');
    expect(DISCARD_LABEL).toBe('Discard');
    expect(FINISH_SETUP_LABEL).toBe('Finish setup');
    expect(SETUP_TEXT).toBe('Set up your mailbox to start saving to Drive.');
  });

  it('never uses an em dash', () => {
    const texts = [
      ...POPUP_COMMANDS.map((command) => command.label),
      ...[statusLine([]), statusLine(items('waiting')), statusLine(items('needs_attention', 'needs_attention'))].map(
        (line) => line.text,
      ),
      QUEUE_UNAVAILABLE_STATUS.text,
      NOT_PDF_HINT,
      LOCAL_FILE_HINT,
      COMMANDS_MENU_LABEL,
      ATTENTION_LIST_LABEL,
      UPLOADING_NOW_LABEL,
      ATTENTION_FALLBACK_MESSAGE,
      SETUP_TEXT,
      FINISH_SETUP_LABEL,
      RETRY_NOW_LABEL,
      VIEW_LABEL,
      HIDE_LABEL,
      RETRY_LABEL,
      DISCARD_LABEL,
    ];
    for (const text of texts) expect(text).not.toContain('\u2014');
  });
});

describe('the list behind View', () => {
  it('is named for what it holds, uploads with problems, since not every item in it needs attention', () => {
    expect(ATTENTION_LIST_LABEL).toBe('Uploads with problems');
  });

  // main.ts has no DOM tests, so pin that it names the list from the constant and the page has no label of its own.
  it('gets that name from the popup script, and the page carries no copy of it', () => {
    const main = readFileSync(new URL('../entrypoints/popup/main.ts', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../entrypoints/popup/index.html', import.meta.url), 'utf8');
    expect(main).toContain("attentionList.setAttribute('aria-label', ATTENTION_LIST_LABEL);");
    const list = /<ul\b[^>]*\bid="attention-list"[^>]*>/.exec(html)?.[0];
    expect(list).toBeDefined();
    expect(list).not.toContain('aria-label');
    expect(html).not.toContain('Needs attention');
  });
});

describe('attentionEntries', () => {
  it('lists only needs-attention items, in queue order, with their message', () => {
    const first = item('needs_attention', { lastMessage: 'Mailbox key was rejected. Check Settings.' });
    const waiting = item('waiting');
    const uploading = item('uploading');
    const second = item('needs_attention', { lastMessage: 'Too big for the mailbox.' });
    expect(attentionEntries([first, waiting, uploading, second])).toEqual([
      {
        captureId: first.captureId,
        filename: first.filename,
        message: 'Mailbox key was rejected. Check Settings.',
        tone: 'attention',
        actions: true,
        statusLabel: null,
      },
      {
        captureId: second.captureId,
        filename: second.filename,
        message: 'Too big for the mailbox.',
        tone: 'attention',
        actions: true,
        statusLabel: null,
      },
    ]);
  });

  it('falls back to a generic message when an item has none', () => {
    const bare = item('needs_attention');
    const blank = item('needs_attention', { lastMessage: '' });
    expect(attentionEntries([bare, blank]).map((entry) => entry.message)).toEqual([
      ATTENTION_FALLBACK_MESSAGE,
      ATTENTION_FALLBACK_MESSAGE,
    ]);
    expect(ATTENTION_FALLBACK_MESSAGE).toBe('Upload needs attention.');
  });

  it('is empty when nothing needs attention', () => {
    expect(attentionEntries(items('waiting', 'uploading'))).toEqual([]);
    expect(attentionEntries([])).toEqual([]);
  });

  it('also lists waiting items that failed 3 or more times, with their last reason, in queue order', () => {
    const struggling = item('waiting', { attempts: 3, lastMessage: 'Drive storage is full.' });
    const fresh = item('waiting', { attempts: 1, lastMessage: "Couldn't reach Drive. Check your internet connection." });
    const attention = item('needs_attention', { lastMessage: 'Mailbox key was rejected. Check Settings.' });
    const retrying = item('uploading', { attempts: 4, lastMessage: 'The Capture folder is missing. Run setup() again.' });
    const noReason = item('waiting', { attempts: 6 });

    expect(attentionEntries([struggling, fresh, attention, retrying, noReason])).toEqual([
      {
        captureId: struggling.captureId,
        filename: struggling.filename,
        message: 'Drive storage is full.',
        tone: 'waiting',
        actions: true,
        statusLabel: null,
      },
      {
        captureId: attention.captureId,
        filename: attention.filename,
        message: 'Mailbox key was rejected. Check Settings.',
        tone: 'attention',
        actions: true,
        statusLabel: null,
      },
      {
        captureId: retrying.captureId,
        filename: retrying.filename,
        message: 'The Capture folder is missing. Run setup() again.',
        tone: 'uploading',
        actions: false,
        statusLabel: UPLOADING_NOW_LABEL,
      },
    ]);
  });

  // A discard cannot stop an upload under way, so the row offers neither button while one runs.
  describe('a listed item that is uploading right now', () => {
    const reason = 'Drive storage is full.';

    it('keeps its row and its last reason, shows the uploading circle, and hides Retry and Discard', () => {
      const retrying = item('uploading', { attempts: 4, lastMessage: reason });
      expect(attentionEntries([retrying])).toEqual([
        {
          captureId: retrying.captureId,
          filename: retrying.filename,
          message: reason,
          tone: 'uploading',
          actions: false,
          statusLabel: UPLOADING_NOW_LABEL,
        },
      ]);
    });

    it('is read as uploading, since its message alone is still the reason the last attempt failed', () => {
      expect(UPLOADING_NOW_LABEL).toBe('Uploading now.');
      const retrying = item('uploading', { attempts: 4, lastMessage: reason });
      expect(attentionEntries([retrying]).map((entry) => entry.statusLabel)).toEqual([UPLOADING_NOW_LABEL]);
    });

    it('carries no spoken label in any other state', () => {
      const entries = attentionEntries([
        item('waiting', { attempts: 4, lastMessage: reason }),
        item('needs_attention', { lastMessage: 'Too big for the mailbox.' }),
        item('needs_attention'),
      ]);
      expect(entries).toHaveLength(3);
      expect(entries.map((entry) => entry.statusLabel)).toEqual([null, null, null]);
    });

    it('gets its buttons back when it goes back to waiting', () => {
      const failedAgain = item('waiting', { attempts: 4, lastMessage: reason });
      expect(attentionEntries([failedAgain])).toEqual([
        {
          captureId: failedAgain.captureId,
          filename: failedAgain.filename,
          message: reason,
          tone: 'waiting',
          actions: true,
          statusLabel: null,
        },
      ]);
    });

    it('gets its buttons back when it turns into needs attention', () => {
      const rejected = item('needs_attention', { attempts: 4, lastMessage: 'Mailbox key was rejected. Check Settings.' });
      expect(attentionEntries([rejected])).toEqual([
        {
          captureId: rejected.captureId,
          filename: rejected.filename,
          message: 'Mailbox key was rejected. Check Settings.',
          tone: 'attention',
          actions: true,
          statusLabel: null,
        },
      ]);
    });

    it('is not listed on an attempt that is not yet the fourth, or without a reason', () => {
      expect(attentionEntries([item('uploading', { attempts: 3, lastMessage: reason })])).toEqual([]);
      expect(attentionEntries([item('uploading', { attempts: 6 })])).toEqual([]);
    });

    it('hides the buttons of that row only', () => {
      const first = item('waiting', { attempts: 3, lastMessage: reason });
      const second = item('uploading', { attempts: 5, lastMessage: reason });
      const third = item('needs_attention', { lastMessage: 'Too big for the mailbox.' });
      expect(attentionEntries([first, second, third]).map((entry) => [entry.captureId, entry.actions])).toEqual([
        [first.captureId, true],
        [second.captureId, false],
        [third.captureId, true],
      ]);
    });
  });
});

describe('keepExpanded', () => {
  it('keeps the list open while something still needs attention', () => {
    expect(keepExpanded(true, statusLine(items('needs_attention')))).toBe(true);
  });

  it('keeps the list open while a waiting item that keeps failing is in it', () => {
    const line = statusLine([item('waiting', { attempts: 3, lastMessage: 'Drive storage is full.' })]);
    expect(keepExpanded(true, line)).toBe(true);
  });

  it('closes the list once there is nothing to show in it, so it starts closed next time', () => {
    expect(keepExpanded(true, statusLine(items('waiting')))).toBe(false);
    expect(keepExpanded(true, statusLine([]))).toBe(false);
    expect(keepExpanded(true, QUEUE_UNAVAILABLE_STATUS)).toBe(false);
  });

  it('never opens the list by itself', () => {
    expect(keepExpanded(false, statusLine(items('needs_attention')))).toBe(false);
  });
});

describe('Save this PDF row', () => {
  it('is disabled with no hint, but with its hint line reserved, while the check runs', () => {
    expect(pdfRowView('checking')).toEqual({ enabled: false, hint: null, reserveHint: true });
  });

  it('is enabled on a PDF tab', () => {
    expect(pdfRowView('pdf')).toEqual({ enabled: true, hint: null, reserveHint: false });
  });

  it('explains how to use it on a tab that is not a PDF', () => {
    expect(pdfRowView('not-pdf')).toEqual({ enabled: false, hint: 'Open a PDF in this tab to use this.', reserveHint: false });
    expect(NOT_PDF_HINT).toBe('Open a PDF in this tab to use this.');
  });

  it('points local files to Upload files', () => {
    expect(pdfRowView('local-file')).toEqual({ enabled: false, hint: 'Local file? Use Upload files.', reserveHint: false });
    expect(LOCAL_FILE_HINT).toBe('Local file? Use Upload files.');
  });

  it('stays disabled with the PDF hint when the check failed or timed out', () => {
    expect(pdfRowView('unavailable')).toEqual({ enabled: false, hint: NOT_PDF_HINT, reserveHint: false });
  });

  it('reads the background answer, and treats anything else as unavailable', () => {
    expect(pdfRowStateFromResponse({ status: 'pdf' })).toBe('pdf');
    expect(pdfRowStateFromResponse({ status: 'not-pdf' })).toBe('not-pdf');
    expect(pdfRowStateFromResponse({ status: 'local-file' })).toBe('local-file');
    for (const answer of [undefined, null, {}, { status: 'maybe' }, { status: 1 }, 'pdf', [{ status: 'pdf' }]]) {
      expect(pdfRowStateFromResponse(answer)).toBe('unavailable');
    }
  });
});

describe('confirmPdfCapture', () => {
  // Save this PDF asks tab:pdf-status again right before capture:pdf: the answer wakes a stopped service worker (so
  // capture:pdf is not lost when the popup closes) and re-checks the tab.
  it('sends the capture only when the background still says the tab is a PDF', () => {
    expect(confirmPdfCapture({ status: 'pdf' })).toEqual({ send: true, state: 'pdf' });
  });

  it('does not send, and gives the row its new state, when the tab is no longer a PDF', () => {
    expect(confirmPdfCapture({ status: 'not-pdf' })).toEqual({ send: false, state: 'not-pdf' });
    expect(confirmPdfCapture({ status: 'local-file' })).toEqual({ send: false, state: 'local-file' });
  });

  it('does not send when the re-check got no answer in time or a malformed one', () => {
    expect(confirmPdfCapture(undefined)).toEqual({ send: false, state: 'unavailable' });
    expect(confirmPdfCapture({ status: 'maybe' })).toEqual({ send: false, state: 'unavailable' });
  });
});

describe('pdfRecheckAnnouncement', () => {
  // The re-check changes the Save this PDF row without moving focus, so its hint is spoken through a live region.
  it('says nothing when the capture goes ahead', () => {
    expect(pdfRecheckAnnouncement(confirmPdfCapture({ status: 'pdf' }))).toBeNull();
  });

  it('speaks the row hint when the tab is no longer a PDF', () => {
    expect(pdfRecheckAnnouncement(confirmPdfCapture({ status: 'not-pdf' }))).toBe(NOT_PDF_HINT);
  });

  it('speaks the local file hint for a local file', () => {
    expect(pdfRecheckAnnouncement(confirmPdfCapture({ status: 'local-file' }))).toBe(LOCAL_FILE_HINT);
  });

  it('speaks the PDF hint when the re-check got no usable answer', () => {
    expect(pdfRecheckAnnouncement(confirmPdfCapture(undefined))).toBe(NOT_PDF_HINT);
    expect(pdfRecheckAnnouncement(confirmPdfCapture({ status: 'maybe' }))).toBe(NOT_PDF_HINT);
  });

  it('speaks exactly what the row shows as its hint, so the screen and the speech agree', () => {
    for (const response of [{ status: 'not-pdf' }, { status: 'local-file' }, undefined]) {
      const decision = confirmPdfCapture(response);
      expect(pdfRecheckAnnouncement(decision)).toBe(pdfRowView(decision.state).hint);
    }
  });
});

describe('disabledRowAnnouncement', () => {
  it('speaks the Save this PDF hint when the row is pressed while disabled', () => {
    expect(disabledRowAnnouncement('pdf', 'not-pdf')).toBe(NOT_PDF_HINT);
    expect(disabledRowAnnouncement('pdf', 'local-file')).toBe(LOCAL_FILE_HINT);
    expect(disabledRowAnnouncement('pdf', 'unavailable')).toBe(NOT_PDF_HINT);
  });

  it('has nothing to say while the PDF check runs (the row has no hint yet)', () => {
    expect(disabledRowAnnouncement('pdf', 'checking')).toBeNull();
  });

  it('has nothing to say for an enabled row', () => {
    expect(disabledRowAnnouncement('pdf', 'pdf')).toBeNull();
    for (const state of ['checking', 'pdf', 'not-pdf', 'local-file', 'unavailable'] satisfies PdfRowState[]) {
      for (const id of ['area', 'page', 'upload'] satisfies PopupCommandId[]) {
        expect(disabledRowAnnouncement(id, state)).toBeNull();
      }
    }
  });
});

describe('DELIVERY_WAIT_MS', () => {
  it('gives a stopped service worker 2.5 s to take a capture trigger before the popup closes', () => {
    expect(DELIVERY_WAIT_MS).toBe(2_500);
  });
});

describe('commandEnabled', () => {
  const states: PdfRowState[] = ['checking', 'pdf', 'not-pdf', 'local-file', 'unavailable'];

  it('always enables Select area, Whole page, and Upload files', () => {
    for (const state of states) {
      expect(commandEnabled('area', state)).toBe(true);
      expect(commandEnabled('page', state)).toBe(true);
      expect(commandEnabled('upload', state)).toBe(true);
    }
  });

  it('enables Save this PDF only once the background says the tab is a PDF', () => {
    expect(states.filter((state) => commandEnabled('pdf', state))).toEqual(['pdf']);
  });
});

describe('menu keyboard navigation', () => {
  it('makes only the active row a tab stop (roving tabindex)', () => {
    const stops = (active: number) => [0, 1, 2, 3].map((index) => rovingTabIndex(index, active));
    expect(stops(0)).toEqual([0, -1, -1, -1]);
    expect(stops(2)).toEqual([-1, -1, 0, -1]);
    expect(stops(3)).toEqual([-1, -1, -1, 0]);
  });

  it('leaves no tab stop in the menu for an out-of-range active row, so the caller always passes a valid one', () => {
    expect([0, 1, 2, 3].map((index) => rovingTabIndex(index, -1))).toEqual([-1, -1, -1, -1]);
  });

  it('recognises the keys that move the active row', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(isNavigationKey(key)).toBe(true);
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'ArrowLeft', 'a']) expect(isNavigationKey(key)).toBe(false);
  });

  it('moves down and up one row at a time, through every row (disabled rows included)', () => {
    expect(moveSelection(0, 'ArrowDown', 4)).toBe(1);
    expect(moveSelection(1, 'ArrowDown', 4)).toBe(2);
    expect(moveSelection(2, 'ArrowDown', 4)).toBe(3);
    expect(moveSelection(3, 'ArrowUp', 4)).toBe(2);
    expect(moveSelection(1, 'ArrowUp', 4)).toBe(0);
  });

  it('wraps from the last row to the first and from the first to the last', () => {
    expect(moveSelection(3, 'ArrowDown', 4)).toBe(0);
    expect(moveSelection(0, 'ArrowUp', 4)).toBe(3);
  });

  it('jumps to the first and last rows with Home and End', () => {
    expect(moveSelection(2, 'Home', 4)).toBe(0);
    expect(moveSelection(1, 'End', 4)).toBe(3);
  });

  it('visits every row exactly once in a full cycle', () => {
    const seen: number[] = [];
    let index = 0;
    for (let step = 0; step < 4; step += 1) {
      seen.push(index);
      index = moveSelection(index, 'ArrowDown', 4);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(index).toBe(0);
  });

  it('recovers from an out-of-range current row and handles a single row', () => {
    expect(moveSelection(-1, 'ArrowDown', 4)).toBe(0);
    expect(moveSelection(9, 'ArrowUp', 4)).toBe(3);
    expect(moveSelection(0, 'ArrowDown', 1)).toBe(0);
    expect(moveSelection(0, 'ArrowUp', 1)).toBe(0);
  });
});

describe('focusIndexAfterActionsLost', () => {
  it('moves focus to the item that took the removed item\'s place, or the new last item', () => {
    expect(focusIndexAfterActionsLost(0, [true, true])).toBe(0);
    expect(focusIndexAfterActionsLost(1, [true, true])).toBe(1);
    expect(focusIndexAfterActionsLost(2, [true, true])).toBe(1);
  });

  it('has nowhere to go when the list is now empty', () => {
    expect(focusIndexAfterActionsLost(0, [])).toBeNull();
  });

  it('moves focus on to the next item when the focused item stays but lost its buttons (it started uploading)', () => {
    expect(focusIndexAfterActionsLost(0, [false, true])).toBe(1);
    expect(focusIndexAfterActionsLost(1, [true, false, true])).toBe(2);
  });

  it('goes back to the item before when no later item has buttons', () => {
    expect(focusIndexAfterActionsLost(1, [true, false])).toBe(0);
    expect(focusIndexAfterActionsLost(2, [true, false, false])).toBe(0);
  });

  it('skips items that are uploading too, also when the removed item\'s neighbor is one of them', () => {
    expect(focusIndexAfterActionsLost(0, [false, false, true])).toBe(2);
    expect(focusIndexAfterActionsLost(1, [true, false, true])).toBe(2);
    expect(focusIndexAfterActionsLost(2, [true, false])).toBe(0);
  });

  it('has nowhere to go when every item is uploading, which leaves the status line to take focus', () => {
    expect(focusIndexAfterActionsLost(0, [false])).toBeNull();
    expect(focusIndexAfterActionsLost(1, [false, false])).toBeNull();
  });

  it('copes with a position outside the list', () => {
    expect(focusIndexAfterActionsLost(-3, [true, true])).toBe(0);
    expect(focusIndexAfterActionsLost(9, [true, false])).toBe(0);
  });
});

describe('focusMoveAfterRender', () => {
  const entry = (captureId: string, actions: boolean) => ({ captureId, actions });
  const focus = (index: number, captureId: string, button: 'retry' | 'discard') => ({ index, captureId, button });

  it('leaves focus alone while its button is still there', () => {
    const entries = [entry('a', true), entry('b', true)];
    expect(focusMoveAfterRender(focus(1, 'b', 'retry'), entries, true)).toEqual({ kind: 'keep' });
    expect(focusMoveAfterRender(focus(1, 'b', 'discard'), entries, true)).toEqual({ kind: 'keep' });
    // The item moved up because an earlier one left: its button still has focus.
    expect(focusMoveAfterRender(focus(1, 'b', 'retry'), [entry('b', true)], true)).toEqual({ kind: 'keep' });
  });

  it('moves a removed item\'s Retry or Discard to the same button of the item that took its place', () => {
    const entries = [entry('a', true), entry('c', true)];
    expect(focusMoveAfterRender(focus(1, 'b', 'retry'), entries, true)).toEqual({ kind: 'row', index: 1, button: 'retry' });
    expect(focusMoveAfterRender(focus(1, 'b', 'discard'), entries, true)).toEqual({
      kind: 'row',
      index: 1,
      button: 'discard',
    });
    // The last item was removed: the new last item.
    expect(focusMoveAfterRender(focus(2, 'd', 'discard'), entries, true)).toEqual({
      kind: 'row',
      index: 1,
      button: 'discard',
    });
  });

  it('skips an item that is uploading when the removed item\'s place is taken by one', () => {
    const entries = [entry('a', true), entry('c', false), entry('d', true)];
    expect(focusMoveAfterRender(focus(1, 'b', 'retry'), entries, true)).toEqual({ kind: 'row', index: 2, button: 'retry' });
  });

  it('moves a Retry whose item started uploading to the Retry of the next item with buttons', () => {
    const entries = [entry('a', true), entry('b', false), entry('c', true)];
    expect(focusMoveAfterRender(focus(1, 'b', 'retry'), entries, true)).toEqual({ kind: 'row', index: 2, button: 'retry' });
    // Nothing after it: the one before.
    expect(focusMoveAfterRender(focus(2, 'c', 'retry'), [entry('a', true), entry('b', true), entry('c', false)], true)).toEqual({
      kind: 'row',
      index: 1,
      button: 'retry',
    });
  });

  // A Discard that was pressed just as the upload started is refused, and its item stays. Focus must not then land on
  // another item's Discard, where one more Enter would discard something the user never chose.
  it('sends a Discard whose item stays listed but lost its buttons to the fallback, never to another Discard', () => {
    const entries = [entry('a', true), entry('b', false), entry('c', true)];
    expect(focusMoveAfterRender(focus(1, 'b', 'discard'), entries, true)).toEqual({ kind: 'fallback' });
    expect(focusMoveAfterRender(focus(0, 'a', 'discard'), [entry('a', false), entry('b', true)], true)).toEqual({
      kind: 'fallback',
    });
  });

  it('uses the fallback when no item shows buttons any more, or the list is closed', () => {
    expect(focusMoveAfterRender(focus(0, 'a', 'retry'), [entry('a', false), entry('b', false)], true)).toEqual({
      kind: 'fallback',
    });
    expect(focusMoveAfterRender(focus(0, 'a', 'retry'), [], true)).toEqual({ kind: 'fallback' });
    expect(focusMoveAfterRender(focus(0, 'a', 'discard'), [], true)).toEqual({ kind: 'fallback' });
    expect(focusMoveAfterRender(focus(0, 'a', 'retry'), [entry('b', true)], false)).toEqual({ kind: 'fallback' });
  });
});

describe('ariaKeyShortcuts', () => {
  it('names the Windows and Linux form with ARIA key names', () => {
    expect(ariaKeyShortcuts(['Alt', 'Shift', 'S'])).toBe('Alt+Shift+S');
    expect(ariaKeyShortcuts(['Ctrl', 'Shift', '7'])).toBe('Control+Shift+7');
  });

  it('names the macOS symbols', () => {
    expect(ariaKeyShortcuts(['⌥', '⇧', 'S'])).toBe('Alt+Shift+S');
    expect(ariaKeyShortcuts(['⌘', '⇧', 'S'])).toBe('Meta+Shift+S');
    expect(ariaKeyShortcuts(['⌃', '⇧', 'S'])).toBe('Control+Shift+S');
    expect(ariaKeyShortcuts(['Command', 'Shift', 'S'])).toBe('Meta+Shift+S');
    expect(ariaKeyShortcuts(['MacCtrl', 'Shift', 'S'])).toBe('Control+Shift+S');
  });

  it('leaves the attribute out for no shortcut or a key it cannot name', () => {
    expect(ariaKeyShortcuts([])).toBeUndefined();
    expect(ariaKeyShortcuts(['Ctrl', 'Shift', 'MediaNextTrack'])).toBeUndefined();
  });
});

describe('coalesce', () => {
  /** Lets every pending promise callback run. */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
    let resolve = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('runs the task once per call when calls do not overlap', async () => {
    let runs = 0;
    const refresh = coalesce(async () => {
      runs += 1;
    });
    await refresh();
    await refresh();
    expect(runs).toBe(2);
  });

  it('runs once more after the current run for any number of calls made during it', async () => {
    const gates = [deferred(), deferred()];
    let runs = 0;
    const refresh = coalesce(async () => {
      const gate = gates[runs];
      runs += 1;
      await gate?.promise;
    });

    const first = refresh();
    const second = refresh();
    const third = refresh();
    expect(runs).toBe(1);

    gates[0]?.resolve();
    await flush();
    expect(runs).toBe(2);
    gates[1]?.resolve();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);

    await refresh();
    expect(runs).toBe(3);
  });

  it('passes a failure to every waiting caller and runs again on the next call', async () => {
    const gate = deferred();
    let runs = 0;
    const refresh = coalesce(async () => {
      runs += 1;
      if (runs === 1) await gate.promise;
    });
    const first = refresh();
    const second = refresh();
    gate.reject(new Error('read failed'));
    await expect(first).rejects.toThrow('read failed');
    await expect(second).rejects.toThrow('read failed');
    await refresh();
    expect(runs).toBe(2);
  });
});
