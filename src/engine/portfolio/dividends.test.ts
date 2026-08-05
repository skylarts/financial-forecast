import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import {
  dividendSourceHash,
  proposeDividends,
  toTransaction,
  type DividendEvent,
} from "./dividends";

let seq = 0;
function tx(patch: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    accountId: "acct-1",
    symbol: "VTI",
    quantity: 0,
    price: 0,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
    ...patch,
  };
}

function events(pairs: [string, number][]): Map<string, DividendEvent[]> {
  return new Map([["VTI", pairs.map(([date, amount]) => ({ date, amount }))]]);
}

describe("proposeDividends", () => {
  it("multiplies shares held by the per-share amount", () => {
    const { proposals } = proposeDividends(
      [tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 })],
      events([["2024-03-20", 0.9]]),
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      symbol: "VTI",
      date: "2024-03-20",
      shares: 100,
      perShare: 0.9,
      amount: 90,
    });
  });

  it("uses the shares held going into the ex-date, not after it", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        // Bought on the ex-date itself: too late to be entitled to this one.
        tx({ type: "buy", date: "2024-03-20", quantity: 500, price: 210 }),
      ],
      events([["2024-03-20", 1 ]]),
    );

    expect(proposals[0].shares).toBe(100);
  });

  it("counts a sale before the ex-date", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "sell", date: "2024-02-01", quantity: 60, price: 210 }),
      ],
      events([["2024-03-20", 1]]),
    );

    expect(proposals[0].shares).toBe(40);
  });

  it("proposes nothing for a position already closed", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "sell", date: "2024-02-01", quantity: 100, price: 210 }),
      ],
      events([["2024-03-20", 1]]),
    );

    expect(proposals).toHaveLength(0);
  });

  it("skips an ex-date the ledger already has a dividend near", () => {
    // Paid three weeks after the ex-date, which is how a statement records it.
    const { proposals, skippedExisting } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "dividend", date: "2024-04-10", amount: 90 }),
      ],
      events([["2024-03-20", 0.9]]),
    );

    expect(proposals).toHaveLength(0);
    expect(skippedExisting).toBe(1);
  });

  it("still proposes the next quarter when the last one is recorded", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "dividend", date: "2024-04-10", amount: 90 }),
      ],
      events([
        ["2024-03-20", 0.9],
        ["2024-06-20", 0.95],
      ]),
    );

    // The match window must not reach the following ex-date.
    expect(proposals.map((p) => p.date)).toEqual(["2024-06-20"]);
  });

  it("never proposes the same payment twice", () => {
    const already = toTransaction({
      key: "k",
      accountId: "acct-1",
      symbol: "VTI",
      date: "2024-03-20",
      perShare: 0.9,
      shares: 100,
      amount: 90,
      sourceHash: dividendSourceHash("VTI", "2024-03-20"),
    });

    const { proposals, skippedExisting } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        { ...already, id: "tx-existing" },
      ],
      events([["2024-03-20", 0.9]]),
    );

    expect(proposals).toHaveLength(0);
    expect(skippedExisting).toBe(1);
  });

  it("ignores ex-dates from before the position existed", () => {
    const { proposals } = proposeDividends(
      [tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 })],
      events([
        ["2023-06-20", 0.8],
        ["2024-03-20", 0.9],
      ]),
    );

    expect(proposals.map((p) => p.date)).toEqual(["2024-03-20"]);
  });

  it("proposes a payment owed on a short position, as money out", () => {
    const { proposals } = proposeDividends(
      [tx({ type: "short_sell", date: "2024-01-10", quantity: 50, price: 200 })],
      events([["2024-03-20", 0.9]]),
    );

    expect(proposals[0].shares).toBe(-50);
    expect(proposals[0].amount).toBeCloseTo(-45, 10);
  });

  it("applies a split to the share count before paying on it", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "split", date: "2024-02-01", quantity: 2 }),
      ],
      events([["2024-03-20", 0.5]]),
    );

    expect(proposals[0].shares).toBe(200);
    expect(proposals[0].amount).toBe(100);
  });

  it("keeps accounts separate", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "buy", date: "2024-01-10", quantity: 30, price: 200, accountId: "acct-2" }),
      ],
      events([["2024-03-20", 1]]),
    );

    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.shares).sort((a, b) => a - b)).toEqual([30, 100]);
  });

  it("narrows to the accounts asked for", () => {
    const { proposals } = proposeDividends(
      [
        tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200 }),
        tx({ type: "buy", date: "2024-01-10", quantity: 30, price: 200, accountId: "acct-2" }),
      ],
      events([["2024-03-20", 1]]),
      { accountIds: ["acct-2"] },
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0].accountId).toBe("acct-2");
  });

  it("says nothing about symbols the feed has no dividends for", () => {
    const { proposals } = proposeDividends(
      [tx({ type: "buy", date: "2024-01-10", quantity: 100, price: 200, symbol: "BRK.B" })],
      events([["2024-03-20", 1]]),
    );

    expect(proposals).toHaveLength(0);
  });
});

describe("toTransaction", () => {
  it("writes a cash dividend that moves no shares", () => {
    const written = toTransaction({
      key: "k",
      accountId: "acct-1",
      symbol: "VTI",
      date: "2024-03-20",
      perShare: 0.9,
      shares: 100,
      amount: 90,
      sourceHash: dividendSourceHash("VTI", "2024-03-20"),
    });

    expect(written).toMatchObject({
      type: "dividend",
      symbol: "VTI",
      date: "2024-03-20",
      amount: 90,
      // A share count here would replay as a position change in the lot ledger.
      quantity: 0,
      sourceHash: "auto-div:VTI:2024-03-20",
    });
  });
});
