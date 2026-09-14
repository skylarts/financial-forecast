"use client";

import { Fragment, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ProjectionResult, Scenario } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { DEFAULT_STRESS_PARAMS, STRESS_GROUP_LABELS, retirementYearOf, type StressGroup, type StressKey, type StressParams } from "@/engine/stress";
import { netWorthIn, summarizeProjection, yearsOfSpendingCovered } from "@/engine/stressSummary";
import { useStressAnalysis, type StressRow } from "@/store/useStress";
import { useUiStore } from "@/store/useUiStore";
import { InfoTooltip, inputClass } from "@/components/ui/formFields";
import { Segmented } from "@/components/ui/controls";
import { MonteCarloPanel } from "./MonteCarloPanel";
import { knobsFor, type StressKnob } from "./stressKnobs";

const CHART_THEME = {
  dark: { grid: "#172d34", axis: "#8399a0", tooltipBg: "#0e2027", tooltipBorder: "#1f3a42", label: "#e7e7de", base: "#3fb8a4" },
  joy: { grid: "#f4e5d3", axis: "#a68a72", tooltipBg: "#ffffff", tooltipBorder: "#ffe0c7", label: "#4a3729", base: "#2fb98d" },
} as const;

/** One colour per stressed line, fixed per test so a line keeps its colour when others are hidden. */
const STRESS_PALETTE = ["#c9a063", "#db7a6e", "#e8555a", "#9c8cd6", "#d98bb0", "#7fb3d5", "#6fbf9a", "#e0a458", "#b48ead", "#8fa1c9", "#d4a5a5", "#a3be8c", "#ebcb8b", "#bf616a", "#88c0d0", "#c98ac9", "#8ac9b8", "#c9b58a"];

const BASE_KEY = "base";
const GROUPS: StressGroup[] = ["markets", "life", "costs"];

const VIEW_OPTIONS = [
  { value: "scenarios", label: "Scenarios" },
  { value: "monte_carlo", label: "Monte Carlo" },
] as const;

function Delta({ value, base }: { value: number | null; base: number | null }) {
  if (value === null || base === null) return <span className="text-dim-2">—</span>;
  const d = value - base;
  if (Math.abs(d) < 1) return <span className="text-dim-2">—</span>;
  return <span className={d < 0 ? "text-negative" : "text-positive"}>{`${d > 0 ? "+" : "−"}${formatMoney(Math.abs(d))}`}</span>;
}

function Pending({ label = "…" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-dim-2" aria-label="Still running">
      <i aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-dim-2" />
      {label}
    </span>
  );
}

function KnobField({ knob, params, onChange }: { knob: StressKnob; params: StressParams; onChange: (p: Partial<StressParams>) => void }) {
  const value = knob.toInput(params[knob.param]);
  return (
    <label className="flex flex-col gap-1 text-xs text-dim">
      <span className="inline-flex items-center gap-1">
        {knob.label}
        {knob.hint && <InfoTooltip text={knob.hint} />}
      </span>
      <span className="relative block">
        <input
          key={value}
          type="number"
          step={knob.step ?? 1}
          inputMode="decimal"
          defaultValue={value}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange({ [knob.param]: knob.fromInput(n) });
          }}
          className={`${inputClass} pr-12`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-dim">{knob.unit}</span>
      </span>
    </label>
  );
}

function BreakingPointCell({ row }: { row: StressRow }) {
  if (row.breakingPoint === undefined) return row.summary ? <Pending label="searching" /> : <span className="text-dim-2">—</span>;
  if (row.breakingPoint === null) return <span className="text-dim-2">—</span>;
  const bp = row.breakingPoint;
  const tone = bp.kind === "holds_all" ? "text-positive" : bp.kind === "already_short" ? "text-negative" : "text-foreground";
  return <span className={tone}>{bp.label}</span>;
}

function FixesCell({ row }: { row: StressRow }) {
  if (!row.summary) return <span className="text-dim-2">—</span>;
  if (row.summary.firstShortfallYear === null) return <span className="text-dim-2">—</span>;
  if (row.fixes === undefined) return row.breakingPoint === undefined ? <span className="text-dim-2">—</span> : <Pending label="searching" />;
  if (row.fixes === null) return <span className="text-dim-2">—</span>;
  if (row.fixes.length === 0) return <span className="text-negative">No single change within reach mends it</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {row.fixes.map((f) => (
        <li key={f.kind}>{f.label}</li>
      ))}
    </ul>
  );
}

/**
 * The Stress test view, in two halves behind a toggle: the deterministic
 * scenarios (each one bad assumption over the same plan, with where it
 * breaks and what mends it) and Monte Carlo (hundreds of random futures).
 * The scenarios read as one line each; a row opens to show what it does,
 * its own knobs, and the secondary figures. The chart draws only the rows
 * that are ticked, so it is a comparison you chose rather than every line.
 */
export function StressTestTab({ scenario, projection, dollarMode }: { scenario: Scenario; projection: ProjectionResult; dollarMode: DollarMode }) {
  const params = useUiStore((s) => s.stressParams);
  const setParams = useUiStore((s) => s.setStressParams);
  const view = useUiStore((s) => s.stressView);
  const setView = useUiStore((s) => s.setStressView);
  const chartKeys = useUiStore((s) => s.stressChartKeys);
  const setChartKeys = useUiStore((s) => s.setStressChartKeys);
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const theme = isJoy ? CHART_THEME.joy : CHART_THEME.dark;
  const real = dollarMode === "real";
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<StressGroup>>(new Set());

  const base = useMemo(() => summarizeProjection(projection), [projection]);
  const { rows, progress, running, error } = useStressAnalysis(scenario, params, true);

  // The engine's own definition, not a second copy of it: retirement lives on
  // the person now, and one place to ask keeps this row honest.
  const retirementYear = useMemo(() => retirementYearOf(scenario), [scenario]);
  const baseEnd = real ? base.netWorthAtEndReal : base.netWorthAtEnd;
  // "vs plan" compares every run in the base plan's final year, so a run
  // that lasts longer (Live longer) is not credited for its extra years.
  const baseEndYear = base.endYear;
  const checkpoints = useMemo(() => {
    const start = retirementYear ?? base.years[0]?.year ?? baseEndYear;
    return [start + 5, start + 15, start + 25].filter((y) => y <= baseEndYear);
  }, [retirementYear, base.years, baseEndYear]);

  const colorOf = useMemo(() => new Map(rows.map((r, i) => [r.key as string, STRESS_PALETTE[i % STRESS_PALETTE.length]])), [rows]);
  const onChart = useMemo(() => new Set<string>(chartKeys), [chartKeys]);
  const lines = useMemo(
    () => [
      { key: BASE_KEY, label: scenario.name, summary: base, color: theme.base },
      ...rows.filter((r) => r.summary && onChart.has(r.key)).map((r) => ({ key: r.key as string, label: r.label, summary: r.summary!, color: colorOf.get(r.key)! })),
    ],
    [rows, base, scenario.name, theme.base, onChart, colorOf]
  );

  // One row per year across every drawn run (a "live longer" run outlasts the base).
  const data = useMemo(() => {
    const years = new Set<number>();
    for (const l of lines) for (const y of l.summary.years) years.add(y.year);
    return [...years]
      .sort((a, b) => a - b)
      .map((year) => {
        const row: Record<string, number> = { year };
        for (const l of lines) {
          const y = l.summary.years.find((s) => s.year === year);
          if (y) row[l.key] = real ? y.netWorthReal : y.netWorthNominal;
        }
        return row;
      });
  }, [lines, real]);

  const toggleChart = (key: StressKey) => setChartKeys(onChart.has(key) ? chartKeys.filter((k) => k !== key) : [...chartKeys, key]);
  const toggleIn = <T,>(set: Set<T>, key: T): Set<T> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const set = (p: Partial<StressParams>) => setParams({ ...params, ...p });
  const isDefault = JSON.stringify(params) === JSON.stringify(DEFAULT_STRESS_PARAMS);

  const finished = rows.filter((r) => r.summary);
  const holding = finished.filter((r) => r.summary!.firstShortfallYear === null).length;
  const weakest = finished.filter((r) => r.summary!.firstShortfallYear !== null).sort((a, b) => (a.summary!.firstShortfallYear ?? 0) - (b.summary!.firstShortfallYear ?? 0))[0];
  const pctDone = progress.total > 0 ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;

  const renderRow = (r: StressRow) => {
    const s = r.summary;
    const color = colorOf.get(r.key)!;
    const isOpen = open.has(r.key);
    const drawn = onChart.has(r.key);
    const shortfall = s?.firstShortfallYear ?? null;
    const depth = s ? (real ? s.shortfallDepthReal : s.shortfallDepthNominal) : 0;
    const knobs = knobsFor(r.key);
    const retire = s ? netWorthIn(s, retirementYear, real) : null;
    return (
      <Fragment key={r.key}>
        <tr onClick={() => setOpen((prev) => toggleIn(prev, r.key))} className={`cursor-pointer border-b border-border-soft hover:bg-panel-2/60 ${isOpen ? "bg-panel-2/40" : ""}`}>
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 text-[10px] text-dim-2">{isOpen ? "▾" : "▸"}</span>
              <span className="font-medium">{r.label}</span>
            </div>
          </td>
          <td className={`px-3 py-2 whitespace-nowrap ${!s ? "" : shortfall === null ? "text-positive" : "text-negative"}`}>
            {!s ? <Pending /> : shortfall === null ? "End of plan" : `Short in ${shortfall}`}
            {s && shortfall !== null && depth > 0 && <span className="ml-1 text-[11px] text-dim-2">by {formatMoney(depth)}</span>}
          </td>
          <td className="px-3 py-2 text-right font-mono tabular-nums">{!s ? <Pending /> : <Delta value={netWorthIn(s, baseEndYear, real)} base={baseEnd} />}</td>
          <td className="px-3 py-2 text-[12px]">
            <BreakingPointCell row={r} />
          </td>
          <td className="px-3 py-2 text-[12px]">
            <FixesCell row={r} />
          </td>
          <td className="px-3 py-2 text-right">
            <button
              type="button"
              disabled={!s}
              onClick={(e) => {
                e.stopPropagation();
                toggleChart(r.key);
              }}
              aria-pressed={drawn}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] ${drawn ? "border-accent text-foreground" : "border-border text-dim hover:text-foreground"} disabled:opacity-40`}
              title={drawn ? "Remove this test from the chart" : "Draw this test on the chart"}
            >
              <i aria-hidden className="block h-2 w-2 rounded-sm" style={{ background: drawn ? color : "transparent", outline: drawn ? undefined : "1px solid currentColor" }} />
              {drawn ? "On chart" : "Chart"}
            </button>
          </td>
        </tr>
        {isOpen && (
          <tr className="border-b border-border-soft bg-panel-2/25">
            <td colSpan={6} className="px-4 py-3">
              <div className="flex flex-col gap-3 pl-5">
                <p className="max-w-3xl text-[12px] text-dim">{r.description}</p>
                {knobs.length > 0 && (
                  <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
                    {knobs.map((k) => (
                      <KnobField key={k.param} knob={k} params={params} onChange={set} />
                    ))}
                  </div>
                )}
                {s && (
                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-dim-2">
                    <div>
                      <dt className="inline">At retirement{retirementYear ? ` (${retirementYear})` : ""}: </dt>
                      <dd className="inline font-mono text-dim">{retire === null ? "—" : formatMoney(retire)}</dd>
                    </div>
                    <div>
                      <dt className="inline">At end of plan: </dt>
                      <dd className="inline font-mono text-dim">{formatMoney(real ? s.netWorthAtEndReal : s.netWorthAtEnd)}</dd>
                    </div>
                    {checkpoints.length > 0 && (
                      <div>
                        <dt className="inline">
                          Years of spending covered in {checkpoints.join(" / ")}:{" "}
                          <InfoTooltip text="How many years of that year's spending the investable accounts (cash, investments, HSA) would cover at its end." />
                        </dt>
                        <dd className="inline font-mono text-dim">
                          {checkpoints
                            .map((year) => {
                              const n = yearsOfSpendingCovered(s, year);
                              return n === null ? "—" : n >= 99 ? "99+" : n < 0 ? "0" : String(Math.round(n));
                            })
                            .join(" / ")}
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented ariaLabel="Which half of the stress test to show" options={VIEW_OPTIONS} value={view} onChange={setView} />
        <div className="flex items-center gap-2 text-[11px] text-dim-2">
          {running && (
            <>
              <span className="whitespace-nowrap">
                {progress.done} of {progress.total} runs
              </span>
              <span className="h-1.5 w-32 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={pctDone} aria-valuemin={0} aria-valuemax={100}>
                <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${pctDone}%` }} />
              </span>
            </>
          )}
          {error && <span className="text-negative">{error}</span>}
        </div>
      </div>

      {view === "monte_carlo" ? (
        <MonteCarloPanel scenario={scenario} base={base} real={real} ready={!running} retirementYear={retirementYear} />
      ) : (
        <>
          <div className="rounded-xl border border-border bg-panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm">
                {finished.length === 0 ? (
                  <span className="text-dim">Running every test…</span>
                ) : (
                  <>
                    <span className="font-semibold">
                      {holding} of {rows.length} tests hold
                    </span>
                    {weakest && (
                      <span className="text-dim">
                        {" "}
                        · weakest: {weakest.label}, short in {weakest.summary!.firstShortfallYear}
                      </span>
                    )}
                  </>
                )}
              </h2>
              <div className="flex items-center gap-3 text-[11px] text-dim-2">
                <span>{real ? "Today’s dollars" : "Future dollars"}</span>
                <span>·</span>
                <button type="button" onClick={() => setChartKeys(rows.map((r) => r.key))} className="text-dim hover:text-foreground">
                  Show all
                </button>
                <button type="button" onClick={() => setChartKeys([])} className="text-dim hover:text-foreground">
                  Hide all
                </button>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
                <XAxis dataKey="year" stroke={theme.axis} tick={{ fontSize: 12 }} />
                <YAxis stroke={theme.axis} tick={{ fontSize: 12 }} tickFormatter={(v) => formatMoney(v)} width={80} />
                <Tooltip
                  contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: 8 }}
                  labelStyle={{ color: theme.label }}
                  itemSorter={(item) => -(Number(item.value) || 0)}
                  formatter={(value, name) => [formatMoney(Number(value)), lines.find((l) => l.key === name)?.label ?? String(name)]}
                />
                {lines.map((l) => (
                  <Line key={l.key} type="monotone" dataKey={l.key} stroke={l.color} strokeWidth={l.key === BASE_KEY ? 2.5 : 1.5} strokeDasharray={l.key === BASE_KEY ? undefined : "5 3"} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
            {lines.length === 1 && <p className="mt-2 text-center text-[11px] text-dim-2">Tick a test below to draw it against the plan.</p>}
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-panel">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border text-[10.5px] font-medium uppercase tracking-[0.08em] text-dim">
                  <th className="px-4 py-2.5 text-left">Test</th>
                  <th className="px-3 py-2.5 text-left">Holds through</th>
                  <th className="px-3 py-2.5 text-right">{baseEndYear ? `vs plan in ${baseEndYear}` : "vs plan"}</th>
                  <th className="px-3 py-2.5 text-left">
                    <span className="inline-flex items-center gap-1">
                      Breaking point
                      <InfoTooltip text="How far this test's one number can go before the plan first runs short: the largest value it survives. Found by re-running the plan and narrowing in." />
                    </span>
                  </th>
                  <th className="px-3 py-2.5 text-left">
                    <span className="inline-flex items-center gap-1">
                      What would fix it
                      <InfoTooltip text="For a test that runs short: the smallest single change that makes the plan hold under it. Spend less (every entered expense), work longer (every retirement still ahead), or have more saved today." />
                    </span>
                  </th>
                  <th className="px-3 py-2.5 text-right">Chart</th>
                </tr>
              </thead>
              <tbody>
                {GROUPS.map((group) => {
                  const members = rows.filter((r) => r.group === group);
                  if (members.length === 0) return null;
                  const isCollapsed = collapsed.has(group);
                  const groupHolding = members.filter((r) => r.summary && r.summary.firstShortfallYear === null).length;
                  return (
                    <Fragment key={group}>
                      <tr onClick={() => setCollapsed((prev) => toggleIn(prev, group))} className="cursor-pointer border-b border-border-soft bg-panel-2/40 hover:bg-panel-2/70">
                        <td colSpan={6} className="px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim">
                          <span className="mr-1 inline-block w-3">{isCollapsed ? "▸" : "▾"}</span>
                          {STRESS_GROUP_LABELS[group]}
                          <span className="ml-2 font-normal normal-case tracking-normal text-dim-2">
                            {members.length} tests{members.some((r) => r.summary) ? `, ${groupHolding} hold` : ""}
                          </span>
                        </td>
                      </tr>
                      {!isCollapsed && members.map(renderRow)}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-[11px] text-dim-2">
              <span>Click a test to see what it does and change how hard it hits. Every test runs the whole plan; the searches are exact, not averages.</span>
              {!isDefault && (
                <button type="button" onClick={() => setParams(DEFAULT_STRESS_PARAMS)} className="text-dim hover:text-foreground">
                  Reset every test to defaults
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
