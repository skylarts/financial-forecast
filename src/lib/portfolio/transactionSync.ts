import type { Transaction } from "@/domain/portfolio";

/**
 * Working out the smallest set of writes that brings the cloud copy of a
 * ledger in line with the local one.
 *
 * The tracker used to push the entire portfolio as a single JSON blob on every
 * edit. That is roughly 2.8 MB at 10,000 transactions and 28 MB at 100,000 --
 * re-sent in full, on a debounce, after every keystroke that reaches the
 * store. Slow at the low end and unusable at the high end.
 *
 * Almost every edit touches a handful of rows, so the fix is to send those.
 * The diff below is pure and takes both sides as plain maps, which is what
 * makes it testable without a database.
 */

export interface TransactionDiff {
  /** Rows to write: new ones, and ones whose contents changed. */
  upserts: Transaction[];
  /** Ids to remove, because they are no longer in the local ledger. */
  deletes: string[];
}

/**
 * A transaction's contents, for telling "changed" from "same".
 *
 * Compared as serialized JSON rather than field by field so a field added to
 * the schema later is covered without anyone remembering to add it here. Key
 * order is stable because every transaction is built from the same object
 * literal or parsed by the same zod schema, so this never reports a spurious
 * change from reordering alone -- and a spurious change costs one redundant
 * row write, not a wrong answer.
 */
function fingerprint(tx: Transaction): string {
  return JSON.stringify(tx);
}

/**
 * What to write and what to remove, comparing the local ledger against what
 * was last seen in the cloud.
 *
 * `remote` is the previous push's snapshot rather than a fresh read: the point
 * is to avoid a round trip on every edit, and the local session is the only
 * writer between pushes in the ordinary case. A second device writing
 * concurrently is handled the way it always has been -- the pull on sign-in
 * takes the cloud copy -- not by trying to merge mid-session.
 */
export function diffTransactions(
  local: readonly Transaction[],
  remote: ReadonlyMap<string, string>,
): TransactionDiff {
  const upserts: Transaction[] = [];
  const seen = new Set<string>();

  for (const tx of local) {
    seen.add(tx.id);
    const previous = remote.get(tx.id);
    if (previous === undefined || previous !== fingerprint(tx)) upserts.push(tx);
  }

  const deletes: string[] = [];
  for (const id of remote.keys()) {
    if (!seen.has(id)) deletes.push(id);
  }

  return { upserts, deletes };
}

/** The snapshot to remember after a successful push, for the next diff. */
export function snapshotOf(transactions: readonly Transaction[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const tx of transactions) snapshot.set(tx.id, fingerprint(tx));
  return snapshot;
}

/**
 * How many rows go up in one request.
 *
 * A first sync of a large ledger is still a large upload -- it just arrives in
 * pieces small enough that no single request is rejected for size, and a
 * failure part way costs one chunk rather than the whole thing.
 */
export const SYNC_CHUNK = 500;

export function chunked<T>(rows: readonly T[], size = SYNC_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}
