import { describe, expect, it } from "vitest";
import type { Transaction, TransactionType } from "@/domain/portfolio";
import type { ClosedLot } from "./lots";
import { flagWashSales } from "./washSales";

let seq = 0;
function tx(partial: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    accountId: "acct-1",
    symbol: "VTI",
    quantity: 10,
    price: 100,
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

function lot(partial: Partial<ClosedLot> = {}): ClosedLot {
  return {
    id: "VTI-1",
    accountId: "acct-1",
    symbol: "VTI",
    side: "long",
    acquiredDate: "2025-01-10",
    disposedDate: "2026-03-01",
    quantity: 10,
    costBasis: 1000,
    proceeds: 800,
    gain: -200,
    term: "long",
    taxable: true,
    unmatched: false,
    openTxId: "open-1",
    closeTxId: "close-1",
    ...partial,
  };
}

describe("flagWashSales", () => {
  it("flags a loss with a repurchase inside thirty days after the sale", () => {
    const sold = lot();
    const flagged = flagWashSales([sold], [tx({ type: "buy", date: "2026-03-20" })]);
    expect(flagged.has(sold)).toBe(true);
  });

  it("flags a loss with a purchase inside thirty days before the sale", () => {
    const sold = lot();
    const flagged = flagWashSales([sold], [tx({ type: "buy", date: "2026-02-05" })]);
    expect(flagged.has(sold)).toBe(true);
  });

  it("counts a reinvested dividend as a repurchase", () => {
    const sold = lot();
    const flagged = flagWashSales([sold], [tx({ type: "reinvest", date: "2026-03-15", quantity: 0.4 })]);
    expect(flagged.has(sold)).toBe(true);
  });

  it("reaches into another account", () => {
    const sold = lot();
    const flagged = flagWashSales([sold], [tx({ type: "buy", date: "2026-03-10", accountId: "roth-ira" })]);
    expect(flagged.has(sold)).toBe(true);
  });

  it("does not flag a purchase outside the window", () => {
    const sold = lot();
    const flagged = flagWashSales([sold], [tx({ type: "buy", date: "2026-04-05" })]);
    expect(flagged.has(sold)).toBe(false);
  });

  it("does not flag the purchase that opened the lot itself", () => {
    const sold = lot({ acquiredDate: "2026-02-20", disposedDate: "2026-03-01", term: "short" });
    const flagged = flagWashSales([sold], [tx({ type: "buy", date: "2026-02-20", id: "open-1" })]);
    expect(flagged.has(sold)).toBe(false);
  });

  it("does not flag gains, other symbols, untaxed disposals, or shorts", () => {
    const gain = lot({ gain: 200, proceeds: 1200 });
    const other = lot({ symbol: "BND" });
    const transfer = lot({ taxable: false });
    const short = lot({ side: "short" });
    const flagged = flagWashSales([gain, other, transfer, short], [tx({ type: "buy", date: "2026-03-05" })]);
    expect(flagged.size).toBe(0);
  });
});
