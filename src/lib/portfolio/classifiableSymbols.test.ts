import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction } from "@/domain/portfolio";
import { inferInstrumentType, symbolsEverTraded } from "./classifiableSymbols";

function tx(patch: Partial<Transaction>): Transaction {
  return {
    id: patch.id ?? "t1",
    accountId: "a1",
    date: "2026-01-01",
    type: "buy",
    symbol: null,
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
    ...patch,
  };
}

function portfolio(transactions: Transaction[]): Portfolio {
  return { id: "p1", accounts: [], transactions, securities: [], baskets: [] };
}

describe("symbolsEverTraded", () => {
  it("keeps a symbol that was bought and then fully sold", () => {
    const result = symbolsEverTraded(
      portfolio([
        tx({ id: "1", type: "buy", symbol: "ARKK", quantity: 10, price: 50 }),
        tx({ id: "2", type: "sell", symbol: "ARKK", quantity: 10, price: 40 }),
      ]),
    );
    expect(result).toEqual(["ARKK"]);
  });

  it("includes a spinoff child that never carries a transaction of its own", () => {
    const result = symbolsEverTraded(
      portfolio([tx({ type: "spinoff", symbol: "GE", spinoffSymbol: "GEHC", spinoffShareRatio: 1 / 3 })]),
    );
    expect(result).toContain("GEHC");
  });

  it("ignores transactions with no symbol", () => {
    expect(symbolsEverTraded(portfolio([tx({ type: "cash_deposit", amount: 500 })]))).toEqual([]);
  });

  it("normalizes, so one contract spelled two ways is one symbol", () => {
    const result = symbolsEverTraded(
      portfolio([
        tx({ id: "1", symbol: "KLAR 01/21/2028 17.50 C" }),
        tx({ id: "2", symbol: "KLAR280121C00017500" }),
      ]),
    );
    expect(result).toHaveLength(1);
  });
});

describe("inferInstrumentType", () => {
  it("reads an option off its own symbol, with no ledger evidence at all", () => {
    expect(inferInstrumentType("KLAR280121C00017500", [])).toBe("option");
  });

  it("calls a delisted ticker the ledger traded in shares a stock", () => {
    const ledger = [tx({ type: "buy", symbol: "SPAQ", quantity: 100, price: 25 })];
    expect(inferInstrumentType("SPAQ", ledger)).toBe("stock");
  });

  it("still says stock when the only evidence is the sale", () => {
    const ledger = [tx({ type: "sell", symbol: "SPAQ", quantity: 100, price: 3 })];
    expect(inferInstrumentType("SPAQ", ledger)).toBe("stock");
  });

  it("stays 'other' for a symbol that only ever received a dividend", () => {
    const ledger = [tx({ type: "dividend", symbol: "MYST", amount: 12 })];
    expect(inferInstrumentType("MYST", ledger)).toBe("other");
  });

  it("does not borrow another symbol's share trades", () => {
    const ledger = [tx({ type: "buy", symbol: "VTI", quantity: 1, price: 200 })];
    expect(inferInstrumentType("SPAQ", ledger)).toBe("other");
  });
});
