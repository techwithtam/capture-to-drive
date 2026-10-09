import { fakeBrowser } from 'wxt/testing/fake-browser';
import { describe, expect, it } from 'vitest';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

describe('test environment', () => {
  it('provides IndexedDB and a fake browser.storage', async () => {
    const opening = indexedDB.open('smoke-test', 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('items', { keyPath: 'id' });
    };
    const db = await request(opening);
    const items = db.transaction('items', 'readwrite').objectStore('items');
    await request(items.put({ id: 'a', value: 1 }));
    const read = db.transaction('items', 'readonly').objectStore('items');
    expect(await request(read.get('a'))).toEqual({ id: 'a', value: 1 });
    db.close();

    await fakeBrowser.storage.local.set({ settings: { name: 'Test' } });
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({ settings: { name: 'Test' } });
  });
});
