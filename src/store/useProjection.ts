import { useMemo } from "react";
import type { Scenario } from "@/domain";
import { forecastScenario } from "@/engine/forecastScenario";

/**
 * Memoized derived value -- the projection is never stored as state, only
 * ever computed from a scenario. Re-computes only when the scenario object
 * reference changes (i.e. an actual edit), not on unrelated re-renders.
 */
export function useProjection(scenario: Scenario) {
  return useMemo(() => forecastScenario(scenario), [scenario]);
}
