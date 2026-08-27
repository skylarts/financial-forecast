"use client";

import { useMemo, useState } from "react";
import { formatOptionSymbol, type Portfolio } from "@/domain/portfolio";
import type { Holding, PortfolioSummary } from "@/engine/portfolio/metrics";
import {
  buildPerformanceSeries,
  earliestCoveredDate,
  symbolsForWindow,
  windowReturn,
} from "@/engine/portfolio/performance";
import { money, percent, signedMoney, toneFor } from "@/lib/portfolio/format";
import { usePriceHistories } from "@/lib/portfolio/usePriceHistories";
import { useMarketIndexes } from "@/store/useMarketIndexes";
import { Segmented } from "@/components/ui/controls";

/** How many day movers the strip names before it runs out of room. */
const MAX_MOVERS = 4;

const MOVER_SORT_OPTIONS = [
  { value: "best", label: "Best" },
  { value: "worst", label: "Worst" },
] as const;

const MOVER_METRIC_OPTIONS = [
  { value: "dollar", label: "$" },
  { value: "percent", label: "%" },
] as const;

type MoverSort = (typeof MOVER_SORT_OPTIONS)[number]["value"];
type MoverMetric = (typeof MOVER_METRIC_OPTIONS)[number]["value"];

/**
 * The deepest range the feed still answers daily.
 *
 * Never "max": that range is quietly downsampled to monthly closes, which would
 * turn a lifetime return into a figure computed off month-end prices.
 */
const HISTORY_RANGE = "10y";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoYearAgo(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[10.5px] uppercase tracking-wide text-dim-2">{title}</span>
        {hint && (
          <span
            title={hint}
            aria-label={hint}
            className="cursor-help select-none rounded-full border border-border px-[4px] text-[9px] leading-[13px] text-dim-2"
          >
            i
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** One label-and-figure line. Every card is built out of these, so the four
 *  of them line up across the row however many rows each carries. */
function Row({
  label,
  value,
  tone,
  hint,
  muted,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <span className={`text-[12.5px] ${muted ? "text-dim-2" : "text-dim"}`}>{label}</span>
      <span className={`text-[12.5px] tabular-nums ${tone || (muted ? "text-dim" : "text-foreground")}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * The four cards above the tabs: what the portfolio is worth, what moved today,
 * how it has performed, and what it has made.
 *
 * The performance figures here are time-weighted, built from the same daily
 * closes the Performance tab draws -- and through the same cache, so the two
 * share one fetch rather than each paying for the same years of history.
 * "Money-weighted" is the exception and is deliberately labelled as such: it is
 * the ledger's own IRR, which answers "how did my money do" rather than "how
 * did this portfolio do", and the two are different questions.
 */
export function SummaryCards({
  portfolio,
  summary,
  holdings,
  scopeAccountIds,
  loadingQuotes,
}: {
  portfolio: Portfolio;
  summary: PortfolioSummary;
  holdings: readonly Holding[];
  /** null = every account; otherwise the ids the header's picker covers. */
  scopeAccountIds: readonly string[] | null;
  loadingQuotes: boolean;
}) {
  const { indexes } = useMarketIndexes();
  const [moverSort, setMoverSort] = useState<MoverSort>("best");
  const [moverMetric, setMoverMetric] = useState<MoverMetric>("dollar");

  const scopedTransactions = useMemo(
    () =>
      scopeAccountIds === null
        ? portfolio.transactions
        : portfolio.transactions.filter((tx) => scopeAccountIds.includes(tx.accountId)),
    [portfolio.transactions, scopeAccountIds],
  );

  const earliest = useMemo(() => {
    const dates = scopedTransactions.map((tx) => tx.date).sort();
    return dates[0] ?? todayIso();
  }, [scopedTransactions]);

  // Seeded the same way the Accounts tab's balance is, so a ledger that starts
  // mid-history can't have its return and its balance disagree.
  const openingCash = useMemo(
    () =>
      portfolio.accounts
        .filter((a) => scopeAccountIds === null || scopeAccountIds.includes(a.id))
        .reduce((sum, a) => sum + a.openingCashBalance, 0),
    [portfolio.accounts, scopeAccountIds],
  );

  const to = todayIso();

  const neededSymbols = useMemo(
    () => symbolsForWindow(scopedTransactions, earliest, to, scopeAccountIds ?? undefined),
    [scopedTransactions, earliest, to, scopeAccountIds],
  );

  const { histories, splits, loading } = usePriceHistories(neededSymbols, HISTORY_RANGE, earliest);

  /**
   * One series spanning the whole ledger, which every window below is read off.
   *
   * A time-weighted index is a running product of daily factors, so the ratio
   * between any two of its points is exactly what a fresh series for that
   * narrower window would report -- four figures for the price of one build.
   */
  const series = useMemo(
    () =>
      buildPerformanceSeries(scopedTransactions, histories, {
        from: earliest,
        to,
        accountIds: scopeAccountIds ?? undefined,
        splits,
        openingCash,
      }),
    [scopedTransactions, histories, splits, earliest, to, scopeAccountIds, openingCash],
  );

  const returns = useMemo(() => {
    const points = series.points;
    /** How far back the loaded closes reach. */
    const feedStart = earliestCoveredDate(histories);
    /**
     * How far back this portfolio reaches. Its own first point is covered by
     * definition -- it exists only because a loaded history reached that far.
     */
    const seriesStart = points[0]?.date ?? null;

    /**
     * What a fixed-lookback window is measured as covered against: the later of
     * the two starts.
     *
     * A window has to reach back that far in the *ledger* as well as in the
     * feed, or a six-month-old account reports its six months as a one-year
     * return. Year-to-date deliberately doesn't use this -- an account opened
     * in March has no January, but the return since March genuinely is its
     * year to date.
     */
    const lookbackStart =
      feedStart === null || seriesStart === null ? null : feedStart > seriesStart ? feedStart : seriesStart;

    const lifetime = windowReturn(points, seriesStart ?? to, to, seriesStart);
    return {
      ytd: windowReturn(points, `${to.slice(0, 4)}-01-01`, to, feedStart).total,
      oneYear: windowReturn(points, isoYearAgo(), to, lookbackStart).total,
      lifetime: lifetime.total,
      lifetimeCagr: lifetime.annualized,
    };
  }, [series.points, histories, to]);

  /**
   * The day's biggest movers -- gainers or losers, ranked in dollars or in
   * percent, per the two toggles above the list.
   *
   * A 40% pop on a $200 position isn't what moved the account today, so the
   * dollar ranking (the default) puts it below the holding that actually did.
   * Percent ranking exists for the opposite question -- which name itself had
   * the wildest day -- and the two can order the same holdings differently.
   *
   * Rolled up by security first. Holdings are per-account, so the same ticker
   * held in a 401(k) and a brokerage is two rows -- and listing both spends two
   * of four slots saying the same thing about the same move.
   */
  const movers = useMemo(() => {
    const bySymbol = new Map<string, { symbol: string; name: string; change: number; previous: number }>();
    for (const holding of holdings) {
      if (holding.dayChange === null) continue;
      // What the position was worth yesterday, which is just today's value less
      // the move. Taken as a magnitude so a short -- whose market value is a
      // negative liability -- still contributes a positive base. Summing these
      // is what keeps the combined percentage value-weighted rather than one
      // account's rate standing in for both.
      const previous = Math.abs(holding.marketValue - holding.dayChange);
      const existing = bySymbol.get(holding.symbol);
      if (existing) {
        existing.change += holding.dayChange;
        existing.previous += previous;
      } else {
        bySymbol.set(holding.symbol, {
          symbol: holding.symbol,
          name: holding.name,
          change: holding.dayChange,
          previous,
        });
      }
    }
    const rows = [...bySymbol.values()]
      .filter((row) => row.change !== 0)
      .map((row) => ({ ...row, changePct: row.previous !== 0 ? row.change / row.previous : null }));

    const rankKey = (row: (typeof rows)[number]) => (moverMetric === "percent" ? row.changePct : row.change);

    return rows
      .filter((row) => {
        const k = rankKey(row);
        return k !== null && (moverSort === "best" ? k > 0 : k < 0);
      })
      .sort((a, b) => {
        // Ranked by magnitude either way: "best" wants the largest gain
        // first (descending), "worst" wants the largest loss first, which
        // since every row here is negative means the most negative first
        // (ascending).
        const diff = (rankKey(b) ?? 0) - (rankKey(a) ?? 0);
        return moverSort === "best" ? diff : -diff;
      })
      .slice(0, MAX_MOVERS);
  }, [holdings, moverSort, moverMetric]);

  // A window that couldn't be measured and one still being fetched must not
  // read the same -- a dash says "there is no answer", which is a lie while the
  // closes behind it are still in flight.
  const pct = (value: number | null) => (loading && value === null ? "…" : percent(value));

  return (
    <div className="grid gap-3 px-6 py-4 md:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-foreground">My portfolio</span>
          <span className="text-[21px] font-semibold tabular-nums text-foreground">
            {money(summary.totalValue)}
          </span>
        </div>
        <div className="mt-1.5 space-y-1">
          <Row
            label="Today"
            value={
              summary.dayChange === null
                ? "—"
                : `${signedMoney(summary.dayChange)}  ${percent(summary.dayChangePct, 2)}`
            }
            tone={summary.dayChange === null ? undefined : toneFor(summary.dayChange)}
            hint="Change in the priced positions since the previous close."
          />
          <Row label="Cost basis" value={money(summary.costBasis)} muted />
          <Row
            label="Cash"
            value={money(summary.cash)}
            muted
            hint="Uninvested cash, replayed from the ledger's own money movements."
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-2.5">
          {indexes.map((index) => (
            <div key={index.symbol} className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] text-dim-2">{index.label}</span>
              <span
                className={`text-[11.5px] tabular-nums ${
                  index.changePct === null ? "text-dim-2" : toneFor(index.changePct)
                }`}
              >
                {percent(index.changePct, 2)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Card
        title="Top movers"
        hint={`${moverSort === "best" ? "Biggest gainers" : "Biggest losers"} in your holdings since the previous close, ranked by ${moverMetric === "percent" ? "percent" : "dollar"} move.`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <Segmented
            options={MOVER_SORT_OPTIONS}
            value={moverSort}
            onChange={setMoverSort}
            size="sm"
            ariaLabel="Best or worst movers"
          />
          <Segmented
            options={MOVER_METRIC_OPTIONS}
            value={moverMetric}
            onChange={setMoverMetric}
            size="sm"
            ariaLabel="Rank by dollar or percent"
          />
        </div>
        {movers.length === 0 ? (
          <p className="text-[12.5px] text-dim">
            {loadingQuotes
              ? "Waiting on quotes…"
              : moverSort === "best"
                ? "Nothing gained today."
                : "Nothing lost today."}
          </p>
        ) : (
          <div className="space-y-1">
            {movers.map((mover) => {
              const primary = moverMetric === "percent" ? percent(mover.changePct, 2) : signedMoney(mover.change);
              const secondary = moverMetric === "percent" ? signedMoney(mover.change) : percent(mover.changePct, 2);
              return (
                <div key={mover.symbol} className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[12.5px] text-dim" title={mover.name}>
                    {formatOptionSymbol(mover.symbol)}
                  </span>
                  <span className={`shrink-0 text-[12.5px] tabular-nums ${toneFor(mover.change)}`}>
                    {primary}
                    <span className="ml-2 text-dim-2">{secondary}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="Performance"
        hint="Time-weighted returns, which strip out when you happened to add money — the only figures comparable to an index. Money-weighted is your own IRR instead."
      >
        <div className="space-y-1">
          <Row label="YTD" value={pct(returns.ytd)} tone={returns.ytd === null ? undefined : toneFor(returns.ytd)} />
          <Row
            label="1 Year"
            value={pct(returns.oneYear)}
            tone={returns.oneYear === null ? undefined : toneFor(returns.oneYear)}
          />
          <Row
            label="Lifetime"
            value={pct(returns.lifetime)}
            tone={returns.lifetime === null ? undefined : toneFor(returns.lifetime)}
          />
          <Row
            label="Lifetime CAGR"
            value={pct(returns.lifetimeCagr)}
            tone={returns.lifetimeCagr === null ? undefined : toneFor(returns.lifetimeCagr)}
            hint="Lifetime return expressed as a yearly rate. Under a year, it is the plain return."
          />
          <Row
            label="Money-weighted"
            value={percent(summary.irr)}
            tone={summary.irr === null ? undefined : toneFor(summary.irr)}
            hint="Annualized IRR across every trade and dividend in scope."
          />
        </div>
      </Card>

      <Card
        title="Gains & losses"
        hint="Dollars, not rates. Unrealized moves with the market; realized is locked in by a sale."
      >
        <div className="space-y-1">
          <Row
            label="Current unrealized"
            value={money(summary.unrealizedGain)}
            tone={toneFor(summary.unrealizedGain)}
          />
          <Row
            label="Lifetime realized"
            value={money(summary.realizedGain)}
            tone={toneFor(summary.realizedGain)}
            hint="All-time realized gains from closed lots."
          />
          <Row
            label="YTD realized"
            value={money(summary.realizedGainYtd)}
            tone={toneFor(summary.realizedGainYtd)}
            hint="What a sale this year has locked in — the figure the tax bill follows."
          />
          <Row
            label="YTD income"
            value={money(summary.incomeYtd)}
            tone={toneFor(summary.incomeYtd)}
            hint="Dividends and interest received since January 1st."
          />
          <Row
            label="Lifetime income"
            value={money(summary.income)}
            tone={toneFor(summary.income)}
            hint="Dividends and interest on the positions still held."
          />
        </div>
      </Card>
    </div>
  );
}
