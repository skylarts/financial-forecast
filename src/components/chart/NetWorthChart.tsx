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
import type { Account, AccountClass, ExpenseBaseline, IncomeSource, Person, ScenarioEvent, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { useUiStore } from "@/store/useUiStore";
import { usePlanStore } from "@/store/usePlanStore";
import { buildChartMarkers, type ChartMarker } from "./chartMarkers";
import { MARKER_TONE_CLASS } from "./eventIcons";
import { MarkerLayoutReporter, type MarkerLayout } from "./MarkerLayoutReporter";
import { IncomeDrawer } from "@/components/income/IncomeDrawer";
import { ExpenseDrawer } from "@/components/expenses/ExpenseDrawer";
import { EventDrawer } from "@/components/events/EventDrawer";

/** Pointer movement (px) below which a marker press counts as a click (open
 *  its editor) rather than a drag (reschedule its date). */
const CLICK_MOVE_THRESHOLD = 4;

const CHART_COLORS = ["#5b8def", "#3ecf8e", "#e8555a", "#f4b740", "#a97bea", "#3ec7cf", "#f2789f", "#8fd14f"];
const PINK_CHART_COLORS = ["#ff4fa3", "#c874e8", "#ff8fab", "#f4a63b", "#8a6bea", "#3ec7cf", "#e8555a", "#5b8def"];

/** One base hue per account class, so "By Account" reads as a color family
 *  per class (e.g. every blue is cash) with individual accounts as shades
 *  of that hue rather than unrelated colors. */
const ACCOUNT_CLASS_HUE: Record<AccountClass, number> = {
  cash: 212,
  taxable_investment: 152,
  tax_free: 268,
  tax_deferred: 32,
  real_estate: 176,
  other_asset: 48,
  credit_card: 355,
  loan: 15,
  mortgage: 335,
};

/** Evenly spread lightness across a class's accounts so shades stay visually
 *  distinct even with several accounts in the same class; a single account
 *  gets a mid-range shade. Ranges differ per theme since dark backgrounds
 *  need brighter lines and the light pink theme needs darker ones. */
function accountClassColor(hue: number, index: number, count: number, isPink: boolean): string {
  const saturation = isPink ? 70 : 72;
  const [minL, maxL] = isPink ? [32, 56] : [42, 78];
  const t = count <= 1 ? 0.5 : index / (count - 1);
  const lightness = Math.round(maxL - t * (maxL - minL));
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

// Recharts needs concrete color strings, so mirror the two palettes here.
const CHART_THEME = {
  dark: { grid: "#2a3245", axis: "#9aa4b8", tooltipBg: "#171d2b", tooltipBorder: "#2a3245", label: "#e6e9f0" },
  pink: { grid: "#ffc9e0", axis: "#c06e93", tooltipBg: "#ffe4ef", tooltipBorder: "#ffbcda", label: "#6a2748" },
} as const;

type ViewMode = "net_worth" | "by_account";

const ICON_SIZE = 22;
const ICON_GAP = 4;
const TOP_PAD = 6;

/** Fixed grouping for "By Account" -- cash first (most liquid), then
 *  investment/retirement accounts by tax treatment, then other assets,
 *  then liabilities last. */
const ACCOUNT_CLASS_ORDER: Record<AccountClass, number> = {
  cash: 0,
  taxable_investment: 1,
  tax_free: 2,
  tax_deferred: 3,
  real_estate: 4,
  other_asset: 5,
  credit_card: 6,
  loan: 7,
  mortgage: 8,
};

function sortAccountsForDisplay(list: Account[]): Account[] {
  return [...list].sort((a, b) => ACCOUNT_CLASS_ORDER[a.class] - ACCOUNT_CLASS_ORDER[b.class]);
}

const ACCOUNT_CLASS_LABELS: Record<AccountClass, string> = {
  cash: "Cash",
  taxable_investment: "Taxable",
  tax_free: "Tax-Free",
  tax_deferred: "Tax-Deferred",
  real_estate: "Real Estate",
  other_asset: "Other Assets",
  credit_card: "Credit Cards",
  loan: "Loans",
  mortgage: "Mortgages",
};

/** Splits an already class-sorted account list into consecutive runs of the
 *  same class, for the grouped "By Account" legend. */
function groupAccountsByClass(list: Account[]): { cls: AccountClass; accounts: Account[] }[] {
  const groups: { cls: AccountClass; accounts: Account[] }[] = [];
  for (const a of list) {
    const last = groups[groups.length - 1];
    if (last && last.cls === a.class) last.accounts.push(a);
    else groups.push({ cls: a.class, accounts: [a] });
  }
  return groups;
}

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
  years: YearSnapshot[];
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
}

export function NetWorthChart({
  accounts: allAccounts,
  editableAccounts,
  years,
  dollarMode,
  onDollarModeChange,
  events,
  incomeSources,
  expenses,
  people,
  scenarioName,
  compareOptions,
  compareScenarioId,
  onCompareChange,
  compareScenario,
}: {
  accounts: Account[];
  /** Accounts selectable in the drawers opened by clicking a marker -- excludes the mandatory Extra Savings account etc. */
  editableAccounts: Account[];
  years: YearSnapshot[];
  dollarMode: DollarMode;
  onDollarModeChange: (mode: DollarMode) => void;
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
  scenarioName: string;
  compareOptions: { id: string; name: string }[];
  compareScenarioId: string | null;
  onCompareChange: (id: string | null) => void;
  compareScenario: CompareScenarioData | null;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("net_worth");
  const [hiddenAccountIds, setHiddenAccountIds] = useState<Set<string>>(new Set());
  const [compareMenuOpen, setCompareMenuOpen] = useState(false);
  const isPink = useUiStore((s) => s.theme) === "pink";
  const theme = isPink ? CHART_THEME.pink : CHART_THEME.dark;
  const palette = isPink ? PINK_CHART_COLORS : CHART_COLORS;

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

  const accounts = useMemo(
    () => sortAccountsForDisplay(allAccounts.filter((a) => !a.isExcluded)),
    [allAccounts]
  );

  /** Per-account line/legend color -- a shade of its class's base hue. */
  const accountColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groupAccountsByClass(accounts)) {
      const hue = ACCOUNT_CLASS_HUE[group.cls];
      group.accounts.forEach((a, i) => {
        map.set(a.id, accountClassColor(hue, i, group.accounts.length, isPink));
      });
    }
    return map;
  }, [accounts, isPink]);

  const compareByYear = useMemo(() => {
    if (!compareScenario) return null;
    const map = new Map<number, YearSnapshot>();
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

  const markers = useMemo(
    () => buildChartMarkers({ events, incomeSources, expenses, people }),
    [events, incomeSources, expenses, people]
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
    <div className="rounded-lg border border-border bg-panel p-4">
      <div className="relative mb-1 flex items-center justify-center gap-2">
        <span className="text-base font-semibold">{scenarioName}</span>
        {compareName && <span className="text-sm font-normal text-dim/70">Vs {compareName}</span>}
        {compareOptions.length > 0 && (
          <div className="relative ml-1">
            <button
              type="button"
              onClick={() => setCompareMenuOpen((v) => !v)}
              title={compareName ? `Comparing to ${compareName}` : "Compare to another scenario"}
              aria-label={compareName ? `Comparing to ${compareName}` : "Compare to another scenario"}
              className={`rounded border px-1 py-0.5 text-[10px] leading-none ${
                compareName ? "border-accent text-accent" : "border-border text-dim/50 hover:text-dim"
              }`}
            >
              ⇄
            </button>
            {compareMenuOpen && (
              <div className="absolute left-1/2 top-full z-30 mt-1 w-48 -translate-x-1/2 rounded-md border border-border bg-panel p-1 shadow-lg">
                {compareOptions.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      onCompareChange(o.id);
                      setCompareMenuOpen(false);
                    }}
                    className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-accent/15 ${
                      o.id === compareScenarioId ? "text-foreground" : "text-dim"
                    }`}
                  >
                    {o.name}
                  </button>
                ))}
                {compareName && (
                  <button
                    type="button"
                    onClick={() => {
                      onCompareChange(null);
                      setCompareMenuOpen(false);
                    }}
                    className="mt-1 block w-full rounded border-t border-border px-3 py-2 pt-2 text-left text-sm text-dim hover:bg-accent/15"
                  >
                    Clear comparison
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-dim">
          {viewMode === "net_worth" ? "Net Worth Projection" : "Balance by Account"}
        </h2>
        <div className="flex items-center gap-2">
          {viewMode === "by_account" && (
            <button
              type="button"
              onClick={toggleAllAccounts}
              className="rounded-md border border-border px-2 py-1 text-xs text-dim"
            >
              {allHidden ? "Show all" : "Hide all"}
            </button>
          )}
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("net_worth")}
              className={`rounded px-2 py-1 text-xs ${viewMode === "net_worth" ? "bg-accent text-white" : "text-dim"}`}
            >
              Net Worth
            </button>
            <button
              type="button"
              onClick={() => setViewMode("by_account")}
              className={`rounded px-2 py-1 text-xs ${viewMode === "by_account" ? "bg-accent text-white" : "text-dim"}`}
            >
              By Account
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => onDollarModeChange("nominal")}
              className={`rounded px-2 py-1 text-xs ${dollarMode === "nominal" ? "bg-accent text-white" : "text-dim"}`}
            >
              Nominal
            </button>
            <button
              type="button"
              onClick={() => onDollarModeChange("real")}
              className={`rounded px-2 py-1 text-xs ${dollarMode === "real" ? "bg-accent text-white" : "text-dim"}`}
            >
              Real
            </button>
          </div>
        </div>
      </div>

      <div ref={containerRef} className="relative">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={data} margin={{ top: chartTopMargin, right: 8, left: 8, bottom: 4 }}>
            <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
            <XAxis dataKey="year" stroke={theme.axis} tick={{ fontSize: 12 }} />
            <YAxis stroke={theme.axis} tick={{ fontSize: 12 }} tickFormatter={(v) => formatMoney(v)} width={80} />
            <Tooltip
              contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: 8 }}
              labelStyle={{ color: theme.label }}
              formatter={(value, name) => {
                if (viewMode !== "net_worth") {
                  return [formatMoney(Number(value)), accounts.find((a) => a.id === name)?.name ?? String(name)];
                }
                const label = name === "compareValue" ? (compareName ?? "Compare") : scenarioName;
                return [formatMoney(Number(value)), label];
              }}
            />
            <Legend
              content={viewMode === "by_account" ? renderAccountLegend : undefined}
              formatter={(value: string) => (value === "compareValue" ? (compareName ?? "Compare") : scenarioName)}
              wrapperStyle={{ fontSize: 12 }}
            />
            {viewMode === "net_worth" ? (
              <>
                <Line type="monotone" dataKey="value" stroke={palette[0]} dot={false} strokeWidth={2} />
                {compareName && (
                  <Line
                    type="monotone"
                    dataKey="compareValue"
                    stroke={theme.axis}
                    dot={false}
                    strokeWidth={2}
                    strokeDasharray="6 4"
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
                />
              ))
            )}
            {viewMode === "net_worth" && <MarkerLayoutReporter years={dataYears} onLayout={handleLayout} />}
          </LineChart>
        </ResponsiveContainer>

        {viewMode === "net_worth" && layout && (
          <div className="pointer-events-none absolute inset-0">
            {[...markersByYear.entries()].map(([year, list]) => {
              const x = layout.xByYear.get(year);
              if (x === undefined) return null;
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
                  className="absolute -translate-x-1/2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white"
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
