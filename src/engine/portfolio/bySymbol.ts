import type { ISODate, Id } from "@/domain";
import type { AssetClass } from "@/domain/portfolio";
import type { ClosedLot } from "./lots";
import type { Holding } from "./metrics";

/**
 * How a stock has actually treated you, across every account and both sides of
 * the ledger.
 *
 * The rest of the tracker slices by position -- one row per account, per symbol,
 * per side -- which is right for reconciling against a statement and wrong for
 * the question people actually ask, which is "how have I done on Apple". That
 * question spans accounts, spans open and closed, and includes the dividends
 * that never show up in either.
 */
export interface SymbolRollup {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** How many accounts hold or have held it, for the "spread across" hint. */
  accountCount: number;

  /* --- what's still open --- */
  isOpen: boolean;
  quantity: number;
  /** Basis of the shares still held. */
  openCostBasis: number;
  marketValue: number;
  price: number | null;
  unrealizedGain: number;
  /** Share of the portfolio in scope, summed across accounts. */
  weight: number;

  /* --- what's been closed --- */
  realizedGain: number;
  /** Basis of the shares already disposed of. */
  closedCostBasis: number;
  /** Closed lots, which is round trips rather than sell orders. */
  tradeCount: number;
  winCount: number;
  /** Null with no closed trades -- zero would read as "never won one". */
  winRate: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
  /** Mean days held across closed lots, share-weighted. */
  avgHoldDays: number | null;

  /* --- and the dividends --- */
  income: number;

  /* --- the whole story --- */
  totalGain: number;
  /**
   * Total gain over every dollar ever committed to the name, open and closed
   * alike. Null when nothing was ever committed -- gifted shares, a position
   * that only ever arrived by transfer at zero basis.
   */
  totalReturnPct: number | null;
}

/** Which half of the ledger a view is asking about. */
export type RollupScope = "positions" | "trades" | "both";

/**
 * Whole days between two dates, parsed as UTC.
 *
 * Local midnight would be an hour out across a daylight-saving boundary, so a
 * position bought in January and sold in April reports as 99.96 days held. It
 * rounds away in a display, but it is wrong, and a holding period is exactly
 * the figure where being a hair under the line matters.
 */
function daysBetween(from: ISODate, to: ISODate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return (b - a) / 86_400_000;
}

interface Bucket {
  holdings: Holding[];
  lots: ClosedLot[];
  accounts: Set<Id>;
}

/**
 * Consolidates holdings and closed lots into one row per symbol.
 *
 * Cash never appears: it isn't a position anyone won or lost on, and letting it
 * in would put a permanent zero-return row at the top of a table whose whole
 * purpose is ranking by return.
 *
 * A symbol held both long and short in different accounts collapses into one
 * row. That is the intent -- the question is about the name, not the mechanics
 * of how the exposure was built -- but it does mean a hedged pair reports its
 * net, which is the honest answer to "how did I do on this".
 */
export function rollUpBySymbol(
  holdings: readonly Holding[],
  closedLots: readonly ClosedLot[],
): SymbolRollup[] {
  const buckets = new Map<string, Bucket>();

  const bucketFor = (symbol: string): Bucket => {
    const existing = buckets.get(symbol);
    if (existing) return existing;
    const created: Bucket = { holdings: [], lots: [], accounts: new Set() };
    buckets.set(symbol, created);
    return created;
  };

  for (const holding of holdings) {
    if (holding.kind === "cash") continue;
    const bucket = bucketFor(holding.symbol);
    bucket.holdings.push(holding);
    bucket.accounts.add(holding.accountId);
  }

  for (const lot of closedLots) {
    // Untaxed disposals realized nothing -- a transfer between accounts is not
    // a trade, and counting it as one would report a 0% round trip that never
    // happened and drag the win rate down with it.
    if (!lot.taxable) continue;
    const bucket = bucketFor(lot.symbol);
    bucket.lots.push(lot);
    bucket.accounts.add(lot.accountId);
  }

  const rollups: SymbolRollup[] = [];
  for (const [symbol, bucket] of buckets) {
    const { holdings: open, lots, accounts } = bucket;

    const openCostBasis = open.reduce((sum, h) => sum + h.costBasis, 0);
    const marketValue = open.reduce((sum, h) => sum + h.marketValue, 0);
    const unrealizedGain = open.reduce((sum, h) => sum + h.unrealizedGain, 0);
    const income = open.reduce((sum, h) => sum + h.income, 0);

    const realizedGain = lots.reduce((sum, lot) => sum + lot.gain, 0);
    const closedCostBasis = lots.reduce((sum, lot) => sum + lot.costBasis, 0);
    const closedShares = lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const winCount = lots.filter((lot) => lot.gain > 0).length;

    const totalGain = unrealizedGain + realizedGain + income;
    const committed = openCostBasis + closedCostBasis;

    rollups.push({
      symbol,
      // A fully closed name has no holding left to carry its display name, so
      // it falls back to the ticker rather than rendering blank.
      name: open[0]?.name ?? symbol,
      assetClass: open[0]?.assetClass ?? "other",
      accountCount: accounts.size,

      isOpen: open.length > 0,
      quantity: open.reduce((sum, h) => sum + h.quantity, 0),
      openCostBasis,
      marketValue,
      price: open.find((h) => h.price !== null)?.price ?? null,
      unrealizedGain,
      weight: open.reduce((sum, h) => sum + h.weight, 0),

      realizedGain,
      closedCostBasis,
      tradeCount: lots.length,
      winCount,
      winRate: lots.length > 0 ? winCount / lots.length : null,
      bestTrade: lots.length > 0 ? Math.max(...lots.map((l) => l.gain)) : null,
      worstTrade: lots.length > 0 ? Math.min(...lots.map((l) => l.gain)) : null,
      avgHoldDays:
        closedShares > 0
          ? lots.reduce(
              (sum, lot) => sum + daysBetween(lot.acquiredDate, lot.disposedDate) * lot.quantity,
              0,
            ) / closedShares
          : null,

      income,

      totalGain,
      totalReturnPct: committed > 0 ? totalGain / committed : null,
    });
  }

  return rollups.sort((a, b) => b.totalGain - a.totalGain);
}

/**
 * The gain a given view is ranking on.
 *
 * Kept beside the rollup rather than in the component so sorting, the
 * winner/loser split, and the headline strip can never disagree about which
 * number "best" refers to.
 */
export function gainForScope(row: SymbolRollup, scope: RollupScope): number {
  switch (scope) {
    case "positions":
      return row.unrealizedGain;
    case "trades":
      return row.realizedGain;
    case "both":
      return row.totalGain;
  }
}

/** The basis that gain was earned on, for a percentage that matches the scope. */
export function returnForScope(row: SymbolRollup, scope: RollupScope): number | null {
  const basis =
    scope === "positions"
      ? row.openCostBasis
      : scope === "trades"
        ? row.closedCostBasis
        : row.openCostBasis + row.closedCostBasis;
  return basis > 0 ? gainForScope(row, scope) / basis : null;
}

/** Rows a scope has anything to say about. */
export function inScope(row: SymbolRollup, scope: RollupScope): boolean {
  if (scope === "positions") return row.isOpen;
  if (scope === "trades") return row.tradeCount > 0;
  return true;
}
