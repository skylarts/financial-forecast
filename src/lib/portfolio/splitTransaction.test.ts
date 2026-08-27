import { describe, expect, it } from "vitest";
import type { Transaction } from "@/domain/portfolio";
import { isDivisible, splitTransactionByFraction } from "./splitTransaction";

function tx(patch: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    accountId: "k401",
    date: "2026-08-04",
    type: "buy",
    symbol: "VIIIX",
    quantity: 1.70686,
    price: 608.72,
    amount: 1039,
    fees: 0,
    lotId: "VIIIX-2026-08-04-1",
    acquiredDate: null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "Payroll contribution",
    importBatchId: "batch-1",
    sourceHash: "hash-1",
    ...patch,
  };
}

describe("splitTransactionByFraction", () => {
  it("files the moved part under the target account and leaves the rest behind", () => {
    const halves = splitTransactionByFraction(tx(), "roth", 0.25, "tx-2")!;

    expect(halves.kept.accountId).toBe("k401");
    expect(halves.moved.accountId).toBe("roth");
    expect(halves.moved.id).toBe("tx-2");
  });

  it("divides money and shares by the fraction", () => {
    const halves = splitTransactionByFraction(tx({ fees: 4 }), "roth", 0.25, "tx-2")!;

    expect(halves.moved.amount).toBe(259.75);
    expect(halves.kept.amount).toBe(779.25);
    expect(halves.moved.fees).toBe(1);
    expect(halves.kept.fees).toBe(3);
  });

  it("adds back to the original exactly, whatever the fraction does to the cents", () => {
    // A third of $1,039 is $346.333..., which no rounding can represent twice.
    const original = tx({ amount: 1039, fees: 0.07, quantity: 1.70686 });
    const halves = splitTransactionByFraction(original, "roth", 1 / 3, "tx-2")!;

    expect(halves.kept.amount! + halves.moved.amount!).toBe(original.amount);
    expect(halves.kept.fees + halves.moved.fees).toBe(original.fees);
    expect(halves.kept.quantity + halves.moved.quantity).toBeCloseTo(original.quantity, 10);
  });

  it("keeps a derived amount derived on both halves", () => {
    // A null amount means "work it out from quantity x price"; writing a
    // number here would book a trade the statement never stated.
    const halves = splitTransactionByFraction(tx({ amount: null }), "roth", 0.4, "tx-2")!;

    expect(halves.kept.amount).toBeNull();
    expect(halves.moved.amount).toBeNull();
  });

  it("clears both lot ids so each half re-derives one where it now lives", () => {
    const halves = splitTransactionByFraction(tx(), "roth", 0.5, "tx-2")!;

    expect(halves.kept.lotId).toBeNull();
    expect(halves.moved.lotId).toBeNull();
  });

  it("keeps the source fingerprint on both halves", () => {
    const halves = splitTransactionByFraction(tx(), "roth", 0.5, "tx-2")!;

    expect(halves.kept.sourceHash).toBe("hash-1");
    expect(halves.moved.sourceHash).toBe("hash-1");
  });

  it("refuses a fraction that is not a real division", () => {
    for (const fraction of [0, 1, -0.5, 1.5, Number.NaN]) {
      expect(splitTransactionByFraction(tx(), "roth", fraction, "tx-2")).toBeNull();
    }
  });

  it("refuses to split a row into the account it is already in", () => {
    expect(splitTransactionByFraction(tx(), "k401", 0.5, "tx-2")).toBeNull();
  });

  it("leaves corporate actions whole", () => {
    // Quantity is a ratio on these, not a share count: two half-splits are not
    // one split.
    expect(splitTransactionByFraction(tx({ type: "split", quantity: 2 }), "roth", 0.5, "tx-2")).toBeNull();
    expect(splitTransactionByFraction(tx({ type: "spinoff" }), "roth", 0.5, "tx-2")).toBeNull();
  });
});

describe("isDivisible", () => {
  it("covers ordinary money-moving rows", () => {
    expect(isDivisible(tx({ type: "buy" }))).toBe(true);
    expect(isDivisible(tx({ type: "dividend" }))).toBe(true);
    expect(isDivisible(tx({ type: "fee" }))).toBe(true);
  });

  it("excludes the rows whose quantity is a ratio", () => {
    expect(isDivisible(tx({ type: "split" }))).toBe(false);
    expect(isDivisible(tx({ type: "spinoff" }))).toBe(false);
  });
});
