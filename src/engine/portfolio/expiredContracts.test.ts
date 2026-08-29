import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction, TransactionType } from "@/domain/portfolio";
import { analyzePortfolio } from "./metrics";

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

function portfolio(transactions: Transaction[]): Portfolio {
  return {
    id: "p1",
    accounts: [
      {
        id: "acct-1",
        name: "Schwab",
        institution: "",
        type: "taxable",
        forecastAccountId: null,
        syncToForecast: true,
        ownerId: null,
        openingCashBalance: 0,
        parentAccountId: null,
        schwabAccountHash: null,
      },
    ],
    transactions,
    securities: [],
  };
}

/** Expired 2026-09-18; "today" in these tests is well past it. */
const CALL_250 = "AAPL260918C00250000";
const PUT_250 = "AAPL260918P00250000";
const TODAY = "2026-11-01";

describe("finding contracts left open past expiry", () => {
  it("flags a contract still open after its expiry date", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 2, price: 4 })]),
      {},
      { asOf: TODAY },
    );

    expect(expiredContracts).toHaveLength(1);
    expect(expiredContracts[0].symbol).toBe(CALL_250);
    expect(expiredContracts[0].quantity).toBe(2);
    expect(expiredContracts[0].strike).toBe(250);
    expect(expiredContracts[0].expiry).toBe("2026-09-18");
  });

  it("leaves a contract alone until its expiry has actually passed", () => {
    const held = portfolio([
      tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 }),
    ]);

    expect(analyzePortfolio(held, {}, { asOf: "2026-09-17" }).expiredContracts).toHaveLength(0);
    expect(analyzePortfolio(held, {}, { asOf: "2026-09-18" }).expiredContracts).toHaveLength(0);
    expect(analyzePortfolio(held, {}, { asOf: "2026-09-19" }).expiredContracts).toHaveLength(1);
  });

  it("says nothing once the closing event is recorded", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 }),
        tx({ type: "option_expire", date: "2026-09-18", symbol: CALL_250, quantity: 1 }),
      ]),
      {},
      { asOf: TODAY },
    );

    expect(expiredContracts).toHaveLength(0);
  });

  it("never flags ordinary shares", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2020-01-01", symbol: "AAPL", quantity: 100, price: 100 })]),
      { AAPL: { price: 309, date: TODAY } },
      { asOf: TODAY },
    );

    expect(expiredContracts).toHaveLength(0);
  });
});

describe("inferring what actually happened", () => {
  it("suggests exercise for a long call that finished in the money", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 })]),
      { AAPL: { price: 309, date: TODAY } },
      { asOf: TODAY },
    );

    expect(expiredContracts[0].outcome).toBe("settled");
    expect(expiredContracts[0].suggestedType).toBe("option_exercise");
  });

  it("suggests assignment for a written call that finished in the money", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([
        tx({ type: "short_sell", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 }),
      ]),
      { AAPL: { price: 309, date: TODAY } },
      { asOf: TODAY },
    );

    expect(expiredContracts[0].side).toBe("short");
    expect(expiredContracts[0].suggestedType).toBe("option_assign");
  });

  it("suggests a worthless expiry for a call that finished below its strike", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 })]),
      { AAPL: { price: 210, date: TODAY } },
      { asOf: TODAY },
    );

    expect(expiredContracts[0].outcome).toBe("worthless");
    expect(expiredContracts[0].suggestedType).toBe("option_expire");
  });

  it("reads a put the opposite way to a call", () => {
    const inTheMoney = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: PUT_250, quantity: 1, price: 4 })]),
      { AAPL: { price: 210, date: TODAY } },
      { asOf: TODAY },
    );
    const outOfTheMoney = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: PUT_250, quantity: 1, price: 4 })]),
      { AAPL: { price: 309, date: TODAY } },
      { asOf: TODAY },
    );

    // A put pays off when the stock falls, so the same prices flip the verdict.
    expect(inTheMoney.expiredContracts[0].outcome).toBe("settled");
    expect(outOfTheMoney.expiredContracts[0].outcome).toBe("worthless");
  });

  it("treats a finish exactly at the strike as worthless", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 })]),
      { AAPL: { price: 250, date: TODAY } },
      { asOf: TODAY },
    );

    // There is nothing to gain by exercising at the strike.
    expect(expiredContracts[0].outcome).toBe("worthless");
  });

  it("suggests nothing when the underlying has no quote", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", symbol: CALL_250, quantity: 1, price: 4 })]),
      {},
      { asOf: TODAY },
    );

    // Guessing wrong here misstates both the amount and the tax year, so the
    // choice stays with whoever is holding the statement.
    expect(expiredContracts[0].outcome).toBe("unknown");
    expect(expiredContracts[0].suggestedType).toBeNull();
    expect(expiredContracts[0].underlyingPrice).toBeNull();
  });
});

describe("ordering", () => {
  it("puts the longest-overdue contract first", () => {
    const { expiredContracts } = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2026-01-02", symbol: "AAPL260918C00250000", quantity: 1, price: 4 }),
        tx({ type: "buy", date: "2026-01-02", symbol: "AAPL260320C00250000", quantity: 1, price: 4 }),
      ]),
      {},
      { asOf: TODAY },
    );

    expect(expiredContracts.map((c) => c.expiry)).toEqual(["2026-03-20", "2026-09-18"]);
  });
});
