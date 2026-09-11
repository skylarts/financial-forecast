"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { normalizeSymbol, type Portfolio } from "@/domain/portfolio";
import {
  annualizedReturn,
  buildPerformanceSeries,
  indexPrices,
  indexedReturn,
  symbolsForWindow,
  totalReturn,
  type PricePoint,
} from "@/engine/portfolio/performance";
import { classifySymbol } from "@/engine/portfolio/metrics";
import { maxDrawdown, netFlows, volatility, MIN_VOLATILITY_POINTS } from "@/engine/portfolio/riskStats";
import { money, percent, shortDate, signedMoney, toneFor } from "@/lib/portfolio/format";
import { usePriceHistories } from "@/lib/portfolio/usePriceHistories";
import { Segmented } from "@/components/ui/controls";
import {
  holdingFacetsActive,
  matchesHoldingFacets,
  type Classifiable,
  type HoldingFacets,
} from "./filters";
import { BenchmarkPicker } from "./BenchmarkPicker";
import { scopedTo } from "@/lib/portfolio/scope";

const MAX_BENCHMARKS = 5;

/** Where a benchmark's colour comes from. Fixed by slot, so removing one
 *  doesn't repaint the rest. */
const BENCHMARK_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-7)",
];

const PERIODS = [
  { value: "1mo", label: "1M" },
  { value: "3mo", label: "3M" },
  { value: "6mo", label: "6M" },
  { value: "ytd", label: "YTD" },
  { value: "1y", label: "1Y" },
  { value: "3y", label: "3Y" },
  { value: "5y", label: "5Y" },
  { value: "max", label: "Max" },
] as const;

type Period = (typeof PERIODS)[number]["value"] | "custom";

/**
 * The strip as it's actually offered, with a custom window on the end.
 *
 * The two date fields used to sit beside the presets permanently, taking most
 * of a row to serve the one case in eight the presets don't already cover.
 * Behind a segment they cost a click when wanted and nothing when not.
 */
const PERIOD_OPTIONS = [...PERIODS, { value: "custom", label: "Custom…" }] as const;

const MONTHS_BACK: Partial<Record<Period, number>> = {
  "1mo": 1,
  "3mo": 3,
  "6mo": 6,
  "1y": 12,
  "3y": 36,
  "5y": 60,
};

/**
 * How much history to pull, whatever the period.
 *
 * One range for every window, so switching periods never goes back to the feed
 * and -- more to the point -- so this panel and the summary cards above it
 * cannot disagree. Those cards need the full history to report a lifetime
 * return at all, and they are always on screen. When this panel asked for a
 * shallower two years for its short periods, its own 1Y box was computed off a
 * different, thinner series than the "1 Year" figure sitting directly above it,
 * and the two printed different numbers under the same label.
 *
 * Ten years, never "max": the feed quietly downsamples its max range to
 * monthly closes and ignores the daily interval it was asked for. Monthly data
 * silently rewrote the short periods in the table -- a one-month return
 * computed from two month-end prices. Every range up to 10y comes back daily.
 */
const HISTORY_RANGE = "10y";

/**
 * How long a typed date is left alone before the chart follows it.
 *
 * Long enough to type a four-digit year into a date input without the window
 * jumping to the year 2 on the way there, short enough that finishing the date
 * and looking up finds the chart already moving.
 */
const DATE_ENTRY_SETTLE_MS = 700;

function isoDaysAgo(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A year, as the engine measures one when it annualizes. */
const DAYS_PER_YEAR = 365.25;

/** Calendar days between a series' first and last point; 0 for under two points. */
function spanDays(points: readonly { date: string }[]): number {
  if (points.length < 2) return 0;
  const first = Date.parse(`${points[0].date}T00:00:00Z`);
  const last = Date.parse(`${points[points.length - 1].date}T00:00:00Z`);
  return (last - first) / 86_400_000;
}

interface ChartRow {
  date: string;
  portfolio: number;
  [benchmark: string]: number | string;
}

function GrowthTooltip({
  active,
  payload,
  label,
  base,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; color: string }[];
  label?: string;
  base: number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-panel px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 font-semibold text-foreground">{shortDate(String(label))}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-baseline justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-3 rounded"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-dim">
              {entry.dataKey === "portfolio" ? "Your portfolio" : entry.dataKey}
            </span>
          </span>
          <span className="tabular-nums text-foreground">
            {money(entry.value)}
            <span className={`ml-2 ${toneFor(entry.value - base)}`}>
              {percent(entry.value / base - 1)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Time-weighted performance against anything you can search for.
 *
 * The annualized figure on the summary strip is money-weighted -- it answers
 * "how did my money do", which depends on when contributions landed. That is
 * the right question for your own account and the wrong one for a comparison,
 * because a benchmark never had contributions. Everything here is
 * time-weighted instead, so the portfolio and the index are measured the same
 * way and the gap between them means something.
 */
export function PerformancePanel({
  portfolio,
  scopeAccountIds,
  facets,
  viewToggle,
}: {
  portfolio: Portfolio;
  /** null = every account (the "all" scope); otherwise the account ids the
   *  header's person-or-account picker currently covers. */
  scopeAccountIds: readonly string[] | null;
  /** Owned by the shared filter bar above the tabs. */
  facets: HoldingFacets;
  /** The over-time / by-stock switch, handed down so it sits in this panel's
   *  own first control row rather than in a second bar above it. */
  viewToggle?: ReactNode;
}) {
  const [period, setPeriod] = useState<Period>("1y");
  // What the chart is drawn from, and separately what the boxes are showing.
  // A date input fires a change for every segment typed, so the year is
  // reported as 0002 on the way to 2026 -- committing each of those redraws a
  // window nobody asked for and refetches the prices behind it. The typed value
  // is held here until it settles, which is what makes the field usable at all.
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [benchmarks, setBenchmarks] = useState<string[]>(["SPY"]);

  // A part-typed date settles into the real one a beat later; committing on the
  // pause keeps the boxes responsive without needing the user to hit anything.
  useEffect(() => {
    if (draftFrom === customFrom && draftTo === customTo) return;
    const timer = setTimeout(() => {
      setCustomFrom(draftFrom);
      setCustomTo(draftTo);
    }, DATE_ENTRY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draftFrom, draftTo, customFrom, customTo]);

  const scopedTransactions = useMemo(
    () =>
      scopeAccountIds === null
        ? portfolio.transactions
        : portfolio.transactions.filter(scopedTo(scopeAccountIds)),
    [portfolio.transactions, scopeAccountIds],
  );

  const securityBySymbol = useMemo(
    () => new Map(portfolio.securities.map((s) => [normalizeSymbol(s.symbol), s])),
    [portfolio.securities],
  );

  // Every symbol this scope has ever traded, classified the same way a
  // holding is -- the universe the facet menus offer and filter against, not
  // just what's still open today.
  const symbolClassifications = useMemo(() => {
    const symbols = new Set<string>();
    for (const tx of scopedTransactions) if (tx.symbol !== null) symbols.add(normalizeSymbol(tx.symbol));
    const map = new Map<string, Classifiable>();
    for (const symbol of symbols) map.set(symbol, classifySymbol(symbol, securityBySymbol.get(symbol)));
    return map;
  }, [scopedTransactions, securityBySymbol]);

  const filtersActive = holdingFacetsActive(facets);

  // undefined means "no filter" -- passed straight through to the engine,
  // which then behaves exactly as it did before facets existed.
  const includedSymbols = useMemo(() => {
    if (!filtersActive) return undefined;
    const set = new Set<string>();
    for (const [symbol, classification] of symbolClassifications) {
      if (matchesHoldingFacets(classification, facets)) set.add(symbol);
    }
    return set;
  }, [filtersActive, symbolClassifications, facets]);

  // What the accounts in scope opened holding, before their ledgers begin. The
  // series replays from the same seed the Accounts tab's balance does, so the
  // two cannot drift apart on a ledger that starts mid-history.
  const openingCash = useMemo(
    () =>
      portfolio.accounts
        .filter((a) => scopeAccountIds === null || new Set(scopeAccountIds).has(a.id))
        .reduce((sum, a) => sum + a.openingCashBalance, 0),
    [portfolio.accounts, scopeAccountIds],
  );

  // Narrowed the same way the series itself is -- a symbol/type facet has no
  // history before its own first trade, so "Max" has to open there too, not
  // at the account's first-ever transaction in some other symbol entirely.
  const earliest = useMemo(() => {
    const relevant =
      includedSymbols === undefined
        ? scopedTransactions
        : scopedTransactions.filter((tx) => tx.symbol !== null && includedSymbols.has(normalizeSymbol(tx.symbol)));
    const dates = relevant.map((tx) => tx.date).sort();
    return dates[0] ?? todayIso();
  }, [scopedTransactions, includedSymbols]);

  const { from, to } = useMemo(() => {
    const end = period === "custom" && customTo ? customTo : todayIso();
    if (period === "custom") return { from: customFrom || earliest, to: end };
    // "Max" means as far back as there are daily prices, which on a ledger
    // older than the fetch window is later than the first transaction. The
    // caption under the chart names the date it actually starts from.
    if (period === "max") return { from: earliest, to: end };
    if (period === "ytd") return { from: `${end.slice(0, 4)}-01-01`, to: end };
    return { from: isoDaysAgo(MONTHS_BACK[period] ?? 12), to: end };
  }, [period, customFrom, customTo, earliest]);

  /**
   * What to ask the feed for, in priority order.
   *
   * Benchmarks lead because they were chosen deliberately and must survive any
   * cap -- and because the list used to be sorted alphabetically, which meant a
   * ledger with enough option contracts silently pushed SPY and VTI past the
   * server's limit and rendered them as though the feed had no data for them.
   *
   * Holdings follow, for the *whole ledger* rather than the period on screen.
   * The chart's window is one slice of the series, but the returns table and
   * the statement reconciliation below it replay every day since the first
   * transaction, and they were being built on whatever prices the chart
   * happened to need. With a one-year period selected, every position closed
   * before that year had no prices at all and was carried at the last figure
   * paid -- and the reconciliation then reported a Roth IRA two thousand
   * dollars off for months that were within a few dollars on a full fetch.
   * The cost is one fetch for the ledger's full history, paid once per
   * twelve hours; switching periods after that touches nothing.
   */
  const neededSymbols = useMemo(() => {
    const ordered = [
      ...benchmarks,
      ...symbolsForWindow(scopedTransactions, earliest, todayIso(), scopeAccountIds ?? undefined, includedSymbols),
    ];
    return [...new Set(ordered)];
  }, [scopedTransactions, benchmarks, earliest, scopeAccountIds, includedSymbols]);

  const { histories, splits, skipped, loading, failed } = usePriceHistories(
    neededSymbols,
    HISTORY_RANGE,
    earliest,
  );

  const series = useMemo(
    () =>
      buildPerformanceSeries(scopedTransactions, histories, {
        from,
        to,
        accountIds: scopeAccountIds ?? undefined,
        splits,
        openingCash,
        symbols: includedSymbols,
      }),
    [scopedTransactions, histories, splits, from, to, scopeAccountIds, openingCash, includedSymbols],
  );

  // A window can open before the filtered slice had anything to show for
  // itself -- no shares of the included symbols yet, or no account funded
  // yet -- and the engine correctly holds the index flat through that dead
  // stretch rather than inventing a return for it. Charting that flat lead
  // anyway reads as "no activity" when what happened is "wrong question for
  // this period", so the visible series -- and any benchmark laid over it --
  // starts at the first day there was something to measure.
  const displayFrom = useMemo(() => {
    const firstActive = series.points.findIndex((p) => Math.abs(p.value) > 1e-9);
    return firstActive > 0 ? series.points[firstActive].date : from;
  }, [series.points, from]);

  const benchmarkSeries = useMemo(
    () =>
      benchmarks.map((symbol, i) => ({
        symbol,
        color: BENCHMARK_COLORS[i % BENCHMARK_COLORS.length],
        points: indexPrices(histories.get(symbol) ?? [], displayFrom, to),
      })),
    [benchmarks, histories, displayFrom, to],
  );

  const BASE = 10_000;

  /** The series from the first day there was something to measure. */
  const windowPoints = useMemo(
    () => series.points.filter((p) => p.date >= displayFrom),
    [series.points, displayFrom],
  );
  const rows = useMemo<ChartRow[]>(() => {
    const byDate = new Map<string, ChartRow>();
    for (const point of windowPoints) {
      byDate.set(point.date, { date: point.date, portfolio: point.index * BASE });
    }
    for (const benchmark of benchmarkSeries) {
      for (const point of benchmark.points) {
        // Benchmarks trade on days the portfolio may have no point for, and
        // vice versa. Only dates the portfolio series covers are plotted, so
        // the two lines always describe the same window.
        const row = byDate.get(point.date);
        if (row) row[benchmark.symbol] = point.index * BASE;
      }
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [windowPoints, benchmarkSeries]);

  /**
   * The risk and context figures for the window on screen. Drawdown and
   * volatility run over the same indexed points the chart draws, and over
   * each benchmark's own, so the two read against each other.
   */
  const context = useMemo(() => {
    const flows = netFlows(windowPoints);
    // Securities carried in or out that the feed could not price count as
    // zero flow in the series, so the contributions figure understates by
    // whatever they were worth. Say so rather than let the number look exact.
    const unpricedTransfers = scopedTransactions.filter(
      (tx) =>
        tx.date >= displayFrom &&
        tx.date <= to &&
        (tx.type === "transfer_in" || tx.type === "transfer_out") &&
        tx.symbol !== null &&
        !histories.has(normalizeSymbol(tx.symbol)),
    ).length;
    return {
      drawdown: maxDrawdown(windowPoints),
      volatility: volatility(windowPoints),
      flows,
      unpricedTransfers,
      benchmarks: benchmarkSeries.map((b) => {
        const total = indexedReturn(b.points);
        const years = spanDays(b.points) / DAYS_PER_YEAR;
        return {
          symbol: b.symbol,
          total,
          // The same rule as the portfolio's tile: nothing to annualize under a year.
          annualized: total === null || years <= 1 ? null : Math.pow(1 + total, 1 / years) - 1,
          drawdown: maxDrawdown(b.points),
          volatility: volatility(b.points),
        };
      }),
    };
  }, [windowPoints, benchmarkSeries, scopedTransactions, histories, displayFrom, to]);

  /**
   * One series spanning every window the table can possibly need -- from the
   * first transaction through today, which is a superset of "max" and of
   * every shorter period below it.
   *
   * A time-weighted index is a running product of daily factors that each
   * depend only on that day's own value and the day before it, never on where
   * the series happened to start accumulating. So the ratio between any two of
   * its points reproduces exactly what building a fresh series for that
   * narrower window would report, and the eight rows below can be read off one
   * build instead of costing one apiece -- the difference between a table that
   * redraws instantly and one that freezes the tab for seconds on a ledger
   * with real history behind it.
   */
  const fullSeries = useMemo(
    () =>
      buildPerformanceSeries(scopedTransactions, histories, {
        from: earliest,
        to: todayIso(),
        accountIds: scopeAccountIds ?? undefined,
        splits,
        openingCash,
        symbols: includedSymbols,
      }),
    [scopedTransactions, histories, splits, earliest, scopeAccountIds, openingCash, includedSymbols],
  );

  /**
   * Returns across every window the loaded history can actually cover.
   *
   * A period longer than what was fetched reports nothing rather than a figure
   * quietly measured over a shorter span than its own label claims.
   */
  const periodTable = useMemo(() => {
    const end = todayIso();

    /**
     * The oldest date any loaded history reaches. Coverage is measured against
     * this rather than against whether a trading day happens to land on the
     * window's first date -- a window opening on New Year's Day or a Sunday is
     * perfectly well covered, and checking for an exact match reported those
     * periods as having no data at all.
     */
    const firstAvailable = (points: readonly PricePoint[] | undefined): string | null =>
      points && points.length > 0 ? points[0].date : null;

    const portfolioHistoryStart = [...histories.values()]
      .map((points) => firstAvailable(points))
      .filter((date): date is string => date !== null)
      .sort()[0];

    return PERIODS.map((definition) => {
      const start =
        definition.value === "max"
          ? earliest
          : definition.value === "ytd"
            ? `${end.slice(0, 4)}-01-01`
            : isoDaysAgo(MONTHS_BACK[definition.value] ?? 12);

      const windowedPoints = fullSeries.points.filter((p) => p.date >= start && p.date <= end);

      // The fetch only went back so far. A window starting before the data does
      // would silently measure a shorter span than its own label claims.
      const covered =
        windowedPoints.length > 1 &&
        portfolioHistoryStart !== undefined &&
        (definition.value === "max" || start >= portfolioHistoryStart);

      return {
        label: definition.label,
        portfolio: covered ? totalReturn(windowedPoints) : null,
        benchmarks: benchmarks.map((symbol) => {
          // Checked per benchmark: one added today may have less history than
          // the rest, and rebasing it to a later start would understate the
          // period rather than admit it can't answer for it.
          const points = histories.get(symbol);
          const benchmarkStart = firstAvailable(points);
          if (!covered || benchmarkStart === null || benchmarkStart > start) return null;
          return indexedReturn(indexPrices(points ?? [], start, end));
        }),
      };
    });
  }, [fullSeries, histories, benchmarks, earliest]);

  const portfolioReturn = totalReturn(series.points);
  /**
   * Blank, not repeated, for a window of a year or less. Under a year the
   * engine leaves the return un-annualized, so the tile printed the same
   * figure as "Your return" beside it -- and on the 1Y window the two are
   * the same by definition. A dash says there is nothing to add.
   */
  const shortWindow = spanDays(series.points) <= DAYS_PER_YEAR;
  const portfolioAnnualized = shortWindow ? null : annualizedReturn(series.points);

  const addBenchmark = (symbol: string) => {
    setBenchmarks((current) =>
      current.includes(symbol) || current.length >= MAX_BENCHMARKS ? current : [...current, symbol],
    );
  };

  // A chart drew, as opposed to a message standing in for one. Named because
  // the legend below now sits between the chart and the commentary about it,
  // and both halves have to agree on when there is something to talk about.
  const chartReady = !failed && !loading && rows.length >= 2;

  if (portfolio.transactions.length === 0) {
    return (
      <div className="px-3 py-4 sm:px-6">
        {/* The switch stays even with nothing to measure -- without it there
            is no way back to the other view from an empty portfolio. */}
        {viewToggle}
        <p className="p-8 text-center text-[13px] text-dim">
          Nothing to measure yet. Import a transaction history or add a buy.
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {viewToggle}
        <Segmented
          options={PERIOD_OPTIONS}
          value={period}
          onChange={(next) => {
            // Arriving at the custom window with both fields blank would swing
            // the chart out to the whole history. Seeding them with the window
            // already on screen makes "Custom…" the start of an edit instead.
            if (next === "custom" && !draftFrom && !draftTo) {
              setDraftFrom(from);
              setDraftTo(to);
              setCustomFrom(from);
              setCustomTo(to);
            }
            setPeriod(next);
          }}
          size="sm"
          ariaLabel="Performance period"
        />
        {/* One range, one row: split across two lines the boxes also fell out of
            alignment, because the "From" label is wider than "To". */}
        {period === "custom" && (
          <div className="grid w-full grid-cols-2 items-end gap-2 sm:flex sm:w-auto sm:items-center sm:gap-2">
            <label className="min-w-0 text-[11.5px] text-dim-2 sm:flex sm:items-center sm:gap-1">
              <span className="mb-0.5 block sm:mb-0">From</span>
              <input
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(e) => setDraftFrom(e.target.value)}
                // Leaving the field or pressing enter means it is finished, so
                // there is nothing left to wait for.
                onBlur={() => setCustomFrom(draftFrom)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setCustomFrom(draftFrom);
                }}
                className="w-full rounded-md border border-border bg-panel-2 px-1.5 py-1 text-[11.5px] text-foreground outline-none focus:border-accent sm:w-auto"
              />
            </label>
            <label className="min-w-0 text-[11.5px] text-dim-2 sm:flex sm:items-center sm:gap-1">
              <span className="mb-0.5 block sm:mb-0">To</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(e) => setDraftTo(e.target.value)}
                onBlur={() => setCustomTo(draftTo)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setCustomTo(draftTo);
                }}
                className="w-full rounded-md border border-border bg-panel-2 px-1.5 py-1 text-[11.5px] text-foreground outline-none focus:border-accent sm:w-auto"
              />
            </label>
          </div>
        )}
      </div>

      {/* Five tiles, one row on a wide screen. The benchmarks' own figures
          sit under each in small grey, so the comparison is read inside the
          tile rather than off a separate one -- "vs SPY -4.9 pts" was a
          tile that said less than a line under the figure it compared. */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <ContextTile
          label="Your return"
          value={percent(portfolioReturn)}
          tone={toneFor(portfolioReturn ?? 0)}
          hint="Time-weighted return over this window: what a dollar invested at the start grew to, with deposits and withdrawals taken out."
          sub={context.benchmarks.map((b) => {
            const gap = portfolioReturn !== null && b.total !== null ? portfolioReturn - b.total : null;
            return `${b.symbol} ${percent(b.total)}${gap === null ? "" : ` · ${gap > 0 ? "+" : ""}${(gap * 100).toFixed(1)} pts`}`;
          })}
        />
        <ContextTile
          label="Annualized"
          value={percent(portfolioAnnualized)}
          tone={portfolioAnnualized === null ? "text-dim-2" : toneFor(portfolioAnnualized)}
          hint={
            shortWindow
              ? "Compounded to a yearly rate. Blank for windows of a year or less, where it would only repeat the return."
              : "Compounded to a yearly rate."
          }
          sub={context.benchmarks.map((b) => `${b.symbol} ${percent(b.annualized)}`)}
        />
        <ContextTile
          label="Max drawdown"
          value={context.drawdown ? percent(context.drawdown.depth) : "—"}
          tone={context.drawdown ? "text-negative" : "text-dim-2"}
          hint={
            context.drawdown
              ? `Peak ${shortDate(context.drawdown.peak)} to trough ${shortDate(context.drawdown.trough)}, ${
                  context.drawdown.recovered ? `recovered ${shortDate(context.drawdown.recovered)}` : "not yet recovered"
                }. The deepest fall from any high within this window.`
              : "The index never fell from a high in this window."
          }
          sub={context.benchmarks.map((b) => `${b.symbol} ${b.drawdown ? percent(b.drawdown.depth) : "—"}`)}
        />
        <ContextTile
          label="Volatility"
          value={context.volatility === null ? "—" : percent(context.volatility).replace("+", "")}
          tone={context.volatility === null ? "text-dim-2" : "text-foreground"}
          hint={
            context.volatility === null
              ? `Needs at least ${MIN_VOLATILITY_POINTS} trading days; a shorter window annualized is noise.`
              : "Annualized standard deviation of daily returns over this window. Higher is a rougher ride."
          }
          sub={context.benchmarks.map(
            (b) => `${b.symbol} ${b.volatility === null ? "—" : percent(b.volatility).replace("+", "")}`,
          )}
        />
        <ContextTile
          label="Net contributions"
          value={signedMoney(context.flows.net)}
          tone={toneFor(context.flows.net)}
          hint={
            `${money(context.flows.in)} put in, ${money(context.flows.out)} taken out, in this window. ` +
            "Time-weighted returns ignore this; the money-weighted figure on the summary card does not, which is the gap between them." +
            (context.unpricedTransfers > 0
              ? ` ${context.unpricedTransfers} securit${context.unpricedTransfers === 1 ? "y" : "ies"} transferred in or out could not be priced by the feed and ${context.unpricedTransfers === 1 ? "is" : "are"} not counted.`
              : "")
          }
          sub={[`${money(context.flows.in)} in · ${money(context.flows.out)} out`]}
        />
      </div>

      {failed ? (
        <p className="py-8 text-center text-[13px] text-dim">
          Couldn&apos;t load price history. The feed may be rate-limiting — try again shortly.
        </p>
      ) : loading ? (
        <div className="flex h-72 items-center justify-center text-[13px] text-dim">
          Loading price history…
        </div>
      ) : !chartReady ? (
        <p className="py-8 text-center text-[13px] text-dim">
          Not enough price history in this window to plot a return.
        </p>
      ) : (
        <>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--color-border-soft)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--color-dim-2)" }}
                  tickFormatter={(date: string) => date.slice(0, 7)}
                  minTickGap={56}
                  stroke="var(--color-border)"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-dim-2)" }}
                  // One decimal: growth of $10k over a year spans a few
                  // thousand dollars, and rounding to whole thousands printed
                  // the same label on adjacent ticks.
                  tickFormatter={(value: number) => `$${(value / 1000).toFixed(1)}k`}
                  width={56}
                  domain={["auto", "auto"]}
                  stroke="var(--color-border)"
                />
                <Tooltip content={<GrowthTooltip base={BASE} />} />
                <Line
                  type="monotone"
                  dataKey="portfolio"
                  name="Your portfolio"
                  stroke="var(--color-accent-line)"
                  strokeWidth={2.25}
                  dot={false}
                  isAnimationActive={false}
                />
                {benchmarkSeries.map((benchmark) => (
                  <Line
                    key={benchmark.symbol}
                    type="monotone"
                    dataKey={benchmark.symbol}
                    stroke={benchmark.color}
                    strokeWidth={1.5}
                    dot={false}
                    // A benchmark listed before its history begins would
                    // otherwise draw a straight line across the gap.
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* The legend and the benchmark control are the same thing: every row
          here is a line on the chart, so reading one and removing one belong
          together. Outside the branch above so a failed or empty chart still
          lets you change what it would have compared against. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] text-dim">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-0.5 w-4 rounded"
            style={{ backgroundColor: "var(--accent-line)" }}
          />
          Your portfolio
        </span>
        {benchmarkSeries.map((benchmark) => (
          <span key={benchmark.symbol} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded"
              style={{ backgroundColor: benchmark.color }}
            />
            {benchmark.symbol}
            {benchmark.points.length === 0 && !loading && (
              <span title="No price history for this window." className="text-dim-2">
                (no data)
              </span>
            )}
            <button
              type="button"
              onClick={() => setBenchmarks((c) => c.filter((s) => s !== benchmark.symbol))}
              title={`Remove ${benchmark.symbol}`}
              className="text-dim-2 hover:text-negative"
            >
              ✕
            </button>
          </span>
        ))}
        <BenchmarkPicker
          onAdd={addBenchmark}
          disabled={benchmarks.length >= MAX_BENCHMARKS}
          disabledReason={`Remove one to add another — ${MAX_BENCHMARKS} is the limit.`}
        />
      </div>

      {chartReady && (
        <>
          <p className="mt-2 text-[11.5px] text-dim-2">
            Growth of {money(BASE)} invested on {shortDate(rows[0].date)}, time-weighted so
            deposits and withdrawals don&apos;t count as performance.
          </p>

          {skipped.length > 0 && (
            <p className="mt-2 text-[11.5px] text-negative">
              {skipped.length} holding{skipped.length === 1 ? "" : "s"} left out of this request —
              too many symbols at once. The figures below cover everything else.
            </p>
          )}

          {series.basis === "securities" &&
            (filtersActive ? (
              <p className="mt-2 text-[11.5px] text-dim-2">
                These figures cover only the filtered names — a slice like this has no cash
                balance of its own, so a buy or sell counts as money entering or leaving it.
              </p>
            ) : (
              <p className="mt-2 text-[11.5px] text-dim-2">
                These figures cover the investments only, not the cash beside them — this
                ledger records purchases it has no deposits for, so there is no saying what
                its cash balance was on any past day. Importing the account&apos;s cash
                activity would let the return cover the whole account.
              </p>
            ))}

          {series.approximated.length > 0 && (
            <p className="mt-2 text-[11.5px] text-dim-2">
              Still holding {series.approximated.join(", ")} with no price history behind them —
              they are valued at the last price paid, so the closing figure is an estimate.
            </p>
          )}

          <div className="mt-5 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-dim-2">
                    Return by period
                  </th>
                  {periodTable.map((column) => (
                    <th
                      key={column.label}
                      className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-dim-2"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border-soft">
                  <td className="px-3 py-2 text-left text-[12.5px] font-semibold text-foreground">
                    Your portfolio
                  </td>
                  {periodTable.map((column) => (
                    <td
                      key={column.label}
                      className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${toneFor(
                        column.portfolio ?? 0,
                      )}`}
                    >
                      {percent(column.portfolio)}
                    </td>
                  ))}
                </tr>
                {benchmarks.map((symbol, i) => (
                  <tr key={symbol} className="border-b border-border-soft">
                    <td className="px-3 py-2 text-left text-[12.5px] text-dim">
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="inline-block h-0.5 w-3 rounded"
                          style={{
                            backgroundColor: BENCHMARK_COLORS[i % BENCHMARK_COLORS.length],
                          }}
                        />
                        {symbol}
                      </span>
                    </td>
                    {periodTable.map((column) => (
                      <td
                        key={column.label}
                        className={`px-3 py-2 text-right text-[12.5px] tabular-nums ${toneFor(
                          column.benchmarks[i] ?? 0,
                        )}`}
                      >
                        {percent(column.benchmarks[i])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11.5px] text-dim-2">
              A dash means the feed has no prices that far back for anything held then.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One of the three context tiles: a headline figure, a hover that says what
 * it means, and a dim line under it for the benchmarks' own figures so the
 * portfolio's number reads against something.
 */
function ContextTile({
  label,
  value,
  tone,
  hint,
  sub,
}: {
  label: string;
  value: string;
  tone: string;
  hint: string;
  sub: readonly string[];
}) {
  return (
    <div className="rounded-lg border border-border bg-panel px-4 py-3" title={hint}>
      <div className="text-[10.5px] uppercase tracking-wide text-dim-2">{label}</div>
      <div className={`mt-1 text-[19px] font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub.length > 0 && (
        <div className="mt-0.5 truncate text-[11px] tabular-nums text-dim-2">{sub.join(" · ")}</div>
      )}
    </div>
  );
}
