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
import type { Account, ExpenseBaseline, IncomeSource, Person, ScenarioEvent, TimelineRow, YearSnapshot } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { useUiStore } from "@/store/useUiStore";
import { usePlanStore } from "@/store/usePlanStore";
import { buildChartMarkers, type ChartMarker } from "./chartMarkers";
import { MARKER_TONE_CLASS } from "./eventIcons";
import { MarkerLayoutReporter, type MarkerLayout } from "./MarkerLayoutReporter";

const CHART_COLORS = ["#5b8def", "#3ecf8e", "#e8555a", "#f4b740", "#a97bea", "#3ec7cf", "#f2789f", "#8fd14f"];
const PINK_CHART_COLORS = ["#ff4fa3", "#c874e8", "#ff8fab", "#f4a63b", "#8a6bea", "#3ec7cf", "#e8555a", "#5b8def"];

// Recharts needs concrete color strings, so mirror the two palettes here.
const CHART_THEME = {
  dark: { grid: "#2a3245", axis: "#9aa4b8", tooltipBg: "#171d2b", tooltipBorder: "#2a3245", label: "#e6e9f0" },
  pink: { grid: "#ffc9e0", axis: "#c06e93", tooltipBg: "#ffe4ef", tooltipBorder: "#ffbcda", label: "#6a2748" },
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

export function NetWorthChart({
  accounts: allAccounts,
  years,
  dollarMode,
  onDollarModeChange,
  events,
  incomeSources,
  expenses,
  timeline,
  people,
}: {
  accounts: Account[];
  years: YearSnapshot[];
  dollarMode: DollarMode;
  onDollarModeChange: (mode: DollarMode) => void;
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  timeline: TimelineRow[];
  people: Person[];
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("net_worth");
  const [hiddenAccountIds, setHiddenAccountIds] = useState<Set<string>>(new Set());
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
    () => allAccounts.filter((a) => !a.isExcluded),
    [allAccounts]
  );

  const data = useMemo(() => {
    return years.map((y) => {
      const factor = dollarMode === "real" ? y.inflationDeflator : 1;
      const row: Record<string, number> = { year: y.year };
      if (viewMode === "net_worth") {
        row.value = (dollarMode === "real" ? y.netWorthReal : y.netWorthNominal);
      } else {
        for (const a of accounts) {
          const nominal = y.accountBalances[a.id] ?? 0;
          row[a.id] = nominal / factor;
        }
      }
      return row;
    });
  }, [years, viewMode, dollarMode, accounts]);

  const dataYears = useMemo(() => data.map((d) => d.year as number), [data]);

  const markers = useMemo(
    () => buildChartMarkers({ events, incomeSources, expenses, timeline, people }),
    [events, incomeSources, expenses, timeline, people]
  );

  const markersByYear = useMemo(() => {
    const yearSet = new Set(dataYears);
    const map = new Map<number, ChartMarker[]>();
    for (const m of markers) {
      if (!yearSet.has(m.year)) continue;
      const list = map.get(m.year) ?? [];
      list.push(m);
      map.set(m.year, list);
    }
    return map;
  }, [markers, dataYears]);

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
    if (!layout) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const rect = containerRef.current!.getBoundingClientRect();
    const pointerX = e.clientX - rect.left;
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
    const rect = containerRef.current!.getBoundingClientRect();
    const x = Math.min(layout.right, Math.max(layout.left, e.clientX - rect.left));
    const year = nearestYear(x, layout);
    setDrag((prev) => (prev ? { ...prev, pointerX: x, year } : prev));
  };

  const handleMarkerPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    e.stopPropagation();
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    applyDrag(drag);
    setDrag(null);
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

  return (
    <div className="rounded-lg border border-border bg-panel p-4">
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
              formatter={(value, name) => [
                formatMoney(Number(value)),
                viewMode === "net_worth" ? "Net Worth" : accounts.find((a) => a.id === name)?.name ?? String(name),
              ]}
            />
            <Legend
              onClick={(e) => {
                if (viewMode === "by_account" && typeof e.dataKey === "string") toggleAccount(e.dataKey);
              }}
              formatter={(value: string) =>
                viewMode === "net_worth" ? "Net Worth" : accounts.find((a) => a.id === value)?.name ?? value
              }
              wrapperStyle={{ fontSize: 12, cursor: viewMode === "by_account" ? "pointer" : "default" }}
            />
            {viewMode === "net_worth" ? (
              <Line type="monotone" dataKey="value" stroke={palette[0]} dot={false} strokeWidth={2} />
            ) : (
              accounts.map((a, i) => (
                <Line
                  key={a.id}
                  type="monotone"
                  dataKey={a.id}
                  stroke={palette[i % palette.length]}
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
                        className={`pointer-events-auto absolute flex cursor-grab items-center justify-center rounded-md text-xs shadow-sm active:cursor-grabbing ${MARKER_TONE_CLASS[m.kind]}`}
                        style={{
                          left: x - ICON_SIZE / 2,
                          top,
                          width: ICON_SIZE,
                          height: ICON_SIZE,
                          opacity: isDragging ? 0 : 1,
                          touchAction: "none",
                          userSelect: "none",
                        }}
                        onPointerDown={(e) => handleMarkerPointerDown(e, m, top)}
                        onPointerMove={handleMarkerPointerMove}
                        onPointerUp={handleMarkerPointerUp}
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
                const m = markers.find((mm) => mm.key === hoverKey);
                if (!m) return null;
                const x = layout.xByYear.get(m.year);
                if (x === undefined) return null;
                const list = markersByYear.get(m.year) ?? [];
                const idx = list.findIndex((mm) => mm.key === m.key);
                const top = layout.top + TOP_PAD + Math.max(0, idx) * (ICON_SIZE + ICON_GAP);
                return (
                  <div
                    className="absolute z-20 w-56 -translate-x-1/2 rounded-md border border-border bg-panel p-2 text-xs shadow-lg"
                    style={{ left: x, top: top + ICON_SIZE + 6 }}
                  >
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] ${MARKER_TONE_CLASS[m.kind]}`}>
                      {m.badge}
                    </span>
                    <div className="mt-1 font-semibold">{m.title}</div>
                    {m.detail && <div className="text-dim">{m.detail}</div>}
                    <div className="mt-1 text-dim">{m.startDate}</div>
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
    </div>
  );
}
