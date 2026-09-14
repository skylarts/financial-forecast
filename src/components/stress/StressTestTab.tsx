"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ProjectionResult, Scenario } from "@/domain";
import { formatMoney, type DollarMode } from "@/lib/format";
import { DEFAULT_STRESS_PARAMS, retirementYearOf, type StressKey, type StressParams } from "@/engine/stress";
import { firstShortfallYear } from "@/engine/planHealth";
import { useStressSuite, type StressRun } from "@/store/useStress";
import { useUiStore } from "@/store/useUiStore";
import { InfoTooltip, inputClass } from "@/components/ui/formFields";

const CHART_THEME = {
  dark: { grid: "#172d34", axis: "#8399a0", tooltipBg: "#0e2027", tooltipBorder: "#1f3a42", label: "#e7e7de", base: "#3fb8a4" },
  joy: { grid: "#f4e5d3", axis: "#a68a72", tooltipBg: "#ffffff", tooltipBorder: "#ffe0c7", label: "#4a3729", base: "#2fb98d" },
} as const;

/** One colour per stressed line, cycled in preset order; the base plan keeps the theme's own colour. */
const STRESS_PALETTE = ["#c9a063", "#db7a6e", "#e8555a", "#9c8cd6", "#d98bb0", "#7fb3d5", "#6fbf9a", "#e0a458", "#b48ead", "#8fa1c9", "#d4a5a5", "#a3be8c", "#ebcb8b", "#bf616a", "#88c0d0"];

const BASE_KEY = "base";

function netWorthAt(result: ProjectionResult, year: number | null, real: boolean): number | null {
  if (year === null) return null;
  const y = result.years.find((s) => s.year === year);
  return y ? (real ? y.netWorthReal : y.netWorthNominal) : null;
}

function endNetWorth(result: ProjectionResult, real: boolean): number {
  return real ? result.kpis.netWorthAtEndReal : result.kpis.netWorthAtEnd;
}

function Delta({ value, base }: { value: number | null; base: number | null }) {
  if (value === null || base === null) return <span className="text-dim-2">—</span>;
  const d = value - base;
  if (Math.abs(d) < 1) return <span className="text-dim-2">—</span>;
  return <span className={d < 0 ? "text-negative" : "text-positive"}>{`${d > 0 ? "+" : "−"}${formatMoney(Math.abs(d))}`}</span>;
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

/**
 * The Stress test view: the plan re-run under each bad assumption, side by
 * side with the base run, plus the knobs that set how bad. Everything is
 * deterministic, so a row answers "what if" exactly, not on average.
 */
export function StressTestTab({ scenario, projection, dollarMode }: { scenario: Scenario; projection: ProjectionResult; dollarMode: DollarMode }) {
  const params = useUiStore((s) => s.stressParams);
  const setParams = useUiStore((s) => s.setStressParams);
  const overlay = useUiStore((s) => s.stressOverlay);
  const setOverlay = useUiStore((s) => s.setStressOverlay);
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const theme = isJoy ? CHART_THEME.joy : CHART_THEME.dark;
  const real = dollarMode === "real";
  const runs = useStressSuite(scenario, params);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // The engine's own definition, not a second copy of it: retirement lives on
  // the person now, and one place to ask keeps this row honest.
  const retirementYear = useMemo(() => retirementYearOf(scenario), [scenario]);

  const baseRetire = netWorthAt(projection, retirementYear, real);
  const baseEnd = endNetWorth(projection, real);
  // "vs plan" compares every run in the base plan's final year, so a run
  // that lasts longer (Live longer) is not credited for its extra years.
  const baseEndYear = projection.years[projection.years.length - 1]?.year ?? null;

  const rows = useMemo(
    () => [
      { key: BASE_KEY, label: scenario.name, description: "The plan as entered.", result: projection, color: theme.base },
      ...runs.map((r: StressRun, i: number) => ({ ...r, color: STRESS_PALETTE[i % STRESS_PALETTE.length] })),
    ],
    [runs, projection, scenario.name, theme.base]
  );

  // One row per year across every run (a "live longer" run outlasts the base).
  const data = useMemo(() => {
    const years = new Set<number>();
    for (const r of rows) for (const y of r.result.years) years.add(y.year);
    return [...years]
      .sort((a, b) => a - b)
      .map((year) => {
        const row: Record<string, number> = { year };
        for (const r of rows) {
          const y = r.result.years.find((s) => s.year === year);
          if (y) row[r.key] = real ? y.netWorthReal : y.netWorthNominal;
        }
        return row;
      });
  }, [rows, real]);

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const set = (p: Partial<StressParams>) => setParams({ ...params, ...p });
  const isDefault = JSON.stringify(params) === JSON.stringify(DEFAULT_STRESS_PARAMS);

  return (
    <div className="flex flex-col gap-4">
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
              formatter={(value, name) => [formatMoney(Number(value)), rows.find((r) => r.key === name)?.label ?? String(name)]}
            />
            {rows.map((r) => (
              <Line
                key={r.key}
                type="monotone"
                dataKey={r.key}
                stroke={r.color}
                strokeWidth={r.key === BASE_KEY ? 2.5 : 1.5}
                strokeDasharray={r.key === BASE_KEY ? undefined : "5 3"}
                dot={false}
                hide={hidden.has(r.key)}
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
              <th className="px-3 py-2.5 text-right">On chart</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const retire = netWorthAt(r.result, retirementYear, real);
              const end = endNetWorth(r.result, real);
              const shortfall = firstShortfallYear(r.result);
              const isBase = r.key === BASE_KEY;
              const lineHidden = hidden.has(r.key);
              return (
                <tr
                  key={r.key}
                  onClick={() => toggle(r.key)}
                  className={`cursor-pointer border-b border-border-soft last:border-b-0 hover:bg-panel-2/60 ${lineHidden ? "opacity-50" : ""}`}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-start gap-2">
                      <i aria-hidden className="mt-1.5 block h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} />
                      <div className="min-w-0">
                        <div className="font-medium">{r.label}</div>
                        <div className="text-[11px] text-dim-2">{r.description}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{retire === null ? "—" : formatMoney(retire)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{formatMoney(end)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {isBase ? <span className="text-dim-2">—</span> : <Delta value={netWorthAt(r.result, baseEndYear, real)} base={baseEnd} />}
                  </td>
                  <td className={`px-3 py-2.5 ${shortfall === null ? "text-positive" : "text-negative"}`}>
                    {shortfall === null ? "End of plan" : `Runs short in ${shortfall}`}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {!isBase && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOverlay(overlay === r.key ? null : (r.key as StressKey));
                        }}
                        className={`rounded-md border px-2 py-0.5 text-[11px] ${
                          overlay === r.key ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"
                        }`}
                        title="Draw this test on the Overview chart"
                      >
                        {overlay === r.key ? "On Overview" : "Show on Overview"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {baseRetire === null && (
          <p className="border-t border-border px-4 py-2 text-[11px] text-dim-2">Add a Retire event to see each test at retirement.</p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-dim">How hard each test hits</h2>
          {!isDefault && (
            <button type="button" onClick={() => setParams(DEFAULT_STRESS_PARAMS)} className="text-[11.5px] text-dim hover:text-foreground">
              Reset to defaults
            </button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            label="Lower returns: change in return"
            hint="Added to every investment account's yearly return for the whole plan. Negative = worse."
            value={Math.round(params.returnDelta * 1000) / 10}
            unit="pts"
            step={0.5}
            onCommit={(n) => set({ returnDelta: n / 100 })}
          />
          <NumberField
            label="Bear market: return in the retirement year"
            hint="Investments earn exactly this in the year of the first Retire event (or the plan's first year), then their normal return. No rebound is assumed."
            value={Math.round(params.crashReturn * 100)}
            unit="%"
            onCommit={(n) => set({ crashReturn: n / 100 })}
          />
          <NumberField
            label="Higher inflation: change in inflation"
            hint="Added to the plan's inflation rate for the whole plan."
            value={Math.round(params.inflationDelta * 1000) / 10}
            unit="pts"
            step={0.5}
            onCommit={(n) => set({ inflationDelta: n / 100 })}
          />
          <NumberField
            label="Live longer: extra years"
            hint="Added to everyone's planning end age."
            value={params.extraYears}
            unit="yrs"
            onCommit={(n) => set({ extraYears: Math.max(0, Math.round(n)) })}
          />
        </div>
      </div>
    </div>
  );
}
