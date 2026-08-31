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
import { money, percent, shortDate, toneFor } from "@/lib/portfolio/format";
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

  const earliest = useMemo(() => {
    const dates = scopedTransactions.map((tx) => tx.date).sort();
    return dates[0] ?? todayIso();
  }, [scopedTransactions]);

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
   * Holdings follow, narrowed to the ones this window actually needs.
   */
  const neededSymbols = useMemo(() => {
    const ordered = [
      ...benchmarks,
      ...symbolsForWindow(scopedTransactions, from, to, scopeAccountIds ?? undefined, includedSymbols),
    ];
    return [...new Set(ordered)];
  }, [scopedTransactions, benchmarks, from, to, scopeAccountIds, includedSymbols]);

  const { histories, splits, skipped, loading, failed } = usePriceHistories(
    neededSymbols,
    HISTORY_RANGE,
    from,
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

  const benchmarkSeries = useMemo(
    () =>
      benchmarks.map((symbol, i) => ({
        symbol,
        color: BENCHMARK_COLORS[i % BENCHMARK_COLORS.length],
        points: indexPrices(histories.get(symbol) ?? [], from, to),
      })),
    [benchmarks, histories, from, to],
  );

  const BASE = 10_000;

  const rows = useMemo<ChartRow[]>(() => {
    const byDate = new Map<string, ChartRow>();
    for (const point of series.points) {
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
  }, [series.points, benchmarkSeries]);

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
  const portfolioAnnualized = annualizedReturn(series.points);

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
      <div className="p-5">
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
    <div className="p-5">
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
        {period === "custom" && (
          <>
            <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
              From
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
                className="rounded-md border border-border bg-panel-2 px-1.5 py-1 text-[11.5px] text-foreground outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
              To
              <input
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(e) => setDraftTo(e.target.value)}
                onBlur={() => setCustomTo(draftTo)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setCustomTo(draftTo);
                }}
                className="rounded-md border border-border bg-panel-2 px-1.5 py-1 text-[11.5px] text-foreground outline-none focus:border-accent"
              />
            </label>
          </>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-panel px-4 py-3">
          <div className="text-[10.5px] uppercase tracking-wide text-dim-2">Your return</div>
          <div className={`mt-1 text-[19px] font-semibold tabular-nums ${toneFor(portfolioReturn ?? 0)}`}>
            {percent(portfolioReturn)}
          </div>
        </div>
        <div
          className="rounded-lg border border-border bg-panel px-4 py-3"
          title="Compounded to a yearly rate. Windows under a year are shown as they stand."
        >
          <div className="text-[10.5px] uppercase tracking-wide text-dim-2">Annualized</div>
          <div
            className={`mt-1 text-[19px] font-semibold tabular-nums ${toneFor(portfolioAnnualized ?? 0)}`}
          >
            {percent(portfolioAnnualized)}
          </div>
        </div>
        {benchmarkSeries.slice(0, 2).map((benchmark) => {
          const benchmarkReturn = indexedReturn(benchmark.points);
          const gap =
            portfolioReturn !== null && benchmarkReturn !== null ? portfolioReturn - benchmarkReturn : null;
          return (
            <div key={benchmark.symbol} className="rounded-lg border border-border bg-panel px-4 py-3">
              <div className="text-[10.5px] uppercase tracking-wide text-dim-2">
                vs {benchmark.symbol}
              </div>
              <div className={`mt-1 text-[19px] font-semibold tabular-nums ${toneFor(gap ?? 0)}`}>
                {gap === null ? "—" : `${gap > 0 ? "+" : ""}${(gap * 100).toFixed(1)} pts`}
              </div>
            </div>
          );
        })}
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
              A dash means the loaded history doesn&apos;t reach back that far. Pick a longer
              period above to fetch more.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
