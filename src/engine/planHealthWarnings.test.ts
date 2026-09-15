import { describe, expect, it } from "vitest";
import { projectScenario } from "./forecastScenario";
import { makeScenario, makeAccount, makeIncome, makeExpense } from "./testHelpers";
import type { Scenario } from "@/domain";

const HORIZON = { startDate: "2026-01-01", horizonEndDate: "2056-12-31" } as const;
const kinds = (sc: Scenario, k: string) => projectScenario(sc).warnings.filter((w) => w.kind === k);

describe("stranded_account", () => {
  const build = (listRoth: boolean) => {
    const hub = makeAccount({ name: "Hub", class: "cash", isSpendingAccount: true, startingBalance: 50_000, withdrawalPriority: 1 });
    const roth = makeAccount({
      name: "Orphan Roth", class: "tax_free", startingBalance: 100_000, growthRatePct: 0.05,
      ...(listRoth ? { withdrawalPriority: 2 } : {}),
    });
    return makeScenario({ accounts: [hub, roth], ...HORIZON });
  };

  it("flags an asset the custom drain order never lists", () => {
    const w = kinds(build(false), "stranded_account");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("Orphan Roth");
    expect(w[0].message).toContain("never cover a shortfall");
  });

  it("stays quiet when the account is listed", () => {
    expect(kinds(build(true), "stranded_account")).toHaveLength(0);
  });

  it("stays quiet for a preset strategy, which derives its order from the accounts", () => {
    const sc = build(false);
    expect(kinds({ ...sc, settings: { ...sc.settings, withdrawalStrategy: "conventional" } }, "stranded_account")).toHaveLength(0);
  });

  it("stays quiet for an account that ends at zero -- nothing is actually stranded", () => {
    const hub = makeAccount({ name: "Hub", class: "cash", isSpendingAccount: true, startingBalance: 50_000, withdrawalPriority: 1 });
    const empty = makeAccount({ name: "Empty", class: "tax_free", startingBalance: 0 });
    expect(kinds(makeScenario({ accounts: [hub, empty], ...HORIZON }), "stranded_account")).toHaveLength(0);
  });
});

describe("frozen_floor", () => {
  it("flags a floor that outruns its own account, and names both rates", () => {
    const hub = makeAccount({ name: "Hub", class: "cash", isSpendingAccount: true, startingBalance: 10_000, withdrawalPriority: 1 });
    const reserve = makeAccount({
      name: "Reserve", class: "cash", startingBalance: 50_000, growthRatePct: 0.01,
      balanceFloor: 50_000, balanceFloorGrowthRatePct: 0.05, withdrawalPriority: 2,
    });
    const w = kinds(makeScenario({ accounts: [hub, reserve], ...HORIZON }), "frozen_floor");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("outruns the balance");
    expect(w[0].message).toContain("5.0%/yr");
    expect(w[0].message).toContain("1.0%/yr");
  });

  it("flags an account that is drained down onto a same-rate floor and then frozen there", () => {
    // The real-world shape: the floor doesn't outrun anything, but once
    // spending has pulled the balance down to it, that money is stuck.
    const hub = makeAccount({ name: "Hub", class: "cash", isSpendingAccount: true, startingBalance: 1_000 });
    const reserve = makeAccount({
      name: "Reserve", class: "cash", startingBalance: 200_000, growthRatePct: 0.03,
      balanceFloor: 50_000, balanceFloorGrowthRatePct: 0.03, withdrawalPriority: 1,
    });
    const sc = makeScenario({
      accounts: [hub, reserve],
      expenses: [makeExpense({ name: "Living", amount: 2_000, growthRatePct: 0.03 })],
      ...HORIZON,
    });
    const w = kinds(sc, "frozen_floor");
    expect(w).toHaveLength(1);
    expect(w[0].message).not.toContain("outruns");
    expect(w[0].message).toContain("can never be spent");
  });

  it("stays quiet when the balance ends well clear of the floor", () => {
    const hub = makeAccount({ name: "Hub", class: "cash", isSpendingAccount: true, startingBalance: 10_000, withdrawalPriority: 1 });
    const reserve = makeAccount({
      name: "Reserve", class: "cash", startingBalance: 500_000, growthRatePct: 0.05,
      balanceFloor: 10_000, balanceFloorGrowthRatePct: 0.01,
    });
    expect(kinds(makeScenario({ accounts: [hub, reserve], ...HORIZON }), "frozen_floor")).toHaveLength(0);
  });
});

describe("ineligible_contribution", () => {
  const build = (cls: "tax_free" | "hsa" | "taxable_investment", stopEndDate: string | null): Scenario => {
    const hub = makeAccount({ name: "Hub", class: "cash", isSpendingAccount: true, startingBalance: 10_000, withdrawalPriority: 1 });
    const target = makeAccount({ name: `Target ${cls}`, class: cls, startingBalance: 0, isSurplusTarget: true });
    const sc = makeScenario({
      accounts: [hub, target],
      people: [{ id: "p1", name: "A", birthDate: "1980-01-01", retirementAge: 60, planningEndAge: 90 }],
      incomeSources: [makeIncome({ name: "Salary", category: "salary", amount: 5_000, endDate: "2040-12-31" })],
      ...HORIZON,
    });
    return {
      ...sc,
      settings: { ...sc.settings, moneyFlow: {
        ...sc.settings.moneyFlow,
        splitOrder: sc.settings.moneyFlow.splitOrder.map((s) => ({ ...s, endDate: stopEndDate })),
      } },
    };
  };

  it("flags an IRA still funded after the last salary ends", () => {
    const w = kinds(build("tax_free", null), "ineligible_contribution");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("earned income");
  });

  it("flags an HSA and explains the Medicare cutoff", () => {
    const w = kinds(build("hsa", null), "ineligible_contribution");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("65");
    // Born 1980, so 65 lands in 2045 -- BEFORE the 2040 salary end is irrelevant here;
    // the earlier of the two limits is what the warning should be dated to.
    expect(w[0].year).toBe(2040);
  });

  it("stays quiet once the stop ends inside the earning years", () => {
    expect(kinds(build("tax_free", "2040-12-31"), "ineligible_contribution")).toHaveLength(0);
  });

  it("ignores a taxable account, which anyone can fund at any age", () => {
    expect(kinds(build("taxable_investment", null), "ineligible_contribution")).toHaveLength(0);
  });
});
