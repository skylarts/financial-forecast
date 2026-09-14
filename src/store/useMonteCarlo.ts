import { useEffect, useRef, useState } from "react";
import type { Scenario } from "@/domain";
import { generatePaths, summarizeMonteCarlo, type MonteCarloParams, type MonteCarloResult } from "@/engine/monteCarlo";
import type { StressSummary } from "@/engine/stressSummary";
import { CancelledError, runProjection } from "./projectionPool";

export interface MonteCarloState {
  /** The fan and success rate so far; updated as paths land, final when `running` is false. */
  result: MonteCarloResult | null;
  progress: { done: number; total: number };
  running: boolean;
  error: string | null;
}

/** How often the partial fan is recomputed while paths are landing. */
const REFRESH_EVERY = 25;

/**
 * Runs the plan once per random path in the worker pool and folds the
 * results into a fan. Starts only when `ready` (the deterministic analysis
 * has finished, so it is not competing with the searches for workers) and
 * starts over when the plan or the settings change.
 *
 * Each path runs a single engine pass on the base run's tax rates: the
 * December true-up still charges the exact bill, only the within-year
 * withholding timing is approximate, and it makes a path a third the cost.
 */
export function useMonteCarlo(scenario: Scenario, params: MonteCarloParams, enabled: boolean, ready: boolean): MonteCarloState {
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled || !ready) return;
    const gen = ++generation.current;
    const live = () => generation.current === gen;
    const total = 1 + params.paths;
    let done = 0;

    const simulate = async () => {
      setResult(null);
      setProgress({ done, total });
      setRunning(true);
      setError(null);
      try {
        const base = await runProjection(scenario, {}, gen, true);
        done += 1;
        if (!live()) return;
        setProgress({ done, total });
        const paths = generatePaths(scenario, params);
        const summaries: StressSummary[] = [];
        await Promise.all(
          paths.map(async (yearReturnOverrides) => {
            const r = await runProjection(scenario, { yearReturnOverrides, seedTaxRates: base.ratesByYear, maxConvergencePasses: 0 }, gen);
            if (!live()) return;
            summaries.push(r.summary);
            done += 1;
            setProgress({ done, total });
            if (summaries.length % REFRESH_EVERY === 0) setResult(summarizeMonteCarlo(summaries));
          })
        );
        if (!live()) return;
        setResult(summarizeMonteCarlo(summaries));
        setRunning(false);
      } catch (err) {
        if (err instanceof CancelledError || !live()) return;
        setError(err instanceof Error ? err.message : String(err));
        setRunning(false);
      }
    };
    void simulate();

    return () => {
      generation.current += 1;
    };
  }, [scenario, params, enabled, ready]);

  return { result, progress, running, error };
}
