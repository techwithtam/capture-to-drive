// Settings page (spec section 6.6): mailbox URL, secret key, and name; Save, Test connection, and a shortcut link.
// Extension pages hold host permissions, so Test connection calls the mailbox directly (no background message).

import '@/assets/tokens.css';
import '@/assets/components.css';
import './style.css';
import { browser } from 'wxt/browser';
import { describeConnectionResult } from '@/lib/connection-message';
import { createIcon } from '@/lib/icons';
import { pingMailbox } from '@/lib/mailbox-client';
import type { MailboxResult } from '@/lib/mailbox-client';
import { getSettings, saveSettings, validateMailboxConnection, validateSettings } from '@/lib/settings';
import type { Settings } from '@/lib/settings';
import { shortcutKeys } from '@/lib/shortcut-keys';

type FieldName = keyof Settings;
/** Which status circle (assets/components.css) goes with a message: saved, needs attention, or in progress. */
type StatusState = 'success' | 'error' | 'testing' | 'none';

const STATUS_CLASS: Record<Exclude<StatusState, 'none'>, string> = {
  success: 'status-saved',
  error: 'status-attention',
  testing: 'status-uploading',
};

/** Field order on the page, which is also the order errors are reported and focused in. */
const FIELD_ORDER: readonly FieldName[] = ['mailboxUrl', 'key', 'name'];
const CONNECTION_FIELDS: readonly FieldName[] = ['mailboxUrl', 'key'];

const TEST_LABEL = 'Test connection';
const TESTING_LABEL = 'Testing…';
const TESTING_STATUS = 'Testing connection…';

function requireElement<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Settings page is missing #${id}`);
  return element;
}

function requireField(id: string): { input: HTMLInputElement; error: HTMLElement } {
  return { input: requireElement(id, HTMLInputElement), error: requireElement(`${id}-error`, HTMLElement) };
}

const form = requireElement('settings-form', HTMLFormElement);
const fields: Record<FieldName, { input: HTMLInputElement; error: HTMLElement }> = {
  mailboxUrl: requireField('mailbox-url'),
  key: requireField('secret-key'),
  name: requireField('your-name'),
};
const status = requireElement('status', HTMLElement);
const testButton = requireElement('test-connection', HTMLButtonElement);
const shortcutButton = requireElement('change-shortcut', HTMLButtonElement);
const currentShortcut = requireElement('current-shortcut', HTMLElement);

/** Counts edits, so a Test connection result that arrives after the fields changed is not shown for the new values. */
let editCount = 0;

function readForm(): Settings {
  return {
    mailboxUrl: fields.mailboxUrl.input.value,
    key: fields.key.input.value,
    name: fields.name.input.value,
  };
}

function writeForm(settings: Settings): void {
  for (const name of FIELD_ORDER) fields[name].input.value = settings[name];
}

/** Replaces the status line: a status circle (hidden from assistive technology) and the message in the live region. */
function setStatus(text: string, state: StatusState): void {
  status.classList.remove(...Object.values(STATUS_CLASS));
  if (text === '') {
    status.replaceChildren();
    return;
  }
  if (state === 'none') {
    status.replaceChildren(text);
    return;
  }
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.setAttribute('aria-hidden', 'true');
  status.replaceChildren(dot, text);
  status.classList.add(STATUS_CLASS[state]);
}

/** Shows or clears the inline error of each listed field. A field missing from `errors` has its error cleared. */
function showFieldErrors(errors: Partial<Record<FieldName, string>>, names: readonly FieldName[] = FIELD_ORDER): void {
  for (const name of names) {
    const { input, error } = fields[name];
    const message = errors[name];
    error.textContent = message ?? '';
    error.hidden = message === undefined;
    if (message === undefined) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
  }
}

function focusFirstInvalid(errors: Partial<Record<FieldName, string>>): void {
  const first = FIELD_ORDER.find((name) => errors[name] !== undefined);
  if (first !== undefined) fields[first].input.focus();
}

async function handleSave(): Promise<void> {
  const result = validateSettings(readForm());
  if (!result.ok) {
    showFieldErrors(result.errors);
    focusFirstInvalid(result.errors);
    setStatus('Settings not saved. Check the fields above.', 'error');
    return;
  }

  showFieldErrors({});
  try {
    await saveSettings(result.value);
  } catch {
    setStatus("Couldn't save your settings. Try again.", 'error');
    return;
  }
  writeForm(result.value); // Show the trimmed values that were stored.
  setStatus('Saved.', 'success');
}

function setTesting(testing: boolean): void {
  testButton.disabled = testing;
  testButton.textContent = testing ? TESTING_LABEL : TEST_LABEL;
}

async function handleTest(): Promise<void> {
  // Only the URL and key matter to the mailbox, so a missing name does not block the test.
  const connection = validateMailboxConnection(readForm());
  if (!connection.ok) {
    showFieldErrors(connection.errors, CONNECTION_FIELDS);
    focusFirstInvalid(connection.errors);
    setStatus('', 'none');
    return;
  }

  showFieldErrors({}, CONNECTION_FIELDS);
  // In the live region, so screen-reader users hear that something is happening (the button label alone is not announced).
  setStatus(TESTING_STATUS, 'testing');
  setTesting(true);
  const editsAtStart = editCount;
  let result: MailboxResult;
  try {
    result = await pingMailbox(connection.value);
  } catch {
    // pingMailbox is meant never to throw. If it ever does, say so instead of leaving the page silent.
    result = { kind: 'retryable', error: 'network' };
  } finally {
    setTesting(false);
  }
  // A disabled button drops keyboard focus; hand it back unless the user has moved on to something else.
  if (document.activeElement === document.body) testButton.focus();

  if (editCount !== editsAtStart) return;
  const message = describeConnectionResult(result);
  setStatus(message.text, message.ok ? 'success' : 'error');
}

async function handleShortcut(): Promise<void> {
  const scheme = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
  const url = `${scheme}://extensions/shortcuts`;
  try {
    await browser.tabs.create({ url });
  } catch {
    setStatus(`Couldn't open the shortcuts page. Type ${url} in the address bar.`, 'error');
  }
}

/** Counts refreshes, so a slow answer that arrives after a newer request is dropped instead of shown. */
let shortcutRefreshCount = 0;

/** Shows the shortcut the browser currently has for Select area, one `.kbd` per key. Nothing shows when none is set. */
async function showCurrentShortcut(): Promise<void> {
  shortcutRefreshCount += 1;
  const refresh = shortcutRefreshCount;
  const commands = await browser.commands.getAll();
  if (refresh !== shortcutRefreshCount) return;
  const keys = shortcutKeys(commands.find((command) => command.name === 'select-area')?.shortcut);
  currentShortcut.replaceChildren(
    ...keys.map((key) => {
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd';
      kbd.textContent = key;
      return kbd;
    }),
  );
  currentShortcut.hidden = keys.length === 0;
}

function refreshShortcut(): void {
  showCurrentShortcut().catch(() => {
    // The hint is a nicety. Without it the button still opens the browser's shortcuts page.
  });
}

interface ChangeEvent {
  addListener(listener: () => void): void;
}

function isChangeEvent(value: unknown): value is ChangeEvent {
  if (typeof value !== 'object' || value === null || !('addListener' in value)) return false;
  return typeof value.addListener === 'function';
}

/**
 * Runs `listener` when the browser reports that a command's shortcut changed (`commands.onChanged`, Chrome 110 and
 * later). The bundled typings do not declare it, so it is looked up defensively and skipped where it does not exist.
 */
function onCommandShortcutChanged(listener: () => void): void {
  const commands: unknown = browser.commands;
  if (typeof commands !== 'object' || commands === null || !('onChanged' in commands)) return;
  if (isChangeEvent(commands.onChanged)) commands.onChanged.addListener(listener);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void handleSave();
});

form.addEventListener('input', (event) => {
  // Whatever the status said (Saved, Connected, an error) described the old values.
  editCount += 1;
  setStatus('', 'none');
  // The edited field gets a fresh check on the next Save or Test, so its old error goes away now.
  const edited = FIELD_ORDER.find((name) => fields[name].input === event.target);
  if (edited !== undefined) showFieldErrors({}, [edited]);
});

testButton.addEventListener('click', () => {
  void handleTest();
});

shortcutButton.addEventListener('click', () => {
  void handleShortcut();
});

// Decorative: the page heading already names the app.
requireElement('app-mark', HTMLElement).append(createIcon('crop'));

// The shortcut is changed on another page (the browser's shortcuts page), so look again whenever this page is shown or
// focused again, and as soon as the browser says it changed.
refreshShortcut();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshShortcut();
});
window.addEventListener('focus', refreshShortcut);
onCommandShortcutChanged(refreshShortcut);

getSettings()
  .then((settings) => {
    if (settings !== null) writeForm(settings);
  })
  .catch(() => {
    setStatus("Couldn't load your saved settings. Reload this page.", 'error');
  });
