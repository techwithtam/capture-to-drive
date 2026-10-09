// Toolbar popup (spec sections 6.3, 6.5, 6.6): four capture rows, the upload queue's status line with the list behind
// View (needs-attention items, and waiting items that keep failing), and a Settings link; or, while settings are
// incomplete, only a Finish setup button.
//
// The decisions live in lib/popup-model.ts. This file renders them and talks to the browser. Everything that waits on
// the browser (settings, the PDF check, the shortcut, the queue) fills in after the first render, so the rows are
// usable at once.

import '@/assets/tokens.css';
import '@/assets/components.css';
import './style.css';
import { browser } from 'wxt/browser';
import { createIcon } from '@/lib/icons';
import { isQueueChangedMessage } from '@/lib/messages';
import type { QueueRequestMessage, TabPdfStatusMessage } from '@/lib/messages';
import { settleWithin } from '@/lib/note-status';
import {
  ATTENTION_LIST_LABEL,
  COMMANDS_MENU_LABEL,
  DELIVERY_WAIT_MS,
  DISCARD_LABEL,
  FINISH_SETUP_LABEL,
  HIDE_LABEL,
  PDF_STATUS_TIMEOUT_MS,
  POPUP_COMMANDS,
  QUEUE_UNAVAILABLE_STATUS,
  RETRY_LABEL,
  RETRY_NOW_LABEL,
  SETUP_TEXT,
  VIEW_LABEL,
  ariaKeyShortcuts,
  attentionEntries,
  captureMessage,
  coalesce,
  commandEnabled,
  confirmPdfCapture,
  discardMessage,
  disabledRowAnnouncement,
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
} from '@/lib/popup-model';
import type {
  AttentionButton,
  AttentionEntry,
  CaptureCommandId,
  PdfRowState,
  PopupCommand,
  PopupCommandId,
  StatusLineView,
  StatusTone,
} from '@/lib/popup-model';
import { listItems } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import { shortcutKeys } from '@/lib/shortcut-keys';

const STATUS_CLASS: Record<StatusTone, string> = {
  saved: 'status-saved',
  waiting: 'status-waiting',
  uploading: 'status-uploading',
  attention: 'status-attention',
};

function requireElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Popup is missing #${id}`);
  return element;
}

function logFailure(what: string): (error: unknown) => void {
  return (error) => {
    console.error(`Capture to Drive: ${what} failed.`, error);
  };
}

/** Sends a runtime message. A synchronous throw (extension reloaded) becomes a rejection like any other failure. */
function send(message: unknown): Promise<unknown> {
  try {
    return Promise.resolve(browser.runtime.sendMessage(message));
  } catch (error) {
    return Promise.reject(error);
  }
}

const setup = requireElement('setup', HTMLElement);
const finishSetup = requireElement('finish-setup', HTMLButtonElement);
const menu = requireElement('menu', HTMLElement);
const commands = requireElement('commands', HTMLElement);
const announcer = requireElement('announcer', HTMLElement);
const queueStatus = requireElement('queue-status', HTMLElement);
const statusRetry = requireElement('status-retry', HTMLButtonElement);
const statusView = requireElement('status-view', HTMLButtonElement);
const attentionList = requireElement('attention-list', HTMLUListElement);
const openSettings = requireElement('open-settings', HTMLButtonElement);

// Browser state, requested at once and used when it arrives. -----------------------------------------------------

/** False until settings are known to be complete; captures wait for it, and the gate replaces the menu if not. */
const settingsComplete: Promise<boolean> = getSettings().then(
  (settings) => settings !== null,
  () => false,
);

/** The tab the popup was opened over. Undefined if the browser does not say (nothing can be captured then). */
const activeTabId: Promise<number | undefined> = browser.tabs.query({ active: true, currentWindow: true }).then(
  (tabs) => tabs[0]?.id,
  () => undefined,
);

// Command rows ---------------------------------------------------------------------------------------------------

interface CommandRow {
  command: PopupCommand;
  element: HTMLButtonElement;
}

const rows: CommandRow[] = [];
/** The menu's active row: the one tab stop (roving tabindex) and the one Enter runs before anything has focus. */
let selected = 0;
let pdfState: PdfRowState = 'checking';
/**
 * Set while a row's (or Settings') action runs, so a double click or a held Enter starts it once. It stays set once
 * the popup has called window.close(), so nothing can send again while the popup is going away.
 */
let busy = false;

const pdfHint = document.createElement('span');
pdfHint.className = 'row-hint';
pdfHint.id = 'pdf-hint';
// The hint is the row's description (aria-describedby), not part of its name.
pdfHint.setAttribute('aria-hidden', 'true');

const shortcutChips = document.createElement('span');
shortcutChips.className = 'row-keys';
shortcutChips.setAttribute('aria-hidden', 'true');
shortcutChips.hidden = true;

function createRow(command: PopupCommand, index: number): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'row';
  element.id = `command-${command.id}`;
  element.setAttribute('role', 'menuitem');

  // The name comes from the label alone: the hint and the shortcut chips are aria-hidden (the hint is the row's
  // description, the shortcut is in aria-keyshortcuts), so no aria-labelledby is needed.
  const label = document.createElement('span');
  label.className = 'row-label';
  const text = document.createElement('span');
  text.textContent = command.label;
  label.append(text);
  element.append(createIcon(command.icon), label);

  if (command.id === 'pdf') label.append(pdfHint);
  if (command.id === 'area') element.append(shortcutChips);

  element.addEventListener('click', () => {
    void activate(index);
  });
  element.addEventListener('focus', () => {
    if (selected !== index) select(index, false);
  });
  // The pointer moves the selection, so there is one highlighted row and Enter acts on the row under the pointer.
  element.addEventListener('pointermove', () => {
    if (selected === index || !commandEnabled(command.id, pdfState)) return;
    select(index, commands.contains(document.activeElement));
  });
  return element;
}

function select(index: number, focus: boolean): void {
  selected = index;
  rows.forEach((row, i) => {
    row.element.classList.toggle('is-active', i === index);
    // One tab stop for the whole menu (roving tabindex): the active row.
    row.element.tabIndex = rovingTabIndex(i, index);
  });
  if (focus) rows[index]?.element.focus();
}

function rowFor(id: PopupCommandId): HTMLButtonElement | undefined {
  return rows.find((row) => row.command.id === id)?.element;
}

function renderPdfRow(): void {
  const row = rowFor('pdf');
  if (row === undefined) return;
  const view = pdfRowView(pdfState);
  if (view.enabled) row.removeAttribute('aria-disabled');
  else row.setAttribute('aria-disabled', 'true');

  if (view.hint !== null) {
    pdfHint.textContent = view.hint;
    pdfHint.classList.remove('is-reserved');
    row.setAttribute('aria-describedby', pdfHint.id);
  } else {
    // A no-break space keeps a reserved line exactly one line tall.
    pdfHint.textContent = view.reserveHint ? '\u00a0' : '';
    pdfHint.classList.toggle('is-reserved', view.reserveHint);
    row.removeAttribute('aria-describedby');
  }
  pdfHint.hidden = view.hint === null && !view.reserveHint;
  row.classList.toggle('row-has-hint', !pdfHint.hidden);
}

commands.setAttribute('aria-label', COMMANDS_MENU_LABEL);
for (const [index, command] of POPUP_COMMANDS.entries()) {
  const element = createRow(command, index);
  rows.push({ command, element });
  commands.append(element);
}
select(0, false);
renderPdfRow();

// Actions --------------------------------------------------------------------------------------------------------

/** The gap between clearing the live region and writing the text, so the same text twice in a row is announced twice. */
const ANNOUNCE_DELAY_MS = 50;
let announceTimer: number | undefined;

/**
 * Speaks `text` through the polite live region. Cleared first, so the same words said twice in a row (a second press on
 * the same row) are announced again.
 */
function announce(text: string | null): void {
  // One pending announcement at a time: a newer one replaces it rather than queueing behind it.
  if (announceTimer !== undefined) window.clearTimeout(announceTimer);
  announceTimer = undefined;
  announcer.textContent = '';
  if (text === null) return;
  announceTimer = window.setTimeout(() => {
    announceTimer = undefined;
    announcer.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

/**
 * Sends a capture trigger and waits (at most DELIVERY_WAIT_MS) for the background's answer, so a service worker that
 * went idle while the popup was open has started and taken the message before the popup closes. Save this PDF first
 * asks tab:pdf-status again: that wakes the worker and re-checks the tab. If the tab is no longer a PDF (or the check
 * gets no answer), nothing is sent, the row shows its new state, and this returns false so the popup stays open.
 */
async function sendCapture(id: CaptureCommandId, tabId: number): Promise<boolean> {
  if (id === 'pdf') {
    const check: TabPdfStatusMessage = { type: 'tab:pdf-status', tabId };
    const decision = confirmPdfCapture(await settleWithin(send(check), PDF_STATUS_TIMEOUT_MS));
    if (!decision.send) {
      pdfState = decision.state;
      renderPdfRow();
      // The row changes silently (focus stays on it), so say why Save this PDF did not run.
      announce(pdfRecheckAnnouncement(decision));
      return false;
    }
  }
  await settleWithin(send(captureMessage(id, tabId)), DELIVERY_WAIT_MS);
  return true;
}

async function activate(index: number): Promise<void> {
  const row = rows[index];
  if (row === undefined || busy) return;
  if (!commandEnabled(row.command.id, pdfState)) {
    // Nothing runs, and a disabled row looks the same to a screen reader, so say why.
    announce(disabledRowAnnouncement(row.command.id, pdfState));
    return;
  }
  busy = true;
  let closing = false;
  try {
    // Before setup is finished the gate replaces this menu, and nothing would upload.
    if (!(await settingsComplete)) return;
    const id = row.command.id;
    if (id === 'upload') {
      await browser.tabs.create({ url: browser.runtime.getURL('/upload.html') });
    } else {
      const tabId = await activeTabId;
      if (tabId === undefined || !(await sendCapture(id, tabId))) return;
    }
    closing = true;
    window.close();
  } catch (error) {
    // Stay open, so the row can be tried again.
    logFailure(`The ${row.command.label} action`)(error);
  } finally {
    if (!closing) busy = false;
  }
}

async function openOptions(): Promise<void> {
  if (busy) return;
  busy = true;
  let closing = false;
  try {
    await browser.runtime.openOptionsPage();
    closing = true;
    window.close();
  } catch (error) {
    logFailure('Opening Settings')(error);
  } finally {
    if (!closing) busy = false;
  }
}

function sendQueueRequest(message: QueueRequestMessage): void {
  send(message)
    .then((response) => {
      if (typeof response === 'object' && response !== null && 'ok' in response && response.ok === false) {
        // A refused Discard (the item started uploading) is an expected outcome, and the row updates itself from the
        // queue change that follows. The background already logged a Discard that failed for real.
        if (message.type === 'queue:discard') return;
        throw new Error(`The background could not carry out ${message.type}`);
      }
    })
    .catch(logFailure(`The ${message.type} request`));
}

// Keyboard (the ARIA menu pattern): Up, Down, Home, and End move the active row and its focus; Enter runs it. Rows are
// buttons, so a focused row runs on Enter or Space by itself; these keys also work before anything has focus, as they
// do in a command menu. A held Enter (key repeat) does nothing more. Until settings are known, the menu is invisible
// and keys do nothing.
document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const target = event.target;
  const onPage = target === document.body || target === document.documentElement;
  const enter = event.key === 'Enter' && !event.repeat;

  if (!setup.hidden) {
    if (onPage && enter) {
      event.preventDefault();
      void openOptions();
    }
    return;
  }

  if (menu.hidden || menu.classList.contains('is-pending')) return;
  const rowIndex = rows.findIndex((row) => row.element === target);
  if (rowIndex === -1 && !onPage) return;
  if (event.key === 'Enter' && event.repeat && rowIndex !== -1) {
    // A held Enter would repeat the button's native click: run the row once, and say nothing again.
    event.preventDefault();
    return;
  }
  if (isNavigationKey(event.key)) {
    event.preventDefault();
    select(moveSelection(rowIndex === -1 ? selected : rowIndex, event.key, rows.length), true);
  } else if (enter && onPage) {
    event.preventDefault();
    void activate(selected);
  }
});

finishSetup.addEventListener('click', () => {
  void openOptions();
});
openSettings.addEventListener('click', () => {
  void openOptions();
});

// Settings gate --------------------------------------------------------------------------------------------------

requireElement('setup-text', HTMLElement).textContent = SETUP_TEXT;
finishSetup.textContent = FINISH_SETUP_LABEL;

// The menu keeps its space but stays invisible until settings are known (a few ms), so a first run goes straight to
// the gate without showing the capture rows first, and the usual case shows the menu without the popup resizing.
void settingsComplete.then((complete) => {
  if (complete) {
    menu.classList.remove('is-pending');
    return;
  }
  menu.hidden = true;
  setup.hidden = false;
});

// Save this PDF: disabled until the background says this tab is a PDF. ------------------------------------------

async function checkPdfTab(): Promise<void> {
  const tabId = await activeTabId;
  let answer: unknown;
  if (tabId !== undefined) {
    const message: TabPdfStatusMessage = { type: 'tab:pdf-status', tabId };
    answer = await settleWithin(send(message), PDF_STATUS_TIMEOUT_MS);
  }
  pdfState = pdfRowStateFromResponse(answer);
  renderPdfRow();
}

void checkPdfTab();

// Select area shortcut: the keys the browser has for it, as .kbd chips. ------------------------------------------

async function showShortcut(): Promise<void> {
  const all = await browser.commands.getAll();
  const keys = shortcutKeys(all.find((command) => command.name === 'select-area')?.shortcut);
  shortcutChips.replaceChildren(
    ...keys.map((key) => {
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd';
      kbd.textContent = key;
      return kbd;
    }),
  );
  shortcutChips.hidden = keys.length === 0;
  const row = rowFor('area');
  const shortcut = ariaKeyShortcuts(keys);
  if (shortcut === undefined) row?.removeAttribute('aria-keyshortcuts');
  else row?.setAttribute('aria-keyshortcuts', shortcut);
}

// The hint is a nicety; without it the row works the same.
showShortcut().catch(() => {});

// Status line and the list behind View ---------------------------------------------------------------------------

interface AttentionRow {
  element: HTMLLIElement;
  filename: HTMLElement;
  /** The status line under the filename: its circle shows needs attention, waiting, or uploading. */
  line: HTMLElement;
  message: HTMLElement;
  /** Visually hidden text before the message, for a state the message does not say (uploading). */
  statusLabel: HTMLElement;
  /** Holds Retry and Discard; hidden while the item uploads. */
  actions: HTMLElement;
  retry: HTMLButtonElement;
  discard: HTMLButtonElement;
}

const ENTRY_LINE_CLASS: Record<AttentionEntry['tone'], string> = {
  attention: 'status status-attention attention-message',
  waiting: 'status status-waiting attention-message',
  uploading: 'status status-uploading attention-message',
};

const attentionRows = new Map<string, AttentionRow>();
const statusDot = document.createElement('span');
statusDot.className = 'status-dot';
statusDot.setAttribute('aria-hidden', 'true');
const statusText = document.createElement('span');
let line: StatusLineView | undefined;
let expanded = false;
attentionList.setAttribute('aria-label', ATTENTION_LIST_LABEL);

function createAttentionRow(entry: AttentionEntry): AttentionRow {
  const element = document.createElement('li');
  element.className = 'attention-item';
  element.dataset.captureId = entry.captureId;

  const filename = document.createElement('span');
  filename.className = 'attention-filename';

  const message = document.createElement('p');
  message.className = ENTRY_LINE_CLASS[entry.tone];
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.setAttribute('aria-hidden', 'true');
  const statusLabel = document.createElement('span');
  statusLabel.className = 'visually-hidden';
  const messageText = document.createElement('span');
  message.append(dot, statusLabel, messageText);

  const actions = document.createElement('div');
  actions.className = 'attention-actions';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-secondary';
  retry.textContent = RETRY_LABEL;
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'btn btn-ghost';
  discard.textContent = DISCARD_LABEL;
  actions.append(retry, discard);

  retry.addEventListener('click', () => {
    sendQueueRequest(retryMessage(entry.captureId));
  });
  discard.addEventListener('click', () => {
    sendQueueRequest(discardMessage(entry.captureId));
  });

  element.append(filename, message, actions);
  return { element, filename, line: message, message: messageText, statusLabel, actions, retry, discard };
}

function updateAttentionRow(row: AttentionRow, entry: AttentionEntry): void {
  if (row.filename.textContent !== entry.filename) {
    row.filename.textContent = entry.filename;
    row.filename.title = entry.filename;
    // The visible label comes first, so speech input ("click Retry") still finds the button.
    row.retry.setAttribute('aria-label', `${RETRY_LABEL} ${entry.filename}`);
    row.discard.setAttribute('aria-label', `${DISCARD_LABEL} ${entry.filename}`);
  }
  if (row.message.textContent !== entry.message) row.message.textContent = entry.message;
  const statusLabel = entry.statusLabel ?? '';
  if (row.statusLabel.textContent !== statusLabel) row.statusLabel.textContent = statusLabel;
  // A listed item changes tone while it is retried (waiting, uploading, then waiting again or needs attention).
  const lineClass = ENTRY_LINE_CLASS[entry.tone];
  if (row.line.className !== lineClass) row.line.className = lineClass;
  row.actions.hidden = !entry.actions;
}

/** The list's rows in on-screen order. */
function attentionRowsInOrder(): AttentionRow[] {
  return Array.from(attentionList.children).flatMap((element) => {
    const row = attentionRows.get(element instanceof HTMLElement ? (element.dataset.captureId ?? '') : '');
    return row === undefined ? [] : [row];
  });
}

/** Which list item (by on-screen position and capture id), and which of its buttons, has focus. */
function focusedAttentionButton(): { index: number; captureId: string; button: AttentionButton } | undefined {
  const active = document.activeElement;
  const ordered = attentionRowsInOrder();
  for (const [index, row] of ordered.entries()) {
    const captureId = row.element.dataset.captureId ?? '';
    if (active === row.retry) return { index, captureId, button: 'retry' };
    if (active === row.discard) return { index, captureId, button: 'discard' };
  }
  return undefined;
}

/** Updates the list in place (keyed by capture id), so a button that keeps its item also keeps focus. */
function renderAttentionList(entries: readonly AttentionEntry[]): void {
  const focused = focusedAttentionButton();
  const wanted = new Set(entries.map((entry) => entry.captureId));

  for (const [captureId, row] of attentionRows) {
    if (wanted.has(captureId)) continue;
    row.element.remove();
    attentionRows.delete(captureId);
  }

  // Queue order is by age and never changes for items already shown, so only new items need placing.
  let previous: HTMLLIElement | null = null;
  for (const entry of entries) {
    let row = attentionRows.get(entry.captureId);
    if (row === undefined) {
      row = createAttentionRow(entry);
      attentionRows.set(entry.captureId, row);
      attentionList.insertBefore(row.element, previous === null ? attentionList.firstChild : previous.nextSibling);
    }
    updateAttentionRow(row, entry);
    previous = row.element;
  }

  attentionList.hidden = !expanded || entries.length === 0;

  // The focused button went away: its item left the list (retried, discarded, or saved) or lost its buttons (it started
  // uploading). Move focus on rather than losing it; lib/popup-model.ts decides where.
  if (focused !== undefined) {
    const move = focusMoveAfterRender(focused, entries, expanded);
    if (move.kind === 'row') {
      const nextRow = attentionRowsInOrder()[move.index];
      if (nextRow !== undefined) nextRow[move.button].focus();
      else focusFallback();
    } else if (move.kind === 'fallback') {
      focusFallback();
    }
  }
}

/** Where focus goes when the control holding it disappears: a status line button if shown, else the rows. */
function focusFallback(): void {
  if (!statusView.hidden) statusView.focus();
  else if (!statusRetry.hidden) statusRetry.focus();
  else rows[selected]?.element.focus();
}

function renderStatus(view: StatusLineView): void {
  line = view;
  queueStatus.className = `status queue-status ${STATUS_CLASS[view.tone]}`;
  if (statusDot.parentElement === null) queueStatus.replaceChildren(statusDot, statusText);
  // Rewriting the same text would make screen readers announce it again.
  if (statusText.textContent !== view.text) statusText.textContent = view.text;

  const focused = document.activeElement;
  statusRetry.textContent = RETRY_NOW_LABEL;
  statusRetry.hidden = !view.retryAll;
  // The label itself says what a press does (View or Hide), so there is no aria-expanded to repeat it.
  const viewLabel = expanded ? HIDE_LABEL : VIEW_LABEL;
  if (statusView.textContent !== viewLabel) statusView.textContent = viewLabel;
  statusView.setAttribute('aria-controls', attentionList.id);
  statusView.hidden = !view.view;
  // The button that had focus went away (nothing left to retry or view): keep focus in the popup.
  if ((focused === statusRetry && statusRetry.hidden) || (focused === statusView && statusView.hidden)) focusFallback();
}

let entries: AttentionEntry[] = [];

function renderQueue(view: StatusLineView, next: AttentionEntry[]): void {
  expanded = keepExpanded(expanded, view);
  entries = next;
  renderStatus(view);
  renderAttentionList(entries);
}

const refreshQueue = coalesce(async () => {
  try {
    const items = await listItems();
    renderQueue(statusLine(items), attentionEntries(items));
  } catch (error) {
    logFailure('Reading the upload queue')(error);
    renderQueue(QUEUE_UNAVAILABLE_STATUS, []);
  }
});

statusRetry.addEventListener('click', () => {
  if (line?.retryAll === true) sendQueueRequest(retryMessage());
});
statusView.addEventListener('click', () => {
  if (line?.view !== true) return;
  expanded = !expanded;
  renderStatus(line);
  renderAttentionList(entries);
});

// Listen before the first read, so a change during it triggers another read instead of being missed.
browser.runtime.onMessage.addListener((message: unknown) => {
  if (isQueueChangedMessage(message)) void refreshQueue();
  return undefined;
});
void refreshQueue();

// Icons (decorative; the labels say what each control does).
requireElement('app-mark', HTMLElement).append(createIcon('crop'));
openSettings.prepend(createIcon('settings'));
