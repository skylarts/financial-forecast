import { useEffect, useMemo, useRef, useState } from "react";
import type { Scenario } from "@/domain";
import type { ProjectionOptions } from "@/engine/forecastScenario";
import { applicableStressPresets, type StressGroup, type StressKey, type StressParams, type StressPreset } from "@/engine/stress";
import { findBreakingPoint, findFixes, SEARCH_STEPS, type BreakingPoint, type Fix, type Runner } from "@/engine/stressSolver";
import type { StressSummary } from "@/engine/stressSummary";
import { CancelledError, runProjection } from "./projectionPool";

export interface StressRow {
  key: StressKey;
  label: string;
  group: StressGroup;
  description: string;
  /** Null while the run is still queued. */
  summary: StressSummary | null;
  /** Undefined while searching; null for a preset with nothing to search. */
  breakingPoint: BreakingPoint | null | undefined;
  /** Undefined while searching; empty when nothing within reach mends it; null when the run holds and needs no fix. */
  fixes: Fix[] | null | undefined;
}

export interface StressAnalysis {
  rows: StressRow[];
  /** Projections finished out of those planned (the plan grows as broken runs are found). */
  progress: { done: number; total: number };
  running: boolean;
  error: string | null;
}

/** Runs per breaking-point search: the two ends, then the halvings. */
const SEARCH_RUNS = 2 + SEARCH_STEPS;
/** Worst-case runs per fix search: three kinds, each a range check plus the halvings. */
const FIX_RUNS = 3 * (1 + SEARCH_STEPS);

/**
 * The whole stress analysis for a plan, computed in the worker pool and
 * delivered as it lands: every applicable preset's run first, then the
 * breaking point of each preset with a lever, then the smallest fix for
 * each run that broke. An edit to the plan or the parameters cancels what
 * is still queued and starts over.
 */
export function useStressAnalysis(scenario: Scenario, params: StressParams, enabled: boolean): StressAnalysis {
  const presets = useMemo(() => applicableStressPresets(scenario), [scenario]);
  const [rows, setRows] = useState<StressRow[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const gen = ++generation.current;
    const live = () => generation.current === gen;
    const levers = presets.filter((p) => p.lever).length;
    let total = 1 + presets.length + levers * SEARCH_RUNS;
    let done = 0;

    const patch = (key: StressKey, change: Partial<StressRow>) => {
      if (!live()) return;
      setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
    };
    const tick = () => {
      done += 1;
      if (live()) setProgress({ done, total });
    };

    const analyse = async () => {
      // Reset for this plan: every row queued, nothing known yet.
      setRows(presets.map((p) => ({ key: p.key, label: p.label, group: p.group, description: p.describe(params, scenario), summary: null, breakingPoint: undefined, fixes: undefined })));
      setProgress({ done, total });
      setRunning(true);
      setError(null);
      try {
        // The base run settles the tax rates every stressed run is seeded from.
        const base = await runProjection(scenario, {}, gen, true);
        tick();
        const seeded = (options: ProjectionOptions): ProjectionOptions => ({ ...options, seedTaxRates: base.ratesByYear });
        const runner: Runner = async (s, options) => {
          const r = await runProjection(s, seeded(options), gen);
          tick();
          return r.summary;
        };

        // Phase 1: every preset, in parallel across the pool.
        const summaries = await Promise.all(
          presets.map(async (preset: StressPreset) => {
            const { scenario: stressed, options } = preset.apply(scenario, params);
            const summary = await runner(stressed, options);
            patch(preset.key, { summary });
            return { preset, summary, stressed, options };
          })
        );
        if (!live()) return;

        // Phase 2: where each lever breaks the plan. Phase 3, queued behind
        // it: what mends each run that broke.
        const broken = summaries.filter((s) => s.summary.firstShortfallYear !== null);
        total += broken.length * FIX_RUNS;
        setProgress({ done, total });
        await Promise.all(
          presets.map(async (preset) => {
            const breakingPoint = await findBreakingPoint(scenario, preset, params, runner);
            patch(preset.key, { breakingPoint });
          })
        );
        if (!live()) return;
        await Promise.all(
          summaries.map(async ({ preset, summary, stressed, options }) => {
            if (summary.firstShortfallYear === null) {
              patch(preset.key, { fixes: null });
              return;
            }
            const before = done;
            const fixes = await findFixes({ scenario: stressed, options }, runner);
            // A fix search that finished early (a kind left out) still counts its whole budget.
            done = Math.max(done, before + FIX_RUNS);
            patch(preset.key, { fixes });
          })
        );
        if (live()) {
          setProgress({ done: total, total });
          setRunning(false);
        }
      } catch (err) {
        if (err instanceof CancelledError || !live()) return;
        setError(err instanceof Error ? err.message : String(err));
        setRunning(false);
      }
    };
    void analyse();

    return () => {
      // A newer plan supersedes this one: drop what has not started.
      generation.current += 1;
    };
    // `presets` is derived from `scenario`; listing both would only re-run the same work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, params, enabled]);

  return { rows, progress, running, error };
}
