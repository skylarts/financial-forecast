import { describe, expect, it } from "vitest";
import type { Transaction } from "@/domain/portfolio";
import { blankForm, formFromTransaction, num, parseBasisRetained, transactionFromForm } from "./transactionForm";

const stored: Transaction = {
  id: "t1",
  accountId: "acct-1",
  date: "2026-03-01",
  type: "dividend",
  symbol: "VTI",
  quantity: 0,
  price: 0,
  amount: 0,
  fees: 0,
  lotId: null,
  acquiredDate: null,
  spinoffSymbol: null,
  spinoffShareRatio: null,
  spinoffBasisRetained: null,
  note: "",
  importBatchId: null,
  sourceHash: null,
};

describe("num", () => {
  it("reads blank as zero and keeps an explicit zero as zero", () => {
    expect(num("")).toBe(0);
    expect(num("0")).toBe(0);
    expect(num("0.00")).toBe(0);
  });

  it("drops the sign -- direction is the type's job", () => {
    expect(num("-40")).toBe(40);
  });

  it("reads garbage as zero rather than NaN", () => {
    expect(num("ten")).toBe(0);
  });
});

describe("transactionFromForm", () => {
  it("keeps a blank amount null so the ledger derives it, and a typed zero as zero", () => {
    const form = { ...blankForm("acct-1", "2026-03-01"), type: "buy" as const, symbol: "vti", quantity: "10", price: "220.5" };
    expect(transactionFromForm(form).amount).toBeNull();
    expect(transactionFromForm({ ...form, amount: "0" }).amount).toBe(0);
    expect(transactionFromForm({ ...form, amount: "2205" }).amount).toBe(2205);
  });

  it("canonicalises the symbol and blanks an empty one", () => {
    const form = { ...blankForm("acct-1", "2026-03-01"), symbol: " brk.b " };
    expect(transactionFromForm(form).symbol).toBe("BRK-B");
    expect(transactionFromForm({ ...form, symbol: "  " }).symbol).toBeNull();
  });

  it("treats blank lot id, acquired date and spinoff fields as absent", () => {
    const tx = transactionFromForm(blankForm("acct-1", "2026-03-01"));
    expect(tx.lotId).toBeNull();
    expect(tx.acquiredDate).toBeNull();
    expect(tx.spinoffSymbol).toBeNull();
    expect(tx.spinoffShareRatio).toBeNull();
    expect(tx.spinoffBasisRetained).toBeNull();
  });
});

describe("formFromTransaction", () => {
  it("round-trips a stored zero-share dividend without turning its zeros into blanks that then mean something else", () => {
    const form = formFromTransaction(stored);
    expect(form.quantity).toBe("");
    expect(form.price).toBe("");
    // The stored amount is an explicit zero, and it comes back as "0", not blank.
    expect(form.amount).toBe("0");
    const back = transactionFromForm(form);
    expect(back.quantity).toBe(0);
    expect(back.amount).toBe(0);
  });

  it("leaves a derived amount blank on the way out", () => {
    expect(formFromTransaction({ ...stored, amount: null }).amount).toBe("");
  });
});

describe("parseBasisRetained", () => {
  it("accepts a fraction or a percentage", () => {
    expect(parseBasisRetained("0.8834")).toBeCloseTo(0.8834);
    expect(parseBasisRetained("88.34")).toBeCloseTo(0.8834);
    expect(parseBasisRetained("1")).toBe(1);
  });

  it("is null for blank or unreadable input", () => {
    expect(parseBasisRetained("")).toBeNull();
    expect(parseBasisRetained("most")).toBeNull();
  });
});
