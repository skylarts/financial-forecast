import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction, TransactionType } from "@/domain/portfolio";
import { accountCashBalances, replayableCash } from "./cash";

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
        syncToForecast: true,
        ownerId: null,
        openingCashBalance: opening,
        parentAccountId: null,
        schwabAccountHash: null,
      },
    ],
    transactions,
    securities: [],
    baskets: [],
    statementValuations: [],
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
      syncToForecast: true,
      ownerId: null,
      openingCashBalance: 0,
      parentAccountId: null,
      schwabAccountHash: null,
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

  it("reports a balance that really did go negative, once the account was funded", () => {
    const result = balanceOf(
      portfolio([
        cash("cash_deposit", "2025-01-02", 100),
        tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100 }),
      ]),
    );

    // The ledger watched $100 arrive and then $1,000 go out, so the account was
    // $900 down -- a margin balance, or a trade the cash side has yet to catch
    // up with. Seeding it away would say the account opened with $900 nobody
    // recorded, and would apply that to every day of its history.
    expect(result.balance).toBeCloseTo(-900, 6);
    expect(result.implied).toBe(0);
    expect(result.solvent).toBe(true);
    expect(result.overdraft).toBeCloseTo(900, 6);
    expect(result.overdraftOn).toBe("2025-01-05");
  });

  it("still seeds a deficit that lands before the ledger records any funding", () => {
    // The distinction that matters: this one is an export beginning mid-history,
    // so the money really is missing from the record rather than from the account.
    const result = balanceOf(
      portfolio([
        tx({ type: "buy", date: "2025-01-05", quantity: 10, price: 100 }),
        cash("cash_deposit", "2025-01-06", 3000),
      ]),
    );

    expect(result.implied).toBeCloseTo(1000, 6);
    expect(result.balance).toBeCloseTo(3000, 6);
    expect(result.overdraft).toBe(0);
  });

  it("keeps a brief overdraft out of every other day in the account's history", () => {
    // The real case this was written for: $200 of transfer fees charged the day
    // before the sale that covered them. Seeding the gap used to lift the whole
    // history, so a balance five years earlier read $200 richer than the
    // statement for that month said it was.
    const p = portfolio([
      cash("cash_deposit", "2021-03-30", 5000),
      tx({ type: "buy", date: "2021-04-01", quantity: 10, price: 490 }),
      cash("cash_withdrawal", "2025-12-08", 200),
      tx({ type: "sell", date: "2025-12-09", quantity: 10, price: 800 }),
    ]);

    expect(balanceOf(p, "2021-03-31").balance).toBeCloseTo(5000, 6);
    expect(balanceOf(p, "2025-12-08").balance).toBeCloseTo(-100, 6);
    expect(balanceOf(p).overdraft).toBeCloseTo(100, 6);
  });
});

describe("replayableCash", () => {
  it("reports a floor of exactly zero for a ledger that only nets to zero via float-noisy amounts", () => {
    // 3,000 additions of 0.1 land on 299.9999999999997 in plain floating-
    // point arithmetic -- a real drift below the mathematically exact 300,
    // not a contrived value. Left unrounded, the running balance dips a
    // hair below zero at the withdrawal that should have zeroed it exactly,
    // and that sliver used to be reported as an implied opening balance the
    // account never actually needed.
    const deposits = Array.from({ length: 3000 }, () => cash("cash_deposit", "2015-01-01", 0.1));
    const rows = [...deposits, cash("cash_withdrawal", "2015-01-02", 300)];

    expect(replayableCash(rows, 0)).toEqual({
      solvent: true,
      floor: 0,
      overdraft: 0,
      overdraftOn: null,
    });
  });
});
