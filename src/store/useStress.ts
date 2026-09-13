import { useMemo } from "react";
import type { ProjectionResult, Scenario } from "@/domain";
import { projectScenario } from "@/engine/forecastScenario";
import { applyStress, retirementYearOf, STRESS_PRESETS, type StressKey, type StressParams } from "@/engine/stress";

export interface StressRun {
  key: StressKey;
  label: string;
  description: string;
  result: ProjectionResult;
}

/** One stressed projection, or null when no preset is chosen. Memoized on the scenario and the parameters. */
export function useStressProjection(scenario: Scenario, key: StressKey | null, params: StressParams): StressRun | null {
  return useMemo(() => {
    if (!key) return null;
    const preset = STRESS_PRESETS.find((p) => p.key === key);
    if (!preset) return null;
    const { scenario: stressed, options } = applyStress(scenario, key, params);
    return { key, label: preset.label, description: preset.describe(params, retirementYearOf(scenario)), result: projectScenario(stressed, options) };
  }, [scenario, key, params]);
}

/** Every preset run against the plan, for the Stress test tab. */
export function useStressSuite(scenario: Scenario, params: StressParams): StressRun[] {
  return useMemo(() => {
    const retirementYear = retirementYearOf(scenario);
    return STRESS_PRESETS.map((preset) => {
      const { scenario: stressed, options } = applyStress(scenario, preset.key, params);
      return { key: preset.key, label: preset.label, description: preset.describe(params, retirementYear), result: projectScenario(stressed, options) };
    });
  }, [scenario, params]);
}
