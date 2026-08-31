"use client";

import type { PersistStorage, StorageValue } from "zustand/middleware";

/**
 * Where the portfolio is kept between visits.
 *
 * It used to live in `localStorage`, which caps an origin at about 5 MB across
 * everything it holds -- and a ledger is not small: 10,000 transactions
 * serialize to roughly 2.8 MB, 25,000 to 7 MB. Crossing the cap made
 * `setItem` throw, and because zustand's persist middleware writes
 * synchronously inside every `set()`, that exception came straight back out of
 * whichever store action was running and took the page down with it. There was
 * no warning and no degraded mode: the ledger simply got big enough and the
 * app started crashing on every edit.
 *
 * IndexedDB has no comparable ceiling (hundreds of megabytes to gigabytes,
 * depending on the browser and free disk), and two other properties matter as
 * much as the size:
 *
 *  - Writes are asynchronous, so saving no longer blocks the main thread. The
 *    old path ran a multi-megabyte `JSON.stringify` between the click and the
 *    repaint.
 *  - Values go in as structured clones, so there is no serialization step at
 *    all. That is why this is a `PersistStorage` rather than a
 *    `createJSONStorage` wrapper -- the object is handed to the browser as-is.
 *
 * Nothing in here throws. Every failure resolves to "no data", because the
 * only honest options at this layer are the stored ledger or none, and an
 * exception escaping a store mutation is the exact failure this replaced.
 */

const DB_NAME = "portfolio-store";
const DB_VERSION = 1;
const STORE_NAME = "state";

/** The `localStorage` key the ledger used before this module existed. */
const LEGACY_KEY = "portfolio-tracker";

let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * Opened once per page load and reused. Resolves to `null` rather than
 * rejecting when IndexedDB is unavailable -- server rendering, a private
 * window that blocks it, a browser that refuses to open the database -- so
 * every caller can treat a failure as an empty store.
 */
function getDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        // A second tab holding an older version open blocks the upgrade. Rather
        // than hang the load forever, give up and run from memory this session.
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function idbGet<T>(key: string): Promise<T | null> {
  return getDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE_NAME, "readonly");
          const request = tx.objectStore(STORE_NAME).get(key);
          request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function idbPut(key: string, value: unknown): Promise<boolean> {
  return getDb().then(
    (db) =>
      new Promise<boolean>((resolve) => {
        if (!db) return resolve(false);
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).put(value, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch {
          resolve(false);
        }
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return getDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          tx.objectStore(STORE_NAME).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}

/**
 * Moves a ledger still sitting in `localStorage` into IndexedDB, once.
 *
 * The old copy is removed only after the new one has been written *and read
 * back*, so an interrupted or rejected migration leaves the original exactly
 * where it was and simply tries again next load. Removing it at all is the
 * point of the exercise -- a stale 2.8 MB blob nothing writes to any more
 * would go on occupying the same 5 MB budget the forecast plan shares, and a
 * copy that can never be updated is its own hazard if it were ever read again.
 */
async function migrateFromLocalStorage<S>(key: string): Promise<StorageValue<S> | null> {
  if (typeof localStorage === "undefined") return null;

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: StorageValue<S>;
  try {
    parsed = JSON.parse(raw) as StorageValue<S>;
  } catch {
    // Unreadable, so there is nothing to carry across. Clear it rather than
    // re-attempting this parse on every future load.
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* nothing further to try */
    }
    return null;
  }

  const written = await idbPut(key, parsed);
  if (!written) return parsed;

  const readBack = await idbGet<StorageValue<S>>(key);
  if (readBack === null) return parsed;

  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* the copy that matters is already in IndexedDB */
  }
  return readBack;
}

/**
 * Persist storage for the portfolio, backed by IndexedDB.
 *
 * Writes are coalesced rather than queued. The store stamps a save on every
 * mutation, and an import or a bulk edit fires a burst of them; without this,
 * each one would sit in line behind the last, and a ledger's worth of
 * megabyte writes would still be draining long after the UI had settled. Only
 * the newest value is ever worth writing, so a write already in flight keeps
 * just the latest arrival and flushes it when it lands.
 */
export function createPortfolioStorage<S>(): PersistStorage<S> {
  let writing: Promise<void> | null = null;
  let pending: { key: string; value: StorageValue<S> } | null = null;

  const flush = (): Promise<void> => {
    const next = pending;
    if (!next) {
      writing = null;
      return Promise.resolve();
    }
    pending = null;
    return idbPut(next.key, next.value).then(flush);
  };

  return {
    getItem: async (name) => {
      const stored = await idbGet<StorageValue<S>>(name);
      if (stored !== null) return stored;
      return migrateFromLocalStorage<S>(name);
    },

    setItem: (name, value) => {
      pending = { key: name, value };
      if (!writing) writing = flush();
      return writing;
    },

    removeItem: (name) => {
      pending = null;
      return idbDelete(name);
    },
  };
}
