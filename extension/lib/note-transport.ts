// How the note card (content script) and the note window talk to the background. A request that cannot even be sent
// rejects with NoteNotSentError, so the UI can tell "never reached the background" (nothing will upload: say so) from
// "sent, but no answer came" (the background has it and the queue carries on).

import { browser } from 'wxt/browser';
import type { NoteRequestMessage } from './messages';
import { NoteNotSentError } from './note-status';

/** Sends a note request to the background and resolves with its answer. */
export function sendNoteRequest(message: NoteRequestMessage): Promise<unknown> {
  // In a content script whose extension was reloaded or updated, the runtime is gone and nothing can be sent.
  if (browser.runtime?.id === undefined) {
    return Promise.reject(new NoteNotSentError('The extension was reloaded, so this page can no longer reach it.'));
  }
  try {
    return Promise.resolve(browser.runtime.sendMessage(message));
  } catch (error) {
    // Chrome throws (rather than rejects) "Extension context invalidated." when the context is gone.
    return Promise.reject(new NoteNotSentError('The request could not be sent.', { cause: error }));
  }
}
