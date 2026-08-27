import type { ISODate } from "@/domain";
import type { PricePoint, SplitEvent } from "@/engine/portfolio/performance";

/**
 * A symbol's price history, persisted across page reloads.
 *
 * Daily closes never change once the day has closed, so the only thing that
 * ever makes a cached entry unusable is asking for a window it doesn't reach
 * back far enough to cover, or wanting today's close before this entry
 * learned it. See {@link coversRequest}.
 */
export interface CachedHistoryEntry {
  points: PricePoint[];
  splits: SplitEvent[];
  /** How far back this entry's `points` reliably start. */
  from: ISODate;
  fetchedAt: number;
}

/**
 * Mirrors the server's own history TTL (see `HISTORY_TTL_MS` in
 * `priceFeed.ts`) -- there is no reason for the browser to trust a close
 * looser than the process that fetched it does.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Whether a cached entry can answer a request for data back to `from`
 * without going to the network.
 *
 * A cache entry is a high-water mark: it was fetched for some window and
 * holds everything from that window's start through the day it was fetched.
 * It covers a *narrower* request (a later `from`) for free, because the
 * extra leading history a consumer doesn't strictly need is harmless -- every
 * reader in this codebase already tolerates a points array that reaches
 * further back than it asked for. It does not cover a *wider* request (an
 * earlier `from`); that has to go fetch the years it's missing.
 */
export function coversRequest(entry: CachedHistoryEntry, from: ISODate, now: number = Date.now()): boolean {
  return entry.from <= from && now - entry.fetchedAt < CACHE_TTL_MS;
}

const DB_NAME = "portfolio-price-history";
const DB_VERSION = 1;
const STORE_NAME = "history";

function keyFor(symbol: string, range: string): string {
  return `${symbol}::${range}`;
}

/**
 * Opened once per page load and reused -- IndexedDB connections are cheap to
 * hold open and expensive to renegotiate on every read.
 *
 * Resolves to `null` rather than rejecting when IndexedDB is unavailable (no
 * `window`, a private-browsing mode that blocks it, a browser that doesn't
 * support it) or fails to open, so every caller can treat this purely as a
 * cache: a miss here just means falling back to the network, never an error
 * a chart needs to handle.
 */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

/**
 * Cached entries for whichever of `requests` this store has, keyed by symbol.
 *
 * A symbol missing from the result is a cache miss, not an error -- the
 * caller fetches it and, once it has an answer, is expected to call
 * {@link putCachedHistories} so the next reload doesn't miss it too.
 */
export async function getCachedHistories(
  requests: readonly { symbol: string; range: string }[],
): Promise<Map<string, CachedHistoryEntry>> {
  const result = new Map<string, CachedHistoryEntry>();
  if (requests.length === 0) return result;
  const db = await getDb();
  if (!db) return result;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    for (const { symbol, range } of requests) {
      const getRequest = store.get(keyFor(symbol, range));
      getRequest.onsuccess = () => {
        const entry = getRequest.result as CachedHistoryEntry | undefined;
        if (entry) result.set(symbol, entry);
      };
    }
    // A store this reads from failing mid-transaction still leaves whatever
    // was already resolved in `result` -- resolving on error rather than
    // rejecting keeps a corrupt cache from taking the whole page down with
    // it.
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve(result);
  });
}

/** Persists freshly-fetched history so the next reload doesn't refetch it. */
export async function putCachedHistories(
  range: string,
  from: ISODate,
  entries: ReadonlyMap<string, { points: PricePoint[]; splits: SplitEvent[] }>,
): Promise<void> {
  if (entries.size === 0) return;
  const db = await getDb();
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const fetchedAt = Date.now();
    for (const [symbol, { points, splits }] of entries) {
      const entry: CachedHistoryEntry = { points, splits, from, fetchedAt };
      store.put(entry, keyFor(symbol, range));
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
