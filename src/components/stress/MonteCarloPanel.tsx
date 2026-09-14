"use client";

import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Scenario } from "@/domain";
import { formatMoney } from "@/lib/format";
import { DEFAULT_MONTE_CARLO_PARAMS, type MonteCarloModel, type MonteCarloParams } from "@/engine/monteCarlo";
import type { StressSummary } from "@/engine/stressSummary";
import { useMonteCarlo } from "@/store/useMonteCarlo";
import { useUiStore } from "@/store/useUiStore";
import { InfoTooltip, inputClass } from "@/components/ui/formFields";
import { Segmented } from "@/components/ui/controls";

const CHART_THEME = {
  dark: { grid: "#172d34", axis: "#8399a0", tooltipBg: "#0e2027", tooltipBorder: "#1f3a42", label: "#e7e7de", base: "#3fb8a4", fan: "#9c8cd6" },
  joy: { grid: "#f4e5d3", axis: "#a68a72", tooltipBg: "#ffffff", tooltipBorder: "#ffe0c7", label: "#4a3729", base: "#2fb98d", fan: "#8a6fd1" },
} as const;

const PATH_OPTIONS = [
  { value: "200", label: "200" },
  { value: "500", label: "500" },
  { value: "1000", label: "1,000" },
] as const;

const MODEL_OPTIONS: readonly { value: MonteCarloModel; label: string }[] = [
  { value: "history", label: "Years drawn from history" },
  { value: "normal", label: "Bell curve" },
];

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "1 in 8" for 12.5%; "fewer than 1 in 100" below a percent; "none" at zero. */
function oneIn(share: number): string {
  if (share <= 0) return "none";
  if (share < 0.01) return "fewer than 1 in 100";
  if (share >= 0.5) return pct(share);
  return `1 in ${Math.round(1 / share)}`;
}

function NumberField({ label, hint, value, unit, step = 1, onCommit }: { label: string; hint?: string; value: number; unit: string; step?: number; onCommit: (n: number) => void }) {
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
 * Monte Carlo under the deterministic table: the plan run hundreds of times
 * with a different random sequence of returns each time. The headline is
 * how often it holds; the chart is the range of net worth the paths cover,
 * with the plan's own line through it. Runs once the deterministic tests
 * have finished, so the two never compete for the workers.
 */
export function MonteCarloPanel({ scenario, base, real, ready, retirementYear }: { scenario: Scenario; base: StressSummary; real: boolean; ready: boolean; retirementYear: number | null }) {
  const params = useUiStore((s) => s.monteCarloParams);
  const setParams = useUiStore((s) => s.setMonteCarloParams);
  const isJoy = useUiStore((s) => s.theme) === "joy";
  const theme = isJoy ? CHART_THEME.joy : CHART_THEME.dark;
  const { result, progress, running, error } = useMonteCarlo(scenario, params, true, ready);
  const set = (p: Partial<MonteCarloParams>) => setParams({ ...params, ...p });
  const isDefault = JSON.stringify(params) === JSON.stringify(DEFAULT_MONTE_CARLO_PARAMS);

  const data = useMemo(() => {
    if (!result) return [];
    return result.years.map((y) => {
      const b = base.years.find((s) => s.year === y.year);
      return {
        year: y.year,
        outer: real ? [y.p10Real, y.p90Real] : [y.p10, y.p90],
        inner: real ? [y.p25Real, y.p75Real] : [y.p25, y.p75],
        median: real ? y.p50Real : y.p50,
        plan: b ? (real ? b.netWorthReal : b.netWorthNominal) : undefined,
      };
    });
  }, [result, base, real]);

  // The chance of having run short by a few points along the plan.
  const checkpoints = useMemo(() => {
    if (!result) return [];
    const start = retirementYear ?? result.years[0]?.year ?? 0;
    const end = result.years[result.years.length - 1]?.year ?? start;
    const wanted = [start + 10, start + 20, end].filter((y, i, arr) => y <= end && arr.indexOf(y) === i);
    return wanted.map((year) => ({ year, share: result.years.find((y) => y.year === year)?.shortBy ?? 0, isEnd: year === end }));
  }, [result, retirementYear]);

  const pctDone = progress.total > 0 ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : 0;
  const success = result?.successRate ?? null;
  const tone = success === null ? "text-dim" : success >= 0.9 ? "text-positive" : success >= 0.75 ? "text-foreground" : "text-negative";

  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-dim">
            Monte Carlo: {params.paths.toLocaleString("en-US")} random futures
            <InfoTooltip text="The plan run once per path, each with a different random sequence of yearly investment returns. Randomizes returns only: inflation, spending, lifespans and everything else stay exactly as planned. Every investment account gets the same return in a year." />
          </h2>
          <div className={`mt-1 text-xl font-semibold ${tone}`}>
            {!ready && !result ? (
              <span className="text-sm font-normal text-dim-2">Waiting for the tests above to finish…</span>
            ) : success === null ? (
              <span className="text-sm font-normal text-dim-2">Running…</span>
            ) : (
              <>
                Holds in {pct(success)} of futures
                {running && <span className="ml-2 text-xs font-normal text-dim-2">(so far)</span>}
              </>
            )}
          </div>
          {result && result.medianShortfallYear !== null && (
            <div className="text-[11.5px] text-dim-2">When it runs short, the typical year is {result.medianShortfallYear}.</div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] text-dim-2">
          {running && (
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap">
                {progress.done} of {progress.total} runs
              </span>
              <span className="h-1.5 w-32 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={pctDone} aria-valuemin={0} aria-valuemax={100}>
                <span className="block h-full rounded-full bg-accent transition-[width]" style={{ width: `${pctDone}%` }} />
              </span>
            </div>
          )}
          {error && <span className="text-negative">{error}</span>}
          {checkpoints.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {checkpoints.map((c) => (
                <span key={c.year}>
                  Short by {c.isEnd ? "the end" : c.year}: <span className="font-mono text-foreground">{oneIn(c.share)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {data.length > 0 && (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
            <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
            <XAxis dataKey="year" stroke={theme.axis} tick={{ fontSize: 12 }} />
            <YAxis stroke={theme.axis} tick={{ fontSize: 12 }} tickFormatter={(v) => formatMoney(v)} width={80} />
            <Tooltip
              contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: 8 }}
              labelStyle={{ color: theme.label }}
              formatter={(value, name) => {
                const label = name === "outer" ? "10th–90th percentile" : name === "inner" ? "25th–75th percentile" : name === "median" ? "Median future" : scenario.name;
                const text = Array.isArray(value) ? `${formatMoney(Number(value[0]))} – ${formatMoney(Number(value[1]))}` : formatMoney(Number(value));
                return [text, label];
              }}
            />
            <Area type="monotone" dataKey="outer" stroke="none" fill={theme.fan} fillOpacity={0.14} isAnimationActive={false} />
            <Area type="monotone" dataKey="inner" stroke="none" fill={theme.fan} fillOpacity={0.24} isAnimationActive={false} />
            <Line type="monotone" dataKey="median" stroke={theme.fan} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="plan" stroke={theme.base} strokeWidth={2.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-dim">
          <span className="inline-flex items-center gap-1">
            Each year&apos;s return
            <InfoTooltip text="Years drawn from history: each year is a random real year from 1928-2024 for a portfolio this much in stocks, shifted so the long-run average equals the plan's own expected return -- history's shape, the plan's average. Bell curve: a normal distribution around the plan's expected return with the volatility you set." />
          </span>
          <Segmented ariaLabel="How each year's return is drawn" size="sm" options={MODEL_OPTIONS} value={params.model} onChange={(model) => set({ model })} />
        </div>
        <div className="flex flex-col gap-1 text-xs text-dim">
          <span>Paths</span>
          <Segmented ariaLabel="How many random futures to run" size="sm" options={PATH_OPTIONS} value={String(params.paths) as (typeof PATH_OPTIONS)[number]["value"]} onChange={(v) => set({ paths: Number(v) })} />
        </div>
        {params.model === "history" ? (
          <div className="w-40">
            <NumberField label="Share in stocks" hint="The rest is in 10-year Treasuries." value={Math.round(params.equityShare * 100)} unit="%" onCommit={(n) => set({ equityShare: Math.min(1, Math.max(0, n / 100)) })} />
          </div>
        ) : (
          <div className="w-40">
            <NumberField label="Volatility" hint="Yearly standard deviation of returns. About 12% for a 60/40 mix, 17% for all stocks." value={Math.round(params.volatility * 100)} unit="%" onCommit={(n) => set({ volatility: Math.max(0, n / 100) })} />
          </div>
        )}
        <button type="button" onClick={() => set({ seed: params.seed + 1 })} className="rounded-md border border-border px-2.5 py-1 text-[11.5px] text-dim hover:text-foreground" title="Draw a fresh set of random futures">
          Re-roll
        </button>
        {!isDefault && (
          <button type="button" onClick={() => setParams(DEFAULT_MONTE_CARLO_PARAMS)} className="text-[11.5px] text-dim hover:text-foreground">
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  );
}
