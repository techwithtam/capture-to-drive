// The card's and window's link to the background: a request that cannot even be sent (extension reloaded, so the
// content script's runtime is gone) must fail as "not sent", never as "sent, no answer".
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitSaveAnswer, isNotDeliveredError, NoteNotSentError } from '../lib/note-status';
import { sendNoteRequest } from '../lib/note-transport';

const runtime = fakeBrowser.runtime as { id?: string };
const EXTENSION_ID = runtime.id;

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  // fakeBrowser.reset() does not restore an id set on fakeBrowser.runtime itself.
  runtime.id = EXTENSION_ID;
});

describe('sendNoteRequest', () => {
  it('sends the request and resolves with the answer', async () => {
    fakeBrowser.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ outcome: 'saved' });
      return true;
    });
    await expect(sendNoteRequest({ type: 'note:save', captureId: 'a', note: '' })).resolves.toEqual({ outcome: 'saved' });
  });

  it('rejects with NoteNotSentError, without sending, when the extension context is gone', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    // What a content script sees after the extension is reloaded or updated.
    runtime.id = undefined;
    const sending = sendNoteRequest({ type: 'note:save', captureId: 'a', note: 'x' });
    await expect(sending).rejects.toBeInstanceOf(NoteNotSentError);
    expect(send).not.toHaveBeenCalled();
  });

  it('turns a synchronous throw from sendMessage into NoteNotSentError', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    const error: unknown = await sendNoteRequest({ type: 'note:discard', captureId: 'a' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoteNotSentError);
    expect(isNotDeliveredError(error)).toBe(true);
  });

  it('leaves an asynchronous "port closed" rejection as it is (sent, no answer)', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(
      new Error('The message port closed before a response was received.'),
    );
    const result = await awaitSaveAnswer(() => sendNoteRequest({ type: 'note:save', captureId: 'a', note: '' }), 1000);
    expect(result).toEqual({ kind: 'no_answer' });
  });

  it('makes awaitSaveAnswer report not_sent once the context is gone', async () => {
    runtime.id = undefined;
    const result = await awaitSaveAnswer(() => sendNoteRequest({ type: 'note:save', captureId: 'a', note: '' }), 1000);
    expect(result).toEqual({ kind: 'not_sent' });
  });
});
