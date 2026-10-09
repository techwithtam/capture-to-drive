// Note window (spec section 6.4): the note step in a small popup window, for tabs that cannot host the in-page card
// (browser pages, the web store) or captures without a tab. The background opens it as
//   note.html?id=<captureId>              the note step for a pending capture (fetched with note:get)
//   note.html?message=<text>&kind=<kind>  a message on its own (showMessage)
// The window uses the same view as the in-page card and closes itself when the view is finished.

import '@/assets/tokens.css';
import '@/assets/components.css';
import '@/assets/note-view.css';
import type { NoteCaptureView, NoteMessageKind } from '@/lib/messages';
import { isNoteGetResponse } from '@/lib/messages';
import { NOTE_DIALOG_LABEL, NOTE_GONE_TEXT, settleWithin } from '@/lib/note-status';
import { sendNoteRequest } from '@/lib/note-transport';
import { createMessageView, createNoteView } from '@/lib/note-view';
import type { MountedView } from '@/lib/note-view';

/** How long to wait for the background to answer note:get before saying the capture is gone. */
const GET_TIMEOUT_MS = 10_000;
/** How long Discard waits for the background to take the message before the window closes anyway. */
const DISCARD_TIMEOUT_MS = 2000;

const app = document.getElementById('app');
const heading = document.getElementById('note-heading');
if (!(app instanceof HTMLElement) || !(heading instanceof HTMLElement)) throw new Error('Note window is missing #app');

function closeWindow(): void {
  window.close();
}

function mount(view: MountedView): void {
  app?.append(view.element);
  // Esc anywhere in the window, not only inside the view (focus may be on the page background).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !event.isTrusted) return;
    event.preventDefault();
    view.cancel();
  });
}

function showMessage(message: string, kind: NoteMessageKind): void {
  heading?.replaceChildren(NOTE_DIALOG_LABEL);
  document.title = NOTE_DIALOG_LABEL;
  mount(createMessageView(document, { message, kind }, { onFinished: closeWindow }));
}

/** What to show for the capture, or null when it is gone or the background did not answer. */
async function fetchCapture(captureId: string): Promise<NoteCaptureView | null> {
  const answer = await settleWithin(sendNoteRequest({ type: 'note:get', captureId }), GET_TIMEOUT_MS);
  return isNoteGetResponse(answer) ? answer.capture : null;
}

async function showNoteStep(captureId: string): Promise<void> {
  const capture = await fetchCapture(captureId);
  if (capture === null) {
    showMessage(NOTE_GONE_TEXT, 'error');
    return;
  }
  let discarding = false;
  const view = createNoteView(document, capture, {
    save: (note) => sendNoteRequest({ type: 'note:save', captureId, note }),
    discard: () => {
      discarding = true;
      // Closing the window at once could cut the message off, so close once the background has it.
      void settleWithin(sendNoteRequest({ type: 'note:discard', captureId }), DISCARD_TIMEOUT_MS).then(closeWindow);
    },
    // 2 s after a saved or still-uploading status, or when the user closes a save that ended in an error (Close or Esc:
    // the view never finishes an error by itself). A discard closes the window itself, above.
    onFinished: () => {
      if (!discarding) closeWindow();
    },
  });
  mount(view);
  view.focus();
}

const params = new URLSearchParams(location.search);
const captureId = params.get('id');
const message = params.get('message');

if (captureId !== null && captureId !== '') {
  void showNoteStep(captureId);
} else if (message !== null && message !== '') {
  showMessage(message, params.get('kind') === 'info' ? 'info' : 'error');
} else {
  showMessage(NOTE_GONE_TEXT, 'error');
}
