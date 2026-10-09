// The extension's IndexedDB database (spec section 6.5): "capture-to-drive" with the stores "queue" for uploads
// and "pending" for captures waiting for the note step. Both stores are created at version 1.
// Safe to import from any extension context; content scripts cannot reach this database.

export const DATABASE_NAME = 'capture-to-drive';
export const DATABASE_VERSION = 1;
export const QUEUE_STORE = 'queue';
export const PENDING_STORE = 'pending';
/** Index on the queue's `status` field. */
export const QUEUE_STATUS_INDEX = 'status';

let connection: Promise<IDBDatabase> | null = null;

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(QUEUE_STORE)) {
    const queue = db.createObjectStore(QUEUE_STORE, { keyPath: 'captureId' });
    queue.createIndex(QUEUE_STATUS_INDEX, 'status');
  }
  if (!db.objectStoreNames.contains(PENDING_STORE)) {
    db.createObjectStore(PENDING_STORE, { keyPath: 'captureId' });
  }
}

/** This context's connection, opened on first use and reused after that. */
export function openDatabase(): Promise<IDBDatabase> {
  if (connection !== null) return connection;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    // Forget this connection (only if it is still the current one) so the next call opens a fresh one.
    const forget = () => {
      if (connection === opening) connection = null;
    };
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      // Another context wants a newer schema, or the browser closed the connection (for example, site data was
      // cleared). Either way this connection is finished.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget;
      resolve(db);
    };
    request.onerror = () => {
      forget();
      reject(request.error ?? new Error('Could not open the capture-to-drive database.'));
    };
  });
  connection = opening;
  return opening;
}

/** Closes this context's connection. The data stays; the next call to `openDatabase` reconnects. */
export async function closeDatabase(): Promise<void> {
  const current = connection;
  connection = null;
  if (current === null) return;
  try {
    (await current).close();
  } catch {
    // It never opened, so there is nothing to close.
  }
}

/**
 * Runs `work` inside one transaction on one store and resolves with the value its returned getter reports, once the
 * transaction has committed. `work` issues requests synchronously (and from their success handlers), which keeps a
 * read-modify-write atomic. Rejects, with nothing written, if any request fails (with IndexedDB's own error, such as a
 * DOMException named ConstraintError for a duplicate key), `work` throws, or the transaction aborts.
 */
export async function transact<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => () => T,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction | undefined;
    let result: () => T;
    try {
      tx = db.transaction(storeName, mode);
      result = work(tx.objectStore(storeName));
    } catch (error) {
      try {
        tx?.abort();
      } catch {
        // Already finished; nothing to undo.
      }
      reject(error);
      return;
    }
    const failed = tx;
    tx.oncomplete = () => {
      try {
        resolve(result());
      } catch (error) {
        reject(error);
      }
    };
    // The failing request's own error (a ConstraintError for a duplicate key, for example). `tx.error` is still null
    // while the error event runs; it is set by the time the transaction aborts. The first rejection wins.
    tx.onerror = (event) => {
      const request = event.target instanceof IDBRequest ? event.target : null;
      reject(request?.error ?? failed.error ?? new Error('IndexedDB transaction failed.'));
    };
    tx.onabort = () => reject(failed.error ?? new Error('IndexedDB transaction aborted.'));
  });
}
