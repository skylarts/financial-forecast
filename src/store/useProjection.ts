import { useMemo } from "react";
import type { ProjectionResult, Scenario } from "@/domain";
import { projectScenario } from "@/engine/forecastScenario";

// One projection per scenario object: the page and any drawer that previews
// the same scenario (the healthcare preview in Assumptions) share the run
// instead of each paying for the engine on every edit. Keyed by reference,
// so an edit (a new object) always recomputes.
const cache = new WeakMap<Scenario, ProjectionResult>();

export function projectScenarioCached(scenario: Scenario): ProjectionResult {
  const hit = cache.get(scenario);
  if (hit) return hit;
  const result = projectScenario(scenario);
  cache.set(scenario, result);
  return result;
}

/**
 * Memoized derived value -- the projection is never stored as state, only
 * ever computed from a scenario. Re-computes only when the scenario object
 * reference changes (i.e. an actual edit), not on unrelated re-renders.
 */
export function useProjection(scenario: Scenario) {
  return useMemo(() => projectScenarioCached(scenario), [scenario]);
}

/**
 * The comparison scenario's projection, reusing `primary` by reference when
 * there is no comparison selected.
 *
 * The common case has no comparison at all, and the caller used to pass the
 * active scenario to a second `useProjection` for that case -- projecting the
 * same scenario twice on every plan edit, at the full cost of the engine, for
 * a result that was always identical to the one already sitting in `primary`.
 */
export function useCompareProjection(
  compareScenario: Scenario | null,
  primary: ProjectionResult,
): ProjectionResult {
  return useMemo(
    () => (compareScenario ? projectScenarioCached(compareScenario) : primary),
    [compareScenario, primary],
  );
}
