import { accountObjectSchema, categoryForClass } from "@/domain";
import { usePlanStore } from "@/store/usePlanStore";
import { moneyStrToNumber, percentStrToFraction } from "@/lib/inputFormat";

/** Rate fields are PERCENT-unit strings ("7" = 7%/yr); money fields are
 *  lenient money strings ("18,400"). */
export interface ExistingLoanInput {
  name?: string;
  /** What is still owed today -- not the amount originally borrowed. */
  balance: string;
  annualInterestRatePct: string;
  /** Years left to run, not the original term. */
  yearsRemaining: string;
  monthlyPayment: string;
  extraPrincipalMonthly: string;
}

export const EXISTING_LOAN_DEFAULTS: ExistingLoanInput = {
  name: "",
  balance: "",
  annualInterestRatePct: "7",
  yearsRemaining: "5",
  monthlyPayment: "",
  extraPrincipalMonthly: "",
};

type Result = { ok: true } | { ok: false; error: string };

function validate(input: ExistingLoanInput): string | null {
  const balance = moneyStrToNumber(input.balance) ?? 0;
  if (!(balance > 0)) return "Enter how much is still owed on this loan.";
  const years = Number(input.yearsRemaining);
  // A blank term is what turns a loan into a one-month balloon payment: the
  // whole balance charged the month after it starts, with no error shown.
  if (!Number.isFinite(years) || years <= 0) return "Enter how many years are left on this loan.";
  const rate = percentStrToFraction(input.annualInterestRatePct) ?? 0;
  const payment = moneyStrToNumber(input.monthlyPayment);
  if (payment != null && payment <= (balance * rate) / 12) {
    return `That monthly payment doesn't cover the interest (~$${Math.ceil((balance * rate) / 12).toLocaleString()}/mo) -- the balance would grow forever. Raise the payment or leave it blank to auto-calculate.`;
  }
  return null;
}

/** A loan you already carry: it amortizes from the plan's start date at
 *  today's remaining balance, so there is no origination transaction and no
 *  cash ever arrives -- the borrowing happened before the plan began. */
function candidateFor(input: ExistingLoanInput, planStartDate: string, existing?: { isExcluded?: boolean; ownerId?: string | null }) {
  const balance = moneyStrToNumber(input.balance) ?? 0;
  const years = Number(input.yearsRemaining);
  return {
    name: input.name?.trim() || "Loan",
    class: "loan" as const,
    category: categoryForClass("loan"),
    ownerId: existing?.ownerId ?? null,
    startingBalance: balance,
    growthRatePct: 0,
    taxTreatment: "n/a" as const,
    subjectToRMD: false,
    isExcluded: existing?.isExcluded,
    loanTerms: {
      originalPrincipal: balance,
      originationDate: planStartDate,
      annualInterestRatePct: percentStrToFraction(input.annualInterestRatePct) ?? 0,
      termMonths: Math.max(1, Math.round(years * 12)),
      monthlyPayment: moneyStrToNumber(input.monthlyPayment) ?? undefined,
      extraPrincipalMonthly: moneyStrToNumber(input.extraPrincipalMonthly) ?? undefined,
    },
  };
}

export function addExistingLoan(input: ExistingLoanInput, planStartDate: string): Result {
  const error = validate(input);
  if (error) return { ok: false, error };
  const parsed = accountObjectSchema.omit({ id: true }).safeParse(candidateFor(input, planStartDate));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That doesn't look right." };
  usePlanStore.getState().addAccount(parsed.data);
  return { ok: true };
}

export function updateExistingLoan(accountId: string, input: ExistingLoanInput, planStartDate: string): Result {
  const error = validate(input);
  if (error) return { ok: false, error };
  const { activeScenario, updateAccount } = usePlanStore.getState();
  const account = activeScenario().accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: "That loan no longer exists." };
  // Keep the original origination date when there is one -- re-saving a loan
  // shouldn't silently restart its amortization clock at the plan start.
  const planStart = account.loanTerms?.originationDate ?? planStartDate;
  const parsed = accountObjectSchema.omit({ id: true }).safeParse(candidateFor(input, planStart, account));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That doesn't look right." };
  updateAccount(accountId, parsed.data);
  return { ok: true };
}

export function removeExistingLoan(accountId: string): Result {
  if (!usePlanStore.getState().removeAccount(accountId)) {
    return { ok: false, error: "Can't delete this loan -- it's still referenced elsewhere (e.g. a Pay off a loan event). Remove that first." };
  }
  return { ok: true };
}
