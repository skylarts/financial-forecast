import { describe, expect, it } from "vitest";
import { chunked, diffTransactions, snapshotOf } from "./transactionSync";
import type { Transaction } from "@/domain/portfolio";

function tx(id: string, patch: Partial<Transaction> = {}): Transaction {
  return {
    id,
    accountId: "acct-1",
    date: "2026-01-05",
    type: "buy",
    symbol: "VTI",
    quantity: 3,
    price: 100,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "",
    taxSourceLabel: null,
    importBatchId: null,
    ...patch,
  } as unknown as Transaction;
}

describe("diffTransactions", () => {
  it("sends everything when the cloud holds nothing", () => {
    const local = [tx("a"), tx("b")];
    const { upserts, deletes } = diffTransactions(local, new Map());
    expect(upserts.map((t) => t.id)).toEqual(["a", "b"]);
    expect(deletes).toEqual([]);
  });

  it("sends nothing when the two sides already agree", () => {
    const local = [tx("a"), tx("b")];
    const { upserts, deletes } = diffTransactions(local, snapshotOf(local));
    expect(upserts).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it("sends only the row that changed", () => {
    const before = [tx("a"), tx("b"), tx("c")];
    const after = [tx("a"), tx("b", { quantity: 9 }), tx("c")];
    const { upserts, deletes } = diffTransactions(after, snapshotOf(before));
    expect(upserts.map((t) => t.id)).toEqual(["b"]);
    expect(deletes).toEqual([]);
  });

  it("removes rows that are gone locally", () => {
    const before = [tx("a"), tx("b"), tx("c")];
    const after = [tx("a"), tx("c")];
    const { upserts, deletes } = diffTransactions(after, snapshotOf(before));
    expect(upserts).toEqual([]);
    expect(deletes).toEqual(["b"]);
  });

  it("handles an import as adds without touching what was there", () => {
    const before = [tx("a")];
    const after = [tx("a"), tx("new-1"), tx("new-2")];
    const { upserts, deletes } = diffTransactions(after, snapshotOf(before));
    expect(upserts.map((t) => t.id)).toEqual(["new-1", "new-2"]);
    expect(deletes).toEqual([]);
  });

  it("treats a re-created id with different contents as a write, not a no-op", () => {
    const before = [tx("a", { symbol: "VTI" })];
    const after = [tx("a", { symbol: "BND" })];
    const { upserts } = diffTransactions(after, snapshotOf(before));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].symbol).toBe("BND");
  });

  it("only sends a handful of rows for a one-row edit on a large ledger", () => {
    const before = Array.from({ length: 10_000 }, (_, i) => tx(`tx-${i}`));
    const after = before.map((t, i) => (i === 5000 ? tx("tx-5000", { quantity: 42 }) : t));
    const { upserts, deletes } = diffTransactions(after, snapshotOf(before));
    expect(upserts).toHaveLength(1);
    expect(deletes).toHaveLength(0);
  });
});

describe("chunked", () => {
  it("splits a long list into batches and keeps every row", () => {
    const rows = Array.from({ length: 1250 }, (_, i) => i);
    const batches = chunked(rows, 500);
    expect(batches.map((b) => b.length)).toEqual([500, 500, 250]);
    expect(batches.flat()).toEqual(rows);
  });

  it("returns nothing for an empty list", () => {
    expect(chunked([], 500)).toEqual([]);
  });
});
