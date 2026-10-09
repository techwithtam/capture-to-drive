// Helpers for the note card, note window, and selection overlay DOM tests.
//
// The note UI and the overlay act only on events a real person caused (`event.isTrusted`), so that a web page cannot
// press their buttons with a script. In a browser, an event a script makes (`element.click()`, `dispatchEvent(...)`)
// has `isTrusted === false`, and one from real input has `isTrusted === true`. happy-dom has no Event.isTrusted at all:
// it reads undefined for every event. `useBrowserTrust()` closes that gap for a test file: every event reads false, as
// a script's does in a browser (including the one `element.click()` makes inside), and `trusted()` stamps `true` on one
// event instance, the way a browser does for real input (an own property of the event). No product code changes.
// `scriptClick()` and `scriptPress()` are what page script can do; `userClick()` and `press()` are what a person does.
import { afterAll, beforeAll, expect, vi } from 'vitest';

/**
 * Call once at the top of a test file. Gives every event a browser-like `isTrusted === false` for the file's tests,
 * and fails the file at once if that does not hold (for example, after a happy-dom upgrade changes how it works).
 */
export function useBrowserTrust(): void {
  let original: PropertyDescriptor | undefined;
  beforeAll(() => {
    original = Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');
    Object.defineProperty(Event.prototype, 'isTrusted', { get: () => false, configurable: true });
    expect(new MouseEvent('click').isTrusted).toBe(false);
    expect(trusted(new MouseEvent('click')).isTrusted).toBe(true);
  });
  afterAll(() => {
    if (original === undefined) Reflect.deleteProperty(Event.prototype, 'isTrusted');
    else Object.defineProperty(Event.prototype, 'isTrusted', original);
  });
}

/** Marks one event as caused by real input. */
export function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

/** A trusted key press (keydown) on `target`, bubbling out of any shadow root like a real one. Returns the event. */
export function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = trusted(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init }));
  target.dispatchEvent(event);
  return event;
}

/** The same key press made by a page script: not trusted. */
export function scriptPress(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** A trusted click, as when the user presses the button. */
export function userClick(target: EventTarget): void {
  target.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })));
}

/** What a page script can do to a button: `click()` and a dispatched click event. Neither is trusted. */
export function scriptClick(target: HTMLElement): void {
  target.click();
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
}

/** The text a screen reader would read for `node`: its text, without parts marked aria-hidden. */
export function accessibleText(node: Node): string {
  if (node instanceof Text) return node.data;
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(accessibleText).join('');
}

/** True when `element` or an ancestor has the hidden attribute (so the element is not shown or reachable). */
export function isHidden(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.hidden) return true;
  }
  return false;
}

/** The button whose accessible name is `name`, in the document or in a shadow root. */
export function buttonNamed(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((button) => accessibleText(button) === name);
  if (found === undefined) throw new Error(`No button named "${name}"`);
  return found;
}

/** The note field of the view in the document or in a shadow root. */
export function noteInput(root: ParentNode = document): HTMLInputElement {
  const input = root.querySelector('input');
  if (input === null) throw new Error('No input');
  return input;
}

/** The view's polite live region (its status line). */
export function statusLine(root: ParentNode = document): HTMLElement {
  const line = root.querySelector<HTMLElement>('[aria-live="polite"]');
  if (line === null) throw new Error('No live region');
  return line;
}

/** The text of the view's status line. */
export function statusText(root: ParentNode = document): string {
  return statusLine(root).textContent ?? '';
}

/** Lets promise callbacks run and moves fake time forward by `ms`. The test must have called `vi.useFakeTimers()`. */
export async function wait(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** A promise that the test settles by hand. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
