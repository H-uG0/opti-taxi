/**
 * IndexedDB storage of the status queue (status-queue.ts), written by hand
 * (no dependency). One database per account on the phone
 * ("opti-taxi-statuts-<user id>"), so statuses typed by one driver are never
 * sent in the name of another who signs in on the same phone. Each record is
 * exactly { stopId, action, observedAt } under an auto-increment key (the
 * order of the taps). Browser only.
 */
import { isQueuedStatus, type QueueStorage, type QueuedStatus, type StoredStatus } from "./status-queue";

const STORE = "statuses";

export function queueDatabaseName(ownerId: string): string {
  return `opti-taxi-statuts-${ownerId}`;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves once the transaction is committed (the status survives the app being killed). */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openIndexedDbQueue(ownerId: string): Promise<QueueStorage> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(queueDatabaseName(ownerId), 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { autoIncrement: true });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
    request.onsuccess = () => resolve(storageOf(request.result));
  });
}

function storageOf(database: IDBDatabase): QueueStorage {
  return {
    async list() {
      const transaction = database.transaction(STORE, "readonly");
      const store = transaction.objectStore(STORE);
      const [keys, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
      const rows: StoredStatus[] = [];
      keys.forEach((key, index) => {
        const value: unknown = values[index];
        // Invalid rows are handed back as they are: the queue drops them.
        if (typeof key === "number") rows.push({ key, value: value as QueuedStatus });
      });
      return rows;
    },
    async add(value) {
      if (!isQueuedStatus(value)) throw new Error("not a status");
      const transaction = database.transaction(STORE, "readwrite");
      const request = transaction.objectStore(STORE).add({ stopId: value.stopId, action: value.action, observedAt: value.observedAt });
      await committed(transaction);
      return request.result as number;
    },
    async remove(key) {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(key);
      await committed(transaction);
    },
  };
}
