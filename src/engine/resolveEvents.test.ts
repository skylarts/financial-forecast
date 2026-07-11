import { describe, it, expect } from "vitest";
import { nanoid } from "nanoid";
import { resolveEvents } from "./resolveEvents";
import { mockScenario } from "@/lib/mockScenario";
import { elapsedYears } from "./dateMath";
import { growthAdjustedAmount } from "./growth";
import { makeAccount, makeIncome, makeExpense, makeScenario } from "./testHelpers";

describe("resolveEvents (mock fixture)", () => {
  const resolved = resolveEvents(mockScenario);
  const buyEvent = mockScenario.events.find((e) => e.type === "buy_home");
  if (!buyEvent || buyEvent.type !== "buy_home") throw new Error("unreachable");
  // Purchase price and down payment are entered in today's dollars and
  // inflate from plan start to the purchase date, same factor for both.
  const inflationFactor = growthAdjustedAmount(
    1,
    elapsedYears(mockScenario.settings.startDate, buyEvent.startDate),
    mockScenario.settings.inflationRatePct
  );
  const inflatedPurchasePrice = buyEvent.purchasePrice * inflationFactor;
  const inflatedDownPayment = buyEvent.downPaymentAmount * inflationFactor;

  it("creates the real estate + mortgage accounts from the buy_home event", () => {
    const realEstate = resolved.accounts.find((a) => a.class === "real_estate");
    const mortgage = resolved.accounts.find((a) => a.class === "mortgage");
    expect(realEstate).toBeDefined();
    expect(mortgage).toBeDefined();
    expect(realEstate!.startingBalance).toBeCloseTo(inflatedPurchasePrice, 6);
    expect(mortgage!.startingBalance).toBeCloseTo(inflatedPurchasePrice - inflatedDownPayment, 6);
    expect(realEstate!.linkedLiabilityId).toBe(mortgage!.id);
    expect(mortgage!.loanTerms?.linkedAssetId).toBe(realEstate!.id);
    expect(resolved.mortgages).toHaveLength(1);
  });

  it("stops Alex's salary postings after the retire event", () => {
    const alexSalary = resolved.postings.filter((p) => p.label === "Alex Salary");
    const last = alexSalary[alexSalary.length - 1];
    expect(last.date < "2055-05-15").toBe(true);
  });

  it("includes a down-payment transfer posting, not counted as an expense", () => {
    const downPayment = resolved.postings.find((p) => p.label.startsWith("Down payment"));
    expect(downPayment).toBeDefined();
    expect(downPayment!.amount).toBeCloseTo(-inflatedDownPayment, 6);
    expect(downPayment!.category).toBe("transfer");
  });

  it("generates childcare postings only within the have_a_kid window", () => {
    const childcare = resolved.postings.filter((p) => p.label.startsWith("Childcare"));
    expect(childcare[0].date).toBe("2028-03-01");
    expect(childcare[childcare.length - 1].date < "2033-09-02").toBe(true);
  });

  it("generates Social Security income postings starting at the event date", () => {
    const ss = resolved.postings.filter((p) => p.label === "Alex Social Security");
    expect(ss[0].date).toBe("2057-05-15");
    expect(ss[0].category).toBe("income");
  });

  it("builds one timeline row per event", () => {
    expect(resolved.timeline).toHaveLength(mockScenario.events.length);
  });
});

describe("resolveEvents -- today's dollars for future-dated items with no growth rate", () => {
  const planStart = "2026-01-01";
  const futureDate = "2036-01-01"; // 10 years out
  const inflationRatePct = 0.03;
  const inflationFactor = growthAdjustedAmount(1, elapsedYears(planStart, futureDate), inflationRatePct);

  it("inflates a one-time windfall (an Income entry with a future start date) entered in today's dollars", () => {
    // Windfalls are no longer a separate event type (v3): a one-time inflow is
    // just an Income source with frequency "one_time" and a future startDate,
    // riding the same today's-dollars path as every other income source.
    const cash = makeAccount({ class: "cash", name: "Cash" });
    const inheritance = makeIncome({
      name: "Inheritance",
      amount: 50_000,
      frequency: "one_time",
      startDate: futureDate,
      growthRatePct: 0,
      depositAccountId: cash.id,
    });
    const scenario = makeScenario({
      accounts: [cash],
      incomeSources: [inheritance],
      startDate: planStart,
      horizonEndDate: "2036-12-31",
      inflationRatePct,
    });
    const resolved = resolveEvents(scenario);
    const posting = resolved.postings.find((p) => p.label === "Inheritance")!;
    expect(posting).toBeDefined();
    expect(posting.amount).toBeCloseTo(50_000 * inflationFactor, 6);
    expect(posting.amount).toBeGreaterThan(50_000); // inflated, not the literal entered number
  });

  it("inflates a custom transfer with no explicit growth rate", () => {
    const from = makeAccount({ class: "cash", name: "From" });
    const to = makeAccount({ class: "cash", name: "To" });
    const scenario = makeScenario({
      accounts: [from, to],
      events: [
        {
          id: nanoid(),
          type: "custom_transfer",
          name: "Car replacement",
          startDate: futureDate,
          amount: 30_000,
          fromAccountId: from.id,
          toAccountId: to.id,
          frequency: "one_time",
        },
      ],
      startDate: planStart,
      horizonEndDate: "2036-12-31",
      inflationRatePct,
    });
    const resolved = resolveEvents(scenario);
    const outgoing = resolved.postings.find((p) => p.accountId === from.id)!;
    expect(outgoing.amount).toBeCloseTo(-30_000 * inflationFactor, 6);
  });

  it("inflates have_a_kid's childcare expense and one-time cost", () => {
    const cash = makeAccount({ class: "cash", name: "Cash" });
    const scenario = makeScenario({
      accounts: [cash],
      events: [
        {
          id: nanoid(),
          type: "have_a_kid",
          name: "Kid",
          startDate: futureDate,
          childcareMonthlyExpense: 2_000,
          childcareEndDate: null,
          additionalOneTimeCost: 10_000,
          paymentAccountId: cash.id,
        },
      ],
      startDate: planStart,
      horizonEndDate: "2036-12-31",
      inflationRatePct,
    });
    const resolved = resolveEvents(scenario);
    const firstChildcare = resolved.postings.find((p) => p.label.startsWith("Childcare"))!;
    const oneTime = resolved.postings.find((p) => p.label.startsWith("One-time cost"))!;
    expect(firstChildcare.amount).toBeCloseTo(-2_000 * inflationFactor, 6);
    expect(oneTime.amount).toBeCloseTo(-10_000 * inflationFactor, 6);
  });
});

describe("resolveEvents -- temporary adjustments modify an income/expense in place", () => {
  // income_change / expense_change are no longer separate event types (v3):
  // a temporary scaling window lives directly on the income source or
  // expense it affects (Scenario.incomeSources[].adjustments), removing the
  // "which event points at which source" indirection.
  it("applies a temporary-adjustment multiplier window to an income source", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true });
    const salary = makeIncome({
      name: "Salary",
      amount: 4_000,
      frequency: "monthly",
      growthRatePct: 0,
      depositAccountId: cash.id,
      adjustments: [{ id: nanoid(), startDate: "2026-06-01", endDate: "2026-08-31", multiplier: 0 }],
    });
    const scenario = makeScenario({
      accounts: [cash],
      incomeSources: [salary],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    });
    const resolved = resolveEvents(scenario);
    const postings = resolved.postings.filter((p) => p.label === "Salary");
    // A 0-multiplier posting is skipped entirely upstream, so the paused
    // months (Jun-Aug) simply produce no posting at all.
    const paused = postings.filter((p) => p.date >= "2026-06-01" && p.date <= "2026-08-31");
    expect(paused).toHaveLength(0);
    expect(postings).toHaveLength(9); // Jan-May + Sep-Dec
    expect(postings.every((p) => p.amount === 4_000)).toBe(true);
  });

  it("applies a temporary-adjustment multiplier window to an expense", () => {
    const cash = makeAccount({ class: "cash", name: "Cash", isSpendingAccount: true });
    const rent = makeExpense({
      name: "Rent",
      amount: 1_500,
      frequency: "monthly",
      growthRatePct: 0,
      paymentAccountId: cash.id,
      adjustments: [{ id: nanoid(), startDate: "2026-07-01", endDate: null, multiplier: 1.2 }],
    });
    const scenario = makeScenario({
      accounts: [cash],
      expenses: [rent],
      startDate: "2026-01-01",
      horizonEndDate: "2026-12-31",
    });
    const resolved = resolveEvents(scenario);
    const postings = resolved.postings.filter((p) => p.label === "Rent");
    const before = postings.filter((p) => p.date < "2026-07-01");
    const after = postings.filter((p) => p.date >= "2026-07-01");
    expect(before.every((p) => p.amount === -1_500)).toBe(true);
    expect(after.every((p) => p.amount === -1_800)).toBe(true); // 1,500 * 1.2
  });
});

describe("resolveEvents -- isExcluded", () => {
  it("an excluded income source produces no postings", () => {
    const cash = makeAccount({ class: "cash", name: "Cash" });
    const salary = makeIncome({ name: "Salary", amount: 4_000, depositAccountId: cash.id, isExcluded: true });
    const scenario = makeScenario({ accounts: [cash], incomeSources: [salary], horizonEndDate: "2026-12-31" });
    const resolved = resolveEvents(scenario);
    expect(resolved.postings.some((p) => p.label === "Salary")).toBe(false);
  });

  it("an excluded expense produces no postings", () => {
    const cash = makeAccount({ class: "cash", name: "Cash" });
    const rent = makeExpense({ name: "Rent", amount: 1_500, paymentAccountId: cash.id, isExcluded: true });
    const scenario = makeScenario({ accounts: [cash], expenses: [rent], horizonEndDate: "2026-12-31" });
    const resolved = resolveEvents(scenario);
    expect(resolved.postings.some((p) => p.label === "Rent")).toBe(false);
  });

  it("an excluded event has no effect (a retire event doesn't trim salary)", () => {
    const personId = nanoid();
    const cash = makeAccount({ class: "cash", name: "Cash" });
    const salary = makeIncome({ name: "Salary", amount: 4_000, ownerId: personId, category: "salary", depositAccountId: cash.id });
    const scenario = makeScenario({
      accounts: [cash],
      incomeSources: [salary],
      events: [{ id: nanoid(), type: "retire", name: "Retire", startDate: "2026-06-01", personId, isExcluded: true }],
      horizonEndDate: "2026-12-31",
    });
    const resolved = resolveEvents(scenario);
    const postings = resolved.postings.filter((p) => p.label === "Salary");
    expect(postings).toHaveLength(12); // not trimmed -- the retire event is excluded
  });

  it("a posting targeting an excluded account is dropped entirely", () => {
    const excludedAccount = makeAccount({ class: "cash", name: "Kid's UTMA", isExcluded: true });
    const income = makeIncome({ name: "Gift", amount: 1_000, depositAccountId: excludedAccount.id });
    const scenario = makeScenario({ accounts: [excludedAccount], incomeSources: [income], horizonEndDate: "2026-12-31" });
    const resolved = resolveEvents(scenario);
    expect(resolved.postings).toHaveLength(0);
  });
});
