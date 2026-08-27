import type { Account, ISODate, Id, Person } from "@/domain";
import type {
  Portfolio,
  PortfolioAccount,
  PortfolioAccountType,
  Security,
  Transaction,
  TransactionType,
} from "@/domain/portfolio";

/**
 * A fictional but fully-formed ledger, for looking at the tracker with
 * something in it.
 *
 * Every panel here reads differently against an empty portfolio than against a
 * real one -- grouping, subtotals, realized gains, the performance chart, the
 * allocation split -- so reviewing a change used to mean typing a plausible
 * ledger by hand first, and typing a *different* one next time. This is that
 * ledger, written once.
 *
 * It is built against the plan actually loaded, not against fixed ids: the
 * accounts come out owned by the household's real people and linked to their
 * real forecast accounts, which is the only way the Accounts tab's side-by-side
 * comparison shows anything. Nothing is written back to the forecast -- the
 * demo accounts link, but they don't sync (see `syncToForecast` below), so
 * loading this can't overwrite a starting balance somebody meant to keep.
 *
 * Real tickers, so quotes resolve and today's figures move on their own.
 * Fictional trades, in round numbers that are obviously not anyone's.
 */

/** Every symbol the demo ledger touches, with the classification it demos. */
const SECURITIES: readonly Security[] = [
  security("VTI", "Vanguard Total Stock Market ETF", "us_equity", "etf", ["Core"]),
  security("VXUS", "Vanguard Total International Stock ETF", "intl_equity", "etf", ["Core"]),
  {
    // The reason the class grouping exists: one fund whose money is not all in
    // one class, so "By class" has something to actually split.
    ...security("VT", "Vanguard Total World Stock ETF", "us_equity", "etf", ["Core", "Global"]),
    exposures: [
      { assetClass: "us_equity", weight: 0.62 },
      { assetClass: "intl_equity", weight: 0.38 },
    ],
  },
  security("BND", "Vanguard Total Bond Market ETF", "bond", "etf", ["Income"]),
  security("SCHD", "Schwab US Dividend Equity ETF", "us_equity", "etf", ["Income", "Dividend growth"]),
  security("VNQ", "Vanguard Real Estate ETF", "real_estate", "etf", ["Income"]),
  security("NVDA", "NVIDIA Corporation", "us_equity", "stock", ["AI"]),
  security("MSFT", "Microsoft Corporation", "us_equity", "stock", ["AI", "Dividend growth"]),
  security("IBIT", "iShares Bitcoin Trust", "crypto", "etf", ["Speculative"]),
];

function security(
  symbol: string,
  name: string,
  assetClass: Security["assetClass"],
  instrumentType: Security["instrumentType"],
  themes: string[],
): Security {
  return {
    symbol,
    name,
    assetClass,
    assetClassSource: "manual",
    exposures: [],
    instrumentType,
    instrumentTypeSource: "manual",
    themes,
    manualPrice: null,
    manualPriceDate: null,
    lastKnownPrice: null,
    lastKnownPriceDate: null,
  };
}

/**
 * Which forecast tax treatment a portfolio account of this type feeds. Used to
 * pair the two sides up when the names don't match.
 */
const TREATMENT_OF: Record<string, Account["taxTreatment"]> = {
  taxable: "taxable",
  traditional_401k: "tax_deferred",
  traditional_ira: "tax_deferred",
  roth_ira: "tax_free",
  roth_401k: "tax_free",
  hsa: "tax_free",
};

/**
 * The forecast account a demo account should point at.
 *
 * Name first, since a household that already tracks "Alex Roth IRA" on both
 * sides means the same account by it. Falling back to owner and tax treatment
 * covers the plans that don't use these names at all, which is every real one.
 */
function matchForecastAccount(
  forecastAccounts: readonly Account[],
  name: string,
  ownerId: Id | null,
  type: PortfolioAccountType,
): Id | null {
  const assets = forecastAccounts.filter((a) => a.category === "asset");
  const byName = assets.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName.id;

  const treatment = TREATMENT_OF[type];
  const byOwner = assets.find((a) => a.ownerId === ownerId && a.taxTreatment === treatment);
  return byOwner?.id ?? null;
}

/**
 * Dates are anchored to the year the demo is loaded in, not hardcoded, so the
 * "realized this year" tiles and the year-to-date figures always have something
 * in them however long from now this runs.
 */
function yearsAgo(today: ISODate, years: number, monthDay: string): ISODate {
  return `${Number(today.slice(0, 4)) - years}-${monthDay}`;
}

interface TxSeed {
  date: ISODate;
  type: TransactionType;
  symbol?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  fees?: number;
  acquiredDate?: ISODate;
  note?: string;
}

function transactionsFor(accountId: Id, seeds: readonly TxSeed[], prefix: string): Transaction[] {
  return seeds.map((seed, i) => ({
    id: `${prefix}-${i + 1}`,
    accountId,
    date: seed.date,
    type: seed.type,
    symbol: seed.symbol ?? null,
    quantity: seed.quantity ?? 0,
    price: seed.price ?? 0,
    amount: seed.amount ?? null,
    fees: seed.fees ?? 0,
    // Left for the store to assign: it draws sale lots oldest-first, which is
    // the same thing a real ledger does when a statement doesn't say.
    lotId: null,
    acquiredDate: seed.acquiredDate ?? null,
    spinoffSymbol: null,
    spinoffShareRatio: null,
    spinoffBasisRetained: null,
    note: seed.note ?? "",
    importBatchId: null,
    sourceHash: null,
  }));
}

/**
 * The demo ledger, built against the household actually loaded.
 *
 * `people[0]` and `people[1]` stand in for the two earners; a one-person
 * household simply gets the accounts that belong to the person it has, and the
 * joint brokerage. Ids are fixed strings rather than generated, so loading the
 * demo twice replaces it rather than doubling it.
 */
export function buildDemoPortfolio(
  people: readonly Person[],
  forecastAccounts: readonly Account[],
  today: ISODate,
): Portfolio {
  const first = people[0] ?? null;
  const second = people[1] ?? first;

  const account = (
    id: Id,
    name: string,
    type: PortfolioAccountType,
    ownerId: Id | null,
    institution: string,
  ): PortfolioAccount => ({
    id,
    name,
    institution,
    type,
    forecastAccountId: matchForecastAccount(forecastAccounts, name, ownerId, type),
    // Linked but not syncing: the demo's fictional balances have no business
    // overwriting a real plan's starting balances just because somebody had a
    // look at the tracker. Turn it on per account to watch the push work.
    syncToForecast: false,
    ownerId,
    openingCashBalance: 0,
  });

  const accounts: PortfolioAccount[] = [
    account("demo-joint-brokerage", "Joint Brokerage", "taxable", null, "Fidelity"),
  ];
  if (first) {
    accounts.push(
      account("demo-first-401k", `${first.name} 401(k)`, "traditional_401k", first.id, "Empower"),
      account("demo-first-roth", `${first.name} Roth IRA`, "roth_ira", first.id, "Vanguard"),
    );
  }
  if (second && second !== first) {
    accounts.push(
      account("demo-second-401k", `${second.name} 401(k)`, "traditional_401k", second.id, "Fidelity"),
    );
  }

  const transactions = [
    ...transactionsFor("demo-joint-brokerage", jointBrokerageLedger(today), "demo-jb"),
    ...(first ? transactionsFor("demo-first-401k", firstFourOhOneKLedger(today), "demo-f4") : []),
    ...(first ? transactionsFor("demo-first-roth", firstRothLedger(today), "demo-fr") : []),
    ...(second && second !== first
      ? transactionsFor("demo-second-401k", secondFourOhOneKLedger(today), "demo-s4")
      : []),
  ];

  return { id: "demo-portfolio", accounts, securities: [...SECURITIES], transactions };
}

/**
 * The taxable account, and the one carrying most of the interesting cases:
 * dividends, a reinvestment, a split, a long-term gain, a short-term gain
 * realized this year, and a loss to sit beside them.
 */
function jointBrokerageLedger(today: ISODate): TxSeed[] {
  return [
    { date: yearsAgo(today, 5, "01-08"), type: "cash_deposit", amount: 120_000, note: "Opening funding" },
    { date: yearsAgo(today, 5, "01-12"), type: "buy", symbol: "VTI", quantity: 180, price: 196.4 },
    { date: yearsAgo(today, 5, "01-12"), type: "buy", symbol: "VT", quantity: 300, price: 88.2 },
    { date: yearsAgo(today, 5, "03-24"), type: "buy", symbol: "BND", quantity: 250, price: 84.1 },
    { date: yearsAgo(today, 5, "06-21"), type: "dividend", symbol: "VTI", amount: 236.4 },
    { date: yearsAgo(today, 5, "06-21"), type: "dividend", symbol: "VT", amount: 318.9 },
    { date: yearsAgo(today, 5, "09-20"), type: "dividend", symbol: "VTI", amount: 241.8 },
    { date: yearsAgo(today, 5, "12-19"), type: "dividend", symbol: "VTI", amount: 254.5 },
    { date: yearsAgo(today, 5, "12-19"), type: "dividend", symbol: "BND", amount: 412.2 },

    { date: yearsAgo(today, 4, "02-03"), type: "cash_deposit", amount: 25_000 },
    { date: yearsAgo(today, 4, "02-05"), type: "buy", symbol: "SCHD", quantity: 260, price: 74.3 },
    { date: yearsAgo(today, 4, "03-22"), type: "dividend", symbol: "SCHD", amount: 168.4 },
    { date: yearsAgo(today, 4, "06-24"), type: "reinvest", symbol: "SCHD", quantity: 2.31, price: 76.9 },
    { date: yearsAgo(today, 4, "09-23"), type: "reinvest", symbol: "SCHD", quantity: 2.4, price: 78.15 },
    { date: yearsAgo(today, 4, "12-16"), type: "dividend", symbol: "VTI", amount: 268.1 },
    { date: yearsAgo(today, 4, "12-16"), type: "dividend", symbol: "BND", amount: 421.7 },

    { date: yearsAgo(today, 3, "02-19"), type: "buy", symbol: "NVDA", quantity: 60, price: 92.4 },
    { date: yearsAgo(today, 3, "07-18"), type: "buy", symbol: "VXUS", quantity: 300, price: 57.8 },
    { date: yearsAgo(today, 3, "09-22"), type: "dividend", symbol: "VT", amount: 341.2 },
    { date: yearsAgo(today, 3, "12-20"), type: "dividend", symbol: "VTI", amount: 279.6 },

    { date: yearsAgo(today, 2, "05-02"), type: "buy", symbol: "IBIT", quantity: 200, price: 41.6 },
    {
      date: yearsAgo(today, 2, "06-10"),
      type: "split",
      symbol: "NVDA",
      quantity: 2,
      note: "2-for-1 split",
    },
    // A position closed at a loss, so the Realized tab has both signs in it and
    // the winners/losers filter has something to filter.
    { date: yearsAgo(today, 2, "08-13"), type: "sell", symbol: "VXUS", quantity: 300, price: 54.15, fees: 0.06 },
    { date: yearsAgo(today, 2, "12-18"), type: "dividend", symbol: "VTI", amount: 291.3 },

    { date: yearsAgo(today, 1, "02-11"), type: "cash_deposit", amount: 18_000 },
    { date: yearsAgo(today, 1, "02-14"), type: "buy", symbol: "MSFT", quantity: 45, price: 402.15 },
    { date: yearsAgo(today, 1, "03-13"), type: "dividend", symbol: "MSFT", amount: 33.75 },
    // A winner trimmed after a split, so one realized lot has a cost basis half
    // of what its buy row says it paid.
    { date: yearsAgo(today, 1, "04-16"), type: "sell", symbol: "NVDA", quantity: 40, price: 128.5, fees: 0.08 },
    { date: yearsAgo(today, 1, "06-12"), type: "dividend", symbol: "MSFT", amount: 33.75 },
    { date: yearsAgo(today, 1, "07-01"), type: "fee", amount: 25, note: "Annual account fee" },
    { date: yearsAgo(today, 1, "09-11"), type: "dividend", symbol: "MSFT", amount: 37.35 },
    { date: yearsAgo(today, 1, "10-08"), type: "sell", symbol: "VTI", quantity: 40, price: 288.6, fees: 0.09 },
    { date: yearsAgo(today, 1, "12-11"), type: "dividend", symbol: "VTI", amount: 274.9 },
    { date: yearsAgo(today, 1, "12-11"), type: "dividend", symbol: "BND", amount: 398.6 },

    // This year, so the year-to-date tiles are never empty.
    { date: yearsAgo(today, 0, "01-21"), type: "interest", amount: 61.4, note: "Cash sweep" },
    { date: yearsAgo(today, 0, "02-12"), type: "buy", symbol: "VNQ", quantity: 120, price: 92.7 },
    { date: yearsAgo(today, 0, "03-12"), type: "dividend", symbol: "MSFT", amount: 37.35 },
    { date: yearsAgo(today, 0, "04-09"), type: "sell", symbol: "MSFT", quantity: 15, price: 448.2, fees: 0.05 },
    { date: yearsAgo(today, 0, "05-14"), type: "sell", symbol: "IBIT", quantity: 60, price: 38.9, fees: 0.04 },
    // Bought and sold inside the same year, so the short-term tile on the
    // Realized tab has a figure in it and isn't just a zero beside the others.
    { date: yearsAgo(today, 0, "06-05"), type: "sell", symbol: "VNQ", quantity: 40, price: 101.4, fees: 0.04 },
    { date: yearsAgo(today, 0, "06-11"), type: "dividend", symbol: "MSFT", amount: 27.75 },
    { date: yearsAgo(today, 0, "06-24"), type: "dividend", symbol: "SCHD", amount: 214.6 },
    { date: yearsAgo(today, 0, "07-15"), type: "cash_withdrawal", amount: 4_000, note: "Transfer to checking" },
  ];
}

/** A payroll-fed retirement account: steady contributions, two funds, no cash out. */
function firstFourOhOneKLedger(today: ISODate): TxSeed[] {
  const seeds: TxSeed[] = [
    { date: yearsAgo(today, 5, "01-15"), type: "cash_deposit", amount: 50_000, note: "Rollover" },
    { date: yearsAgo(today, 5, "01-16"), type: "buy", symbol: "VTI", quantity: 150, price: 197.1 },
    { date: yearsAgo(today, 5, "01-16"), type: "buy", symbol: "BND", quantity: 140, price: 84.4 },
  ];
  // Four years of quarterly contributions, bought straight into the same two
  // funds -- enough rows that grouping and paging have something to chew on.
  for (let years = 4; years >= 1; years -= 1) {
    for (const [month, vtiPrice, bndPrice] of QUARTERS) {
      seeds.push(
        { date: yearsAgo(today, years, `${month}-05`), type: "cash_deposit", amount: 4_500 },
        {
          date: yearsAgo(today, years, `${month}-06`),
          type: "buy",
          symbol: "VTI",
          quantity: 14,
          price: vtiPrice + (5 - years) * 12,
        },
        {
          date: yearsAgo(today, years, `${month}-06`),
          type: "buy",
          symbol: "BND",
          quantity: 20,
          price: bndPrice,
        },
      );
    }
  }
  seeds.push(
    { date: yearsAgo(today, 0, "02-05"), type: "cash_deposit", amount: 4_500 },
    { date: yearsAgo(today, 0, "02-06"), type: "buy", symbol: "VTI", quantity: 14, price: 268.4 },
    { date: yearsAgo(today, 0, "05-05"), type: "cash_deposit", amount: 4_500 },
    { date: yearsAgo(today, 0, "05-06"), type: "buy", symbol: "VTI", quantity: 13, price: 281.9 },
  );
  return seeds;
}

/** Month and the two prices its quarterly contribution buys at. */
const QUARTERS: readonly [string, number, number][] = [
  ["02", 201.4, 82.9],
  ["05", 208.7, 81.6],
  ["08", 214.2, 80.4],
  ["11", 219.8, 79.8],
];

/** The Roth: smaller, more opinionated, and where the transfer-in case lives. */
function firstRothLedger(today: ISODate): TxSeed[] {
  return [
    { date: yearsAgo(today, 5, "04-02"), type: "cash_deposit", amount: 6_000 },
    { date: yearsAgo(today, 5, "04-03"), type: "buy", symbol: "SCHD", quantity: 78, price: 72.1 },
    { date: yearsAgo(today, 4, "04-01"), type: "cash_deposit", amount: 6_500 },
    { date: yearsAgo(today, 4, "04-02"), type: "buy", symbol: "VNQ", quantity: 68, price: 88.4 },
    { date: yearsAgo(today, 4, "09-26"), type: "dividend", symbol: "VNQ", amount: 62.8 },
    {
      // Shares moved in from an old account keep their original acquired date,
      // which is what decides long vs short term -- worth having one in here.
      date: yearsAgo(today, 3, "05-20"),
      type: "transfer_in",
      symbol: "VTI",
      quantity: 30,
      // Priced at what the shares originally cost, not at the day they moved:
      // a transfer carries its basis along with its holding period.
      price: 132.4,
      acquiredDate: yearsAgo(today, 8, "07-14"),
      note: "Rolled in from a closed IRA",
    },
    { date: yearsAgo(today, 3, "06-24"), type: "dividend", symbol: "SCHD", amount: 64.1 },
    { date: yearsAgo(today, 2, "04-05"), type: "cash_deposit", amount: 7_000 },
    { date: yearsAgo(today, 2, "04-08"), type: "buy", symbol: "IBIT", quantity: 90, price: 43.2 },
    { date: yearsAgo(today, 1, "04-04"), type: "cash_deposit", amount: 7_000 },
    { date: yearsAgo(today, 1, "04-07"), type: "buy", symbol: "VT", quantity: 60, price: 118.4 },
    { date: yearsAgo(today, 1, "09-24"), type: "dividend", symbol: "VNQ", amount: 71.4 },
    { date: yearsAgo(today, 0, "04-06"), type: "cash_deposit", amount: 7_000 },
    { date: yearsAgo(today, 0, "04-07"), type: "buy", symbol: "VT", quantity: 52, price: 131.6 },
    { date: yearsAgo(today, 0, "06-25"), type: "dividend", symbol: "SCHD", amount: 74.9 },
  ];
}

/** The second earner's 401(k): world fund plus bonds, and a rebalance. */
function secondFourOhOneKLedger(today: ISODate): TxSeed[] {
  const seeds: TxSeed[] = [
    { date: yearsAgo(today, 5, "02-01"), type: "cash_deposit", amount: 30_000, note: "Rollover" },
    { date: yearsAgo(today, 5, "02-02"), type: "buy", symbol: "VT", quantity: 240, price: 89.4 },
    { date: yearsAgo(today, 5, "02-02"), type: "buy", symbol: "BND", quantity: 90, price: 84.6 },
  ];
  for (let years = 4; years >= 1; years -= 1) {
    seeds.push(
      { date: yearsAgo(today, years, "03-05"), type: "cash_deposit", amount: 6_000 },
      {
        date: yearsAgo(today, years, "03-06"),
        type: "buy",
        symbol: "VT",
        quantity: 52,
        price: 96.2 + (5 - years) * 8.4,
      },
      { date: yearsAgo(today, years, "10-05"), type: "cash_deposit", amount: 6_000 },
      {
        date: yearsAgo(today, years, "10-06"),
        type: "buy",
        symbol: "VT",
        quantity: 48,
        price: 101.8 + (5 - years) * 8.4,
      },
    );
  }
  seeds.push(
    // A rebalance: bonds sold to buy stock, so this account has a realized
    // figure of its own and a sale inside a tax-sheltered account to compare
    // against the taxable one's.
    { date: yearsAgo(today, 1, "11-14"), type: "sell", symbol: "BND", quantity: 40, price: 73.2 },
    { date: yearsAgo(today, 1, "11-15"), type: "buy", symbol: "VT", quantity: 22, price: 128.9 },
    { date: yearsAgo(today, 0, "03-05"), type: "cash_deposit", amount: 6_000 },
    { date: yearsAgo(today, 0, "03-06"), type: "buy", symbol: "VT", quantity: 44, price: 134.2 },
  );
  return seeds;
}
