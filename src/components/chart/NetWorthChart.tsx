"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { Account, ExpenseBaseline, IncomeSource, Person, ScenarioEvent, PeriodSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { useUiStore } from "@/store/useUiStore";
import { usePlanStore } from "@/store/usePlanStore";
import { buildChartMarkers, type ChartMarker } from "./chartMarkers";
import { MARKER_TONE_CLASS } from "./eventIcons";
import { MarkerLayoutReporter, type MarkerLayout } from "./MarkerLayoutReporter";
import { Chip, Segmented } from "@/components/ui/controls";
import {
  ACCOUNT_CLASS_LABELS,
  buildAccountColors,
  displayAccounts,
  groupAccountsByClass,
} from "@/lib/accountColors";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { EventDrawer } from "@/components/events/EventDrawer";

/** Pointer movement (px) below which a marker press counts as a click (open
 *  its editor) rather than a drag (reschedule its date). */
const CLICK_MOVE_THRESHOLD = 4;

const CHART_COLORS = ["#3fb8a4", "#5cb88f", "#db7a6e", "#c9a063", "#9c8cd6", "#4fa8c9", "#d98bb0", "#8fbf5f"];
const JOY_CHART_COLORS = ["#ff7a59", "#f4a63b", "#2fb98d", "#3ec7cf", "#ff9d6f", "#e8555a", "#7bc47f", "#c874e8"];

// Recharts needs concrete color strings, so mirror the two palettes here.
// These must stay in sync with the theme tokens in globals.css.
const CHART_THEME = {
  dark: { grid: "#172d34", axis: "#8399a0", tooltipBg: "#0e2027", tooltipBorder: "#1f3a42", label: "#e7e7de" },
  joy: { grid: "#f4e5d3", axis: "#a68a72", tooltipBg: "#ffffff", tooltipBorder: "#ffe0c7", label: "#4a3729" },
} as const;

type ViewMode = "net_worth" | "by_account";

const ICON_SIZE = 22;
const ICON_GAP = 4;
const TOP_PAD = 6;

interface DragState {
  key: string;
  kind: ChartMarker["kind"];
  id: string;
  startDate: string;
  origYear: number;
  year: number;
  pointerX: number;
  iconTop: number;
}

/** From/To year selects plus range-preset chips -- a compact copy of the
 *  ViewBar's range controls for use in the chart's fullscreen header, where
 *  the ViewBar itself is covered. */
function FullscreenRangeControls({
  minYear,
  maxYear,
  rangeStart,
  rangeEnd,
  onRangeChange,
}: {
  minYear: number;
  maxYear: number;
  rangeStart: number;
  rangeEnd: number;
  onRangeChange: (start: number, end: number) => void;
}) {
  const yearOptions = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
  const isFullRange = rangeStart === minYear && rangeEnd === maxYear;
  const activePreset = RANGE_PRESETS.find((n) => rangeEnd - rangeStart + 1 === n && !isFullRange) ?? null;
  const selectClass = "rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[12px] text-foreground";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-[11.5px] text-dim-2">
        From
        <select
          value={rangeStart}
          onChange={(e) => onRangeChange(Number(e.target.value), rangeEnd)}
          className={selectClass}
        >
          {yearOptions
            .filter((y) => y <= rangeEnd)
            .map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11.5px] text-dim-2">
        To
        <select
          value={rangeEnd}
          onChange={(e) => onRangeChange(rangeStart, Number(e.target.value))}
          className={selectClass}
        >
          {yearOptions
            .filter((y) => y >= rangeStart)
            .map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
        </select>
      </label>
      <div className="flex items-center gap-1">
        {RANGE_PRESETS.map((n) => (
          <Chip
            key={n}
            active={activePreset === n}
            onClick={() => onRangeChange(rangeStart, Math.min(maxYear, rangeStart + n - 1))}
          >
            {n}y
          </Chip>
        ))}
        <Chip active={isFullRange} onClick={() => onRangeChange(minYear, maxYear)}>
          Full
        </Chip>
      </div>
    </div>
  );
}

function nearestYear(x: number, layout: MarkerLayout): number {
  let best = 0;
  let bestDist = Infinity;
  for (const [year, px] of layout.xByYear) {
    const dist = Math.abs(px - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = year;
    }
  }
  return best;
}

export function nextHiddenAccountIds(
  hiddenAccountIds: Set<string>,
  accountIds: string[]
): Set<string> {
  const allHidden = accountIds.length > 0 && accountIds.every((id) => hiddenAccountIds.has(id));
  return allHidden ? new Set() : new Set(accountIds);
}

interface CompareScenarioData {
  name: string;
  years: PeriodSnapshot[];
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
}

const RANGE_PRESETS = [5, 10, 20, 40] as const;

const DOLLAR_OPTIONS = [
  { value: "nominal" as const, label: "Nominal" },
  { value: "real" as const, label: "Real" },
];

export function NetWorthChart({
  accounts: allAccounts,
  editableAccounts,
  years,
  dollarMode,
  onDollarModeChange,
  minYear,
  maxYear,
  rangeStart,
  rangeEnd,
  onRangeChange,
  events,
  incomeSources,
  expenses,
  people,
  scenarioName,
  compareOptions,
  compareScenarioId,
  compareScenario,
}: {
  accounts: Account[];
  /** Accounts selectable in the drawers opened by clicking a marker -- excludes the mandatory Extra Savings account etc. */
  editableAccounts: Account[];
  years: PeriodSnapshot[];
  dollarMode: DollarMode;
  /** Lets the chart's own fullscreen header drive the same nominal/real
   *  toggle the persistent ViewBar controls -- otherwise there's no way to
   *  change dollar mode while the chart covers the ViewBar. */
  onDollarModeChange: (mode: DollarMode) => void;
  minYear: number;
  maxYear: number;
  rangeStart: number;
  rangeEnd: number;
  onRangeChange: (start: number, end: number) => void;
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
  scenarioName: string;
  compareOptions: { id: string; name: string }[];
  compareScenarioId: string | null;
  compareScenario: CompareScenarioData | null;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("net_worth");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hiddenAccountIds, setHiddenAccountIds] = useState<Set<string>>(new Set());
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const theme = isJoy ? CHART_THEME.joy : CHART_THEME.dark;
  const palette = isJoy ? JOY_CHART_COLORS : CHART_COLORS;

  const updateEvent = usePlanStore((s) => s.updateEvent);
  const updateIncomeSource = usePlanStore((s) => s.updateIncomeSource);
  const updateExpense = usePlanStore((s) => s.updateExpense);

  const containerRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<MarkerLayout | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);

  const [incomeDrawer, setIncomeDrawer] = useState<{ open: boolean; item?: IncomeSource }>({ open: false });
  const [expenseDrawer, setExpenseDrawer] = useState<{ open: boolean; item?: ExpenseBaseline }>({ open: false });
  const [eventDrawer, setEventDrawer] = useState<{ open: boolean; item?: ScenarioEvent }>({ open: false });

  const openMarkerEditor = useCallback(
    (marker: ChartMarker) => {
      if (marker.kind === "event") {
        const ev = events.find((e) => e.id === marker.id);
        if (ev) setEventDrawer({ open: true, item: ev });
      } else if (marker.kind === "income") {
        const inc = incomeSources.find((i) => i.id === marker.id);
        if (inc) setIncomeDrawer({ open: true, item: inc });
      } else {
        const exp = expenses.find((e) => e.id === marker.id);
        if (exp) setExpenseDrawer({ open: true, item: exp });
      }
    },
    [events, incomeSources, expenses]
  );

  const handleLayout = useCallback((next: MarkerLayout | null) => {
    setLayout((prev) => {
      if (!next) return prev === null ? prev : null;
      if (
        prev &&
        prev.top === next.top &&
        prev.bottom === next.bottom &&
        prev.left === next.left &&
        prev.right === next.right &&
        prev.xByYear.size === next.xByYear.size &&
        [...next.xByYear].every(([year, x]) => prev.xByYear.get(year) === x)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const accounts = useMemo(() => displayAccounts(allAccounts), [allAccounts]);

  /** Per-account line/legend color -- shared with the overview's account
   *  snapshot so a given account is the same color in both places. */
  const accountColors = useMemo(() => buildAccountColors(accounts, isJoy), [accounts, isJoy]);

  const compareByYear = useMemo(() => {
    if (!compareScenario) return null;
    const map = new Map<number, PeriodSnapshot>();
    for (const y of compareScenario.years) map.set(y.year, y);
    return map;
  }, [compareScenario]);

  const data = useMemo(() => {
    return years.map((y) => {
      const factor = dollarMode === "real" ? y.inflationDeflator : 1;
      const row: Record<string, number> = { year: y.year };
      if (viewMode === "net_worth") {
        row.value = (dollarMode === "real" ? y.netWorthReal : y.netWorthNominal);
        const cy = compareByYear?.get(y.year);
        if (cy) row.compareValue = dollarMode === "real" ? cy.netWorthReal : cy.netWorthNominal;
      } else {
        for (const a of accounts) {
          const nominal = y.accountBalances[a.id] ?? 0;
          row[a.id] = nominal / factor;
        }
      }
      return row;
    });
  }, [years, viewMode, dollarMode, accounts, compareByYear]);

  const dataYears = useMemo(() => data.map((d) => d.year as number), [data]);

  // Years where net worth first crosses a big round milestone ($1M, $5M, ...).
  // Joy mode twinkles a sparkle on those points to celebrate the climb.
  const milestoneIndices = useMemo(() => {
    const thresholds = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];
    const reached = new Set<number>();
    const indices = new Set<number>();
    data.forEach((row, i) => {
      const v = typeof row.value === "number" ? row.value : null;
      if (v == null) return;
      for (const t of thresholds) {
        if (v >= t && !reached.has(t)) {
          reached.add(t);
          indices.add(i);
        }
      }
    });
    return indices;
  }, [data]);

  // Joy mode dresses up the net-worth line: milestone years twinkle with a
  // sparkle, and the final year is capped with a pulsing sun (rotating rays +
  // coral halo) -- a cheery "destination" that makes the payoff feel exciting.
  const renderSunDot = useCallback(
    (props: { cx?: number; cy?: number; index?: number }) => {
      const { cx, cy, index } = props;
      if (cx == null || cy == null || index == null) return <g key={`joy-dot-${index}`} />;

      if (index === data.length - 1) {
        return (
          <g key={`joy-dot-${index}`} style={{ pointerEvents: "none" }}>
            {/* soft coral halo */}
            <circle cx={cx} cy={cy} r={15} fill="#ff7a59" opacity={0.18} />
            {/* slowly-rotating rays (SMIL keeps them pinned to the point) */}
            <g>
              <animateTransform
                attributeName="transform"
                type="rotate"
                from={`0 ${cx} ${cy}`}
                to={`360 ${cx} ${cy}`}
                dur="9s"
                repeatCount="indefinite"
              />
              {Array.from({ length: 12 }).map((_, k) => {
                const ang = (k * 30 * Math.PI) / 180;
                return (
                  <line
                    key={k}
                    x1={cx + Math.cos(ang) * 12}
                    y1={cy + Math.sin(ang) * 12}
                    x2={cx + Math.cos(ang) * 17}
                    y2={cy + Math.sin(ang) * 17}
                    stroke="#ffb14e"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                );
              })}
            </g>
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={20} className="joy-sun">
              ☀️
            </text>
          </g>
        );
      }

      if (milestoneIndices.has(index)) {
        return (
          <text
            key={`joy-dot-${index}`}
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={16}
            className="joy-sparkle"
            style={{ pointerEvents: "none" }}
          >
            ✨
          </text>
        );
      }

      return <g key={`joy-dot-${index}`} />;
    },
    [data.length, milestoneIndices]
  );

  // Hovering any year pops a little sun on that point, so exploring the line
  // feels playful instead of clinical.
  const renderSunActiveDot = useCallback((props: { cx?: number; cy?: number }) => {
    const { cx, cy } = props;
    if (cx == null || cy == null) return <g />;
    return (
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={18} className="joy-sun">
        ☀️
      </text>
    );
  }, []);

  const markers = useMemo(
    () => buildChartMarkers({ events, incomeSources, expenses, people, accounts }),
    [events, incomeSources, expenses, people, accounts]
  );

  const compareMarkers = useMemo(() => {
    if (!compareScenario) return [];
    return buildChartMarkers({
      events: compareScenario.events,
      incomeSources: compareScenario.incomeSources,
      expenses: compareScenario.expenses,
      people: compareScenario.people,
    }).map((m) => ({ ...m, key: `cmp-${m.key}`, isCompare: true, scenarioName: compareScenario.name }));
  }, [compareScenario]);

  const allMarkers = useMemo(() => {
    if (!compareScenario) return markers.map((m) => ({ ...m, scenarioName }));
    return [...markers.map((m) => ({ ...m, scenarioName })), ...compareMarkers];
  }, [markers, compareMarkers, compareScenario, scenarioName]);

  const markersByYear = useMemo(() => {
    const yearSet = new Set(dataYears);
    const map = new Map<number, ChartMarker[]>();
    for (const m of allMarkers) {
      if (!yearSet.has(m.year)) continue;
      const list = map.get(m.year) ?? [];
      list.push(m);
      map.set(m.year, list);
    }
    return map;
  }, [allMarkers, dataYears]);

  const chartTopMargin = 4;

  const applyDrag = useCallback(
    (d: DragState) => {
      if (d.year === d.origYear) return;
      const newStartDate = `${d.year}${d.startDate.slice(4)}`;
      if (d.kind === "event") {
        const ev = events.find((e) => e.id === d.id);
        if (ev) updateEvent(ev.id, { ...ev, startDate: newStartDate });
      } else if (d.kind === "income") {
        const inc = incomeSources.find((i) => i.id === d.id);
        if (inc) updateIncomeSource(inc.id, { ...inc, startDate: newStartDate });
      } else {
        const exp = expenses.find((e) => e.id === d.id);
        if (exp) updateExpense(exp.id, { ...exp, startDate: newStartDate });
      }
    },
    [events, incomeSources, expenses, updateEvent, updateIncomeSource, updateExpense]
  );

  const handleMarkerPointerDown = (e: React.PointerEvent, marker: ChartMarker, iconTop: number) => {
    if (!layout || marker.isCompare) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const rect = containerRef.current!.getBoundingClientRect();
    const pointerX = e.clientX - rect.left;
    pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
    didDragRef.current = false;
    setHoverKey(null);
    setDrag({
      key: marker.key,
      kind: marker.kind,
      id: marker.id,
      startDate: marker.startDate,
      origYear: marker.year,
      year: marker.year,
      pointerX,
      iconTop,
    });
  };

  const handleMarkerPointerMove = (e: React.PointerEvent) => {
    if (!drag || !layout) return;
    e.stopPropagation();
    const downPos = pointerDownPosRef.current;
    if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > CLICK_MOVE_THRESHOLD) {
      didDragRef.current = true;
    }
    const rect = containerRef.current!.getBoundingClientRect();
    const x = Math.min(layout.right, Math.max(layout.left, e.clientX - rect.left));
    const year = nearestYear(x, layout);
    setDrag((prev) => (prev ? { ...prev, pointerX: x, year } : prev));
  };

  const handleMarkerPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    e.stopPropagation();
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    pointerDownPosRef.current = null;
    if (didDragRef.current) applyDrag(drag);
    setDrag(null);
  };

  /** Native click, not pointerup -- pointerup can be swallowed by pointer
   *  capture handoff in some automated/synthetic-input environments, while
   *  click remains reliable. Only fires the editor when the preceding
   *  pointer sequence didn't actually drag the marker. */
  const handleMarkerClick = (marker: ChartMarker) => {
    if (marker.isCompare) return;
    if (!didDragRef.current) openMarkerEditor(marker);
  };

  const toggleAccount = (accountId: string) => {
    setHiddenAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const allHidden = accounts.length > 0 && accounts.every((a) => hiddenAccountIds.has(a.id));

  const toggleAllAccounts = () => {
    setHiddenAccountIds((prev) => nextHiddenAccountIds(prev, accounts.map((a) => a.id)));
  };

  const compareName = compareOptions.find((o) => o.id === compareScenarioId)?.name ?? null;

  // Recharts' <Legend> auto-collects items in the order its <Line> children
  // mount, which doesn't reliably track our sort order -- render our own
  // legend for "By Account" straight from the sorted `accounts` array instead.
  //
  // Rendered as a sibling BELOW the chart rather than inside Recharts' own
  // <Legend>: an in-chart legend is laid out within the chart's height, so
  // this multi-row account key ate a third of the plot area the moment you
  // switched to "By Account". Outside, the plot keeps its full height and the
  // tile grows to fit the key instead.
  const renderAccountLegend = () => {
    const groups = groupAccountsByClass(accounts);
    return (
      <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs">
        {groups.map((g, gi) => (
          <div
            key={g.cls}
            className={`flex flex-col gap-1 ${gi > 0 ? "border-l border-border pl-4" : ""}`}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide text-dim/70">
              {ACCOUNT_CLASS_LABELS[g.cls]}
            </span>
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {g.accounts.map((a) => {
                const hidden = hiddenAccountIds.has(a.id);
                return (
                  <li
                    key={a.id}
                    onClick={() => toggleAccount(a.id)}
                    className="flex cursor-pointer items-center gap-1"
                    style={{ opacity: hidden ? 0.5 : 1 }}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: accountColors.get(a.id) }}
                    />
                    <span>{a.name}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      className={
        isFullscreen
          ? "joy-lift fixed inset-0 z-50 flex flex-col overflow-auto rounded-none border-0 bg-panel p-4"
          : "joy-lift flex h-full flex-col rounded-xl border border-border bg-panel p-4"
      }
    >
      {/* Dollar mode and scenario comparison moved to the persistent ViewBar
          (they apply to the tables too, which are now separate views); what
          stays here is chart-only: the series mode and its legend. While
          fullscreen the chart covers the ViewBar, so it grows its own copy
          of the date-range and dollar-mode controls, driven by the same
          lifted state via onRangeChange/onDollarModeChange. */}
      <div className="mb-3 flex flex-col gap-2">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <h2 className="text-sm font-semibold text-dim">
            {viewMode === "net_worth" ? "Net Worth Projection" : "Balance by Account"}
            {compareName && <span className="ml-2 font-normal text-dim-2">vs {compareName}</span>}
          </h2>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Segmented
              ariaLabel="Chart series"
              size="sm"
              options={[
                { value: "net_worth" as const, label: "Net Worth" },
                { value: "by_account" as const, label: "By Account" },
              ]}
              value={viewMode}
              onChange={setViewMode}
            />
            {viewMode === "by_account" && (
              <Chip onClick={toggleAllAccounts}>{allHidden ? "Show all" : "Hide all"}</Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isFullscreen && (
              <Segmented
                ariaLabel="Show figures in future or today's dollars"
                size="sm"
                options={DOLLAR_OPTIONS}
                value={dollarMode}
                onChange={onDollarModeChange}
              />
            )}
            <button
              type="button"
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? "Minimize" : "Expand to full screen"}
              aria-label={isFullscreen ? "Minimize" : "Expand to full screen"}
              className="flex items-center justify-center rounded-md border border-border bg-panel-2 px-2 py-1 text-sm text-dim transition-colors hover:border-accent hover:text-foreground"
            >
              {isFullscreen ? "⤡" : "⤢"}
            </button>
          </div>
        </div>
        {isFullscreen && (
          <div className="flex justify-start">
            <FullscreenRangeControls
              minYear={minYear}
              maxYear={maxYear}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onRangeChange={onRangeChange}
            />
          </div>
        )}
      </div>

      {/* Fullscreen: the plot takes whatever height is left after the header
          and the account key, rather than a fixed viewport calc that the key
          would then push past the bottom of the screen. */}
      <div ref={containerRef} className={`relative ${isFullscreen ? "min-h-0 flex-1" : ""}`}>
        <ResponsiveContainer width="100%" height={isFullscreen ? "100%" : 320}>
          <LineChart data={data} margin={{ top: chartTopMargin, right: isJoy ? 24 : 8, left: 8, bottom: 4 }}>
            <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
            <XAxis dataKey="year" stroke={theme.axis} tick={{ fontSize: 12 }} />
            <YAxis stroke={theme.axis} tick={{ fontSize: 12 }} tickFormatter={(v) => formatMoney(v)} width={80} />
            <Tooltip
              // Recharts renders the Legend after the Tooltip in the DOM, so
              // without an explicit z-index the "By Account" legend (which
              // wraps onto several lines of account names) paints on top of
              // the tooltip instead of behind it.
              wrapperStyle={{ zIndex: 40 }}
              contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: 8 }}
              labelStyle={{ color: theme.label }}
              // "By Account" otherwise lists rows in <Line> mount order (our
              // sorted-by-class order) rather than by size -- sort by value,
              // largest first, so the tooltip reads like a ranked breakdown.
              itemSorter={(item) => -(Number(item.value) || 0)}
              formatter={(value, name) => {
                if (viewMode !== "net_worth") {
                  return [formatMoney(Number(value)), accounts.find((a) => a.id === name)?.name ?? String(name)];
                }
                const label = name === "compareValue" ? (compareName ?? "Compare") : scenarioName;
                return [formatMoney(Number(value)), label];
              }}
            />
            {viewMode === "net_worth" && (
              <Legend
                formatter={(value: string) => (value === "compareValue" ? (compareName ?? "Compare") : scenarioName)}
                wrapperStyle={{ fontSize: 12 }}
              />
            )}
            {viewMode === "net_worth" ? (
              <>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={palette[0]}
                  dot={isJoy ? renderSunDot : false}
                  activeDot={isJoy ? renderSunActiveDot : undefined}
                  strokeWidth={2}
                  isAnimationActive={false}
                />

                {compareName && (
                  <Line
                    type="monotone"
                    dataKey="compareValue"
                    stroke={theme.axis}
                    dot={false}
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    isAnimationActive={false}
                  />
                )}
              </>
            ) : (
              accounts.map((a) => (
                <Line
                  key={a.id}
                  type="monotone"
                  dataKey={a.id}
                  stroke={accountColors.get(a.id)}
                  dot={false}
                  strokeWidth={2}
                  hide={hiddenAccountIds.has(a.id)}
                  isAnimationActive={false}
                />
              ))
            )}
            {viewMode === "net_worth" && <MarkerLayoutReporter years={dataYears} onLayout={handleLayout} />}
          </LineChart>
        </ResponsiveContainer>

        {viewMode === "net_worth" && layout && (
          <div className="pointer-events-none absolute inset-0">
            {[...markersByYear.entries()].map(([year, rawList]) => {
              const rawX = layout.xByYear.get(year);
              if (rawX === undefined) return null;
              // Keep icons inside the plot area: markers on the first visible
              // year would otherwise center over the y-axis and sit on top of
              // its dollar labels.
              const x = Math.max(rawX, layout.left + ICON_SIZE / 2 + 10);
              const list = rawList;
              const stackBottom = layout.top + TOP_PAD + list.length * (ICON_SIZE + ICON_GAP) - ICON_GAP;
              return (
                <div key={year}>
                  <div
                    className="absolute"
                    style={{
                      left: x,
                      top: stackBottom,
                      height: Math.max(0, layout.bottom - stackBottom),
                      borderLeft: `1px dashed ${theme.axis}`,
                      opacity: 0.4,
                    }}
                  />
                  {list.map((m, i) => {
                    const top = layout.top + TOP_PAD + i * (ICON_SIZE + ICON_GAP);
                    const isDragging = drag?.key === m.key;
                    return (
                      <div
                        key={m.key}
                        className={`pointer-events-auto absolute flex items-center justify-center rounded-md text-xs shadow-sm ${
                          m.isCompare
                            ? "cursor-default grayscale bg-dim/15 text-dim"
                            : `cursor-grab active:cursor-grabbing ${MARKER_TONE_CLASS[m.kind]}`
                        }`}
                        style={{
                          left: x - ICON_SIZE / 2,
                          top,
                          width: ICON_SIZE,
                          height: ICON_SIZE,
                          opacity: isDragging ? 0 : m.isCompare ? 0.5 : 1,
                          touchAction: "none",
                          userSelect: "none",
                        }}
                        onPointerDown={(e) => handleMarkerPointerDown(e, m, top)}
                        onPointerMove={handleMarkerPointerMove}
                        onPointerUp={handleMarkerPointerUp}
                        onClick={() => handleMarkerClick(m)}
                        onPointerEnter={() => !drag && setHoverKey(m.key)}
                        onPointerLeave={() => setHoverKey((k) => (k === m.key ? null : k))}
                      >
                        {m.icon}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {hoverKey &&
              !drag &&
              (() => {
                const m = allMarkers.find((mm) => mm.key === hoverKey);
                if (!m) return null;
                const x = layout.xByYear.get(m.year);
                if (x === undefined) return null;
                const list = markersByYear.get(m.year) ?? [];
                const idx = list.findIndex((mm) => mm.key === m.key);
                const top = layout.top + TOP_PAD + Math.max(0, idx) * (ICON_SIZE + ICON_GAP);
                return (
                  <div
                    className="absolute z-20 w-64 -translate-x-1/2 rounded-md border border-border bg-panel p-3 text-xs shadow-lg"
                    style={{ left: x, top: top + ICON_SIZE + 6 }}
                  >
                    {compareScenario && <div className="mb-1 text-[10px] font-semibold text-dim">{m.scenarioName}</div>}
                    <div className="mb-1.5 text-sm font-semibold">{m.title}</div>
                    <div className="flex flex-col gap-1">
                      {m.rows.map((r, i) => (
                        <div key={i} className="flex items-center justify-between gap-3">
                          <span className="text-dim">{r.label}</span>
                          <span className="font-medium">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

            {drag && (
              <>
                <div
                  className="absolute"
                  style={{
                    left: layout.xByYear.get(drag.year) ?? drag.pointerX,
                    top: layout.top,
                    height: Math.max(0, layout.bottom - layout.top),
                    borderLeft: `1.5px dashed ${palette[0]}`,
                  }}
                />
                <div
                  className="absolute -translate-x-1/2 rounded bg-pri px-1.5 py-0.5 text-[10px] font-semibold text-pri-fg"
                  style={{ left: drag.pointerX, top: drag.iconTop - 20 }}
                >
                  {drag.year}
                </div>
                <div
                  className={`pointer-events-none absolute z-30 flex items-center justify-center rounded-md text-xs shadow-lg ${MARKER_TONE_CLASS[drag.kind]}`}
                  style={{ left: drag.pointerX - ICON_SIZE / 2, top: drag.iconTop, width: ICON_SIZE, height: ICON_SIZE }}
                >
                  {markers.find((m) => m.key === drag.key)?.icon}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {viewMode === "by_account" && renderAccountLegend()}

      <IncomeDrawer
        key={`income-${incomeDrawer.open}-${incomeDrawer.item?.id ?? "new"}`}
        open={incomeDrawer.open}
        onClose={() => setIncomeDrawer({ open: false })}
        income={incomeDrawer.item}
        people={people}
        accounts={editableAccounts}
      />
      <ExpenseDrawer
        key={`expense-${expenseDrawer.open}-${expenseDrawer.item?.id ?? "new"}`}
        open={expenseDrawer.open}
        onClose={() => setExpenseDrawer({ open: false })}
        expense={expenseDrawer.item}
        accounts={editableAccounts}
      />
      <EventDrawer
        open={eventDrawer.open}
        onClose={() => setEventDrawer({ open: false })}
        event={eventDrawer.item}
        accounts={editableAccounts}
        people={people}
      />
    </div>
  );
}
