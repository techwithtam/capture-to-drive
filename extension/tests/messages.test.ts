// Runtime message guards: the background only acts on well-formed queue requests.
import { describe, expect, it } from 'vitest';
import {
  isNoReceiverError,
  isNoteCardMessage,
  isNoteCardResponse,
  isNoteGetResponse,
  isNoteRequestMessage,
  isNoteSaveResponse,
  isQueueChangedMessage,
  isQueueRequestMessage,
  isSelectAreaAbortMessage,
  isSelectAreaMessage,
} from '../lib/messages';

describe('isSelectAreaAbortMessage', () => {
  it('accepts the background abort without treating it as an overlay result', () => {
    const message = { type: 'select-area:abort' };
    expect(isSelectAreaAbortMessage(message)).toBe(true);
    expect(isSelectAreaMessage(message)).toBe(false);
  });

  it.each([null, undefined, {}, 'select-area:abort', { type: 'select-area:cancel' }, { type: 'note:show' }])(
    'rejects %j', (message) => { expect(isSelectAreaAbortMessage(message)).toBe(false); },
  );
});

describe('isSelectAreaMessage', () => {
  const rect = { x: 10, y: 20, width: 100, height: 80 };

  it.each([
    [{ type: 'select-area:cancel' }],
    [{ type: 'select-area:visible' }],
    [{ type: 'select-area:done', rect, viewportWidth: 1000, viewportHeight: 800 }],
  ])('accepts %j', (message) => {
    expect(isSelectAreaMessage(message)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    ['select-area:visible'],
    [{}],
    [{ type: 'select-area:abort' }],
    [{ type: 'select-area:visible-area' }],
    [{ type: 'select-area:done' }],
    [{ type: 'select-area:done', rect: { ...rect, width: 7 }, viewportWidth: 1000, viewportHeight: 800 }],
    [{ type: 'select-area:done', rect, viewportWidth: 0, viewportHeight: 800 }],
  ])('rejects %j', (message) => {
    expect(isSelectAreaMessage(message)).toBe(false);
  });
});

describe('isQueueRequestMessage', () => {
  it.each([
    [{ type: 'queue:kick' }],
    [{ type: 'queue:retry' }],
    [{ type: 'queue:retry', captureId: 'a' }],
    [{ type: 'queue:discard', captureId: 'a' }],
  ])('accepts %j', (message) => {
    expect(isQueueRequestMessage(message)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    ['queue:kick'],
    [{}],
    [{ type: 'queue:changed', captureId: 'a', state: 'saved' }],
    [{ type: 'queue:retry', captureId: 7 }],
    [{ type: 'queue:retry', captureId: '' }],
    [{ type: 'queue:discard' }],
    [{ type: 'queue:discard', captureId: '' }],
    [{ type: 'capture:area', tabId: 1 }],
  ])('rejects %j', (message) => {
    expect(isQueueRequestMessage(message)).toBe(false);
  });
});

describe('isQueueChangedMessage', () => {
  it.each(['saved', 'waiting', 'uploading', 'needs_attention', 'discarded'])('accepts state %s', (state) => {
    expect(isQueueChangedMessage({ type: 'queue:changed', captureId: 'a', state })).toBe(true);
  });

  it('accepts a message line', () => {
    const message = { type: 'queue:changed', captureId: 'a', state: 'needs_attention', message: 'Too big for the mailbox.' };
    expect(isQueueChangedMessage(message)).toBe(true);
  });

  it.each([
    [{ type: 'queue:changed', captureId: 'a', state: 'lost' }],
    [{ type: 'queue:changed', state: 'saved' }],
    [{ type: 'queue:changed', captureId: 'a', state: 'saved', message: 3 }],
    [{ type: 'queue:kick' }],
    [null],
  ])('rejects %j', (message) => {
    expect(isQueueChangedMessage(message)).toBe(false);
  });
});

describe('isNoReceiverError', () => {
  it("recognizes Chrome's error for a broadcast that no page is listening to", () => {
    expect(isNoReceiverError(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(true);
  });

  it.each([[new Error('Extension context invalidated.')], ['Receiving end does not exist.'], [undefined]])(
    'does not match %s',
    (error) => {
      expect(isNoReceiverError(error)).toBe(false);
    },
  );
});

describe('isNoteRequestMessage', () => {
  it.each([
    [{ type: 'note:get', captureId: 'a' }],
    [{ type: 'note:save', captureId: 'a', note: '' }],
    [{ type: 'note:save', captureId: 'a', note: 'Costco, for taxes' }],
    [{ type: 'note:discard', captureId: 'a' }],
  ])('accepts %j', (message) => {
    expect(isNoteRequestMessage(message)).toBe(true);
  });

  it.each([
    [null],
    [{ type: 'note:get' }],
    [{ type: 'note:get', captureId: '' }],
    [{ type: 'note:save', captureId: 'a' }],
    [{ type: 'note:save', captureId: 'a', note: 7 }],
    [{ type: 'note:save', note: 'x' }],
    [{ type: 'note:discard', captureId: 3 }],
    [{ type: 'note:show', captureId: 'a', filename: 'x.png', fileKind: 'image' }],
    [{ type: 'queue:kick' }],
  ])('rejects %j', (message) => {
    expect(isNoteRequestMessage(message)).toBe(false);
  });
});

describe('isNoteCardMessage', () => {
  it.each([
    [{ type: 'note:show', captureId: 'a', filename: 'x.png', fileKind: 'image' }],
    [
      {
        type: 'note:show',
        captureId: 'a',
        filename: 'x.png',
        fileKind: 'image',
        thumbnailDataUrl: 'data:image/png;base64,AAAA',
        message: "Selection isn't available on this page, so the visible area was captured.",
      },
    ],
    [{ type: 'note:show', captureId: 'a', filename: 'x.pdf', fileKind: 'pdf' }],
    [{ type: 'note:show', captureId: 'a', filename: 'x.bin', fileKind: 'file' }],
    [{ type: 'note:message', message: 'That link opens a web page, not a file.', kind: 'error' }],
    [{ type: 'note:message', message: 'Hello.', kind: 'info' }],
  ])('accepts %j', (message) => {
    expect(isNoteCardMessage(message)).toBe(true);
  });

  it.each([
    [{ type: 'note:show', captureId: 'a', filename: 'x.png', fileKind: 'video' }],
    [{ type: 'note:show', captureId: '', filename: 'x.png', fileKind: 'image' }],
    [{ type: 'note:show', captureId: 'a', fileKind: 'image' }],
    [{ type: 'note:show', captureId: 'a', filename: 'x.png', fileKind: 'image', thumbnailDataUrl: 5 }],
    // Only image data URLs may become an <img> source in a web page.
    [{ type: 'note:show', captureId: 'a', filename: 'x.png', fileKind: 'image', thumbnailDataUrl: 'https://example.com/x.png' }],
    [{ type: 'note:show', captureId: 'a', filename: 'x.png', fileKind: 'image', message: null }],
    [{ type: 'note:message', message: 'x', kind: 'warning' }],
    [{ type: 'note:message', kind: 'error' }],
    [{ type: 'note:get', captureId: 'a' }],
    [undefined],
  ])('rejects %j', (message) => {
    expect(isNoteCardMessage(message)).toBe(false);
  });
});

describe('isNoteSaveResponse', () => {
  it.each([
    [{ outcome: 'saved' }],
    [{ outcome: 'will_retry' }],
    [{ outcome: 'needs_attention', message: 'Mailbox key was rejected. Check Settings.' }],
  ])('accepts %j', (response) => {
    expect(isNoteSaveResponse(response)).toBe(true);
  });

  it.each([[undefined], [null], [{}], [{ outcome: 'lost' }], [{ outcome: 'saved', message: 4 }], [{ ok: true }]])(
    'rejects %j',
    (response) => {
      expect(isNoteSaveResponse(response)).toBe(false);
    },
  );
});

describe('isNoteCardResponse', () => {
  it('accepts the card answer', () => {
    expect(isNoteCardResponse({ ok: true })).toBe(true);
    expect(isNoteCardResponse({ ok: false })).toBe(true);
  });

  it.each([[undefined], [{}], [{ ok: 'yes' }]])('rejects %j', (response) => {
    expect(isNoteCardResponse(response)).toBe(false);
  });
});

describe('isNoteGetResponse', () => {
  it.each([
    [{ capture: null }],
    [{ capture: { captureId: 'a', filename: 'x.png', fileKind: 'image' } }],
    [{ capture: { captureId: 'a', filename: 'x.pdf', fileKind: 'pdf', message: 'Hi.' } }],
  ])('accepts %j', (response) => {
    expect(isNoteGetResponse(response)).toBe(true);
  });

  it.each([
    [undefined],
    [{}],
    [{ capture: undefined }],
    [{ capture: { captureId: 'a', filename: 'x.png' } }],
    [{ capture: { captureId: 'a', filename: 'x.png', fileKind: 'image', thumbnailDataUrl: 'javascript:alert(1)' } }],
  ])('rejects %j', (response) => {
    expect(isNoteGetResponse(response)).toBe(false);
  });
});
