/**
 * Where a photo waits until the server has it.
 *
 * The composer sends the note at once and uploads the photo afterwards, in the background. If the tab
 * closes (iOS reclaims a backgrounded Safari very quickly) the photo would otherwise be gone while the
 * note on the server says it has an attachment. So the blob and the entry id are written to IndexedDB
 * before the upload starts, and deleted only once the server confirms it.
 *
 * IndexedDB can be unavailable — Safari private mode, a browser with storage disabled — and that must
 * degrade, not break sending. Every operation falls back to an in-memory map; the note still sends,
 * it just cannot survive a reload.
 */
export const UPLOAD_DB_NAME = "sutra-scratch";
export const UPLOAD_STORE_NAME = "uploads";
export const UPLOAD_DB_VERSION = 1;

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(UPLOAD_DB_NAME, UPLOAD_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UPLOAD_STORE_NAME)) {
        db.createObjectStore(UPLOAD_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

/**
 * A small `{ put, all, remove }` store backed by IndexedDB, with an in-memory mirror.
 *
 * `factory` is injectable so the queue's tests can supply a fake IndexedDB and prove resume works;
 * production passes the global.
 */
export function createUploadStore(factory = globalThis.indexedDB) {
  const memory = new Map();
  let db = null;
  let useMemory = !factory;

  /** The database, or null once we know this browser will not give us one. */
  async function handle() {
    if (useMemory) return null;
    if (db) return db;
    try {
      db = await openDatabase(factory);
      return db;
    } catch {
      useMemory = true;
      return null;
    }
  }

  function transaction(handleDb, mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = handleDb.transaction(UPLOAD_STORE_NAME, mode);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
        work(tx.objectStore(UPLOAD_STORE_NAME));
      } catch (error) {
        reject(error);
      }
    });
  }

  return {
    /** "indexeddb" or "memory", after the first operation — useful in a debug readout and in tests. */
    get mode() {
      return useMemory ? "memory" : "indexeddb";
    },

    async put(record) {
      memory.set(record.id, record);
      const handleDb = await handle();
      if (!handleDb) return;
      try {
        await transaction(handleDb, "readwrite", (store) => store.put(record));
      } catch {
        useMemory = true;
      }
    },

    async all() {
      const handleDb = await handle();
      if (!handleDb) return [...memory.values()];
      try {
        const rows = await new Promise((resolve, reject) => {
          const tx = handleDb.transaction(UPLOAD_STORE_NAME, "readonly");
          const request = tx.objectStore(UPLOAD_STORE_NAME).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
        });
        for (const row of rows) memory.set(row.id, row);
        return rows;
      } catch {
        useMemory = true;
        return [...memory.values()];
      }
    },

    async remove(id) {
      memory.delete(id);
      const handleDb = await handle();
      if (!handleDb) return;
      try {
        await transaction(handleDb, "readwrite", (store) => store.delete(id));
      } catch {
        useMemory = true;
      }
    },
  };
}
