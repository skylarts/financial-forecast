import type { Id, ISODate, IncomeSource, Scenario, TemporaryAdjustment } from "@/domain";
import { addDays, compareDates, elapsedYears } from "./dateMath";
import { expandOccurrences } from "./occurrences";
import { growthAdjustedAmount, todaysDollarsAmount } from "./growth";
import { buildTimeline } from "./timeline";
import { resolvePrimarySpendingAccountId } from "./moneyFlow";
import type { EngineAccount, MortgageSpec, Posting, ResolvedSchedule } from "./types";

/** The earlier of two optional dates; null only when both are null. */
function earliestDate(a: ISODate | null, b: ISODate | null): ISODate | null {
  if (!a) return b;
  if (!b) return a;
  return compareDates(a, b) <= 0 ? a : b;
}

function activeMultiplier(windows: TemporaryAdjustment[], onDate: ISODate): number {
  let multiplier = 1;
  for (const w of windows) {
    const started = compareDates(onDate, w.startDate) >= 0;
    const notEnded = !w.endDate || compareDates(onDate, w.endDate) <= 0;
    if (started && notEnded) multiplier *= w.multiplier;
  }
  return multiplier;
}

export function resolveEvents(scenario: Scenario): ResolvedSchedule {
  const { settings } = scenario;
  const horizonEnd = settings.horizonEndDate;
  const events = scenario.events.filter((e) => !e.isExcluded);

  // Accounts that are excluded from the plan never receive or emit a
  // posting -- the engine treats them as if they don't exist for cash-flow
  // purposes (they still appear in the resolved account list so the UI can
  // render them as a static line; see forecastScenario for how their
  // balance stays frozen).
  const excludedAccountIds = new Set(scenario.accounts.filter((a) => a.isExcluded).map((a) => a.id));

  // growth_rate_change events, grouped by target account and sorted so the
  // engine can pick "the last one that's started" for any given month.
  const growthRateOverrides = new Map<Id, { startDate: ISODate; growthRatePct: number }[]>();
  for (const event of events) {
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

  const pushPosting = (posting: Posting) => {
    if (excludedAccountIds.has(posting.accountId)) return;
    postings.push(posting);
  };

  // --- Income sources: today's-dollars amount, own growth rate, plus any
  //     temporary adjustment windows entered directly on the source. ---
  const retirementByPerson = new Map<Id, ISODate>();
  const incomeEndOverrides = new Map<Id, ISODate>();
  for (const event of events) {
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
    }
  }

  // Social Security is not a separate event type -- it's a plain Income
  // entry with category "social_security", which is what triggers the
  // once-per-year (not continuous) COLA compounding below. No event needed.
  const incomeSources: IncomeSource[] = [...scenario.incomeSources];

  for (const src of incomeSources) {
    if (src.isExcluded) continue;
    const effectiveEnd = incomeEndOverrides.get(src.id) ?? src.endDate;
    const windows = src.adjustments ?? [];
    const occurrences = expandOccurrences(src.startDate, effectiveEnd, src.frequency, horizonEnd, src.intervalYears);
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
      pushPosting({
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
  for (const exp of scenario.expenses) {
    if (exp.isExcluded) continue;
    const windows = exp.adjustments ?? [];
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
      pushPosting({
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
  const contributionSpendingAccountId = resolvePrimarySpendingAccountId(scenario.accounts, settings.moneyFlow);
  for (const account of scenario.accounts) {
    if (!account.contribution || account.isExcluded) continue;
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
      pushPosting({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId: account.id,
        amount,
        category: "contribution_in",
        label: `Contribution: ${account.name}`,
        sourceId: `${account.id}:contribution`,
      });
      if (!payrollDeducted && contributionSpendingAccountId && contributionSpendingAccountId !== account.id) {
        pushPosting({
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
  for (const event of events) {
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

      pushPosting({
        date: event.startDate,
        yearMonth: event.startDate.slice(0, 7),
        accountId: event.downPaymentFromAccountId,
        amount: -downPaymentAmount,
        category: "transfer", // asset-for-asset swap (cash -> home equity), not consumption
        label: `Down payment: ${event.name}`,
        sourceId: `${event.id}:downpayment`,
      });

      // Derived from the event's own (stable) id, not a fresh nanoid() --
      // resolveEvents reruns on every edit, and a random id here would give
      // this account a new identity every render, breaking anything keyed by
      // account id across recomputes (e.g. the chart's per-account
      // show/hide toggle, which would silently "forget" these were hidden).
      const realEstateId = `${event.id}:real_estate`;
      let linkedLiabilityId: Id | undefined;

      if (event.mortgage) {
        const mortgageId = `${event.id}:mortgage`;
        const principal = purchasePrice - downPaymentAmount;
        accounts.push({
          id: mortgageId,
          name: `${event.name} (Mortgage)`,
          class: "mortgage",
          category: "liability",
          ownerId: null,
          startingBalance: principal,
          growthRatePct: 0,
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
          payingAccountId: resolvePrimarySpendingAccountId(scenario.accounts, settings.moneyFlow),
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
        pushPosting({
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
        pushPosting({
          date: event.startDate,
          yearMonth: event.startDate.slice(0, 7),
          accountId: event.paymentAccountId,
          amount: -amount,
          category: "expense",
          label: `One-time cost: ${event.name}`,
          sourceId: `${event.id}:onetime`,
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
        pushPosting({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId: event.fromAccountId,
          amount: -amount,
          category: "transfer",
          label: event.name,
          sourceId: `${event.id}:from`,
        });
        pushPosting({
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
