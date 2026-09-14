"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ProjectionResult, Scenario } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { DEFAULT_STRESS_PARAMS, STRESS_GROUP_LABELS, retirementYearOf, type StressGroup, type StressKey, type StressParams } from "@/engine/stress";
import { netWorthIn, summarizeProjection, yearsOfSpendingCovered, type StressSummary } from "@/engine/stressSummary";
import { useStressAnalysis, type StressRow } from "@/store/useStress";
import { useUiStore } from "@/store/useUiStore";
import { InfoTooltip, inputClass } from "@/components/ui/formFields";

const CHART_THEME = {
  dark: { grid: "#172d34", axis: "#8399a0", tooltipBg: "#0e2027", tooltipBorder: "#1f3a42", label: "#e7e7de", base: "#3fb8a4" },
  joy: { grid: "#f4e5d3", axis: "#a68a72", tooltipBg: "#ffffff", tooltipBorder: "#ffe0c7", label: "#4a3729", base: "#2fb98d" },
} as const;

/** One colour per stressed line, cycled in preset order; the base plan keeps the theme's own colour. */
const STRESS_PALETTE = ["#c9a063", "#db7a6e", "#e8555a", "#9c8cd6", "#d98bb0", "#7fb3d5", "#6fbf9a", "#e0a458", "#b48ead", "#8fa1c9", "#d4a5a5", "#a3be8c", "#ebcb8b", "#bf616a", "#88c0d0"];

const BASE_KEY = "base";
const GROUPS: StressGroup[] = ["markets", "life", "costs"];

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

/** A small numeric box with a unit suffix, committing on blur. */
function NumberField({
  label,
  hint,
  value,
  unit,
  step = 1,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  unit: string;
  step?: number;
  onCommit: (n: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-dim">
      <span className="inline-flex items-center gap-1">
        {label}
        {hint && <InfoTooltip text={hint} />}
      </span>
      <span className="relative block">
        <input
          key={value}
          type="number"
          step={step}
          inputMode="decimal"
          defaultValue={value}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onCommit(n);
          }}
          className={`${inputClass} pr-9`}
        />
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-dim">{unit}</span>
      </span>
    </label>
  );
}

/** The years of spending the investable accounts cover, at a few ages along the plan, as "31 / 18 / 6". */
function coverageLabel(summary: StressSummary, checkpoints: number[]): string {
  const parts = checkpoints.map((year) => {
    const n = yearsOfSpendingCovered(summary, year);
    return n === null ? "—" : n >= 99 ? "99+" : n < 0 ? "0" : String(Math.round(n));
  });
  return parts.join(" / ");
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
  if (row.summary.firstShortfallYear === null) return <span className="text-dim-2">Nothing needed</span>;
  if (row.fixes === undefined) return row.breakingPoint === undefined ? <span className="text-dim-2">—</span> : <Pending label="searching" />;
  if (row.fixes === null) return <span className="text-dim-2">Nothing needed</span>;
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
 * The Stress test view: the plan re-run under each bad assumption, side by
 * side with the base run; for each, where its lever breaks the plan and
 * the smallest single change that mends it; plus the knobs that set how
 * bad. Everything is deterministic, so a row answers "what if" exactly, not
 * on average. The runs happen in a worker pool and land as they finish.
 */
export function StressTestTab({ scenario, projection, dollarMode }: { scenario: Scenario; projection: ProjectionResult; dollarMode: DollarMode }) {
  const params = useUiStore((s) => s.stressParams);
  const setParams = useUiStore((s) => s.setStressParams);
  const overlay = useUiStore((s) => s.stressOverlay);
  const setOverlay = useUiStore((s) => s.setStressOverlay);
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const theme = isJoy ? CHART_THEME.joy : CHART_THEME.dark;
  const real = dollarMode === "real";
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [knobsOpen, setKnobsOpen] = useState(false);

  const base = useMemo(() => summarizeProjection(projection), [projection]);
  const { rows, progress, running, error } = useStressAnalysis(scenario, params, true);

  // The engine's own definition, not a second copy of it: retirement lives on
  // the person now, and one place to ask keeps this row honest.
  const retirementYear = useMemo(() => retirementYearOf(scenario), [scenario]);
  const baseRetire = netWorthIn(base, retirementYear, real);
  const baseEnd = real ? base.netWorthAtEndReal : base.netWorthAtEnd;
  // "vs plan" compares every run in the base plan's final year, so a run
  // that lasts longer (Live longer) is not credited for its extra years.
  const baseEndYear = base.endYear;
  // Years of spending covered, checked at three points along the retirement.
  const checkpoints = useMemo(() => {
    const start = retirementYear ?? base.years[0]?.year ?? baseEndYear;
    return [start + 5, start + 15, start + 25].filter((y) => y <= baseEndYear);
  }, [retirementYear, base.years, baseEndYear]);

  const lines = useMemo(
    () => [
      { key: BASE_KEY, label: scenario.name, summary: base, color: theme.base },
      ...rows.filter((r) => r.summary).map((r, i) => ({ key: r.key as string, label: r.label, summary: r.summary!, color: STRESS_PALETTE[i % STRESS_PALETTE.length] })),
    ],
    [rows, base, scenario.name, theme.base]
  );
  const colorOf = useMemo(() => new Map(lines.map((l) => [l.key, l.color])), [lines]);

  // One row per year across every run (a "live longer" run outlasts the base).
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

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const set = (p: Partial<StressParams>) => setParams({ ...params, ...p });
  const isDefault = JSON.stringify(params) === JSON.stringify(DEFAULT_STRESS_PARAMS);

  const finished = rows.filter((r) => r.summary);
  const holding = finished.filter((r) => r.summary!.firstShortfallYear === null).length;
  const weakest = finished
    .filter((r) => r.summary!.firstShortfallYear !== null)
    .sort((a, b) => (a.summary!.firstShortfallYear ?? 0) - (b.summary!.firstShortfallYear ?? 0))[0];
  const pctDone = progress.total > 0 ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;

  const renderRow = (r: { key: string; label: string; description: string; summary: StressSummary | null; row?: StressRow }) => {
    const isBase = r.key === BASE_KEY;
    const s = r.summary;
    const color = colorOf.get(r.key);
    const lineHidden = hidden.has(r.key);
    const shortfall = s?.firstShortfallYear ?? null;
    const depth = s ? (real ? s.shortfallDepthReal : s.shortfallDepthNominal) : 0;
    return (
      <tr
        key={r.key}
        onClick={() => s && toggle(r.key)}
        className={`border-b border-border-soft last:border-b-0 hover:bg-panel-2/60 ${s ? "cursor-pointer" : ""} ${lineHidden ? "opacity-50" : ""}`}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-start gap-2">
            <i aria-hidden className="mt-1.5 block h-2 w-2 shrink-0 rounded-sm" style={{ background: color ?? "transparent", outline: color ? undefined : "1px dashed currentColor" }} />
            <div className="min-w-0">
              <div className="font-medium">{r.label}</div>
              <div className="max-w-[34rem] text-[11px] text-dim-2">{r.description}</div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5 text-right font-mono tabular-nums">{!s ? <Pending /> : netWorthIn(s, retirementYear, real) === null ? "—" : formatMoney(netWorthIn(s, retirementYear, real)!)}</td>
        <td className="px-3 py-2.5 text-right font-mono tabular-nums">{!s ? <Pending /> : formatMoney(real ? s.netWorthAtEndReal : s.netWorthAtEnd)}</td>
        <td className="px-3 py-2.5 text-right font-mono tabular-nums">{isBase || !s ? <span className="text-dim-2">—</span> : <Delta value={netWorthIn(s, baseEndYear, real)} base={baseEnd} />}</td>
        <td className={`px-3 py-2.5 whitespace-nowrap ${!s ? "" : shortfall === null ? "text-positive" : "text-negative"}`}>
          {!s ? <Pending /> : shortfall === null ? "End of plan" : `Runs short in ${shortfall}`}
          {s && shortfall !== null && depth > 0 && <div className="text-[11px] text-dim-2">by {formatMoney(depth)}</div>}
        </td>
        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-dim">{!s ? "—" : coverageLabel(s, checkpoints)}</td>
        <td className="px-3 py-2.5 text-[12px]">{isBase || !r.row ? <span className="text-dim-2">—</span> : <BreakingPointCell row={r.row} />}</td>
        <td className="px-3 py-2.5 text-[12px]">{isBase || !r.row ? <span className="text-dim-2">—</span> : <FixesCell row={r.row} />}</td>
        <td className="px-3 py-2.5 text-right">
          {!isBase && s && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOverlay(overlay === r.key ? null : (r.key as StressKey));
              }}
              className={`whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] ${overlay === r.key ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"}`}
              title="Draw this test on the Overview chart"
            >
              {overlay === r.key ? "On Overview" : "Show on Overview"}
            </button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div className="text-sm">
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
              {finished.length < rows.length && <span className="text-dim-2"> · {rows.length - finished.length} still running</span>}
            </>
          )}
        </div>
        <div className="flex min-w-[12rem] flex-1 items-center justify-end gap-2 text-[11px] text-dim-2 sm:flex-none">
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
          {!running && !error && <span>Every test runs the whole plan; the searches are exact, not averages.</span>}
          {error && <span className="text-negative">{error}</span>}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-dim">Net worth under each test</h2>
          <span className="text-[11px] text-dim-2">{real ? "Today’s dollars" : "Future dollars"} · click a row to hide or show its line</span>
        </div>
        <ResponsiveContainer width="100%" height={300}>
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
              <Line
                key={l.key}
                type="monotone"
                dataKey={l.key}
                stroke={l.color}
                strokeWidth={l.key === BASE_KEY ? 2.5 : 1.5}
                strokeDasharray={l.key === BASE_KEY ? undefined : "5 3"}
                dot={false}
                hide={hidden.has(l.key)}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-panel">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-border text-[10.5px] font-medium uppercase tracking-[0.08em] text-dim">
              <th className="px-4 py-2.5 text-left">Test</th>
              <th className="px-3 py-2.5 text-right">{retirementYear ? `At retirement (${retirementYear})` : "At retirement"}</th>
              <th className="px-3 py-2.5 text-right">At end of plan</th>
              <th className="px-3 py-2.5 text-right">{baseEndYear ? `vs plan in ${baseEndYear}` : "vs plan"}</th>
              <th className="px-3 py-2.5 text-left">Holds through</th>
              <th className="px-3 py-2.5 text-right">
                <span className="inline-flex items-center gap-1">
                  Years covered
                  <InfoTooltip
                    text={`How many years of that year's spending the investable accounts would cover, checked ${checkpoints.length} times along the plan: in ${checkpoints.join(", ")}.`}
                  />
                </span>
              </th>
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
              <th className="px-3 py-2.5 text-right">On chart</th>
            </tr>
          </thead>
          <tbody>
            {renderRow({ key: BASE_KEY, label: scenario.name, description: "The plan as entered.", summary: base })}
            {GROUPS.map((group) => {
              const members = rows.filter((r) => r.group === group);
              if (members.length === 0) return null;
              return [
                <tr key={`group:${group}`} className="border-b border-border-soft bg-panel-2/40">
                  <td colSpan={9} className="px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim">
                    {STRESS_GROUP_LABELS[group]}
                  </td>
                </tr>,
                ...members.map((r) => renderRow({ key: r.key, label: r.label, description: r.description, summary: r.summary, row: r })),
              ];
            })}
          </tbody>
        </table>
        {baseRetire === null && <p className="border-t border-border px-4 py-2 text-[11px] text-dim-2">Set a retirement age on a person to see each test at retirement.</p>}
      </div>

      <div className="rounded-xl border border-border bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={() => setKnobsOpen((v) => !v)} aria-expanded={knobsOpen} className="text-sm font-semibold text-dim hover:text-foreground">
            <span className="mr-1 inline-block w-3">{knobsOpen ? "▾" : "▸"}</span>How hard each test hits
          </button>
          {!isDefault && (
            <button type="button" onClick={() => setParams(DEFAULT_STRESS_PARAMS)} className="text-[11.5px] text-dim hover:text-foreground">
              Reset to defaults
            </button>
          )}
        </div>
        {knobsOpen && (
          <div className="mt-3 flex flex-col gap-4">
            <div>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim-2">Markets</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <NumberField label="Lower returns: change in return" hint="Added to every investment account's yearly return for the whole plan. Negative = worse." value={Math.round(params.returnDelta * 1000) / 10} unit="pts" step={0.5} onCommit={(n) => set({ returnDelta: n / 100 })} />
                <NumberField label="Bear market: return in the first year" hint="Investments earn exactly this in the year the shock begins, then their normal return. No rebound is assumed." value={Math.round(params.crashReturn * 100)} unit="%" onCommit={(n) => set({ crashReturn: n / 100 })} />
                <NumberField label="Long bear: total fall" hint="The total loss across the bear years, spread evenly." value={Math.round(params.bearTotalDrop * 100)} unit="%" onCommit={(n) => set({ bearTotalDrop: n / 100 })} />
                <NumberField label="Long bear: years" hint="How many consecutive years the market falls." value={params.bearYears} unit="yrs" onCommit={(n) => set({ bearYears: Math.max(1, Math.round(n)) })} />
                <NumberField label="Shock begins: years after retirement" hint="Every bear market and historical replay starts this many years after the first retirement (0 = the retirement year). Year five is often worse than year one: contributions have stopped and Social Security has not started." value={params.sequenceOffsetYears} unit="yrs" onCommit={(n) => set({ sequenceOffsetYears: Math.max(0, Math.round(n)) })} />
                <NumberField label="Historical replays: share in stocks" hint="The replays lay real history over the plan for a portfolio this much in U.S. stocks, the rest in 10-year Treasuries, after inflation." value={Math.round(params.equityShare * 100)} unit="%" onCommit={(n) => set({ equityShare: Math.min(1, Math.max(0, n / 100)) })} />
                <NumberField label="Higher inflation: change in inflation" hint="Added to the plan's inflation rate for the whole plan." value={Math.round(params.inflationDelta * 1000) / 10} unit="pts" step={0.5} onCommit={(n) => set({ inflationDelta: n / 100 })} />
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim-2">Life</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <NumberField label="Live longer: extra years" hint="Added to everyone's planning end age." value={params.extraYears} unit="yrs" onCommit={(n) => set({ extraYears: Math.max(0, Math.round(n)) })} />
                <NumberField label="Spouse dies early: at age" hint="The household member the plan leans on most is modelled as dying at this age." value={params.earlyDeathAge} unit="age" onCommit={(n) => set({ earlyDeathAge: Math.max(1, Math.round(n)) })} />
                <NumberField label="Forced early exit: years early" hint="Everyone still working retires this many years before they planned to." value={params.earlyExitYears} unit="yrs" onCommit={(n) => set({ earlyExitYears: Math.max(0, Math.round(n)) })} />
                <NumberField label="Long-term care: monthly cost" hint="Today's dollars. A private room in a nursing home runs $9,000-$12,000 a month in most of the country; assisted living about half that." value={params.ltcMonthly} unit="$/mo" step={500} onCommit={(n) => set({ ltcMonthly: Math.max(0, n) })} />
                <NumberField label="Long-term care: years of care" hint="The average stay is two to three years; one in five lasts five or more." value={params.ltcYears} unit="yrs" onCommit={(n) => set({ ltcYears: Math.max(1, Math.round(n)) })} />
                <NumberField label="Long-term care: starts at age" hint="Care begins on the oldest person's birthday at this age (pulled earlier if it would fall past their planning end age)." value={params.ltcStartAge} unit="age" onCommit={(n) => set({ ltcStartAge: Math.max(1, Math.round(n)) })} />
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-dim-2">Costs and benefits</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <NumberField label="Spending runs over: by" hint="Every entered expense and retirement spending runs this much higher, for the whole plan." value={Math.round(params.spendingOverrunPct * 100)} unit="%" onCommit={(n) => set({ spendingOverrunPct: n / 100 })} />
                <NumberField label="Healthcare: extra cost growth" hint="Added to the healthcare model's yearly cost growth. The marketplace premium credit is also removed." value={Math.round(params.healthcareExtraGrowthPct * 1000) / 10} unit="pts" step={0.5} onCommit={(n) => set({ healthcareExtraGrowthPct: n / 100 })} />
                <NumberField label="Higher taxes: extra rate" hint="Added to the flat tax rate on retirement income: withdrawals, pension, taxable Social Security and gains." value={Math.round(params.taxDeltaPct * 1000) / 10} unit="pts" step={0.5} onCommit={(n) => set({ taxDeltaPct: n / 100 })} />
                <NumberField label="Social Security pays less: by" hint="Every Social Security benefit is cut by this share from its first check." value={Math.round(params.benefitCutPct * 100)} unit="%" onCommit={(n) => set({ benefitCutPct: n / 100 })} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
