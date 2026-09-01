"use client";

import type { Portfolio } from "@/domain/portfolio";

/**
 * A rolling local history of the ledger, kept so that no sync bug, bad pull,
 * or mistaken bulk delete can leave the user with nothing.
 *
 * This exists because on 2026-08-31 a sync bug replaced a real portfolio with
 * an empty one and there was no copy left to go back to. The guards in
 * `syncSafety` stop that specific failure; this is the layer that assumes some
 * *future* failure will get through anyway.
 *
 * Three properties matter, and each is a deliberate choice:
 *
 *  - **Its own database.** Not another store inside `portfolio-store`, which
 *    would share that database's fate: a version upgrade that goes wrong, a
 *    `deleteDatabase` during recovery, or a corrupt record takes every store in
 *    it. A backup that dies with the thing it is backing up is not a backup.
 *  - **Written before the change, never after.** A snapshot records the ledger
 *    that is about to be replaced, so the copy always predates whatever went
 *    wrong.
 *  - **Never written by the sync path.** Nothing that talks to the network can
 *    add, prune, or overwrite a snapshot. The whole point is a copy the cloud
 *    cannot reach.
 *
 * Nothing here throws. A failure to snapshot must never block or break the
 * operation it was trying to protect.
 */

const DB_NAME = "portfolio-snapshots";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

/**
 * How many snapshots to keep.
 *
 * Enough to survive a bad state going unnoticed for a while -- the incident
 * this was written for was spotted a day later, across several app loads --
 * without letting a large ledger's history grow without bound.
 */
export const SNAPSHOT_LIMIT = 12;

export interface SnapshotMeta {
  /** Millisecond timestamp, and the record's key. */
  id: number;
  takenAt: string;
  /** Why it was taken, shown to the user when choosing one to restore. */
  reason: string;
  transactionCount: number;
  accountCount: number;
}

export interface Snapshot extends SnapshotMeta {
  portfolio: Portfolio;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function getDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

/**
 * Decides whether a change is worth preserving the old ledger for.
 *
 * Losing transactions is the only thing being defended against here, so a
 * change that keeps or adds them is not snapshotted -- otherwise every import
 * and every quote writeback would churn the history and push the copies that
 * matter out of the rolling window.
 *
 * Pure, and separated from the storage below, because this is the rule that
 * decides whether a copy exists at all when someone needs one.
 */
export function isDestructiveChange(beforeCount: number, afterCount: number): boolean {
  return beforeCount > 0 && afterCount < beforeCount;
}

/**
 * Whether a new snapshot improves on the best one already taken this session.
 *
 * Deleting a thousand rows one at a time would otherwise write a thousand
 * snapshots, each thinner than the last, and the fullest copy -- the only one
 * actually worth keeping -- would be evicted by its own successors. Keeping
 * only a strictly larger ledger means the rolling window holds the best copies
 * rather than the most recent ones.
 */
export function supersedesSessionBest(candidateCount: number, sessionBestCount: number | null): boolean {
  return sessionBestCount === null || candidateCount > sessionBestCount;
}

let sessionBestCount: number | null = null;

/** Test seam: forget what this session has already captured. */
export function resetSessionSnapshotState(): void {
  sessionBestCount = null;
}

/**
 * Stores `portfolio` as the state that existed before whatever is about to
 * happen. Returns whether a snapshot was actually written.
 */
export async function saveSnapshot(portfolio: Portfolio, reason: string): Promise<boolean> {
  const transactionCount = portfolio.transactions.length;
  if (transactionCount === 0) return false;
  if (!supersedesSessionBest(transactionCount, sessionBestCount)) return false;

  const db = await getDb();
  if (!db) return false;

  const now = Date.now();
  const snapshot: Snapshot = {
    id: now,
    takenAt: new Date(now).toISOString(),
    reason,
    transactionCount,
    accountCount: portfolio.accounts.length,
    portfolio,
  };

  const written = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(snapshot);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });

  if (written) {
    sessionBestCount = transactionCount;
    await pruneSnapshots();
  }
  return written;
}

/** Newest first. Metadata only -- the portfolios themselves are large. */
export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const db = await getDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const rows = (request.result as Snapshot[]) ?? [];
        resolve(
          rows
            .map(({ id, takenAt, reason, transactionCount, accountCount }) => ({
              id,
              takenAt,
              reason,
              transactionCount,
              accountCount,
            }))
            .sort((a, b) => b.id - a.id),
        );
      };
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** The full portfolio behind one snapshot, or null if it has gone. */
export async function readSnapshot(id: number): Promise<Portfolio | null> {
  const db = await getDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as Snapshot | undefined)?.portfolio ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Drops the oldest snapshots past {@link SNAPSHOT_LIMIT}.
 *
 * Oldest-first rather than smallest-first: a genuinely shrinking ledger is a
 * legitimate thing, and preferring big copies forever would eventually pin the
 * window to one ancient snapshot and quietly stop keeping recent ones.
 */
async function pruneSnapshots(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await listSnapshots();
  const doomed = existing.slice(SNAPSHOT_LIMIT);
  if (doomed.length === 0) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const { id } of doomed) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
