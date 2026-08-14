import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import { buildLotLedger } from "./lots";

let seq = 0;
function tx(partial: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    accountId: "acct-1",
    symbol: "AAPL",
    quantity: 0,
    price: 0,
    amount: null,
    fees: 0,
    lotId: null,
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
    ...partial,
  };
}

/** AAPL Sep 18 2026 250 call, and the matching put. */
const CALL = "AAPL260918C00250000";
const PUT = "AAPL260918P00250000";

describe("expiry", () => {
  it("writes off a long contract's premium in full", () => {
    // One call bought for a $4.00 premium: $400 paid, expires worthless.
    const { closedLots, openLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_expire", date: "2026-09-18", symbol: CALL, quantity: 1 }),
    ]);

    expect(openLots).toHaveLength(0);
    expect(closedLots).toHaveLength(1);
    expect(closedLots[0].costBasis).toBe(400);
    expect(closedLots[0].proceeds).toBe(0);
    expect(closedLots[0].gain).toBe(-400);
    expect(closedLots[0].taxable).toBe(true);
  });

  it("lets a written contract keep its premium as a gain", () => {
    // A call sold short for $4.00 that expires is the whole point of writing it.
    const { closedLots, openLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_expire", date: "2026-09-18", symbol: CALL, quantity: 1 }),
    ]);

    expect(openLots).toHaveLength(0);
    expect(closedLots[0].side).toBe("short");
    expect(closedLots[0].gain).toBe(400);
    expect(closedLots[0].taxable).toBe(true);
  });

  it("resolves the side from the book, not from the transaction type", () => {
    const long = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_expire", date: "2026-09-18", symbol: CALL, quantity: 1 }),
    ]);
    const short = buildLotLedger([
      tx({ type: "short_sell", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_expire", date: "2026-09-18", symbol: CALL, quantity: 1 }),
    ]);

    // Identical expiry rows, opposite outcomes.
    expect(long.closedLots[0].gain).toBe(-400);
    expect(short.closedLots[0].gain).toBe(400);
  });

  it("warns when more contracts expire than the ledger holds", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_expire", date: "2026-09-18", symbol: CALL, quantity: 3 }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("more contracts expired than the ledger holds");
  });
});

describe("exercise", () => {
  it("rolls a long call's premium into what the shares cost", () => {
    // Bought a $250 call for $4.00 ($400), exercised into 100 shares at $250
    // ($25,000). The shares cost $25,400 -- the premium is part of the basis,
    // not a separate $400 loss.
    const { openLots, closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: CALL, quantity: 1 }),
      tx({ type: "buy", date: "2026-09-18", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    const shares = openLots.find((lot) => lot.symbol === "AAPL");
    expect(shares?.quantity).toBe(100);
    expect(shares?.costBasis).toBe(25_400);

    // The contract itself realizes nothing -- its premium moved to the shares.
    const contract = closedLots.find((lot) => lot.symbol === CALL);
    expect(contract?.gain).toBe(0);
    expect(contract?.taxable).toBe(false);
  });

  it("takes an exercised put's premium out of the proceeds", () => {
    // Held 100 shares at $200. Bought a $250 put for $4.00 and exercised it,
    // selling at $250 ($25,000) less the $400 premium = $24,600 of proceeds.
    const { closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-01-05", symbol: "AAPL", quantity: 100, price: 200 }),
      tx({ type: "buy", date: "2026-07-01", symbol: PUT, quantity: 1, price: 4 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: PUT, quantity: 1 }),
      tx({ type: "sell", date: "2026-09-18", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    const shares = closedLots.find((lot) => lot.symbol === "AAPL");
    expect(shares?.proceeds).toBe(24_600);
    expect(shares?.gain).toBe(4_600);
  });
});

describe("assignment", () => {
  it("adds a written call's premium to the called-away proceeds", () => {
    // Held 100 shares at $200. Wrote a $250 call for $4.00 and got assigned:
    // $25,000 for the shares plus the $400 premium kept = $25,400.
    const { closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-01-05", symbol: "AAPL", quantity: 100, price: 200 }),
      tx({ type: "short_sell", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_assign", date: "2026-09-18", symbol: CALL, quantity: 1 }),
      tx({ type: "sell", date: "2026-09-18", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    const shares = closedLots.find((lot) => lot.symbol === "AAPL");
    expect(shares?.proceeds).toBe(25_400);
    expect(shares?.gain).toBe(5_400);
    expect(shares?.term).toBe("short");
  });

  it("takes a written put's premium off the basis of the shares put to you", () => {
    // Wrote a $250 put for $4.00 and got assigned: you buy 100 shares at $250
    // ($25,000) but keep the $400, so the shares cost you $24,600.
    const { openLots, closedLots } = buildLotLedger([
      tx({ type: "short_sell", date: "2026-07-01", symbol: PUT, quantity: 1, price: 4 }),
      tx({ type: "option_assign", date: "2026-09-18", symbol: PUT, quantity: 1 }),
      tx({ type: "buy", date: "2026-09-18", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    const shares = openLots.find((lot) => lot.symbol === "AAPL");
    expect(shares?.costBasis).toBe(24_600);

    const contract = closedLots.find((lot) => lot.symbol === PUT);
    expect(contract?.gain).toBe(0);
    expect(contract?.taxable).toBe(false);
  });

  it("keeps the premium out of realized gains so it isn't counted twice", () => {
    const { closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-01-05", symbol: "AAPL", quantity: 100, price: 200 }),
      tx({ type: "short_sell", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_assign", date: "2026-09-18", symbol: CALL, quantity: 1 }),
      tx({ type: "sell", date: "2026-09-18", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    // $5,400 total: $5,000 on the shares and the $400 premium, counted once.
    const realized = closedLots.filter((l) => l.taxable).reduce((sum, l) => sum + l.gain, 0);
    expect(realized).toBe(5_400);
  });
});

describe("pairing", () => {
  it("warns when an exercise has no stock leg to attach to", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: CALL, quantity: 1 }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("No matching AAPL buy");
    expect(warnings[0].message).toContain("250 strike");
  });

  it("does not pair with a stock trade on a different date", () => {
    const { warnings, openLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: CALL, quantity: 1 }),
      tx({ type: "buy", date: "2026-09-21", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    expect(warnings).toHaveLength(1);
    // Unpaired, so the shares stand at bare strike with no premium folded in.
    expect(openLots.find((lot) => lot.symbol === "AAPL")?.costBasis).toBe(25_000);
  });

  it("gives each exercise its own stock leg when two settle the same day", () => {
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 1, price: 4 }),
      tx({ type: "buy", date: "2026-07-01", symbol: PUT, quantity: 1, price: 9 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: CALL, quantity: 1 }),
      tx({ type: "buy", date: "2026-09-18", symbol: "AAPL", quantity: 100, price: 250 }),
    ]);

    // Only the call's $400 lands on the share basis; the put is untouched.
    expect(openLots.find((lot) => lot.symbol === "AAPL")?.costBasis).toBe(25_400);
    expect(openLots.find((lot) => lot.symbol === PUT)?.quantity).toBe(1);
  });

  it("rejects a lifecycle event recorded against an ordinary ticker", () => {
    const { warnings } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: "AAPL", quantity: 100, price: 200 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: "AAPL", quantity: 1 }),
    ]);

    expect(warnings.some((w) => w.message.includes("isn't an option contract"))).toBe(true);
  });
});

describe("partial and multi-contract handling", () => {
  it("retires contracts oldest-first when only some expire", () => {
    const { openLots, closedLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-06-01", symbol: CALL, quantity: 2, price: 3 }),
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 2, price: 5 }),
      tx({ type: "option_expire", date: "2026-09-18", symbol: CALL, quantity: 3 }),
    ]);

    // The two $3.00 contracts go first, then one of the $5.00 pair.
    expect(closedLots.reduce((sum, lot) => sum + lot.gain, 0)).toBe(-(600 + 500));
    expect(openLots).toHaveLength(1);
    expect(openLots[0].quantity).toBe(1);
    expect(openLots[0].costBasis).toBe(500);
  });

  it("spreads a multi-contract exercise across the shares it delivers", () => {
    // Two calls at $4.00 exercised into 200 shares at $250.
    const { openLots } = buildLotLedger([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL, quantity: 2, price: 4 }),
      tx({ type: "option_exercise", date: "2026-09-18", symbol: CALL, quantity: 2 }),
      tx({ type: "buy", date: "2026-09-18", symbol: "AAPL", quantity: 200, price: 250 }),
    ]);

    expect(openLots.find((lot) => lot.symbol === "AAPL")?.costBasis).toBe(50_800);
  });
});
