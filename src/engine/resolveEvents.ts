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

/**
 * Property tax, home insurance, and maintenance are entered as an annual
 * fraction of a home's value -- same shape whether the home came from a
 * buy_home event (baseValue = purchase price, referenceDate = purchase date)
 * or was entered directly as an already-owned real_estate account (baseValue
 * = its starting balance, referenceDate = plan start). Shared here so both
 * call sites price them identically off the home's own growth rate.
 */
function pushOwnershipCosts(
  pushPosting: (p: Posting) => void,
  horizonEnd: ISODate,
  input: {
    rates: { rate: number | undefined; label: string; key: string }[];
    baseValue: number;
    growthRate: number;
    referenceDate: ISODate;
    startDate: ISODate;
    /** null = runs through the end of the plan (or horizonEnd, whichever is sooner). */
    endDate: ISODate | null;
    accountId: Id | null;
    sourceIdPrefix: string;
    nameSuffix: string;
  }
) {
  const active = input.rates.filter((r) => r.rate);
  if (!active.length || !input.accountId) return;
  const occurrences = expandOccurrences(input.startDate, input.endDate, "monthly", horizonEnd);
  // All three rates share one sourceId/label -- separate from the mortgage
  // payment's own posting/key -- so the Cash Flow tab's per-item breakdown
  // (which aggregates by sourceId, see forecastScenario.ts's addTo/itemLabels)
  // rolls them up into a single "Home ownership costs" line instead of three.
  const sourceId = `${input.sourceIdPrefix}:ownership_costs`;
  const label = `Home ownership costs${input.nameSuffix}`;
  for (const occ of occurrences) {
    const homeValue = growthAdjustedAmount(input.baseValue, elapsedYears(input.referenceDate, occ), input.growthRate);
    for (const { rate } of active) {
      const amount = (homeValue * (rate ?? 0)) / 12;
      if (amount === 0) continue;
      pushPosting({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId: input.accountId,
        amount: -amount,
        category: "expense",
        label,
        sourceId,
      });
    }
  }
}

export function resolveEvents(scenario: Scenario): ResolvedSchedule {
  const { settings } = scenario;
  const horizonEnd = settings.horizonEndDate;
  const events = scenario.events.filter((e) => !e.isExcluded);

  // A buy_home event with replaceHousingExpenses retires the household's
  // prior housing arrangement -- computed once, up front, since it's needed
  // by the mortgage-registration and real-estate ownership-cost loops just
  // below (to stop an already-owned home's mortgage payments and its own
  // property tax/insurance/maintenance) as well as the Expenses loop further
  // down (to stop its category="housing" Expense, e.g. old rent). "Earliest
  // wins" across multiple qualifying events, same pattern as a retire event
  // trimming salary income.
  let earliestHousingReplaceCutoff: ISODate | null = null;
  for (const event of events) {
    if (event.type !== "buy_home" || !event.replaceHousingExpenses) continue;
    const trimmedEnd = addDays(event.startDate, -1);
    if (!earliestHousingReplaceCutoff || compareDates(trimmedEnd, earliestHousingReplaceCutoff) < 0) {
      earliestHousingReplaceCutoff = trimmedEnd;
    }
  }

  // A sell_home event retires exactly the one home it names -- unlike the
  // blanket replaceHousingExpenses toggle above, this is scoped per account
  // (a household with multiple homes can sell one without touching the
  // others). Keyed by both the real_estate account and its linked mortgage
  // (if any), since both need to stop the same day. Stores the sale's own
  // startDate (the transaction date, same day the net-proceeds posting
  // lands) -- callers that need "the day before" (recurring costs/payments,
  // same convention as earliestHousingReplaceCutoff above) derive it with
  // addDays(..., -1) at the point of use. "Earliest wins" if an account is
  // somehow named by more than one sell_home event.
  const soldAccountDates = new Map<Id, ISODate>();
  // The computed-proceeds sale mode (sellingCostsPct set): the engine credits
  // simulated equity at the sale month instead of a fixed netProceeds figure.
  const saleInfoByAccount = new Map<Id, { sellingCostsPct: number; proceedsAccountId: Id | null }>();
  for (const event of events) {
    if (event.type !== "sell_home") continue;
    const setSoldDate = (id: Id) => {
      const existing = soldAccountDates.get(id);
      if (!existing || compareDates(event.startDate, existing) < 0) soldAccountDates.set(id, event.startDate);
    };
    setSoldDate(event.realEstateAccountId);
    if (event.sellingCostsPct != null) {
      saleInfoByAccount.set(event.realEstateAccountId, {
        sellingCostsPct: event.sellingCostsPct,
        proceedsAccountId: event.proceedsAccountId,
      });
    }
    const realEstateAccount = scenario.accounts.find((a) => a.id === event.realEstateAccountId);
    if (realEstateAccount?.linkedLiabilityId) setSoldDate(realEstateAccount.linkedLiabilityId);
  }

  // Accounts that are excluded from the plan never receive or emit a
  // posting -- the engine treats them as if they don't exist for cash-flow
  // purposes (they still appear in the resolved account list so the UI can
  // render them as a static line; see forecastScenario for how their
  // balance stays frozen).
  const excludedAccountIds = new Set(scenario.accounts.filter((a) => a.isExcluded).map((a) => a.id));

  // An account's own growthRateSchedule, grouped by account and sorted so the
  // engine can pick "the last one that's started" for any given month --
  // effectiveAnnualRate just picks whichever entry most recently started.
  const growthRateOverrides = new Map<Id, { startDate: ISODate; growthRatePct: number }[]>();
  for (const account of scenario.accounts) {
    if (!account.growthRateSchedule?.length) continue;
    const list = growthRateOverrides.get(account.id) ?? [];
    for (const entry of account.growthRateSchedule) {
      list.push({ startDate: entry.startDate, growthRatePct: entry.ratePct });
    }
    growthRateOverrides.set(account.id, list);
  }
  for (const list of growthRateOverrides.values()) list.sort((a, b) => compareDates(a.startDate, b.startDate));

  const accounts: EngineAccount[] = scenario.accounts.map((a) => ({
    ...a,
    // a.startDate is how a future home purchase (see BuyHomeEvent) stays
    // frozen out of every balance/growth/rollforward calculation until its
    // closing date -- omitted (every other account) means "exists from the
    // plan's own start," unchanged from before this field existed.
    effectiveStartDate: a.startDate ?? settings.startDate,
    growthRateOverrides: growthRateOverrides.get(a.id),
    soldDate: soldAccountDates.get(a.id),
    saleInfo: saleInfoByAccount.get(a.id),
  }));
  const postings: Posting[] = [];
  const mortgages: MortgageSpec[] = [];

  const pushPosting = (posting: Posting) => {
    if (excludedAccountIds.has(posting.accountId)) return;
    postings.push(posting);
  };

  // The account a null depositAccountId/paymentAccountId/payingAccountId
  // falls back to -- Extra Savings, unless somehow missing (defensive only;
  // scenarioSchema's auto-inject transform guarantees it exists on any
  // scenario that's actually been parsed). Resolved once and reused for
  // income, expenses, contribution draws, and mortgage payments below.
  const primarySpendingAccountId = resolvePrimarySpendingAccountId(scenario.accounts);

  // A loan/mortgage account entered directly (Accounts tab, or the "add a
  // home you already own" flow) rather than synthesized by a buy_home event
  // still needs to amortize -- register it here so the "Amortize
  // mortgages/loans" step in forecastScenario.ts (which looks accounts up by
  // id in this same `mortgages` list) picks it up. Payments are funded from
  // the primary spending account, same fallback as every other cashflow. A
  // mortgage (not a generic "loan") stops taking payments once a
  // replaceHousingExpenses buy_home purchase retires it (frozen balance) or a
  // sell_home event sells it (zeroed balance -- see EngineAccount.soldDate
  // and forecastScenario's amortization step, which skips once the balance
  // is <= 0 regardless of paymentEndDate).
  for (const account of scenario.accounts) {
    if (excludedAccountIds.has(account.id)) continue;
    if ((account.class !== "loan" && account.class !== "mortgage" && account.class !== "credit_card") || !account.loanTerms) continue;
    const soldDate = soldAccountDates.get(account.id);
    // The housing-replace cutoff only retires mortgages that EXISTED before
    // the replacing purchase closed -- never the mortgage that purchase
    // itself creates (which starts on/after the cutoff and must amortize
    // normally). Guards the "buy a new home, drop the old housing costs"
    // flow from silently killing its own payments.
    const accountStart = account.startDate ?? settings.startDate;
    const applicableCutoff =
      earliestHousingReplaceCutoff && compareDates(accountStart, earliestHousingReplaceCutoff) <= 0
        ? earliestHousingReplaceCutoff
        : null;
    const paymentEndDate = earliestDate(applicableCutoff, soldDate ? addDays(soldDate, -1) : null);
    mortgages.push({
      accountId: account.id,
      loanTerms: account.loanTerms,
      payingAccountId: primarySpendingAccountId,
      paymentEndDate: account.class === "mortgage" ? paymentEndDate ?? undefined : undefined,
    });
  }

  // Every real_estate account -- whether entered directly ("Add a Home You
  // Already Own") or created by a buy_home event, both are ordinary Accounts
  // now -- prices its own property tax, insurance, and maintenance off its
  // starting balance, growing from its own startDate (falling back to the
  // plan start, same as effectiveStartDate above) at its own
  // propertyGrowthRatePct (falling back to growthRatePct if that's unset).
  // Stops the same day its mortgage's payments do, for the same reason (a
  // blanket replaceHousingExpenses purchase, or this specific home being sold).
  for (const account of scenario.accounts) {
    if (excludedAccountIds.has(account.id)) continue;
    if (account.class !== "real_estate") continue;
    const soldDate = soldAccountDates.get(account.id);
    const costsStartDate = account.startDate ?? settings.startDate;
    // Same scoping as the mortgage loop above: a replaceHousingExpenses
    // purchase only stops the ownership costs of homes that predate it --
    // the newly-bought home's own tax/insurance/maintenance must still run.
    const applicableCutoff =
      earliestHousingReplaceCutoff && compareDates(costsStartDate, earliestHousingReplaceCutoff) <= 0
        ? earliestHousingReplaceCutoff
        : null;
    const costsEndDate = earliestDate(applicableCutoff, soldDate ? addDays(soldDate, -1) : null);
    pushOwnershipCosts(pushPosting, horizonEnd, {
      rates: [
        { rate: account.propertyTaxRatePct, label: "Property tax", key: "property_tax" },
        { rate: account.homeInsuranceRatePct, label: "Home insurance", key: "home_insurance" },
        { rate: account.maintenanceRatePct, label: "Maintenance", key: "maintenance" },
      ],
      baseValue: account.startingBalance,
      growthRate: account.propertyGrowthRatePct ?? account.growthRatePct ?? settings.inflationRatePct,
      referenceDate: costsStartDate,
      startDate: costsStartDate,
      endDate: costsEndDate,
      accountId: primarySpendingAccountId,
      sourceIdPrefix: account.id,
      nameSuffix: `: ${account.name}`,
    });
  }

  // --- Income sources: today's-dollars amount, own growth rate, plus any
  //     temporary adjustment windows entered directly on the source. ---
  const retirementByPerson = new Map<Id, ISODate>();
  const incomeEndOverrides = new Map<Id, ISODate>();
  for (const event of events) {
    if (event.type !== "retire") continue;
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
        src.growthRatePct ?? settings.inflationRatePct, // blank growth = keep pace with inflation
        src.category === "social_security"
      );
      const amount = base * activeMultiplier(windows, occ);
      if (amount === 0) continue;
      const accountId = src.depositAccountId ?? primarySpendingAccountId;
      if (!accountId) continue;
      pushPosting({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId,
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
    // A category="housing" expense (e.g. rent) stops the day before a
    // replaceHousingExpenses buy_home purchase closes, same as the old
    // mortgage payments and ownership costs below.
    const effectiveEnd = exp.category === "housing" ? earliestDate(exp.endDate, earliestHousingReplaceCutoff) : exp.endDate;
    const windows = exp.adjustments ?? [];
    const occurrences = expandOccurrences(exp.startDate, effectiveEnd, exp.frequency, horizonEnd, exp.intervalYears);
    for (const occ of occurrences) {
      // Entered in today's dollars; inflates from plan start to this expense's
      // own start, then grows at its own configured rate from there.
      const base = todaysDollarsAmount(
        exp.amount,
        settings.startDate,
        exp.startDate,
        occ,
        settings.inflationRatePct,
        exp.growthRatePct ?? settings.inflationRatePct // blank growth = keep pace with inflation
      );
      const amount = base * activeMultiplier(windows, occ);
      if (amount === 0) continue;
      const accountId = exp.paymentAccountId ?? primarySpendingAccountId;
      if (!accountId) continue;
      pushPosting({
        date: occ,
        yearMonth: occ.slice(0, 7),
        accountId,
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
  const contributionSpendingAccountId = primarySpendingAccountId;
  const postContribution = (account: (typeof scenario.accounts)[number], occ: ISODate, amount: number, payrollDeducted: boolean) => {
    if (amount === 0) return;
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
  };

  for (const account of scenario.accounts) {
    if (account.isExcluded) continue;
    // Contributions stop the day before the owner's retirement (mirrors how
    // salary is trimmed -- last contribution while still earning). An explicit
    // endDate wins when it lands earlier, and covers jointly-owned accounts
    // that have no single retiree.
    const ownerRetireDate = account.ownerId ? retirementByPerson.get(account.ownerId) : undefined;
    const retireEnd = ownerRetireDate ? addDays(ownerRetireDate, -1) : null;

    if (account.contributionSchedule?.length) {
      // A schedule supersedes the single `contribution` entirely. Each
      // segment runs from its own startDate through its own endDate, else the
      // next segment's startDate, else the retirement/horizon cutoff above --
      // so segments can either abut (one takes over exactly where the last
      // left off) or leave a gap (no contribution in between) depending on
      // whether the user set an explicit endDate.
      const segments = [...account.contributionSchedule].sort((a, b) => compareDates(a.startDate, b.startDate));
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const nextStart = segments[i + 1]?.startDate ?? null;
        const segmentEnd = earliestDate(
          earliestDate(segment.endDate ?? null, nextStart ? addDays(nextStart, -1) : null),
          retireEnd
        );
        const occurrences = expandOccurrences(segment.startDate, segmentEnd, segment.frequency, horizonEnd);
        for (const occ of occurrences) {
          // Entered in today's dollars; inflates from plan start to this
          // segment's own start, then grows at its own rate from there --
          // same two-stage pattern as income/expenses, since (unlike the
          // single `contribution` field) a segment can start well into the plan.
          const amount = todaysDollarsAmount(
            segment.amount,
            settings.startDate,
            segment.startDate,
            occ,
            settings.inflationRatePct,
            segment.growthRatePct ?? settings.inflationRatePct // blank growth = keep pace with inflation
          );
          postContribution(account, occ, amount, segment.payrollDeducted);
        }
      }
    } else if (account.contribution) {
      const { amount: baseAmount, frequency, growthRatePct, payrollDeducted, endDate } = account.contribution;
      const contributionEnd = earliestDate(endDate ?? null, retireEnd);
      const occurrences = expandOccurrences(settings.startDate, contributionEnd, frequency, horizonEnd);
      for (const occ of occurrences) {
        const years = elapsedYears(settings.startDate, occ);
        const amount = growthAdjustedAmount(baseAmount, years, growthRatePct ?? settings.inflationRatePct);
        postContribution(account, occ, amount, payrollDeducted);
      }
    }
  }

  // --- Remaining event types: direct postings + dynamically-created accounts ---
  for (const event of events) {
    if (event.type === "buy_home") {
      // The real_estate account (and, if financed, its linked mortgage) this
      // purchase created is a real, permanent Account by now -- see
      // src/lib/buyHome.ts, which builds it at save time -- so it already
      // flows through the ordinary real_estate/mortgage account loops above
      // (ownership costs, amortization) via its own startDate. All that's
      // left here is the down-payment transaction itself.
      //
      // Purchase price and down payment are entered in today's dollars;
      // inflate both by the same factor so the loan-to-value ratio the user
      // configured is preserved at the purchase date -- same inflation factor
      // buyHome.ts used to compute the account's own startingBalance.
      const inflationFactor = growthAdjustedAmount(
        1,
        elapsedYears(settings.startDate, event.startDate),
        settings.inflationRatePct
      );
      // In a cash purchase the UI stores downPaymentAmount === purchasePrice, so
      // this single upfront posting funds the whole home; when financed it's the
      // real down payment and the mortgage covers the rest. Either way it's an
      // asset-for-asset swap (cash -> home equity), not consumption.
      const downPaymentAmount = event.downPaymentAmount * inflationFactor;
      const realEstateAccount = scenario.accounts.find((a) => a.id === event.realEstateAccountId);

      pushPosting({
        date: event.startDate,
        yearMonth: event.startDate.slice(0, 7),
        accountId: event.downPaymentFromAccountId,
        amount: -downPaymentAmount,
        category: "transfer",
        label: realEstateAccount?.linkedLiabilityId ? `Down payment: ${event.name}` : `Home purchase: ${event.name}`,
        sourceId: `${event.id}:downpayment`,
      });
    } else if (event.type === "sell_home") {
      // Computed-proceeds mode: no posting here -- the engine credits
      // simulated value × (1 − sellingCostsPct) − remaining mortgage at the
      // sale month itself (see EngineAccount.saleInfo and forecastScenario's
      // home-sale step), so the cash credited always matches the equity the
      // model projects at that date.
      if (event.sellingCostsPct != null) continue;
      // Fixed mode: net proceeds are entered directly (not sale price minus
      // costs separately) since the mortgage payoff isn't known until the
      // projection runs -- see EngineAccount.soldDate, which zeroes the
      // real_estate account and its linked mortgage this same month in
      // forecastScenario's monthly loop. Entered in today's dollars,
      // inflated forward to the sale date like every other dollar amount.
      const amount = growthAdjustedAmount(
        event.netProceeds,
        elapsedYears(settings.startDate, event.startDate),
        settings.inflationRatePct
      );
      const accountId = event.proceedsAccountId ?? primarySpendingAccountId;
      if (accountId && amount !== 0) {
        pushPosting({
          date: event.startDate,
          yearMonth: event.startDate.slice(0, 7),
          accountId,
          amount,
          category: "transfer", // asset-for-asset swap (home equity -> cash), not consumption
          label: `Home sale: ${event.name}`,
          sourceId: `${event.id}:proceeds`,
        });
      }
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
    } else if (event.type === "retire" && event.retirementExpense) {
      const exp = event.retirementExpense;
      const windows = exp.adjustments ?? [];
      const occurrences = expandOccurrences(event.startDate, exp.endDate ?? null, "annual", horizonEnd);
      for (const occ of occurrences) {
        // Entered in today's dollars; inflates from plan start to the
        // retirement date (this expense's own "start"), then grows at its
        // own rate from there -- same two-stage pattern as a regular Expense.
        const base = todaysDollarsAmount(
          exp.amount,
          settings.startDate,
          event.startDate,
          occ,
          settings.inflationRatePct,
          exp.growthRatePct ?? settings.inflationRatePct // blank growth = keep pace with inflation
        );
        const amount = base * activeMultiplier(windows, occ);
        if (amount === 0) continue;
        const accountId = exp.paymentAccountId ?? primarySpendingAccountId;
        if (!accountId) continue;
        pushPosting({
          date: occ,
          yearMonth: occ.slice(0, 7),
          accountId,
          amount: -Math.abs(amount),
          category: "expense",
          label: `Retirement expense: ${event.name}`,
          sourceId: `${event.id}:retirement_expense`,
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
          event.growthRatePct ?? settings.inflationRatePct // blank growth = keep pace with inflation
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
