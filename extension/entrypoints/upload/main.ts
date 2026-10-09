import '@/assets/tokens.css';
import '@/assets/components.css';
import './style.css';
import { browser } from 'wxt/browser';
import { createIcon } from '@/lib/icons';
import { isQueueChangedMessage } from '@/lib/messages';
import type { QueueKickMessage, QueueRequestResponse } from '@/lib/messages';
import { addItem } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import type { Settings } from '@/lib/settings';
import {
  ADDING_ROW_STATE,
  ALL_QUEUED_MESSAGE,
  ANNOUNCEMENT_PREFIX_LIFETIME_MS,
  buildUploadRecord,
  formatFileSize,
  rowStateFromBroadcast,
  SOME_QUEUED_MESSAGE,
  START_FAILED_MESSAGE,
  statusAnnouncementPrefix,
  storeBatch,
  uploadRejection,
  WAITING_ROW_STATE,
} from '@/lib/upload-batch';
import type { UploadRowState } from '@/lib/upload-batch';

function requireElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Upload page is missing #${id}`);
  return element;
}

const controls = requireElement('upload-controls', HTMLElement);
const settingsRequired = requireElement('settings-required', HTMLElement);
const loading = requireElement('loading', HTMLElement);
const dropZone = requireElement('drop-zone', HTMLElement);
const fileInput = requireElement('file-input', HTMLInputElement);
const noteInput = requireElement('note', HTMLTextAreaElement);
const fileList = requireElement('file-list', HTMLUListElement);
const results = requireElement('file-results', HTMLElement);
const pageMessage = requireElement('page-message', HTMLElement);
const openSettings = requireElement('open-settings', HTMLButtonElement);

interface FileRow {
  element: HTMLLIElement;
  status: HTMLSpanElement;
  fileName: string;
  /**
   * True once the file is in the queue: stored by this page, or reported by the background, which only knows files
   * that are stored. Until then the row says Adding….
   */
  queued: boolean;
  /** Removes the spoken-only file name once it has been read out. */
  prefixTimer?: number;
}

const rows = new Map<string, FileRow>();
let settings: Settings | null = null;
let settingsRefresh = 0;
/** Accepted files, across every batch on the page, that are not stored yet. */
let adding = 0;
/** Files that could not be stored since the page message was last cleared (the latest batch started). */
let storeFailures = 0;

/**
 * Sets the page message, a polite live region. Nearly every message is a problem, so it is red; `ok` is for the
 * "every file is queued" line.
 */
function setPageMessage(text: string, ok = false): void {
  pageMessage.classList.toggle('page-message-ok', ok);
  pageMessage.textContent = text;
}

/**
 * Adds the failed-start guidance after the "every file is queued" line when that is what the page message shows: the line
 * stays true (the files are safe), and the live region reads only what was added. Otherwise it is the whole message.
 */
function showStartFailed(): void {
  if (pageMessage.textContent !== ALL_QUEUED_MESSAGE) {
    setPageMessage(`${SOME_QUEUED_MESSAGE} ${START_FAILED_MESSAGE}`);
    return;
  }
  const failure = document.createElement('span');
  failure.className = 'field-error';
  failure.textContent = ` ${START_FAILED_MESSAGE}`;
  pageMessage.append(failure);
}

/**
 * How a row's status is shown:
 * - `new`: the row is being created. It is announced whole, with its name, size and status, so it needs no prefix.
 * - `announced`: a change to an existing row. The list's live region reads it out as just the new text, so the file name
 *   goes in front of it (spoken only) to say which file changed. The name is taken out again a few seconds later, once
 *   it has been read, so browsing the list afterwards does not read the name twice.
 * - `quiet`: a change that is shown but not read out (Adding… to Waiting: the arrival of the row was announced, and the
 *   page message says when every file is queued). `aria-live="off"` on the status keeps the live region silent; the
 *   next change takes it off again.
 */
type RowChange = 'new' | 'announced' | 'quiet';

function setRowState(row: FileRow, state: Readonly<UploadRowState>, change: RowChange = 'new'): void {
  if (row.prefixTimer !== undefined) window.clearTimeout(row.prefixTimer);
  row.prefixTimer = undefined;
  if (change === 'quiet') row.status.setAttribute('aria-live', 'off');
  else row.status.removeAttribute('aria-live');
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.setAttribute('aria-hidden', 'true');
  row.status.className = `status file-status ${state.className}`;
  const parts: Array<Node | string> = [dot];
  if (change === 'announced') {
    const prefix = document.createElement('span');
    prefix.className = 'visually-hidden';
    prefix.textContent = statusAnnouncementPrefix(row.fileName);
    parts.push(prefix);
    row.prefixTimer = window.setTimeout(() => {
      row.prefixTimer = undefined;
      prefix.remove();
    }, ANNOUNCEMENT_PREFIX_LIFETIME_MS);
  }
  parts.push(state.text);
  row.status.replaceChildren(...parts);
}

function createRow(file: File, state: Readonly<UploadRowState>): FileRow {
  const element = document.createElement('li');
  element.className = 'file-row';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = formatFileSize(file.size);
  const row: FileRow = { element, status: document.createElement('span'), fileName: file.name, queued: false };
  setRowState(row, state);
  element.append(name, size, row.status);
  results.hidden = false;
  fileList.append(element);
  return row;
}

/** Asks the background to process the queue. Resolves once it has; rejects if it could not. */
async function kickQueue(): Promise<void> {
  const message: QueueKickMessage = { type: 'queue:kick' };
  const response: QueueRequestResponse | undefined = await browser.runtime.sendMessage(message);
  if (response?.ok === false) throw new Error('Queue kick failed');
}

async function queueFiles(files: readonly File[]): Promise<void> {
  if (settings === null || files.length === 0) return;
  const name = settings.name;
  const note = noteInput.value;
  setPageMessage('');
  storeFailures = 0;

  // Render every row and turn away empty and oversize files before the first asynchronous storage call.
  const accepted: { file: File; captureId: string; row: FileRow }[] = [];
  for (const file of files) {
    const rejection = uploadRejection(file.size);
    if (rejection !== null) {
      createRow(file, { className: 'status-attention', text: rejection });
      continue;
    }
    const captureId = crypto.randomUUID();
    // The new row is announced whole, "Adding…" included. Waiting follows quietly once the file is stored.
    const row = createRow(file, ADDING_ROW_STATE);
    rows.set(captureId, row);
    accepted.push({ file, captureId, row });
    adding += 1;
  }

  // The background starts on the first stored file, so closing the tab right after a drop still uploads what is stored.
  const { started } = await storeBatch(accepted, {
    store: ({ file, captureId }) => addItem(buildUploadRecord({ file, captureId, capturedAt: new Date(), name, note })),
    kick: kickQueue,
    onStored: ({ row }) => {
      adding -= 1;
      // A broadcast can get here first (the background is already working on this file): its newer state stands.
      if (!row.queued) {
        row.queued = true;
        setRowState(row, WAITING_ROW_STATE, 'quiet');
      }
      // Said as soon as the last file is stored, not when the final kick answers, which can take the whole upload.
      // A file that could not be stored is not queued, so the line would be untrue.
      if (adding === 0 && storeFailures === 0) setPageMessage(ALL_QUEUED_MESSAGE, true);
    },
    onStoreFailed: ({ captureId, row }) => {
      adding -= 1;
      storeFailures += 1;
      rows.delete(captureId);
      setRowState(row, { className: 'status-attention', text: "Failed: Couldn't queue this file. Choose it again." }, 'announced');
    },
  });
  if (started === false) showStartFailed();
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isQueueChangedMessage(message)) return;
  const row = rows.get(message.captureId);
  if (row === undefined) return;
  row.queued = true;
  const state = rowStateFromBroadcast(message);
  if (state === null) {
    row.element.remove();
    rows.delete(message.captureId);
    results.hidden = fileList.childElementCount === 0;
  } else {
    setRowState(row, state, 'announced');
  }
});

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = ''; // Allows choosing the same file again.
  void queueFiles(files);
});

// Prevent the browser from opening whatever is dropped (a file, a link) in this tab, including drops outside the zone,
// which would lose files not stored yet. The one exception is text dropped into a text field such as Note, which the
// browser inserts there.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  const intoTextField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (!intoTextField || event.dataTransfer?.types.includes('Files') === true) event.preventDefault();
  dropZone.classList.remove('drag-over');
  dragDepth = 0;
});

let dragDepth = 0;
dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
});
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  void queueFiles(Array.from(event.dataTransfer?.files ?? []));
});

async function refreshSettings(): Promise<void> {
  const refresh = ++settingsRefresh;
  try {
    const loaded = await getSettings();
    if (refresh !== settingsRefresh) return;
    settings = loaded;
    controls.hidden = loaded === null;
    settingsRequired.hidden = loaded !== null;
    loading.hidden = true;
  } catch {
    if (refresh !== settingsRefresh) return;
    settings = null;
    controls.hidden = true;
    loading.hidden = true;
    setPageMessage("Couldn't load your saved settings. Reload this page.");
  }
}

openSettings.addEventListener('click', () => {
  browser.runtime.openOptionsPage().catch(() => {
    setPageMessage("Couldn't open Settings. Open them from the extension popup.");
  });
});

requireElement('app-mark', HTMLElement).append(createIcon('crop'));
requireElement('upload-icon', HTMLElement).append(createIcon('upload'));
window.addEventListener('focus', () => { void refreshSettings(); });
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'settings' in changes) void refreshSettings();
});
void refreshSettings();
