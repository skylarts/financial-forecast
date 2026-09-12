/**
 * Copies of the plan the app keeps for itself, so no load, sync, or restore
 * can be the only copy's last moment.
 *
 * Three kinds, one store (browser localStorage, beside the live plan):
 *
 *  - **broken**   the raw bytes of a saved plan that failed to load. Kept
 *                 verbatim, never parsed again by the app; a person can
 *                 download it or hand it to a newer build.
 *  - **replaced** the local plan as it stood the instant something else
 *                 (a cloud pull, a restored file, a newer cloud copy) took
 *                 its place.
 *  - **snapshot** the plan just before a change that removed something: an
 *                 account, an income, an expense, an event, or a scenario.
 *
 * Every write is best-effort. A failure to keep a copy must never block the
 * change that triggered it, so nothing in here throws.
 */

import type { Plan } from "@/domain";

export type RecoveryKind = "broken" | "replaced" | "snapshot";

export interface RecoveryCopy {
  key: string;
  kind: RecoveryKind;
  /** Epoch milliseconds when the copy was taken. */
  at: number;
  /** Why it was taken, in words a person can read in a menu. */
  reason: string;
  /** Scenario count, when the copy parsed; null for a broken copy. */
  scenarioCount: number | null;
}

interface StoredCopy {
  kind: RecoveryKind;
  at: number;
  reason: string;
  scenarioCount: number | null;
  /** A parsed plan, or the raw string for a broken copy. */
  plan?: Plan;
  raw?: string;
}

export const RECOVERY_PREFIX = "forecast-plan.copy.";
/** How many copies to keep per kind; the oldest go first. */
export const RECOVERY_LIMIT = 12;

/** A minimal storage shape so tests can hand in a plain object. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function allKeys(storage: KeyValueStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(RECOVERY_PREFIX)) keys.push(k);
  }
  return keys;
}

function readStored(storage: KeyValueStorage, key: string): StoredCopy | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as StoredCopy;
  } catch {
    return null;
  }
}

function toMeta(key: string, stored: StoredCopy): RecoveryCopy {
  return { key, kind: stored.kind, at: stored.at, reason: stored.reason, scenarioCount: stored.scenarioCount };
}

/** Every copy on hand, newest first. */
export function listRecoveryCopies(storage: KeyValueStorage | null = defaultStorage()): RecoveryCopy[] {
  if (!storage) return [];
  return allKeys(storage)
    .map((key) => {
      const stored = readStored(storage, key);
      return stored ? toMeta(key, stored) : null;
    })
    .filter((c): c is RecoveryCopy => c !== null)
    .sort((a, b) => b.at - a.at);
}

function prune(storage: KeyValueStorage, kind: RecoveryKind): void {
  const ofKind = listRecoveryCopies(storage).filter((c) => c.kind === kind);
  for (const stale of ofKind.slice(RECOVERY_LIMIT)) {
    try {
      storage.removeItem(stale.key);
    } catch {
      /* best effort */
    }
  }
}

function write(storage: KeyValueStorage | null, stored: StoredCopy): string | null {
  if (!storage) return null;
  const key = `${RECOVERY_PREFIX}${stored.kind}.${stored.at}`;
  try {
    storage.setItem(key, JSON.stringify(stored));
    prune(storage, stored.kind);
    return key;
  } catch {
    return null;
  }
}

/** Keep the raw text of a plan that failed to load. Returns the key, or null if nothing could be kept. */
export function keepBrokenCopy(raw: string, reason: string, storage: KeyValueStorage | null = defaultStorage(), now = Date.now()): string | null {
  return write(storage, { kind: "broken", at: now, reason, scenarioCount: null, raw });
}

/** Keep a plan that is about to be replaced or shrunk. Returns the key, or null. */
export function keepPlanCopy(
  plan: Plan,
  kind: Exclude<RecoveryKind, "broken">,
  reason: string,
  storage: KeyValueStorage | null = defaultStorage(),
  now = Date.now()
): string | null {
  return write(storage, { kind, at: now, reason, scenarioCount: plan.scenarios.length, plan });
}

/** The plan behind a copy (parsed), or the raw text for a broken one. */
export function readRecoveryCopy(key: string, storage: KeyValueStorage | null = defaultStorage()): { plan?: Plan; raw?: string } | null {
  if (!storage) return null;
  const stored = readStored(storage, key);
  if (!stored) return null;
  return { plan: stored.plan, raw: stored.raw };
}

export function deleteRecoveryCopy(key: string, storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* best effort */
  }
}

/**
 * Counts that decide whether a change "removed something". A snapshot is
 * taken only when a count falls: adding or editing never snapshots, so a
 * busy session does not fill the store with identical copies.
 */
export function contentCounts(plan: Plan): number[] {
  return [
    plan.scenarios.length,
    ...plan.scenarios.flatMap((s) => [
      s.household.people.length,
      s.accounts.length,
      s.incomeSources.length,
      s.expenses.length,
      s.events.length,
    ]),
  ];
}

/** True when the change from `before` to `after` dropped at least one item somewhere. */
export function isShrinkingChange(before: Plan, after: Plan): boolean {
  const a = contentCounts(before);
  const b = contentCounts(after);
  if (a.length !== b.length) return a.length > b.length;
  return a.some((n, i) => b[i] < n);
}
