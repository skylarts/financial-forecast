import { describe, expect, it } from "vitest";
import { migrateV4Plan, needsV4Migration } from "./migrateV4Plan";
import { PLAN_SCHEMA_VERSION, normalizePlan } from "./planIO";

const accounts = [
  { id: "hub", name: "Extra Savings", class: "cash", category: "asset", ownerId: null, startingBalance: 0, growthRatePct: 0, taxTreatment: "n/a", subjectToRMD: false, isExtraSavings: true },
  { id: "chk", name: "Checking", class: "cash", category: "asset", ownerId: null, startingBalance: 1000, growthRatePct: 0, taxTreatment: "n/a", subjectToRMD: false },
  { id: "ira", name: "IRA", class: "tax_deferred", category: "asset", ownerId: "p1", startingBalance: 100000, growthRatePct: 0.05, taxTreatment: "n/a", subjectToRMD: true },
  { id: "k401", name: "401k", class: "tax_deferred", category: "asset", ownerId: "p1", startingBalance: 50000, growthRatePct: 0.05, taxTreatment: "n/a", subjectToRMD: true },
  { id: "roth", name: "Roth", class: "tax_free", category: "asset", ownerId: "p1", startingBalance: 0, growthRatePct: 0.05, taxTreatment: "n/a", subjectToRMD: false },
  { id: "mort", name: "Mortgage", class: "mortgage", category: "liability", ownerId: null, startingBalance: 200000, growthRatePct: 0, taxTreatment: "n/a", subjectToRMD: false, loanTerms: { originalPrincipal: 200000, originationDate: "2020-01-01", annualInterestRatePct: 0.05, termMonths: 360 } },
];

function plan(events: unknown[]) {
  return {
    id: "p",
    schemaVersion: PLAN_SCHEMA_VERSION,
    activeScenarioId: "s",
    scenarios: [
      {
        id: "s",
        name: "S",
        household: { people: [{ id: "p1", name: "A", birthDate: "1980-01-01", retirementAge: 65, planningEndAge: 95 }] },
        accounts,
        incomeSources: [],
        expenses: [],
        events,
        settings: { startDate: "2026-01-01", horizonEndDate: "2075-12-31", inflationRatePct: 0.03, moneyFlow: { splitOrder: [], drainOrder: [] }, rmdEnabled: true, filingStatus: "single", additionalFlatTaxRatePct: 0 },
      },
    ],
  };
}

describe("migrateV4Plan", () => {
  it("turns a have_a_kid event into childcare expenses", () => {
    const raw = plan([
      { id: "kid", type: "have_a_kid", name: "First kid", startDate: "2028-03-01", childcareMonthlyExpense: 1800, childcareEndDate: "2033-09-01", additionalOneTimeCost: 5000, paymentAccountId: "hub" },
    ]);
    expect(needsV4Migration(raw)).toBe(true);
    const r = normalizePlan(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.plan.scenarios[0];
    expect(s.events).toHaveLength(0);
    expect(s.expenses.map((e) => [e.name, e.amount, e.frequency, e.endDate, e.paymentAccountId])).toEqual([
      ["Childcare: First kid", 1800, "monthly", "2033-09-01", null],
      ["One-time cost: First kid", 5000, "one_time", null, null],
    ]);
    expect(r.migrated).toBe(true);
  });

  it("turns a tax-deferred-to-Roth transfer into a Roth conversion, monthly amounts into a yearly total", () => {
    const raw = plan([
      { id: "t", type: "custom_transfer", name: "Ladder", startDate: "2030-01-01", amount: 2000, fromAccountId: "ira", toAccountId: "roth", frequency: "monthly", growthRatePct: 0 },
    ]);
    const out = migrateV4Plan(raw) as typeof raw;
    const e = out.scenarios[0].events[0] as Record<string, unknown>;
    expect(e.type).toBe("roth_conversion");
    expect(e.amount).toBe(24000);
    expect(e.frequency).toBe("annual");
    expect(e.taxSource).toBe("cash");
    expect(normalizePlan(raw).ok).toBe(true);
  });

  it("turns one-time transfers into rollovers and loan payoffs, and leaves other transfers alone", () => {
    const raw = plan([
      { id: "r", type: "custom_transfer", name: "Roll", startDate: "2030-01-01", amount: 50000, fromAccountId: "k401", toAccountId: "ira", frequency: "one_time" },
      { id: "p", type: "custom_transfer", name: "Payoff", startDate: "2031-01-01", amount: 100000, fromAccountId: "chk", toAccountId: "mort", frequency: "one_time" },
      { id: "c", type: "custom_transfer", name: "Sweep", startDate: "2026-01-01", amount: 500, fromAccountId: "chk", toAccountId: "roth", frequency: "monthly" },
    ]);
    const out = migrateV4Plan(raw) as typeof raw;
    expect(out.scenarios[0].events.map((e) => (e as Record<string, unknown>).type)).toEqual(["rollover", "pay_off_loan", "custom_transfer"]);
    expect(normalizePlan(raw).ok).toBe(true);
  });

  it("is a no-op for a plan already in the current shape", () => {
    const raw = plan([]);
    expect(needsV4Migration(raw)).toBe(false);
    const r = normalizePlan(raw);
    expect(r.ok && r.migrated).toBe(false);
  });
});
