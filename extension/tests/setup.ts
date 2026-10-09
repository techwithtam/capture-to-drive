// Provides a spec-compliant in-memory IndexedDB (indexedDB, IDBKeyRange, ...) for the queue and pending store tests.
import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// WXT's fake browser leaves storage.local.setAccessLevel unimplemented (it throws), and the service worker calls it at
// every start. Stand in for Chrome here, so every test that starts the worker does not have to. A test file's
// vi.restoreAllMocks() undoes this after each test; it is set again before the next one.
beforeEach(() => {
  vi.spyOn(fakeBrowser.storage.local, 'setAccessLevel').mockResolvedValue(undefined);
});
