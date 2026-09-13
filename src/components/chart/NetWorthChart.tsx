"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { addMonths, yearOf } from "@/engine/dateMath";
import { rmdStartAgeForBirthYear } from "@/engine/rmd";
import type { Account, ExpenseBaseline, IncomeSource, Person, ScenarioEvent, PeriodSnapshot } from "@/domain";
import type { StressKey } from "@/engine/stress";
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
  dark: { grid: "#172d34", axis: "#8399a0", tooltipBg: "#0e2027", tooltipBorder: "#1f3a42", label: "#e7e7de", stress: "#db7a6e" },
  joy: { grid: "#f4e5d3", axis: "#a68a72", tooltipBg: "#ffffff", tooltipBorder: "#ffe0c7", label: "#4a3729", stress: "#e8555a" },
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

/**
 * Clicking a legend group heading ("Cash", "Tax Deferred") acts on that group
 * only, leaving every other group's visibility alone: if any of its accounts
 * are hidden, show the whole group; if they are all already showing, hide it.
 * That makes the heading a one-click "just this group" when combined with
 * "Hide all", and still un-does itself on a second click.
 */
export function nextHiddenAfterGroupToggle(
  hiddenAccountIds: Set<string>,
  groupAccountIds: string[]
): Set<string> {
  const next = new Set(hiddenAccountIds);
  const anyHidden = groupAccountIds.some((id) => hiddenAccountIds.has(id));
  for (const id of groupAccountIds) {
    if (anyHidden) next.delete(id);
    else next.add(id);
  }
  return next;
}

interface CompareScenarioData {
  name: string;
  years: PeriodSnapshot[];
  events: ScenarioEvent[];
  incomeSources: IncomeSource[];
  expenses: ExpenseBaseline[];
  people: Person[];
}

/** A stress preset's run, drawn as a dashed second line. */
interface StressOverlayData {
  label: string;
  description: string;
  years: PeriodSnapshot[];
}

/** The "Stress ▾" menu: one preset at a time, or none. */
function StressMenu({
  options,
  value,
  onChange,
  onOpenTab,
}: {
  options: { key: StressKey; label: string }[];
  value: StressKey | null;
  onChange: (key: StressKey | null) => void;
  /** Opens the Stress test tab, where every preset runs side by side and the severity is editable. */
  onOpenTab?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);
  const active = options.find((o) => o.key === value) ?? null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Draw the plan under a bad assumption"
        className={`rounded-md border bg-panel-2 px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
          active ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"
        }`}
      >
        {active ? `Stress: ${active.label}` : "Stress test"} ▾
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-panel p-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(o.key === value ? null : o.key);
                setOpen(false);
              }}
              className={`block w-full rounded px-3 py-2 text-left text-sm hover:bg-accent/15 ${o.key === value ? "text-foreground" : "text-dim"}`}
            >
              {o.label}
            </button>
          ))}
          {active && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="mt-1 block w-full rounded px-3 py-2 text-left text-sm text-dim hover:bg-accent/15"
            >
              Clear
            </button>
          )}
          {/* This menu draws one preset over the plan; the tab runs them all
              together and is where the severity of each is set. */}
          {onOpenTab && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenTab();
              }}
              className="mt-1 flex w-full items-center justify-between gap-2 rounded border-t border-border px-3 py-2 pt-2 text-left text-sm text-dim hover:bg-accent/15 hover:text-foreground"
            >
              <span>Compare all, set severity</span>
              <span aria-hidden>→</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const RANGE_PRESETS = [5, 10, 20, 40] as const;

const DOLLAR_OPTIONS = [
  { value: "real" as const, label: "Today’s $" },
  { value: "nominal" as const, label: "Future $" },
];

/** Markers stacked in one column beyond this many collapse into a "+N" chip. */
const MAX_VISIBLE_MARKERS = 4;

/**
 * The ages the engine's rules key off: penalty-free withdrawals at 59½,
 * Medicare at 65, required distributions at 73 or 75. One line per person
 * per milestone, in the year it lands.
 */
function milestoneYears(people: Person[]): { year: number; label: string }[] {
  const out: { year: number; label: string }[] = [];
  for (const p of people) {
    const rmdAge = rmdStartAgeForBirthYear(yearOf(p.birthDate));
    // Each label says what changes that year, not just a number: the line is
    // only worth drawing if it explains itself where it stands.
    const ms: { age: number; text: string }[] = [
      { age: 59.5, text: "59½ · penalty-free" },
      { age: 65, text: "65 · Medicare" },
      { age: rmdAge, text: `${rmdAge} · RMDs start` },
    ];
    for (const m of ms) out.push({ year: yearOf(addMonths(p.birthDate, Math.round(m.age * 12))), label: `${p.name} ${m.text}` });
  }
  return out;
}

/**
 * A milestone line's caption: rotated to read upward from just above the
 * x-axis, where there is room for the whole phrase. Passed to Recharts as an
 * element rather than a label config, so the position and rotation are ours
 * -- `viewBox` is injected by Recharts when it clones this.
 */
function MilestoneLabel({
  text,
  color,
  viewBox,
}: {
  text: string;
  color: string;
  viewBox?: { x?: number; y?: number; height?: number };
}) {
  const box = viewBox ?? {};
  const x = Number(box.x ?? 0);
  const baseline = Number(box.y ?? 0) + Number(box.height ?? 0) - 6;
  return (
    <text
      x={x}
      y={baseline}
      transform={`rotate(-90 ${x} ${baseline})`}
      textAnchor="start"
      dy={-3}
      fill={color}
      fontSize={12}
      fontWeight={500}
      opacity={0.9}
      style={{ pointerEvents: "none" }}
    >
      {text}
    </text>
  );
}

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
  stressOptions,
  stressKey,
  onStressChange,
  onOpenStressTab,
  stressScenario,
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
  stressOptions: { key: StressKey; label: string }[];
  stressKey: StressKey | null;
  onStressChange: (key: StressKey | null) => void;
  /** Switches to the Stress test tab from the chart's own menu. */
  onOpenStressTab?: () => void;
  stressScenario: StressOverlayData | null;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("net_worth");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showMilestones, setShowMilestones] = useState(true);
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  // Escape leaves full screen, the way every other overlay closes.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFullscreen]);
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
  const stressByYear = useMemo(() => {
    if (!stressScenario) return null;
    const map = new Map<number, PeriodSnapshot>();
    for (const y of stressScenario.years) map.set(y.year, y);
    return map;
  }, [stressScenario]);

  const data = useMemo(() => {
    return years.map((y) => {
      const factor = dollarMode === "real" ? y.inflationDeflator : 1;
      const row: Record<string, number> = { year: y.year };
      if (viewMode === "net_worth") {
        row.value = (dollarMode === "real" ? y.netWorthReal : y.netWorthNominal);
        const cy = compareByYear?.get(y.year);
        if (cy) row.compareValue = dollarMode === "real" ? cy.netWorthReal : cy.netWorthNominal;
        const sy = stressByYear?.get(y.year);
        if (sy) row.stressValue = dollarMode === "real" ? sy.netWorthReal : sy.netWorthNominal;
      } else {
        // Stacked areas: assets up, debts below zero, net worth on top.
        row.value = dollarMode === "real" ? y.netWorthReal : y.netWorthNominal;
        for (const a of accounts) {
          const nominal = y.accountBalances[a.id] ?? 0;
          row[a.id] = ((a.category === "liability" ? -1 : 1) * nominal) / factor;
        }
      }
      return row;
    });
  }, [years, viewMode, dollarMode, accounts, compareByYear, stressByYear]);

  const dataYears = useMemo(() => data.map((d) => d.year as number), [data]);
  const milestones = useMemo(() => {
    if (!showMilestones) return [];
    const visible = new Set(dataYears);
    return milestoneYears(people).filter((m) => visible.has(m.year));
  }, [people, dataYears, showMilestones]);
  // Each year tick carries the household's ages beneath it, so the axis reads
  // "2048 · 52 / 50" rather than a bare calendar year.
  const birthYears = useMemo(() => people.map((p) => yearOf(p.birthDate)), [people]);
  const renderYearTick = useCallback(
    (props: { x?: number | string; y?: number | string; payload?: { value?: unknown } }) => {
      const x = Number(props.x ?? 0);
      const y = Number(props.y ?? 0);
      const year = Number(props.payload?.value);
      const ages = birthYears.map((b) => year - b).filter((a) => a >= 0);
      return (
        <g transform={`translate(${x},${y})`}>
          <text x={0} y={0} dy={12} textAnchor="middle" fill={theme.axis} fontSize={12}>
            {year}
          </text>
          {ages.length > 0 && (
            <text x={0} y={0} dy={25} textAnchor="middle" fill={theme.axis} fontSize={10} opacity={0.75}>
              {ages.join(" / ")}
            </text>
          )}
        </g>
      );
    },
    [birthYears, theme.axis]
  );

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

  // Adjacent years whose columns land closer together on screen than an icon
  // is wide (e.g. a decades-long "Full" range squeezes a year into a few
  // pixels) get merged into one shared stack instead of drawing two columns
  // of icons on top of each other. Chained by GAP so a long run of dense
  // years doesn't all collapse into a single stack just because the ends are
  // far apart -- only neighbours close enough to actually collide merge.
  const markerClusters = useMemo(() => {
    if (!layout) return [] as { x: number; list: ChartMarker[] }[];
    const columns = [...markersByYear.entries()]
      .map(([year, list]) => {
        const rawX = layout.xByYear.get(year);
        if (rawX === undefined) return null;
        // Keep icons inside the plot area: markers on the first visible
        // year would otherwise center over the y-axis and sit on top of
        // its dollar labels.
        const x = Math.max(rawX, layout.left + ICON_SIZE / 2 + 10);
        return { x, list };
      })
      .filter((c): c is { x: number; list: ChartMarker[] } => c !== null)
      .sort((a, b) => a.x - b.x);

    const clusters: { xs: number[]; list: ChartMarker[] }[] = [];
    for (const col of columns) {
      const last = clusters[clusters.length - 1];
      if (last && col.x - last.xs[last.xs.length - 1] < ICON_SIZE + ICON_GAP) {
        last.xs.push(col.x);
        last.list.push(...col.list);
      } else {
        clusters.push({ xs: [col.x], list: [...col.list] });
      }
    }
    return clusters.map((c) => ({ x: c.xs.reduce((s, v) => s + v, 0) / c.xs.length, list: c.list }));
  }, [markersByYear, layout]);

  // Per-marker screen position (which cluster, and its slot within that
  // cluster's stack) -- the hover tooltip needs this to place itself, since
  // it looks a marker up by key rather than walking markerClusters itself.
  const markerPositionByKey = useMemo(() => {
    const map = new Map<string, { x: number; index: number }>();
    for (const cluster of markerClusters) {
      cluster.list.forEach((m, i) => map.set(m.key, { x: cluster.x, index: i }));
    }
    return map;
  }, [markerClusters]);

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

  const toggleAccountGroup = (groupAccountIds: string[]) => {
    setHiddenAccountIds((prev) => nextHiddenAfterGroupToggle(prev, groupAccountIds));
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
            <button
              type="button"
              onClick={() => toggleAccountGroup(g.accounts.map((a) => a.id))}
              title={`Show or hide every ${ACCOUNT_CLASS_LABELS[g.cls]} account`}
              className="cursor-pointer text-left text-[10px] font-medium uppercase tracking-wide text-dim/70 hover:text-fg"
              style={{ opacity: g.accounts.every((a) => hiddenAccountIds.has(a.id)) ? 0.5 : 1 }}
            >
              {ACCOUNT_CLASS_LABELS[g.cls]}
            </button>
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
            {viewMode === "net_worth" && stressScenario && (
              <span className="ml-2 font-normal text-dim-2" title={stressScenario.description}>
                · {stressScenario.label}
              </span>
            )}
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
            {people.length > 0 && (
              <Chip
                active={showMilestones}
                onClick={() => setShowMilestones((v) => !v)}
                title="Mark the year each person reaches 59½ (tax-deferred withdrawals stop carrying the 10% penalty), 65 (Medicare), and the age required withdrawals begin. Everyone's age is on the axis either way."
              >
                Milestones
              </Chip>
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
            {viewMode === "net_worth" && (
              <StressMenu options={stressOptions} value={stressKey} onChange={onStressChange} onOpenTab={onOpenStressTab} />
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
          <ComposedChart data={data} margin={{ top: chartTopMargin, right: isJoy ? 24 : 8, left: 8, bottom: 4 }}>
            <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
            {/* Zero is the line that matters -- net worth crossing it, and in
                "By Account" the divide between what is owned and what is owed.
                Solid and brighter, so it doesn't read as one more gridline. */}
            <ReferenceLine y={0} stroke={theme.axis} strokeWidth={1.5} strokeOpacity={0.9} />
            <XAxis dataKey="year" stroke={theme.axis} tick={renderYearTick} height={people.length > 0 ? 34 : 30} />
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
                  if (name === "value") return [formatMoney(Number(value)), "Net worth"];
                  return [formatMoney(Number(value)), accounts.find((a) => a.id === name)?.name ?? String(name)];
                }
                const label =
                  name === "compareValue" ? (compareName ?? "Compare") : name === "stressValue" ? (stressScenario?.label ?? "Stress") : scenarioName;
                return [formatMoney(Number(value)), label];
              }}
            />
            {viewMode === "net_worth" && (
              <Legend
                formatter={(value: string) =>
                  value === "compareValue" ? (compareName ?? "Compare") : value === "stressValue" ? (stressScenario?.label ?? "Stress") : scenarioName
                }
                wrapperStyle={{ fontSize: 12 }}
              />
            )}
            {milestones.map((m, i) => (
              <ReferenceLine
                key={`${m.label}-${i}`}
                x={m.year}
                stroke={theme.axis}
                strokeDasharray="2 4"
                strokeOpacity={0.6}
                /* Drawn from just above the axis and reading upward. Anchored
                   at the top instead, Recharts clips the rotated text to the
                   plot's first few pixels -- "Skylar 59½" arrived as "Sky" --
                   and the top band is where the event markers already sit. */
                label={<MilestoneLabel text={m.label} color={theme.axis} />}
              />
            ))}
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
                {stressScenario && (
                  <Line
                    type="monotone"
                    dataKey="stressValue"
                    stroke={theme.stress}
                    dot={false}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    isAnimationActive={false}
                  />
                )}
              </>
            ) : (
              <>
                {accounts.map((a) => (
                  <Area
                    key={a.id}
                    type="monotone"
                    dataKey={a.id}
                    stackId={a.category === "liability" ? "debts" : "assets"}
                    stroke={accountColors.get(a.id)}
                    fill={accountColors.get(a.id)}
                    fillOpacity={0.55}
                    strokeWidth={1}
                    hide={hiddenAccountIds.has(a.id)}
                    isAnimationActive={false}
                  />
                ))}
                <Line type="monotone" dataKey="value" stroke={theme.label} dot={false} strokeWidth={2} isAnimationActive={false} />
              </>
            )}
            {viewMode === "net_worth" && <MarkerLayoutReporter years={dataYears} onLayout={handleLayout} />}
          </ComposedChart>
        </ResponsiveContainer>

        {viewMode === "net_worth" && layout && (
          <div className="pointer-events-none absolute inset-0">
            {markerClusters.map(({ x, list: fullList }, ci) => {
              const clusterKey = fullList[0]?.key ?? String(ci);
              const collapsed = fullList.length > MAX_VISIBLE_MARKERS && !expandedClusters.has(clusterKey);
              const list = collapsed ? fullList.slice(0, MAX_VISIBLE_MARKERS - 1) : fullList;
              const slots = list.length + (collapsed ? 1 : 0);
              const stackBottom = layout.top + TOP_PAD + slots * (ICON_SIZE + ICON_GAP) - ICON_GAP;
              return (
                <div key={clusterKey}>
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
                  {collapsed && (
                    <button
                      type="button"
                      onClick={() => setExpandedClusters((prev) => new Set(prev).add(clusterKey))}
                      title={`${fullList.length - list.length} more here: click to show`}
                      className="pointer-events-auto absolute flex items-center justify-center rounded-md border border-border bg-panel-2 text-[10px] font-semibold text-dim shadow-sm hover:text-foreground"
                      style={{ left: x - ICON_SIZE / 2, top: layout.top + TOP_PAD + list.length * (ICON_SIZE + ICON_GAP), width: ICON_SIZE, height: ICON_SIZE }}
                    >
                      +{fullList.length - list.length}
                    </button>
                  )}
                </div>
              );
            })}

            {hoverKey &&
              !drag &&
              (() => {
                const m = allMarkers.find((mm) => mm.key === hoverKey);
                if (!m) return null;
                const pos = markerPositionByKey.get(m.key);
                if (!pos) return null;
                const x = pos.x;
                const top = layout.top + TOP_PAD + pos.index * (ICON_SIZE + ICON_GAP);
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
