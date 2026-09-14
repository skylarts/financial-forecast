import type { Scenario } from "@/domain";
import { projectScenarioWithRates, type ProjectionOptions, type TaxRatesByYear } from "@/engine/forecastScenario";
import { summarizeProjection, type StressSummary } from "@/engine/stressSummary";

/**
 * The projection engine, off the main thread. The stress tab runs the plan
 * hundreds of times per edit (every preset, a bisection per lever, a fix
 * search per broken preset, Monte Carlo paths); on the main thread that
 * froze the page. Each request is one projection; the reply is the compact
 * summary the stress views read, not the full result with its ledger.
 */
export interface ProjectionRequest {
  id: number;
  scenario: Scenario;
  options: ProjectionOptions;
  /** Also return the tax rates the run settled on, to seed the runs that follow. */
  withRates?: boolean;
}

export type ProjectionReply = { id: number; summary: StressSummary; ratesByYear?: TaxRatesByYear } | { id: number; error: string };

self.onmessage = (event: MessageEvent<ProjectionRequest>) => {
  const { id, scenario, options, withRates } = event.data;
  try {
    const { result, ratesByYear } = projectScenarioWithRates(scenario, options);
    const reply: ProjectionReply = { id, summary: summarizeProjection(result), ratesByYear: withRates ? ratesByYear : undefined };
    self.postMessage(reply);
  } catch (err) {
    const reply: ProjectionReply = { id, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(reply);
  }
};
