import { nanoid } from "nanoid";
import type { Account, Id, ISODate, IncomeSource, ExpenseBaseline, Scenario } from "@/domain";
import { addDays, compareDates, elapsedYears } from "./dateMath";
import { expandOccurrences } from "./occurrences";
import { growthAdjustedAmount, todaysDollarsAmount } from "./growth";
import { buildTimeline } from "./timeline";
import type { EngineAccount, MortgageSpec, Posting, ResolvedSchedule } from "./types";

interface ModifierWindow {
  startDate: ISODate;
  endDate: ISODate | null;
  multiplier: number;
}

/** The earlier of two optional dates; null only when both are null. */
function earliestDate(a: ISODate | null, b: ISODate | null): ISODate | null {
  if (!a) return b;
  if (!b) return a;
  return compareDates(a, b) <= 0 ? a : b;
}

function activeMultiplier(windows: ModifierWindow[], onDate: ISODate): number {
  let multiplier = 1;
  for (const w of windows) {
    const started = compareDates(onDate, w.startDate) >= 0;
    const notEnded = !w.endDate || compareDates(onDate, w.endDate) <= 0;
    if (started && notEnded) multiplier *= w.multiplier;
  }
  return multiplier;
}

function resolvePrimarySpendingAccountId(accounts: Account[]): Id | null {
  const spending = accounts.find((a) => a.isSpendingAccount);
  if (spending) return spending.id;
  const cash = accounts.find((a) => a.class === "cash");
  return cash ? cash.id : null;
}

export function resolveEvents(scenario: Scenario): ResolvedSchedule {
  const { settings } = scenario;
  const horizonEnd = settings.horizonEndDate;

  // growth_rate_change events, grouped by target account and sorted so the
  // engine can pick "the last one that's started" for any given month.
  const growthRateOverrides = new Map<Id, { startDate: ISODate; growthRatePct: number }[]>();
  for (const event of scenario.events) {
    if (event.type === "growth_rate_change") {
      const list = growthRateOverrides.get(event.targetAccountId) ?? [];
      list.push({ startDate: event.startDate, growthRatePct: event.newGrowthRatePct });
      growthRateOverrides.set(event.targetAccountId, list);
    }
  }
  for (const list of growthRateOverrides.values()) list.sort((a, b) => compareDates(a.startDate, b.startDate));

  const accounts: EngineAccount[] = scenario.accounts.map((a) => ({
    ...a,
    effectiveStartDate: settings.startDate,
    growthRateOverrides: growthRateOverrides.get(a.id),
  }));
  const postings: Posting[] = [];
  const mortgages: MortgageSpec[] = [];

  // --- Income sources: start from the baseline, then layer event effects ---
  const incomeSources: IncomeSource[] = [...scenario.incomeSources];
  const incomeEndOverrides = new Map<Id, ISODate>();
  const incomeModifiers = new Map<Id, ModifierWindow[]>();
  // Earliest retirement date per person; used to end both their salary and the
  // contributions into accounts they own.
  const retirementByPerson = new Map<Id, ISODate>();

  for (const event of scenario.events) {
    if (event.type === "retire") {
      const existingRetire = retirementByPerson.get(event.personId);
      if (!existingRetire || compareDates(event.startDate, existingRetire) < 0) {
        retirementByPerson.set(event.personId, event.startDate);
      }
      for (const src of scenario.incomeSources) {
        if (src.ownerId === event.personId && src.category === "salary") {
          const trimmedEnd = addDays(event.startDate, -1);
          const existing = incomeEndOverrides.get(src.id);
          if (!existing || compareDates(trimmedEnd, existing) < 0) {
            incomeEndOverrides.set(src.id, trimmedEnd);
          }
        }
      }
    } else if (event.type === "income_change") {
      const list = incomeModifiers.get(event.targetIncomeSourceId) ?? [];
      list.push({
        startDate: event.startDate,
        endDate: event.endDate ?? null,
        multiplier: event.multiplier ?? 0,
      });
      incomeModifiers.set(event.targetIncomeSourceId, list);
    } else if (event.type === "social_security_start") {
      incomeSources.push({
        id: nanoid(),
        name: event.name,
        ownerId: event.personId,
        amount: event.monthlyBenefitAmount,
        frequency: "monthly",
        startDate: event.startDate,
        endDate: null,
        // Benefit is entered in today's dollars; grow it each year as a COLA.
        // Defaults to the global inflation rate unless the event overrides it.
        growthRatePct: event.growthRatePct ?? settings.inflationRatePct,
        depositAccountId: event.depositAccountId,
        category: "social_security",
      });
    }
  }

  for (const src of incomeSources) {
    const effectiveEnd = incomeEndOverrides.get(src.id) ?? src.endDate;
    const windows = incomeModifiers.get(src.id) ?? [];
    const occurrences = expandOccurrences(src.startDate, effectiveEnd, src.frequency, horizonEnd);
    for (const occ of occurrences) {
      // Every income amount is entered in today's dollars: inflation carries
      // it from the plan start to this source's own start date (today's
      // purchasing power -> nominal dollars when it begins), then its own
      // growthRatePct takes over from there (a raise, COLA, etc.). Social
      // Security steps that post-start growth up once per whole year, mirroring
      // how real benefits adjust each January; other income grows continuously.
      const base = todaysDollarsAmount(
        src.amount,
        settings.startDate,
        src.startDate,
        occ,
        settings.inflationRatePct,
        src.growthRatePct,
        src.category === "social_security"
      );
      const amount = base * activeMultiplier(windows, occ);
      if (amount === 0) continue;
      postings.push({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId: src.depositAccountId,
        amount,
        category: "income",
        label: src.name,
        sourceId: src.id,
      });
    }
  }

  // --- Expenses: same pattern as income ---
  const expenses: ExpenseBaseline[] = [...scenario.expenses];
  const expenseModifiers = new Map<Id, ModifierWindow[]>();

  for (const event of scenario.events) {
    if (event.type === "expense_change") {
      const list = expenseModifiers.get(event.targetExpenseId) ?? [];
      list.push({
        startDate: event.startDate,
        endDate: event.endDate ?? null,
        multiplier: event.multiplier ?? 0,
      });
      expenseModifiers.set(event.targetExpenseId, list);
    }
  }

  for (const exp of expenses) {
    const windows = expenseModifiers.get(exp.id) ?? [];
    const occurrences = expandOccurrences(exp.startDate, exp.endDate, exp.frequency, horizonEnd, exp.intervalYears);
    for (const occ of occurrences) {
      // Entered in today's dollars; inflates from plan start to this expense's
      // own start, then grows at its own configured rate from there.
      const base = todaysDollarsAmount(
        exp.amount,
        settings.startDate,
        exp.startDate,
        occ,
        settings.inflationRatePct,
        exp.growthRatePct
      );
      const amount = base * activeMultiplier(windows, occ);
      if (amount === 0) continue;
      postings.push({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId: exp.paymentAccountId,
        amount: -Math.abs(amount),
        category: "expense",
        label: exp.name,
        sourceId: exp.id,
      });
    }
  }

  // --- Account contributions ---
  // Each contributing account gets a deposit ("contribution_in"). Contributions
  // funded from take-home (payrollDeducted false) also draw the same amount out
  // of the spending account ("contribution_out"), so they cost cash; payroll-
  // deducted ones don't, since take-home income was entered net of them. This is
  // independent of tax treatment (a Roth 401k is payroll-deducted but after-tax).
  const contributionSpendingAccountId = resolvePrimarySpendingAccountId(scenario.accounts);
  for (const account of scenario.accounts) {
    if (!account.contribution) continue;
    const { amount: baseAmount, frequency, growthRatePct, payrollDeducted, endDate } = account.contribution;
    // Contributions stop the day before the owner's retirement (mirrors how
    // salary is trimmed -- last contribution while still earning). An explicit
    // endDate wins when it lands earlier, and covers jointly-owned accounts
    // that have no single retiree.
    const ownerRetireDate = account.ownerId ? retirementByPerson.get(account.ownerId) : undefined;
    const retireEnd = ownerRetireDate ? addDays(ownerRetireDate, -1) : null;
    const contributionEnd = earliestDate(endDate ?? null, retireEnd);
    const occurrences = expandOccurrences(settings.startDate, contributionEnd, frequency, horizonEnd);
    for (const occ of occurrences) {
      const years = elapsedYears(settings.startDate, occ);
      const amount = growthAdjustedAmount(baseAmount, years, growthRatePct);
      if (amount === 0) continue;
      postings.push({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId: account.id,
        amount,
        category: "contribution_in",
        label: `Contribution: ${account.name}`,
        sourceId: `${account.id}:contribution`,
      });
      if (!payrollDeducted && contributionSpendingAccountId && contributionSpendingAccountId !== account.id) {
        postings.push({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId: contributionSpendingAccountId,
          amount: -amount,
          category: "contribution_out",
          label: `Contribution: ${account.name}`,
          sourceId: `${account.id}:contribution`,
        });
      }
    }
  }

  // --- Remaining event types: direct postings + dynamically-created accounts ---
  for (const event of scenario.events) {
    if (event.type === "buy_home") {
      // Purchase price and down payment are entered in today's dollars;
      // inflate both by the same factor so the loan-to-value ratio the user
      // configured is preserved at the future purchase date.
      const inflationFactor = growthAdjustedAmount(
        1,
        elapsedYears(settings.startDate, event.startDate),
        settings.inflationRatePct
      );
      const purchasePrice = event.purchasePrice * inflationFactor;
      const downPaymentAmount = event.downPaymentAmount * inflationFactor;

      postings.push({
        date: event.startDate,
        yearMonth: event.startDate.slice(0, 7),
        accountId: event.downPaymentFromAccountId,
        amount: -downPaymentAmount,
        category: "transfer", // asset-for-asset swap (cash -> home equity), not consumption
        label: `Down payment: ${event.name}`,
        sourceId: `${event.id}:downpayment`,
      });

      const realEstateId = nanoid();
      let linkedLiabilityId: Id | undefined;

      if (event.mortgage) {
        const mortgageId = nanoid();
        const principal = purchasePrice - downPaymentAmount;
        accounts.push({
          id: mortgageId,
          name: `${event.name} (Mortgage)`,
          class: "mortgage",
          category: "liability",
          ownerId: null,
          startingBalance: principal,
          growthRatePct: 0,
          isExcluded: false,
          linkedExternally: false,
          withdrawalPriority: null,
          isSpendingAccount: false,
          isSurplusTarget: false,
          surplusTargetPriority: null,
          maxBalance: null,
          maxBalanceGrowthRatePct: null,
          taxTreatment: "n/a",
          subjectToRMD: false,
          loanTerms: {
            originalPrincipal: principal,
            originationDate: event.startDate,
            annualInterestRatePct: event.mortgage.annualInterestRatePct,
            termMonths: event.mortgage.termMonths,
            linkedAssetId: realEstateId,
          },
          effectiveStartDate: event.startDate,
        });
        mortgages.push({
          accountId: mortgageId,
          loanTerms: {
            originalPrincipal: principal,
            originationDate: event.startDate,
            annualInterestRatePct: event.mortgage.annualInterestRatePct,
            termMonths: event.mortgage.termMonths,
          },
          payingAccountId: resolvePrimarySpendingAccountId(scenario.accounts),
        });
        linkedLiabilityId = mortgageId;
      }

      accounts.push({
        id: realEstateId,
        name: event.name,
        class: "real_estate",
        category: "asset",
        ownerId: null,
        startingBalance: purchasePrice,
        growthRatePct: event.propertyGrowthRatePct,
        propertyGrowthRatePct: event.propertyGrowthRatePct,
        isExcluded: false,
        linkedExternally: false,
        withdrawalPriority: null,
        isSpendingAccount: false,
        isSurplusTarget: false,
        surplusTargetPriority: null,
        maxBalance: null,
        maxBalanceGrowthRatePct: null,
        taxTreatment: "n/a",
        subjectToRMD: false,
        linkedLiabilityId,
        effectiveStartDate: event.startDate,
      });
    } else if (event.type === "have_a_kid") {
      const end = event.childcareEndDate ?? horizonEnd;
      const occurrences = expandOccurrences(event.startDate, end, "monthly", horizonEnd);
      for (const occ of occurrences) {
        // Childcare entered in today's dollars; inflates from plan start (not
        // just the kid's arrival) to each occurrence date.
        const amount = growthAdjustedAmount(
          event.childcareMonthlyExpense,
          elapsedYears(settings.startDate, occ),
          settings.inflationRatePct
        );
        postings.push({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId: event.paymentAccountId,
          amount: -amount,
          category: "expense",
          label: `Childcare: ${event.name}`,
          sourceId: `${event.id}:childcare`,
        });
      }
      if (event.additionalOneTimeCost) {
        // Also entered in today's dollars; inflate to the event's start date.
        const amount = growthAdjustedAmount(
          event.additionalOneTimeCost,
          elapsedYears(settings.startDate, event.startDate),
          settings.inflationRatePct
        );
        postings.push({
          date: event.startDate,
          yearMonth: event.startDate.slice(0, 7),
          accountId: event.paymentAccountId,
          amount: -amount,
          category: "expense",
          label: `One-time cost: ${event.name}`,
          sourceId: `${event.id}:onetime`,
        });
      }
    } else if (event.type === "windfall") {
      const recurEvery = event.isRecurring ? event.intervalYears : undefined;
      const frequency = event.isRecurring && event.frequency ? event.frequency : "one_time";
      const occurrences = expandOccurrences(event.startDate, event.endDate ?? null, frequency, horizonEnd, recurEvery);
      for (const occ of occurrences) {
        // Entered in today's dollars; inflates from plan start to each
        // occurrence date (recurring windfalls each reflect the same real
        // cost/value, growing in nominal terms as they recur further out).
        const amount = growthAdjustedAmount(
          event.amount,
          elapsedYears(settings.startDate, occ),
          settings.inflationRatePct
        );
        postings.push({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId: event.depositAccountId,
          amount,
          category: amount >= 0 ? "income" : "expense",
          label: event.name,
          sourceId: event.id,
        });
      }
    } else if (event.type === "custom_transfer") {
      const occurrences = expandOccurrences(event.startDate, event.endDate ?? null, event.frequency, horizonEnd, event.intervalYears);
      for (const occ of occurrences) {
        // Entered in today's dollars; inflates from plan start to this
        // transfer's own start, then grows at its own rate (0 = flat) from there.
        const amount = todaysDollarsAmount(
          event.amount,
          settings.startDate,
          event.startDate,
          occ,
          settings.inflationRatePct,
          event.growthRatePct ?? 0
        );
        postings.push({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId: event.fromAccountId,
          amount: -amount,
          category: "transfer",
          label: event.name,
          sourceId: `${event.id}:from`,
        });
        postings.push({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId: event.toAccountId,
          amount,
          category: "transfer",
          label: event.name,
          sourceId: `${event.id}:to`,
        });
      }
    }
  }

  return { accounts, postings, mortgages, timeline: buildTimeline(scenario) };
}
