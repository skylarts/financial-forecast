import { nanoid } from "nanoid";
import type { Scenario, Account } from "@/domain";

/**
 * A fictional household exercising every part of the domain model, used for
 * Phase 1 (static layout) and Phase 2 (engine unit tests). Not derived from
 * anyone's real financial data.
 */

const alexId = nanoid();
const jordanId = nanoid();

const checkingId = nanoid();
const emergencyFundId = nanoid();
const brokerageId = nanoid();
const alex401kId = nanoid();
const jordan401kId = nanoid();
const alexRothId = nanoid();

const accounts: Account[] = [
  {
    id: checkingId,
    name: "Joint Checking",
    class: "cash",
    category: "asset",
    ownerId: null,
    startingBalance: 15_000,
    growthRatePct: 0.01,
    taxTreatment: "n/a",
    subjectToRMD: false,
  },
  {
    id: emergencyFundId,
    name: "Emergency Fund",
    class: "cash",
    category: "asset",
    ownerId: null,
    startingBalance: 10_000,
    growthRatePct: 0.04,
    taxTreatment: "n/a",
    subjectToRMD: false,
  },
  {
    id: brokerageId,
    name: "Joint Brokerage",
    class: "taxable_investment",
    category: "asset",
    ownerId: null,
    startingBalance: 40_000,
    growthRatePct: 0.065,
    taxTreatment: "taxable",
    subjectToRMD: false,
    // Funded from take-home: drawn from checking each month on top of expenses.
    contribution: { amount: 500, frequency: "monthly", growthRatePct: 0, payrollDeducted: false },
  },
  {
    id: alex401kId,
    name: "Alex 401(k)",
    class: "tax_deferred",
    category: "asset",
    ownerId: alexId,
    startingBalance: 85_000,
    growthRatePct: 0.07,
    taxTreatment: "tax_deferred",
    subjectToRMD: true,
    // Payroll-deducted: grows the balance but doesn't reduce take-home (income is entered net of it).
    contribution: { amount: 1_500, frequency: "monthly", growthRatePct: 0.02, payrollDeducted: true },
  },
  {
    id: jordan401kId,
    name: "Jordan 401(k)",
    class: "tax_deferred",
    category: "asset",
    ownerId: jordanId,
    startingBalance: 62_000,
    growthRatePct: 0.07,
    taxTreatment: "tax_deferred",
    subjectToRMD: true,
  },
  {
    id: alexRothId,
    name: "Alex Roth IRA",
    class: "tax_free",
    category: "asset",
    ownerId: alexId,
    startingBalance: 20_000,
    growthRatePct: 0.07,
    taxTreatment: "tax_free",
    subjectToRMD: false,
  },
];

export const mockScenario: Scenario = {
  id: nanoid(),
  name: "Base Plan",
  description: "Fictional household used for development and testing.",
  household: {
    people: [
      { id: alexId, name: "Alex", birthDate: "1990-05-15", retirementAge: 65, planningEndAge: 95 },
      { id: jordanId, name: "Jordan", birthDate: "1992-09-22", retirementAge: 63, planningEndAge: 95 },
    ],
  },
  accounts,
  incomeSources: [
    {
      id: nanoid(),
      name: "Alex Salary",
      ownerId: alexId,
      amount: 7_500,
      frequency: "monthly",
      startDate: "2026-01-01",
      endDate: null,
      growthRatePct: 0.05, // nominal: ~3% inflation + ~2% real raises
      depositAccountId: checkingId,
      category: "salary",
    },
    {
      id: nanoid(),
      name: "Jordan Salary",
      ownerId: jordanId,
      amount: 6_200,
      frequency: "monthly",
      startDate: "2026-01-01",
      endDate: null,
      growthRatePct: 0.05, // nominal: ~3% inflation + ~2% real raises
      depositAccountId: checkingId,
      category: "salary",
    },
    {
      id: nanoid(),
      name: "Inheritance",
      amount: 50_000,
      frequency: "one_time",
      startDate: "2035-01-15",
      endDate: null,
      growthRatePct: 0,
      depositAccountId: brokerageId,
      category: "other",
      ownerId: null,
    },
  ],
  expenses: [
    {
      id: nanoid(),
      name: "Living Expenses",
      amount: 6_500,
      frequency: "monthly",
      startDate: "2026-01-01",
      endDate: null,
      growthRatePct: 0.03, // nominal: tracks inflation
      paymentAccountId: checkingId,
      category: "discretionary",
    },
    {
      id: nanoid(),
      name: "Rent",
      amount: 2_800,
      frequency: "monthly",
      startDate: "2026-01-01",
      // Ends the day before the "Buy a home" event below -- the engine does
      // not automatically cancel rent when a home is purchased; this is a
      // manual simplification in the fixture, worth revisiting as a future
      // authoring-flow affordance (auto-suggest ending rent on a Buy a Home event).
      endDate: "2032-05-31",
      growthRatePct: 0.03, // nominal: tracks inflation
      paymentAccountId: checkingId,
      category: "housing",
    },
  ],
  events: [
    {
      id: nanoid(),
      type: "have_a_kid",
      name: "First kid",
      startDate: "2028-03-01",
      childcareMonthlyExpense: 1_800,
      childcareEndDate: "2033-09-01",
      additionalOneTimeCost: 5_000,
      paymentAccountId: checkingId,
    },
    {
      id: nanoid(),
      type: "buy_home",
      name: "Buy a home",
      startDate: "2032-06-01",
      purchasePrice: 550_000,
      downPaymentAmount: 110_000,
      downPaymentFromAccountId: brokerageId,
      propertyGrowthRatePct: 0.035,
      mortgage: { annualInterestRatePct: 0.06, termMonths: 360 },
    },
    {
      id: nanoid(),
      type: "retire",
      name: "Alex retires",
      startDate: "2055-05-15",
      personId: alexId,
      retirementAge: 65,
    },
    {
      id: nanoid(),
      type: "retire",
      name: "Jordan retires",
      startDate: "2055-09-22",
      personId: jordanId,
      retirementAge: 63,
    },
    {
      id: nanoid(),
      type: "social_security_start",
      name: "Alex Social Security",
      startDate: "2057-05-15",
      personId: alexId,
      monthlyBenefitAmount: 2_800,
      depositAccountId: checkingId,
    },
    {
      id: nanoid(),
      type: "social_security_start",
      name: "Jordan Social Security",
      startDate: "2059-09-22",
      personId: jordanId,
      monthlyBenefitAmount: 2_400,
      depositAccountId: checkingId,
    },
  ],
  settings: {
    startDate: "2026-01-01",
    horizonEndDate: "2087-12-31",
    inflationRatePct: 0.03,
    moneyFlow: {
      hubs: [{ accountId: checkingId, bufferAmount: 10_000 }],
      // Filled first, but only up to a cap that keeps pace with inflation; once
      // it's topped off, surplus spills to the uncapped brokerage catch-all.
      fillOrder: [
        { accountId: emergencyFundId, maxBalance: 30_000, maxBalanceGrowthRatePct: null, splitPct: null },
        { accountId: brokerageId, maxBalance: null, maxBalanceGrowthRatePct: null, splitPct: null },
      ],
      drainOrder: [emergencyFundId, brokerageId, alex401kId, jordan401kId, alexRothId],
      splitMode: "priority_fill",
    },
    rmdEnabled: true,
    withdrawalTaxRates: { taxDeferredPct: 0.22, taxablePct: 0.15, taxFreePct: 0 },
  },
};
