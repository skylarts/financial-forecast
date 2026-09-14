import type { Scenario } from "@/domain";
import { todayISO, yearOf } from "./dateMath";
import { MARKET_HISTORY, realBlendedReturn } from "./historicalReturns";
import { expectedReturnOf } from "./stress";
import type { StressSummary } from "./stressSummary";

/**
 * Monte Carlo: the plan run many times with a different random sequence of
 * investment returns each time, to put a number on how often it holds and
 * how wide the range of outcomes is. Randomizes RETURNS ONLY -- inflation,
 * spending, lifespans and everything else stay exactly as planned -- so a
 * success rate here is "given everything else goes to plan, how often do
 * the markets let it work". Every investment account gets the same return
 * in a year (one market); cash and real estate keep their own rates.
 *
 * Two ways to draw a year:
 *  - `history`: a random real year from 1928-2024, for a portfolio holding
 *    `equityShare` in stocks, shifted so the long-run average equals the
 *    plan's own expected return. History's shape (fat tails, the size of a
 *    bad year), the plan's average.
 *  - `normal`: a bell curve around the plan's expected return with the
 *    chosen volatility. Simpler, and the assumption most planners quote.
 *
 * Paths are seeded, so the same plan and settings always produce the same
 * paths and the same answer.
 */
export type MonteCarloModel = "history" | "normal";

export interface MonteCarloParams {
  paths: number;
  model: MonteCarloModel;
  /** `normal` only: yearly standard deviation of returns, e.g. 0.12 for a 60/40 mix. */
  volatility: number;
  /** `history` only: the share of the portfolio in stocks, the rest in bonds. */
  equityShare: number;
  seed: number;
}

export const DEFAULT_MONTE_CARLO_PARAMS: MonteCarloParams = {
  paths: 500,
  model: "history",
  volatility: 0.12,
  equityShare: 0.6,
  seed: 1,
};

/** A small, fast, seedable generator (mulberry32) -- reproducible paths without a dependency. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw (Box-Muller) from a uniform source. */
function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The calendar years a plan runs through. */
export function planYears(scenario: Scenario): number[] {
  const start = yearOf(scenario.settings.startDate ?? todayISO());
  const end = yearOf(scenario.settings.horizonEndDate);
  const years: number[] = [];
  for (let y = start; y <= end; y++) years.push(y);
  return years;
}

/**
 * One random return per plan year per path, as the per-year override map
 * the engine takes. Pure and seeded: the same inputs give the same paths.
 */
export function generatePaths(scenario: Scenario, params: MonteCarloParams): Record<number, number>[] {
  const years = planYears(scenario);
  const expected = expectedReturnOf(scenario);
  const inflation = scenario.settings.inflationRatePct;
  const rand = mulberry32(params.seed);
  const paths: Record<number, number>[] = [];

  if (params.model === "history") {
    const share = Math.min(1, Math.max(0, params.equityShare));
    const real = MARKET_HISTORY.map((row) => realBlendedReturn(row, share));
    const mean = real.reduce((s, r) => s + r, 0) / real.length;
    // Shift history so its average real return matches the plan's own
    // expected real return; a year is then "as far from average as that
    // real year was".
    const shift = (expected - inflation) - mean;
    for (let p = 0; p < params.paths; p++) {
      const path: Record<number, number> = {};
      for (const year of years) {
        const pick = real[Math.floor(rand() * real.length)];
        path[year] = Math.max(-0.95, pick + shift + inflation);
      }
      paths.push(path);
    }
    return paths;
  }

  // Lognormal around the expected return: the arithmetic mean of the drawn
  // returns comes out at `expected`, whatever the volatility.
  const sigma = Math.max(0, params.volatility);
  const mu = Math.log(1 + expected) - (sigma * sigma) / 2;
  for (let p = 0; p < params.paths; p++) {
    const path: Record<number, number> = {};
    for (const year of years) path[year] = Math.max(-0.95, Math.exp(mu + sigma * normal(rand)) - 1);
    paths.push(path);
  }
  return paths;
}

export interface MonteCarloYear {
  year: number;
  /** Net worth percentiles across paths, nominal and today's dollars. */
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p10Real: number;
  p25Real: number;
  p50Real: number;
  p75Real: number;
  p90Real: number;
  /** The share of paths that have run short by the end of this year. */
  shortBy: number;
}

export interface MonteCarloResult {
  paths: number;
  /** The share of paths that never run short. */
  successRate: number;
  years: MonteCarloYear[];
  /** The median year a failing path first runs short, or null when none fail. */
  medianShortfallYear: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The percentile fan and the success rate across a set of finished paths. */
export function summarizeMonteCarlo(summaries: StressSummary[]): MonteCarloResult {
  const n = summaries.length;
  if (n === 0) return { paths: 0, successRate: 0, years: [], medianShortfallYear: null };
  const years = new Set<number>();
  for (const s of summaries) for (const y of s.years) years.add(y.year);
  const shortfalls = summaries.map((s) => s.firstShortfallYear).filter((y): y is number => y !== null).sort((a, b) => a - b);
  const rows: MonteCarloYear[] = [...years]
    .sort((a, b) => a - b)
    .map((year) => {
      const nominal: number[] = [];
      const real: number[] = [];
      for (const s of summaries) {
        const y = s.years.find((row) => row.year === year);
        if (!y) continue;
        nominal.push(y.netWorthNominal);
        real.push(y.netWorthReal);
      }
      nominal.sort((a, b) => a - b);
      real.sort((a, b) => a - b);
      return {
        year,
        p10: percentile(nominal, 0.1),
        p25: percentile(nominal, 0.25),
        p50: percentile(nominal, 0.5),
        p75: percentile(nominal, 0.75),
        p90: percentile(nominal, 0.9),
        p10Real: percentile(real, 0.1),
        p25Real: percentile(real, 0.25),
        p50Real: percentile(real, 0.5),
        p75Real: percentile(real, 0.75),
        p90Real: percentile(real, 0.9),
        shortBy: shortfalls.filter((y) => y <= year).length / n,
      };
    });
  return {
    paths: n,
    successRate: 1 - shortfalls.length / n,
    years: rows,
    medianShortfallYear: shortfalls.length > 0 ? shortfalls[Math.floor((shortfalls.length - 1) / 2)] : null,
  };
}
