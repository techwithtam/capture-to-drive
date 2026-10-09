import { vi } from 'vitest';
import type { Settings } from '../../lib/settings';

export const SETTINGS: Settings = {
  mailboxUrl: 'https://script.google.com/macros/s/TEST/exec',
  key: 'test-key',
  name: 'Alex',
};

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

/** Page imports register listeners outside the mounted body; remove those between tests too. */
export function trackPageListeners(): () => void {
  const documentListeners = vi.spyOn(document, 'addEventListener');
  const windowListeners = vi.spyOn(window, 'addEventListener');
  return () => {
    for (const [type, listener, options] of documentListeners.mock.calls) {
      document.removeEventListener(type, listener, options);
    }
    for (const [type, listener, options] of windowListeners.mock.calls) {
      window.removeEventListener(type, listener, options);
    }
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
