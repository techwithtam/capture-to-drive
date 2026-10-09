// The shared IndexedDB database (spec section 6.5): database "capture-to-drive" with stores "queue" and "pending".
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, DATABASE_NAME, openDatabase, PENDING_STORE, QUEUE_STATUS_INDEX, QUEUE_STORE, transact } from '../lib/db';
import { resetDatabase } from './helpers/queue-harness';

beforeEach(async () => {
  await resetDatabase();
});

describe('openDatabase', () => {
  it('creates the queue and pending stores, keyed by captureId, with a status index on the queue', async () => {
    const db = await openDatabase();
    expect(db.name).toBe(DATABASE_NAME);
    expect([...db.objectStoreNames].sort()).toEqual([PENDING_STORE, QUEUE_STORE].sort());

    const tx = db.transaction([QUEUE_STORE, PENDING_STORE], 'readonly');
    const queue = tx.objectStore(QUEUE_STORE);
    expect(queue.keyPath).toBe('captureId');
    expect([...queue.indexNames]).toEqual([QUEUE_STATUS_INDEX]);
    expect(queue.index(QUEUE_STATUS_INDEX).keyPath).toBe('status');
    expect(tx.objectStore(PENDING_STORE).keyPath).toBe('captureId');
  });

  it('reuses one connection per context', async () => {
    expect(await openDatabase()).toBe(await openDatabase());
  });

  it('opens a fresh connection after closeDatabase, with the data still there', async () => {
    await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.put({ captureId: 'a', status: 'waiting' });
      return () => undefined;
    });
    const first = await openDatabase();
    await closeDatabase();
    const second = await openDatabase();
    expect(second).not.toBe(first);

    const stored = await transact(QUEUE_STORE, 'readonly', (store) => {
      const request = store.get('a');
      return () => request.result as unknown;
    });
    expect(stored).toEqual({ captureId: 'a', status: 'waiting' });
  });
});

describe('transact', () => {
  it('resolves with what the work reports, after the transaction commits', async () => {
    const count = await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.put({ captureId: 'a', status: 'waiting' });
      store.put({ captureId: 'b', status: 'uploading' });
      const counting = store.count();
      return () => counting.result;
    });
    expect(count).toBe(2);
  });

  it('rejects, and writes nothing, when a request in the transaction fails', async () => {
    await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.add({ captureId: 'a', status: 'waiting' });
      return () => undefined;
    });

    const failing = transact(QUEUE_STORE, 'readwrite', (store) => {
      store.put({ captureId: 'b', status: 'waiting' });
      store.add({ captureId: 'a', status: 'waiting' });
      return () => undefined;
    });
    await expect(failing).rejects.toThrow();

    const keys = await transact(QUEUE_STORE, 'readonly', (store) => {
      const request = store.getAllKeys();
      return () => request.result;
    });
    expect(keys).toEqual(['a']);
  });

  it("rejects with IndexedDB's own error, so callers can tell a duplicate key from other failures", async () => {
    await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.add({ captureId: 'a', status: 'waiting' });
      return () => undefined;
    });
    const duplicate: unknown = await transact(QUEUE_STORE, 'readwrite', (store) => {
      store.add({ captureId: 'a', status: 'waiting' });
      return () => undefined;
    }).catch((error: unknown) => error);

    expect(duplicate).toBeInstanceOf(DOMException);
    expect((duplicate as DOMException).name).toBe('ConstraintError');
  });

  it('rejects when the work itself throws', async () => {
    const failing = transact(QUEUE_STORE, 'readwrite', () => {
      throw new Error('bad work');
    });
    await expect(failing).rejects.toThrow('bad work');
  });
});
