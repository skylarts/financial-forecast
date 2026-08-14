import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction, TransactionType } from "@/domain/portfolio";
import { accountCashBalances } from "./cash";

let seq = 0;
function tx(partial: Partial<Transaction> & { type: TransactionType; date: string }): Transaction {
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
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: "",
    importBatchId: null,
    sourceHash: null,
    ...partial,
  };
}

function cash(type: "cash_deposit" | "cash_withdrawal", date: string, amount: number, accountId = "acct-1") {
  return tx({ type, date, accountId, symbol: null, amount });
}

function portfolio(transactions: Transaction[], opening = 0): Portfolio {
  return {
    id: "p1",
    accounts: [
      {
        id: "acct-1",
        name: "Brokerage",
        institution: "",
        type: "taxable",
        forecastAccountId: null,
        openingCashBalance: opening,
      },
    ],
    transactions,
    securities: [],
  };
}

const balanceOf = (p: Portfolio, asOf?: string) =>
  accountCashBalances(p, asOf ? { asOf } : {}).get("acct-1")!;

describe("accountCashBalances", () => {
  it("nets every cash movement the ledger records", () => {
    const result = balanceOf(
      portfolio([
        cash("cash_deposit", "2025-01-02", 10000),
        tx({ type: "buy", date: "2025-01-05", quantity: 20, price: 100 }),
        tx({ type: "dividend", date: "2025-03-01", amount: 45 }),
        tx({ type: "sell", date: "2025-06-01", quantity: 5, price: 120 }),
        tx({ type: "fee", date: "2025-06-02", symbol: null, amount: 5 }),
        cash("cash_withdrawal", "2025-07-01", 1500),
      ]),
    );

    // 10,000 in, 2,000 spent, 45 dividend, 600 back from the sale, 5 in fees,
    // 1,500 withdrawn.
    expect(result.balance).toBeCloseTo(7140, 6);
    expect(result.solvent).toBe(true);
    expect(result.implied).toBe(0);
  });

  it("subtracts fees from a purchase and adds them to a sale", () => {
    const result = balanceOf(
      portfolio([
        cash("cash_deposit", "2025-01-02", 5000),
        tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100, fees: 7 }),
        tx({ type: "sell", date: "2025-02-05", quantity: 10, price: 100, fees: 7 }),
      ]),
    );

    // The round trip is a wash on price and costs $14 in commission, so the
    // balance has to land $14 below the deposit -- not back at it.
    expect(result.balance).toBeCloseTo(4986, 6);
  });

  it("leaves share transfers alone -- they move stock, not money", () => {
    const result = balanceOf(
      portfolio([
        cash("cash_deposit", "2025-01-02", 1000),
        tx({ type: "transfer_in", date: "2025-02-01", quantity: 10, price: 100 }),
        tx({ type: "transfer_out", date: "2025-03-01", quantity: 4, price: 130 }),
      ]),
    );

    expect(result.balance).toBeCloseTo(1000, 6);
  });

  it("pays for a reinvestment out of the cash it was paid into", () => {
    const result = balanceOf(
      portfolio([
        cash("cash_deposit", "2025-01-02", 500),
        tx({ type: "dividend", date: "2025-03-01", amount: 60 }),
        tx({ type: "reinvest", date: "2025-03-01", quantity: 0.5, price: 120 }),
      ]),
    );

    // A reinvested dividend arrives and leaves on the same day. Counting only
    // the credit is what turns a DRIP account into a pile of phantom cash.
    expect(result.balance).toBeCloseTo(500, 6);
  });

  it("stops at the as-of date instead of counting the future", () => {
    const p = portfolio([
      cash("cash_deposit", "2025-01-02", 1000),
      cash("cash_deposit", "2025-09-01", 5000),
    ]);

    expect(balanceOf(p, "2025-06-30").balance).toBeCloseTo(1000, 6);
    expect(balanceOf(p, "2025-12-31").balance).toBeCloseTo(6000, 6);
  });

  it("keeps each account's cash to itself", () => {
    const p = portfolio([cash("cash_deposit", "2025-01-02", 1000)]);
    p.accounts.push({
      id: "acct-2",
      name: "IRA",
      institution: "",
      type: "roth_ira",
      forecastAccountId: null,
      openingCashBalance: 0,
    });
    p.transactions.push(cash("cash_deposit", "2025-01-02", 7000, "acct-2"));

    const balances = accountCashBalances(p);
    expect(balances.get("acct-1")?.balance).toBeCloseTo(1000, 6);
    expect(balances.get("acct-2")?.balance).toBeCloseTo(7000, 6);
  });

  it("starts from the declared opening balance for a ledger that begins mid-history", () => {
    const result = balanceOf(
      portfolio([tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100 })], 2500),
    );

    // The account opened with $2,500 the ledger does not otherwise mention, so
    // nothing has to be inferred and the purchase simply draws it down.
    expect(result.balance).toBeCloseTo(1500, 6);
    expect(result.implied).toBe(0);
    expect(result.solvent).toBe(true);
  });

  it("tolerates a purchase settling a day ahead of the transfer that paid for it", () => {
    const result = balanceOf(
      portfolio([
        tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100 }),
        cash("cash_deposit", "2025-01-06", 3000),
      ]),
    );

    // Statement dating, not a real overdraft: the $1,000 gap is seeded so the
    // day never reads as negative, and the balance still lands where the
    // account really is once the money clears.
    expect(result.implied).toBeCloseTo(1000, 6);
    expect(result.balance).toBeCloseTo(3000, 6);
    expect(result.solvent).toBe(true);
  });

  it("flags a ledger of trades with no funding in it as unaccounted for", () => {
    const result = balanceOf(
      portfolio([
        tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2025-02-05", quantity: 10, price: 100 }),
      ]),
    );

    // Nothing vouches for the $2,000 these trades spent, so the balance is a
    // deduction rather than a count and the caller is told as much.
    expect(result.solvent).toBe(false);
    expect(result.implied).toBeCloseTo(2000, 6);
  });

  it("never reports a balance the ledger says went negative", () => {
    const result = balanceOf(
      portfolio([
        cash("cash_deposit", "2025-01-02", 100),
        tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100 }),
      ]),
    );

    expect(result.balance).toBeGreaterThanOrEqual(0);
  });
});
