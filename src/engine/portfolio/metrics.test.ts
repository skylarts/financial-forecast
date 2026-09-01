import { describe, expect, it } from "vitest";
import type { Portfolio, Transaction, TransactionType } from "@/domain/portfolio";
import { analyzePortfolio, buildAllocation, buildThemeAllocation, explodeExposures, xirr, type Holding } from "./metrics";

function holding(patch: Partial<Holding> & { symbol: string }): Holding {
  return {
    key: `${patch.accountId ?? "acct-1"}::${patch.symbol}::long`,
    accountId: "acct-1",
    kind: "position",
    name: patch.symbol,
    assetClass: "us_equity",
    exposures: [],
    instrumentType: "other",
    themes: [],
    side: "long",
    quantity: 0,
    costBasis: 0,
    avgCostPerShare: 0,
    price: null,
    priceDate: null,
    marketValue: 0,
    unrealizedGain: 0,
    unrealizedGainPct: null,
    dayChange: null,
    dayChangePct: null,
    weight: 0,
    realizedGain: 0,
    income: 0,
    totalGain: 0,
    irr: null,
    lots: [],
    ...patch,
  };
}

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

/** Money arriving in the account, which is what any cash balance has to start from. */
function deposit(amount: number, accountId = "acct-1"): Transaction {
  return tx({
    type: "cash_deposit",
    date: "2024-01-01",
    accountId,
    symbol: null,
    amount,
  });
}

function portfolio(transactions: Transaction[], overrides: Partial<Portfolio> = {}): Portfolio {
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
        openingCashBalance: 0,
        parentAccountId: null,
        schwabAccountHash: null,
      },
    ],
    transactions,
    securities: [],
    ...overrides,
  };
}

describe("analyzePortfolio", () => {
  it("values a holding at the quoted price and reports unrealized gain", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })]),
      { VTI: { price: 150, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].marketValue).toBe(1500);
    expect(result.holdings[0].costBasis).toBe(1000);
    expect(result.holdings[0].unrealizedGain).toBe(500);
    expect(result.holdings[0].unrealizedGainPct).toBeCloseTo(0.5, 6);
    expect(result.summary.totalValue).toBe(1500);
  });

  it("weights positions against the total in scope", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "VXUS" }),
      ]),
      { VTI: { price: 300, date: "2026-08-03" }, VXUS: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    const vti = result.holdings.find((h) => h.symbol === "VTI");
    const vxus = result.holdings.find((h) => h.symbol === "VXUS");
    expect(vti?.weight).toBeCloseTo(0.75, 6);
    expect(vxus?.weight).toBeCloseTo(0.25, 6);
    expect(result.holdings.reduce((sum, h) => sum + h.weight, 0)).toBeCloseTo(1, 6);
  });

  it("splits realized gains into short and long term", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2023-01-10", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2026-01-10", quantity: 10, price: 100 }),
        tx({ type: "sell", date: "2026-06-10", quantity: 20, price: 150 }),
      ]),
      {},
      { asOf: "2026-08-04" },
    );

    expect(result.summary.realizedLongTerm).toBeCloseTo(500, 6);
    expect(result.summary.realizedShortTerm).toBeCloseTo(500, 6);
    expect(result.summary.realizedGain).toBeCloseTo(1000, 6);
    expect(result.summary.realizedGainYtd).toBeCloseTo(1000, 6);
  });

  it("measures a day move against the quote's previous close", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })]),
      { VTI: { price: 150, date: "2026-08-03", previousClose: 140 } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].dayChange).toBeCloseTo(100, 6);
    expect(result.holdings[0].dayChangePct).toBeCloseTo(150 / 140 - 1, 6);
    expect(result.summary.dayChange).toBeCloseTo(100, 6);
    expect(result.summary.dayChangePct).toBeCloseTo(150 / 140 - 1, 6);
  });

  it("reports no day move at all when the feed gave no previous close", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })]),
      { VTI: { price: 150, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    // Null rather than zero: an unmoved position and an unmeasurable one are
    // different answers and must not print the same.
    expect(result.holdings[0].dayChange).toBeNull();
    expect(result.summary.dayChange).toBeNull();
    expect(result.summary.dayChangePct).toBeNull();
  });

  it("measures the portfolio's day move against only what it could price", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "VXUS" }),
      ]),
      {
        VTI: { price: 110, date: "2026-08-03", previousClose: 100 },
        VXUS: { price: 500, date: "2026-08-03" },
      },
      { asOf: "2026-08-04" },
    );

    // VXUS moved the portfolio too, but nothing says by how much. Its $5,000
    // must stay out of the denominator or the 10% move on VTI reads as 1.8%.
    expect(result.summary.dayChange).toBeCloseTo(100, 6);
    expect(result.summary.dayChangePct).toBeCloseTo(0.1, 6);
  });

  it("gains on a short when the price falls", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "short_sell", date: "2024-01-10", quantity: 10, price: 100 })]),
      { VTI: { price: 90, date: "2026-08-03", previousClose: 100 } },
      { asOf: "2026-08-04" },
    );

    // The proceeds land as a cash row that outranks a liability by value, so
    // the position is found rather than taken from the top.
    const position = result.holdings.find((h) => h.kind === "position");
    expect(position?.side).toBe("short");
    expect(position?.dayChange).toBeCloseTo(100, 6);
  });

  it("counts this year's dividends as YTD income even from a position since sold", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
        tx({ type: "dividend", date: "2025-04-10", amount: 30 }),
        tx({ type: "dividend", date: "2026-04-10", amount: 40 }),
        tx({ type: "interest", date: "2026-05-10", symbol: null, amount: 2 }),
        tx({ type: "sell", date: "2026-06-10", quantity: 10, price: 120 }),
      ]),
      {},
      { asOf: "2026-08-04" },
    );

    // The shares are gone, so no holding carries this income any more -- but
    // the money still arrived this year.
    expect(result.holdings.filter((h) => h.kind === "position")).toHaveLength(0);
    expect(result.summary.incomeYtd).toBeCloseTo(42, 6);
    // And lifetime income has to count the 2025 dividend too, which incomeYtd
    // correctly leaves out -- summing from `holdings` instead would drop all
    // three, since no holding survives to carry any of them.
    expect(result.summary.income).toBeCloseTo(72, 6);
  });

  it("counts dividends as income without touching share count", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
        tx({ type: "dividend", date: "2024-04-10", amount: 42 }),
      ]),
      { VTI: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].quantity).toBe(10);
    expect(result.holdings[0].income).toBe(42);
    expect(result.summary.income).toBe(42);
  });

  it("falls back to cost basis when a symbol has no quote, keeping weights whole", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })]),
      {},
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].price).toBeNull();
    expect(result.holdings[0].marketValue).toBe(1000);
    expect(result.holdings[0].unrealizedGain).toBe(0);
    expect(result.holdings[0].weight).toBeCloseTo(1, 6);
  });

  it("prefers a manual price over the quote feed", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 })], {
        securities: [
          {
            symbol: "VTI",
            name: "Total Market",
            assetClass: "us_equity",
            assetClassSource: "manual",
            exposures: [],
            instrumentType: "other",
            instrumentTypeSource: "manual",
            themes: [],
            manualPrice: 200,
            manualPriceDate: "2026-08-01",
            lastKnownPrice: null,
            lastKnownPriceDate: null,
            profileCheckedAt: null,
          },
        ],
      }),
      { VTI: { price: 150, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].price).toBe(200);
    expect(result.holdings[0].marketValue).toBe(2000);
    expect(result.holdings[0].assetClass).toBe("us_equity");
  });

  it("narrows every figure to the accounts in scope", () => {
    const base = portfolio([
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, accountId: "acct-2" }),
    ]);
    base.accounts.push({
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
    // $1,500 in, $1,000 spent on the position: the $500 left is the cash.
    base.transactions.push(deposit(1500, "acct-2"));

    const scoped = analyzePortfolio(base, { VTI: { price: 100, date: "2026-08-03" } }, {
      accountIds: ["acct-2"],
      asOf: "2026-08-04",
    });

    // The position plus that account's cash; the other account contributes
    // neither.
    expect(scoped.holdings).toHaveLength(2);
    expect(scoped.holdings.filter((h) => h.kind === "position")).toHaveLength(1);
    expect(scoped.summary.marketValue).toBe(1000);
    expect(scoped.summary.cash).toBe(500);
    expect(scoped.summary.totalValue).toBe(1500);
  });

  it("carries uninvested cash as its own holding, weighted with everything else", () => {
    const base = portfolio([
      deposit(1250),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
    ]);

    const result = analyzePortfolio(base, { VTI: { price: 75, date: "2026-08-03" } }, {
      asOf: "2026-08-04",
    });

    const cash = result.holdings.find((h) => h.kind === "cash");
    expect(cash).toMatchObject({ symbol: "$CASH", assetClass: "cash", marketValue: 250 });

    // $750 of stock and $250 of cash: a quarter of the portfolio is uninvested,
    // and the weights have to say so or the allocation view is fiction.
    expect(cash?.weight).toBeCloseTo(0.25, 6);
    expect(result.holdings.find((h) => h.kind === "position")?.weight).toBeCloseTo(0.75, 6);
    expect(result.holdings.reduce((sum, h) => sum + h.weight, 0)).toBeCloseTo(1, 6);
  });

  it("keeps cash out of every return figure it would dilute", () => {
    const base = portfolio([
      deposit(10000),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
    ]);

    const result = analyzePortfolio(base, { VTI: { price: 150, date: "2026-08-03" } }, {
      asOf: "2026-08-04",
    });

    // A $1,000 position now worth $1,500 returned 50%, whether or not there is
    // idle cash sitting beside it. Letting the balance into the basis would
    // report that same position as having returned 5%.
    expect(result.summary.costBasis).toBe(1000);
    expect(result.summary.unrealizedGain).toBe(500);
    expect(result.summary.unrealizedGainPct).toBeCloseTo(0.5, 6);
    expect(result.summary.marketValue).toBe(1500);
    expect(result.summary.totalValue).toBe(10500);
  });

  it("skips accounts holding no cash rather than listing empty rows", () => {
    // Every dollar deposited went into the position, so there is no cash row.
    const base = portfolio([
      deposit(1000),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
    ]);

    const result = analyzePortfolio(base, { VTI: { price: 100, date: "2026-08-03" } }, {
      asOf: "2026-08-04",
    });

    expect(result.holdings.filter((h) => h.kind === "cash")).toHaveLength(0);
  });

  it("groups allocation by asset class", () => {
    const result = analyzePortfolio(
      portfolio(
        [
          tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
          tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "BND" }),
        ],
        {
          securities: [
            { symbol: "VTI", name: "", assetClass: "us_equity", assetClassSource: "manual", exposures: [], instrumentType: "other", instrumentTypeSource: "manual", themes: [], manualPrice: null, manualPriceDate: null, lastKnownPrice: null, lastKnownPriceDate: null, profileCheckedAt: null },
            { symbol: "BND", name: "", assetClass: "bond", assetClassSource: "manual", exposures: [], instrumentType: "other", instrumentTypeSource: "manual", themes: [], manualPrice: null, manualPriceDate: null, lastKnownPrice: null, lastKnownPriceDate: null, profileCheckedAt: null },
          ],
        },
      ),
      { VTI: { price: 300, date: "2026-08-03" }, BND: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(result.byAssetClass[0]).toMatchObject({ label: "us_equity", value: 3000 });
    expect(result.byAssetClass[1]).toMatchObject({ label: "bond", value: 1000 });
    expect(result.byAssetClass[0].weight).toBeCloseTo(0.75, 6);
  });

  it("splits a multi-class holding's allocation across every class it spans", () => {
    const result = analyzePortfolio(
      portfolio(
        [
          tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "VT" }),
          tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100, symbol: "BND" }),
        ],
        {
          securities: [
            {
              symbol: "VT",
              name: "",
              assetClass: "intl_equity",
              assetClassSource: "manual",
              exposures: [
                { assetClass: "us_equity", weight: 0.6 },
                { assetClass: "intl_equity", weight: 0.4 },
              ],
              instrumentType: "etf",
              instrumentTypeSource: "manual",
              themes: [],
              manualPrice: null,
              manualPriceDate: null,
              lastKnownPrice: null,
              lastKnownPriceDate: null,
              profileCheckedAt: null,
            },
            {
              symbol: "BND",
              name: "",
              assetClass: "bond",
              assetClassSource: "manual",
              exposures: [],
              instrumentType: "other",
              instrumentTypeSource: "manual",
              themes: [],
              manualPrice: null,
              manualPriceDate: null,
              lastKnownPrice: null,
              lastKnownPriceDate: null,
              profileCheckedAt: null,
            },
          ],
        },
      ),
      { VT: { price: 100, date: "2026-08-03" }, BND: { price: 100, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    // $1000 of VT splits 600/400, plus $1000 of BND, all single-class.
    const byLabel = new Map(result.byAssetClass.map((s) => [s.label, s]));
    expect(byLabel.get("us_equity")?.value).toBe(600);
    expect(byLabel.get("intl_equity")?.value).toBe(400);
    expect(byLabel.get("bond")?.value).toBe(1000);
    // The exploded rows still sum to the portfolio's real total -- nothing is
    // invented or lost by splitting a holding across classes.
    const total = result.byAssetClass.reduce((sum, s) => sum + s.value, 0);
    expect(total).toBe(2000);
  });

  it("renormalizes an allocation when cash is excluded", () => {
    const base = portfolio([
      deposit(2000),
      tx({ type: "buy", date: "2024-01-10", quantity: 10, price: 100 }),
    ]);

    const { holdings } = analyzePortfolio(base, { VTI: { price: 100, date: "2026-08-03" } }, {
      asOf: "2026-08-04",
    });

    const withCash = buildAllocation(holdings, (h) => h.assetClass);
    expect(withCash.find((s) => s.label === "cash")?.weight).toBeCloseTo(0.5, 6);

    // Cash gone, the remaining half is the whole of what's invested -- reporting
    // it as 50% of nothing in particular would answer neither question.
    const withoutCash = buildAllocation(holdings, (h) => h.assetClass, { includeCash: false });
    expect(withoutCash).toHaveLength(1);
    expect(withoutCash[0].weight).toBeCloseTo(1, 6);
    expect(withoutCash[0].value).toBe(1000);
  });
});

describe("short positions", () => {
  const shorted = () =>
    portfolio([
      tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      tx({ type: "buy_to_cover", date: "2025-06-01", quantity: 40, price: 30 }),
    ]);

  /**
   * The security row. Shorting pays proceeds into the account, so these ledgers
   * carry a cash row too -- and it outranks a liability in the value ordering,
   * which is why the position is found rather than taken from the top.
   */
  const position = (result: ReturnType<typeof analyzePortfolio>) =>
    result.holdings.filter((h) => h.kind === "position");

  it("values the open short as a liability", () => {
    const result = analyzePortfolio(
      shorted(),
      { VTI: { price: 20, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(position(result)[0].side).toBe("short");
    expect(position(result)[0].quantity).toBe(60);
    expect(position(result)[0].marketValue).toBe(-1200);
    expect(result.summary.marketValue).toBe(-1200);
  });

  it("holds the proceeds of a short as cash in the account", () => {
    const result = analyzePortfolio(
      shorted(),
      { VTI: { price: 20, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    // $5,000 came in shorting 100 at $50; covering 40 at $30 paid $1,200 back
    // out. Those dollars are really sitting in the account, and the ledger is
    // the only thing that knows it.
    expect(result.summary.cash).toBe(3800);
  });

  it("gains as the price falls below the proceeds it opened at", () => {
    const result = analyzePortfolio(
      shorted(),
      { VTI: { price: 20, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    // 60 shares shorted at $50 brought in $3,000; covering now would cost $1,200.
    expect(position(result)[0].costBasis).toBe(3000);
    expect(position(result)[0].unrealizedGain).toBe(1800);
  });

  it("realizes the spread between the short price and the cover price", () => {
    const result = analyzePortfolio(shorted(), {}, { asOf: "2026-08-04" });

    expect(result.summary.realizedGain).toBe(800);
  });

  it("reports no annualized return for a short rather than a misleading one", () => {
    const result = analyzePortfolio(
      shorted(),
      { VTI: { price: 20, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    // A short commits no capital, so there is nothing to compute a return on --
    // and on raw flows this profitable position would report a large negative.
    expect(position(result)[0].irr).toBeNull();
    expect(position(result)[0].unrealizedGainPct).toBeCloseTo(0.6, 6);
  });

  it("keeps a long and a short in the same symbol as separate positions", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2025-01-01", quantity: 10, price: 100 }),
        tx({ type: "short_sell", date: "2025-02-01", quantity: 100, price: 50 }),
      ]),
      { VTI: { price: 40, date: "2026-08-03" } },
      { asOf: "2026-08-04" },
    );

    expect(position(result)).toHaveLength(2);
    const long = position(result).find((h) => h.side === "long");
    const short = position(result).find((h) => h.side === "short");
    expect(long?.marketValue).toBe(400);
    expect(short?.marketValue).toBe(-4000);
    expect(result.summary.marketValue).toBe(-3600);
  });
});

describe("the portfolio's annualized return", () => {
  /** A clean doubling over exactly one year, funded by a deposit that covers it. */
  const doubled = portfolio([
    deposit(2_000),
    tx({ type: "buy", date: "2025-08-04", quantity: 10, price: 100 }),
  ]);

  it("reads the return on what was invested, not on what was deposited", () => {
    const result = analyzePortfolio(doubled, { VTI: { price: 200, date: "2026-08-04" } }, {
      asOf: "2026-08-04",
    });
    expect(result.summary.irr).toBeCloseTo(1, 2);
  });

  it("ignores idle cash instead of crediting the positions with it", () => {
    const withMoreCash = portfolio([
      deposit(50_000),
      tx({ type: "buy", date: "2025-08-04", quantity: 10, price: 100 }),
    ]);
    const lean = analyzePortfolio(doubled, { VTI: { price: 200, date: "2026-08-04" } }, {
      asOf: "2026-08-04",
    });
    const cashHeavy = analyzePortfolio(withMoreCash, { VTI: { price: 200, date: "2026-08-04" } }, {
      asOf: "2026-08-04",
    });
    // The same trade, the same result -- the extra $48,000 sitting in cash was
    // never invested and says nothing about how the investment did.
    expect(cashHeavy.summary.irr).toBeCloseTo(lean.summary.irr ?? 0, 6);
  });

  it("still reports nothing when there is no trade to measure", () => {
    const cashOnly = analyzePortfolio(portfolio([deposit(10_000)]), {}, { asOf: "2026-08-04" });
    expect(cashOnly.summary.irr).toBeNull();
  });
});

describe("xirr", () => {
  it("solves a clean doubling over one year", () => {
    const rate = xirr([
      { date: "2025-01-01", amount: -1000 },
      { date: "2026-01-01", amount: 2000 },
    ]);
    expect(rate).toBeCloseTo(1, 3);
  });

  it("counts the extra day in a leap year rather than assuming a flat 365", () => {
    const rate = xirr([
      { date: "2024-01-01", amount: -1000 },
      { date: "2025-01-01", amount: 2000 },
    ]);
    expect(rate).toBeCloseTo(2 ** (365 / 366) - 1, 4);
  });

  it("solves a flat return as zero", () => {
    const rate = xirr([
      { date: "2024-01-01", amount: -1000 },
      { date: "2025-01-01", amount: 1000 },
    ]);
    expect(rate).toBeCloseTo(0, 5);
  });

  it("returns null when the flows never change sign", () => {
    expect(
      xirr([
        { date: "2024-01-01", amount: -1000 },
        { date: "2025-01-01", amount: -500 },
      ]),
    ).toBeNull();
  });
});

describe("option contracts", () => {
  const CONTRACT = "AAPL260918C00250000";

  it("values a contract at 100 shares per unit", () => {
    // Two contracts bought at a $40.00 premium: $8,000 of cost, and at a $60.77
    // premium they are worth $12,154 -- not $121.54.
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2026-07-01", symbol: CONTRACT, quantity: 2, price: 40 }),
      ]),
      { [CONTRACT]: { price: 60.77, date: "2026-08-04" } },
      { asOf: "2026-08-04" },
    );

    const holding = result.holdings[0];
    expect(holding.costBasis).toBe(8000);
    expect(holding.marketValue).toBeCloseTo(12154, 6);
    expect(holding.unrealizedGain).toBeCloseTo(4154, 6);
  });

  it("keeps average cost comparable to the quoted premium", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2026-07-01", symbol: CONTRACT, quantity: 2, price: 40 }),
      ]),
      { [CONTRACT]: { price: 60.77, date: "2026-08-04" } },
      { asOf: "2026-08-04" },
    );

    // Per-share premium, matching how `price` reads -- not $4,000 per contract.
    expect(result.holdings[0].avgCostPerShare).toBeCloseTo(40, 6);
  });

  it("names an unpriced contract readably instead of showing raw OCC", () => {
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2026-07-01", symbol: CONTRACT, quantity: 1, price: 40 }),
      ]),
      {},
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].name).toBe("AAPL Sep 18 2026 250 Call");
  });

  it("leaves ordinary shares on a multiplier of one", () => {
    const result = analyzePortfolio(
      portfolio([tx({ type: "buy", date: "2026-07-01", quantity: 10, price: 100 })]),
      { VTI: { price: 150, date: "2026-08-04" } },
      { asOf: "2026-08-04" },
    );

    expect(result.holdings[0].marketValue).toBe(1500);
    expect(result.holdings[0].avgCostPerShare).toBe(100);
  });

  it("books a contract's cash flow in dollars when the statement omits an amount", () => {
    // A sale with no explicit amount has to derive $12,154, not $121.54, or the
    // cash balance drifts by a factor of a hundred on every option trade.
    const result = analyzePortfolio(
      portfolio([
        tx({ type: "buy", date: "2026-07-01", symbol: CONTRACT, quantity: 2, price: 40 }),
        tx({ type: "sell", date: "2026-08-01", symbol: CONTRACT, quantity: 2, price: 60.77 }),
      ]),
      {},
      { asOf: "2026-08-04" },
    );

    expect(result.summary.realizedGain).toBeCloseTo(4154, 6);
  });
});

describe("explodeExposures", () => {
  it("passes a single-class holding through as one row, unchanged", () => {
    const h = holding({ symbol: "VTI", marketValue: 1000, costBasis: 800, unrealizedGain: 200, weight: 0.5 });
    const rows = explodeExposures([h]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetClass: "us_equity", exposureCount: 1, exposureWeight: 1, marketValue: 1000 });
    expect(rows[0].source).toBe(h);
  });

  it("splits a multi-class holding's dollar figures proportionally", () => {
    const h = holding({
      symbol: "VT",
      assetClass: "intl_equity",
      exposures: [
        { assetClass: "us_equity", weight: 0.6 },
        { assetClass: "intl_equity", weight: 0.4 },
      ],
      marketValue: 1000,
      costBasis: 800,
      unrealizedGain: 200,
      weight: 0.5,
    });
    const rows = explodeExposures([h]);
    expect(rows).toHaveLength(2);
    const us = rows.find((r) => r.exposureClass === "us_equity")!;
    const intl = rows.find((r) => r.exposureClass === "intl_equity")!;
    expect(us).toMatchObject({ marketValue: 600, costBasis: 480, unrealizedGain: 120, weight: 0.3, exposureCount: 2 });
    expect(intl).toMatchObject({ marketValue: 400, costBasis: 320, unrealizedGain: 80, weight: 0.2, exposureCount: 2 });
    // Splitting keys them uniquely, and both point back to the real holding.
    expect(us.key).not.toBe(intl.key);
    expect(us.source).toBe(h);
    expect(intl.source).toBe(h);
    // Per-share figures describe the whole position, not a slice of it.
    expect(us.quantity).toBe(h.quantity);
  });
});

describe("buildThemeAllocation", () => {
  it("puts an untagged holding in its own bucket", () => {
    const slices = buildThemeAllocation([holding({ symbol: "VTI", marketValue: 1000 })]);
    expect(slices).toEqual([{ label: "Untagged", value: 1000, weight: 1 }]);
  });

  it("counts a holding tagged more than once at full value in each of its tags", () => {
    const h = holding({ symbol: "VT", themes: ["Core", "Global"], marketValue: 1000 });
    const other = holding({ symbol: "BND", themes: ["Core"], marketValue: 500, accountId: "acct-1" });
    const slices = buildThemeAllocation([h, other]);
    const byLabel = new Map(slices.map((s) => [s.label, s]));
    // Core sums both holdings; Global only the one. The two aren't required
    // to sum to the portfolio total the way a partition would.
    expect(byLabel.get("Core")?.value).toBe(1500);
    expect(byLabel.get("Global")?.value).toBe(1000);
    expect(byLabel.get("Global")?.weight).toBeCloseTo(1000 / 1500, 6);
  });
});
