import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { projectScenario } from "./forecastScenario";
import { makeAccount, makeExpense, makeIncome, makeScenario } from "./testHelpers";
import { DEFAULT_STRESS_PARAMS, applyStress, stressPreset } from "./stress";
import { netWorthIn, summarizeProjection, yearsOfSpendingCovered } from "./stressSummary";
import { addSavings, enteredMonthlySpending, findBreakingPoint, findFixes, scaleSpending, shiftRetirements, type Runner } from "./stressSolver";

/** Guards the searches on top of the presets: the run summary, the breaking point of a lever, and the smallest mending change. */

const run: Runner = async (scenario, options) => summarizeProjection(projectScenario(scenario, options));

const person = (birthDate: string, retirementAge: number) => ({ id: nanoid(), name: "P", birthDate, retirementAge, planningEndAge: 90 });

/** A retiree drawing $1.8k/mo from $600k at 4% for 26 years: holds, but not by much. */
function tightPlan() {
  const p = person("1961-06-01", 65);
  const fund = makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 600_000, growthRatePct: 0.04, withdrawalPriority: 1 });
  return makeScenario({ accounts: [fund], people: [p], expenses: [makeExpense({ amount: 1_800 })], horizonEndDate: "2051-12-31", inflationRatePct: 0.03 });
}

describe("run summary", () => {
  it("carries net worth by year, the shortfall year and its depth, and the low point", async () => {
    const short = makeScenario({
      accounts: [makeAccount({ class: "cash", name: "Cash", startingBalance: 50_000, isSpendingAccount: true })],
      people: [person("1961-06-01", 65)],
      expenses: [makeExpense({ amount: 2_000 })],
      horizonEndDate: "2030-12-31",
    });
    const s = await run(short, {});
    expect(s.years.map((y) => y.year)).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(s.firstShortfallYear).toBe(2028);
    // $120k of spending against $50k: the hole is $70k deep by the end.
    expect(s.shortfallDepthNominal).toBeCloseTo(70_000, -2);
    expect(s.lowestReal.year).toBe(2030);
    expect(netWorthIn(s, 2027, false)).toBeCloseTo(2_000, -2);
    expect(netWorthIn(s, 2099, false)).toBeNull();
    expect(yearsOfSpendingCovered(s, 2026)).toBeCloseTo(26_000 / 24_000, 2);
  });
  it("reports no hole for a plan that holds", async () => {
    const s = await run(tightPlan(), {});
    expect(s.firstShortfallYear).toBeNull();
    expect(s.shortfallDepthNominal).toBe(0);
    expect(s.endYear).toBe(2051);
  });
});

describe("breaking point", () => {
  it("finds the largest lever value the plan survives, and words it", async () => {
    const bp = await findBreakingPoint(tightPlan(), stressPreset("spending_overrun")!, DEFAULT_STRESS_PARAMS, run);
    expect(bp?.kind).toBe("breaks");
    expect(bp!.value).toBeGreaterThan(0);
    expect(bp!.value).toBeLessThan(1);
    expect(bp!.label).toMatch(/^\d+% over$/);
    // Just under the point holds; just over does not.
    const at = (x: number) => applyStress(tightPlan(), "spending_overrun", { ...DEFAULT_STRESS_PARAMS, spendingOverrunPct: x });
    expect((await run(at(bp!.value - 0.02).scenario, {})).firstShortfallYear).toBeNull();
    expect((await run(at(bp!.value + 0.02).scenario, {})).firstShortfallYear).not.toBeNull();
  });
  it("says so when the plan holds at the harshest value, and when it is already short", async () => {
    const plan = tightPlan();
    const rich = { ...plan, accounts: plan.accounts.map((a) => (a.class === "taxable_investment" ? { ...a, startingBalance: 50_000_000 } : a)) };
    expect((await findBreakingPoint(rich, stressPreset("higher_taxes")!, DEFAULT_STRESS_PARAMS, run))?.kind).toBe("holds_all");
    const broke = { ...tightPlan(), expenses: [makeExpense({ amount: 9_000 })] };
    expect((await findBreakingPoint(broke, stressPreset("lower_returns")!, DEFAULT_STRESS_PARAMS, run))?.kind).toBe("already_short");
    expect(await findBreakingPoint(tightPlan(), stressPreset("all_at_once")!, DEFAULT_STRESS_PARAMS, run)).toBeNull();
  });
});

describe("fixes", () => {
  const scaled = scaleSpending(tightPlan(), 0.9);
  it("scales spending, shifts future retirements with their anchors, and adds savings to the largest investment account", () => {
    expect(scaled.expenses[0].amount).toBeCloseTo(1_620, 6);
    expect(enteredMonthlySpending(tightPlan())).toBe(1_800);

    const p = person("1980-01-01", 60);
    const pension = makeIncome({ name: "Pension", amount: 1_000, ownerId: p.id, category: "pension", startAnchor: { personId: p.id, point: "retirement", offsetMonths: 0 } });
    const working = makeScenario({ accounts: [makeAccount({ class: "cash", name: "Cash" })], people: [p], incomeSources: [pension] });
    const later = shiftRetirements(working, 18);
    expect(later.household.people[0].retirementDate).toBe("2041-07-01");
    expect(later.incomeSources[0].startDate).toBe("2041-07-01");

    const more = addSavings(tightPlan(), 100_000);
    expect(more.accounts.find((a) => a.class === "taxable_investment")!.startingBalance).toBe(700_000);
  });
  it("finds the smallest spending cut, extra work, and extra savings that mend a broken run", async () => {
    const p = person("1966-01-01", 62);
    const fund = makeAccount({ class: "taxable_investment", name: "Fund", startingBalance: 500_000, growthRatePct: 0.05, withdrawalPriority: 1 });
    const salary = makeIncome({ name: "Salary", amount: 7_000, ownerId: p.id, category: "salary", endAnchor: { personId: p.id, point: "retirement", offsetMonths: 0 } });
    const plan = makeScenario({ accounts: [fund], people: [p], incomeSources: [salary], expenses: [makeExpense({ amount: 4_000 })], horizonEndDate: "2056-12-31", inflationRatePct: 0.03 });
    const stressed = applyStress(plan, "spending_overrun", { ...DEFAULT_STRESS_PARAMS, spendingOverrunPct: 0.5 });
    expect((await run(stressed.scenario, stressed.options)).firstShortfallYear).not.toBeNull();

    const fixes = await findFixes(stressed, run);
    const kinds = fixes.map((f) => f.kind);
    expect(kinds).toContain("spend_less");
    expect(kinds).toContain("work_longer");
    expect(kinds).toContain("save_more");
    for (const fix of fixes) expect(fix.label.length).toBeGreaterThan(10);

    // Each fix, applied, mends the run; a little less than each does not.
    const spend = fixes.find((f) => f.kind === "spend_less")!;
    expect((await run(scaleSpending(stressed.scenario, 1 - spend.value), stressed.options)).firstShortfallYear).toBeNull();
    expect((await run(scaleSpending(stressed.scenario, 1 - spend.value + 0.03), stressed.options)).firstShortfallYear).not.toBeNull();
    const work = fixes.find((f) => f.kind === "work_longer")!;
    expect((await run(shiftRetirements(stressed.scenario, work.value), stressed.options)).firstShortfallYear).toBeNull();
    const save = fixes.find((f) => f.kind === "save_more")!;
    expect((await run(addSavings(stressed.scenario, save.value), stressed.options)).firstShortfallYear).toBeNull();
    expect((await run(addSavings(stressed.scenario, save.value - 40_000), stressed.options)).firstShortfallYear).not.toBeNull();
  });
  it("leaves out working longer for a household already retired", async () => {
    const plan = tightPlan();
    const retired = { ...plan, household: { people: plan.household.people.map((p) => ({ ...p, birthDate: "1958-06-01" })) } };
    const stressed = applyStress(retired, "spending_overrun", { ...DEFAULT_STRESS_PARAMS, spendingOverrunPct: 1 });
    const fixes = await findFixes(stressed, run);
    expect(fixes.map((f) => f.kind)).not.toContain("work_longer");
    expect(fixes.map((f) => f.kind)).toContain("spend_less");
  });
});
