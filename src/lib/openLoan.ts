import { accountObjectSchema, openLoanEventSchema, categoryForClass } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { elapsedYears } from "@/engine/dateMath";
import { growthAdjustedAmount } from "@/engine/growth";
import { moneyStrToNumber, percentStrToFraction } from "@/lib/inputFormat";

/** Rate fields are PERCENT-unit strings ("7" = 7%/yr); money fields are
 *  lenient money strings ("40,000") -- same conventions as buyHome.ts. */
export type LoanKind = "fixed" | "heloc";

export interface OpenLoanInput {
  name: string;
  startDate: string;
  principal: string;
  annualInterestRatePct: string;
  /** A fixed loan's whole term; a HELOC's REPAYMENT period (after the draw). */
  termYears: string;
  extraPrincipalMonthly: string;
  /** "" = the money paid for something the plan doesn't track. */
  proceedsAccountId: string;
  kind: LoanKind;
  /** HELOC only: the years of interest-only draw before repayment starts. */
  drawYears: string;
  /** HELOC only: the home it is secured by -- paid off when that home sells. */
  securedByAccountId: string;
  /** The life-event template this came from, if any -- display only (its chart icon). */
  templateId?: string;
}

export const OPEN_LOAN_DEFAULTS: OpenLoanInput = {
  name: "",
  startDate: "",
  principal: "",
  annualInterestRatePct: "7",
  termYears: "5",
  extraPrincipalMonthly: "",
  proceedsAccountId: "",
  kind: "fixed",
  drawYears: "",
  securedByAccountId: "",
};

/** A HELOC as most US lenders write one: 10 years to draw at interest only,
 *  then 20 years to repay. The rate floats in real life; one rate is the
 *  simplification here, same as every other loan in the plan. */
export const HELOC_DEFAULTS: OpenLoanInput = {
  ...OPEN_LOAN_DEFAULTS,
  name: "HELOC",
  annualInterestRatePct: "8",
  drawYears: "10",
  termYears: "20",
  kind: "heloc",
};

type Result = { ok: true } | { ok: false; error: string };

/** Today's dollars -> nominal dollars at the origination date. Same
 *  inflate-forward snapshot buyHome.ts bakes into a home's starting balance,
 *  so the debt you described in today's money is the right size on the day
 *  you actually take it on. */
function nominalAt(amountToday: number, planStartDate: string, originationDate: string, inflationRatePct: number): number {
  return growthAdjustedAmount(amountToday, elapsedYears(planStartDate, originationDate), inflationRatePct);
}

function validate(input: OpenLoanInput): string | null {
  if (!input.name.trim()) return "Give this loan a name.";
  if (!input.startDate) return "Enter the date the loan starts.";
  if (!((moneyStrToNumber(input.principal) ?? 0) > 0)) return "Enter how much is borrowed.";
  const termYears = Number(input.termYears);
  if (!Number.isFinite(termYears) || termYears <= 0) {
    return input.kind === "heloc" ? "Enter the repayment period in years." : "Enter the loan's term in years.";
  }
  if (input.kind === "heloc") {
    const drawYears = Number(input.drawYears);
    if (!Number.isFinite(drawYears) || drawYears <= 0) return "Enter the draw period in years.";
    if (!input.securedByAccountId) return "Choose the home this line of credit is secured by.";
  }
  return null;
}

/** The `loan` account fields shared by create and update. */
function loanAccountCandidate(input: OpenLoanInput, principal: number, existingName?: string) {
  const termYears = Number(input.termYears);
  return {
    name: existingName ?? input.name.trim(),
    class: "loan" as const,
    category: categoryForClass("loan"),
    ownerId: null,
    startingBalance: principal,
    growthRatePct: 0,
    taxTreatment: "n/a" as const,
    subjectToRMD: false,
    startDate: input.startDate,
    loanTerms: {
      originalPrincipal: principal,
      originationDate: input.startDate,
      annualInterestRatePct: percentStrToFraction(input.annualInterestRatePct) ?? 0,
      termMonths: Math.max(1, Math.round(termYears * 12)),
      extraPrincipalMonthly: moneyStrToNumber(input.extraPrincipalMonthly) ?? undefined,
      ...(input.kind === "heloc"
        ? {
            interestOnlyMonths: Math.max(1, Math.round(Number(input.drawYears) * 12)),
            linkedAssetId: input.securedByAccountId,
          }
        : {}),
    },
  };
}

/**
 * Creates the `loan` account this borrowing produces, plus the thin open_loan
 * event that references it -- the loan is a real, permanent Account from here
 * on (editable on the Account tab, payable-off via a later Pay off a loan
 * event), exactly like a home bought by a buy_home event.
 */
export function openNewLoan(input: OpenLoanInput, settings: { startDate: string; inflationRatePct: number }): Result {
  const error = validate(input);
  if (error) return { ok: false, error };

  const principalToday = moneyStrToNumber(input.principal) ?? 0;
  const principal = nominalAt(principalToday, settings.startDate, input.startDate, settings.inflationRatePct);

  const { addAccount, addEvent } = usePlanStore.getState();
  const aResult = accountObjectSchema.omit({ id: true }).safeParse(loanAccountCandidate(input, principal));
  if (!aResult.success) return { ok: false, error: aResult.error.issues[0]?.message ?? "That doesn't look right." };
  addAccount(aResult.data);
  const after = usePlanStore.getState().activeScenario();
  const loanAccount = after.accounts[after.accounts.length - 1];
  if (!loanAccount) return { ok: false, error: "Something went wrong adding the loan." };

  const eventCandidate = {
    type: "open_loan" as const,
    name: input.name.trim(),
    startDate: input.startDate,
    loanAccountId: loanAccount.id,
    principal: principalToday,
    proceedsAccountId: input.proceedsAccountId || null,
    loanKind: input.kind,
    templateId: input.templateId,
  };
  const eResult = openLoanEventSchema.omit({ id: true }).safeParse(eventCandidate);
  if (!eResult.success) return { ok: false, error: eResult.error.issues[0]?.message ?? "That doesn't look right." };
  addEvent(eResult.data);
  return { ok: true };
}

/** Edits an open_loan in place -- the event and its loan account are updated
 *  together, so the two can never disagree about the amount, rate, term, or
 *  origination date. */
export function updateOpenedLoan(
  eventId: string,
  input: OpenLoanInput,
  settings: { startDate: string; inflationRatePct: number }
): Result {
  const error = validate(input);
  if (error) return { ok: false, error };

  const { activeScenario, updateAccount, updateEvent } = usePlanStore.getState();
  const scenario = activeScenario();
  const event = scenario.events.find((e) => e.id === eventId);
  if (!event || event.type !== "open_loan") return { ok: false, error: "That loan no longer exists." };
  const loanAccount = scenario.accounts.find((a) => a.id === event.loanAccountId);
  // Same guard as updateBoughtHome: a dangling link means an orphaned account
  // is loose in the plan. Fabricating a replacement is what leaves two loan
  // accounts behind, one of them unreachable.
  if (!loanAccount) return { ok: false, error: "This loan's account is missing. Reload the plan before editing it." };

  const principalToday = moneyStrToNumber(input.principal) ?? 0;
  const principal = nominalAt(principalToday, settings.startDate, input.startDate, settings.inflationRatePct);

  const candidate = {
    ...loanAccountCandidate(input, principal),
    isExcluded: loanAccount.isExcluded,
  };
  const aResult = accountObjectSchema.omit({ id: true }).safeParse(candidate);
  if (!aResult.success) return { ok: false, error: aResult.error.issues[0]?.message ?? "That doesn't look right." };
  updateAccount(loanAccount.id, aResult.data);

  const eventCandidate = {
    type: "open_loan" as const,
    name: input.name.trim(),
    startDate: input.startDate,
    loanAccountId: loanAccount.id,
    principal: principalToday,
    proceedsAccountId: input.proceedsAccountId || null,
    loanKind: input.kind,
    templateId: input.templateId ?? event.templateId,
    isExcluded: event.isExcluded,
    notes: event.notes,
  };
  const eResult = openLoanEventSchema.omit({ id: true }).safeParse(eventCandidate);
  if (!eResult.success) return { ok: false, error: eResult.error.issues[0]?.message ?? "That doesn't look right." };
  updateEvent(eventId, eResult.data);
  return { ok: true };
}

/** Removes an open_loan event and cascades to the loan account it created,
 *  since that account only ever existed for this borrowing. Fails without
 *  removing anything if the loan is still referenced elsewhere -- e.g. a
 *  Pay off a loan event pointed at it. */
export function removeOpenedLoan(eventId: string): Result {
  const { activeScenario, removeAccount, removeEvent } = usePlanStore.getState();
  const scenario = activeScenario();
  const event = scenario.events.find((e) => e.id === eventId);
  if (!event || event.type !== "open_loan") return { ok: false, error: "That loan no longer exists." };

  if (scenario.accounts.some((a) => a.id === event.loanAccountId)) {
    if (!removeAccount(event.loanAccountId)) {
      return {
        ok: false,
        error: "Can't delete this loan -- it's still referenced elsewhere (e.g. a Pay off a loan event). Remove that first.",
      };
    }
  }
  removeEvent(eventId);
  return { ok: true };
}
