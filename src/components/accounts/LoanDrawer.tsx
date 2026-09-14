"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, OpenLoanEvent } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { DrawerFooter, ErrorBanner, Field, FieldRow, TextInput, PercentInput, MoneyInput, SelectInput, missingFieldMessage } from "@/components/ui/formFields";
import { accountOptions as labelledAccountOptions } from "@/lib/people";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";
import { addExistingLoan, updateExistingLoan, removeExistingLoan, EXISTING_LOAN_DEFAULTS } from "@/lib/existingLoan";
import { openNewLoan, updateOpenedLoan, removeOpenedLoan, OPEN_LOAN_DEFAULTS, HELOC_DEFAULTS, type LoanKind } from "@/lib/openLoan";
import { computeMonthlyPayment } from "@/engine/amortization";
import { todayISO } from "@/engine/dateMath";

type Mode = "existing" | "new";

interface FormValues {
  name: string;
  startDate: string;
  amount: string;
  annualInterestRatePct: string;
  /** Fixed: the term (or years remaining). HELOC: the repayment period. */
  termYears: string;
  /** HELOC: years of interest-only draw (remaining, when already held). */
  drawYears: string;
  securedByAccountId: string;
  monthlyPayment: string;
  extraPrincipalMonthly: string;
  proceedsAccountId: string;
}

function defaultsFor(mode: Mode, kind: LoanKind): FormValues {
  if (kind === "heloc") {
    return {
      name: HELOC_DEFAULTS.name,
      startDate: "",
      amount: "",
      annualInterestRatePct: HELOC_DEFAULTS.annualInterestRatePct,
      termYears: HELOC_DEFAULTS.termYears,
      drawYears: HELOC_DEFAULTS.drawYears,
      securedByAccountId: "",
      monthlyPayment: "",
      extraPrincipalMonthly: "",
      proceedsAccountId: "",
    };
  }
  return {
    name: mode === "existing" ? "Loan" : "",
    startDate: "",
    amount: "",
    annualInterestRatePct: mode === "existing" ? EXISTING_LOAN_DEFAULTS.annualInterestRatePct : OPEN_LOAN_DEFAULTS.annualInterestRatePct,
    termYears: mode === "existing" ? EXISTING_LOAN_DEFAULTS.yearsRemaining : OPEN_LOAN_DEFAULTS.termYears,
    drawYears: "",
    securedByAccountId: "",
    monthlyPayment: "",
    extraPrincipalMonthly: "",
    proceedsAccountId: "",
  };
}

/** What kind of loan an existing account is, read off its terms. */
function kindOf(account?: Account, event?: OpenLoanEvent): LoanKind {
  if (event) return event.loanKind;
  return account?.loanTerms?.interestOnlyMonths ? "heloc" : "fixed";
}

function toFormValues(mode: Mode, kind: LoanKind, account?: Account, event?: OpenLoanEvent): FormValues {
  if (!account) return defaultsFor(mode, kind);
  const terms = account.loanTerms;
  const shared = {
    annualInterestRatePct: terms ? fractionToPercentStr(terms.annualInterestRatePct) : EXISTING_LOAN_DEFAULTS.annualInterestRatePct,
    termYears: terms ? Math.round(terms.termMonths / 12).toString() : EXISTING_LOAN_DEFAULTS.yearsRemaining,
    drawYears: terms?.interestOnlyMonths != null ? Math.round(terms.interestOnlyMonths / 12).toString() : "",
    securedByAccountId: terms?.linkedAssetId ?? "",
    monthlyPayment: terms?.monthlyPayment != null ? moneyToStr(terms.monthlyPayment) : "",
    extraPrincipalMonthly: terms?.extraPrincipalMonthly != null ? moneyToStr(terms.extraPrincipalMonthly) : "",
  };
  if (mode === "new" && event) {
    return {
      ...shared,
      name: event.name,
      startDate: event.startDate,
      // The event holds today's dollars; the account holds the inflated
      // snapshot. Editing must show what was typed, not the snapshot.
      amount: moneyToStr(event.principal),
      proceedsAccountId: event.proceedsAccountId ?? "",
    };
  }
  return { ...shared, name: account.name, startDate: "", amount: moneyToStr(account.startingBalance), proceedsAccountId: "" };
}

/**
 * One drawer for every loan that isn't a mortgage: one you already carry, one
 * you take out later (a life event), and editing either kind afterward --
 * whether you open it from the Account tab's pencil or from a Take out a loan
 * event on the Timeline, it's the same form against the same underlying
 * account. Mirrors HomeDrawer, which does exactly this for real estate; see
 * src/lib/existingLoan.ts and src/lib/openLoan.ts for the two paths.
 *
 * Two kinds share the form: a fixed loan (car, student, personal) and a home
 * equity line of credit, which is secured by a home and spends its first
 * years interest-only before it amortizes.
 *
 * A mortgage is deliberately NOT handled here -- its terms are edited as part
 * of its home, so it routes to HomeDrawer instead.
 */
export function LoanDrawer({
  open,
  onClose,
  account,
  event,
  accounts,
  initialMode = "existing",
  initialKind = "fixed",
  templateId,
}: {
  open: boolean;
  onClose: () => void;
  /** The loan account being edited; omitted when creating a new one. */
  account?: Account;
  /** The linked open_loan event, if this loan is taken out during the plan. */
  event?: OpenLoanEvent;
  /** For the "Deposit the money into" and "Secured by" dropdowns. */
  accounts: Account[];
  /** Only consulted when account is omitted (creating new). */
  initialMode?: Mode;
  /** Only consulted when account is omitted (creating new). */
  initialKind?: LoanKind;
  /** The life-event template that opened this, if any -- display only (its chart icon). */
  templateId?: string;
}) {
  const settings = usePlanStore((s) => s.activeScenario().settings);
  const effectiveStartDate = settings.startDate ?? todayISO();
  const people = usePlanStore((s) => s.activeScenario().household.people);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!account;
  const [mode, setMode] = useState<Mode>(event ? "new" : initialMode);
  const [kind, setKind] = useState<LoanKind>(isEditing ? kindOf(account, event) : initialKind);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    getValues,
    formState: { isDirty },
  } = useForm<FormValues>({ defaultValues: toFormValues(mode, kind, account, event) });

  /** Switching mode or kind on a new loan re-seeds that combination's
   *  defaults, keeping what was already typed where it still applies. */
  const reseed = (nextMode: Mode, nextKind: LoanKind) => {
    const d = defaultsFor(nextMode, nextKind);
    const keepName = getValues("name");
    const generic = keepName === "" || keepName === "Loan" || keepName === HELOC_DEFAULTS.name;
    reset({ ...d, name: generic ? d.name : keepName, amount: getValues("amount"), startDate: getValues("startDate") });
  };
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    if (!isEditing) reseed(next, kind);
  };
  const switchKind = (next: LoanKind) => {
    if (next === kind) return;
    setKind(next);
    if (!isEditing) reseed(mode, next);
  };

  useEffect(() => {
    const nextMode: Mode = event ? "new" : isEditing ? "existing" : initialMode;
    const nextKind: LoanKind = isEditing ? kindOf(account, event) : initialKind;
    setMode(nextMode);
    setKind(nextKind);
    reset(toFormValues(nextMode, nextKind, account, event));
    setError(null);
    // Only re-run when the drawer opens or the underlying record changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, event, open, initialMode, initialKind, reset]);

  const isHeloc = kind === "heloc";

  // Live payment estimate -- a display aid only; the engine recomputes from
  // the saved terms independently.
  const principal = moneyStrToNumber(watch("amount")) ?? 0;
  const rate = percentStrToFraction(watch("annualInterestRatePct")) ?? 0;
  const termMonths = (Number(watch("termYears")) || 0) * 12;
  const drawYears = Number(watch("drawYears")) || 0;
  const typedPayment = moneyStrToNumber(watch("monthlyPayment"));
  const extra = moneyStrToNumber(watch("extraPrincipalMonthly")) ?? 0;
  const interestOnly = (principal * rate) / 12;
  const pAndI = typedPayment ?? (principal > 0 && termMonths > 0 ? computeMonthlyPayment(principal, rate, termMonths) : 0);
  const money0 = (n: number) => `$${Math.round(n).toLocaleString()}`;

  const proceedsOptions = [
    { value: "", label: isHeloc ? "Nothing drawn yet -- it's just available" : "It paid for something outside the plan" },
    ...labelledAccountOptions(
      accounts.filter((a) => a.category === "asset" && a.class !== "real_estate" && a.class !== "other_asset"),
      people
    ),
  ];
  const homeOptions = [
    { value: "", label: "Choose a home..." },
    ...labelledAccountOptions(
      accounts.filter((a) => a.class === "real_estate"),
      people
    ),
  ];

  const onSubmit = (v: FormValues) => {
    let result: { ok: true } | { ok: false; error: string };
    if (mode === "existing") {
      const input = {
        name: v.name,
        balance: v.amount,
        annualInterestRatePct: v.annualInterestRatePct,
        yearsRemaining: v.termYears,
        monthlyPayment: v.monthlyPayment,
        extraPrincipalMonthly: v.extraPrincipalMonthly,
        kind,
        drawYearsRemaining: v.drawYears,
        securedByAccountId: v.securedByAccountId,
      };
      result = account ? updateExistingLoan(account.id, input, effectiveStartDate) : addExistingLoan(input, effectiveStartDate);
    } else {
      const input = {
        name: v.name,
        startDate: v.startDate,
        principal: v.amount,
        annualInterestRatePct: v.annualInterestRatePct,
        termYears: v.termYears,
        extraPrincipalMonthly: v.extraPrincipalMonthly,
        proceedsAccountId: v.proceedsAccountId,
        kind,
        drawYears: v.drawYears,
        securedByAccountId: v.securedByAccountId,
        templateId,
      };
      result = event
        ? updateOpenedLoan(event.id, input, { ...settings, startDate: effectiveStartDate })
        : openNewLoan(input, { ...settings, startDate: effectiveStartDate });
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onClose();
  };

  const handleDelete = () => {
    const result = mode === "new" && event ? removeOpenedLoan(event.id) : account ? removeExistingLoan(account.id) : null;
    if (!result) return;
    if (result.ok) onClose();
    else setError(result.error);
  };

  const noun = isHeloc ? "HELOC" : "Loan";
  const segment = (active: boolean) =>
    `flex-1 rounded px-3 py-1.5 font-medium ${active ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`;

  return (
    <Drawer open={open} onClose={onClose} title={isEditing ? `Edit ${noun}` : `Add a ${noun}`} dirty={isDirty}>
      <form
        onSubmit={handleSubmit(onSubmit, (errors) =>
          setError(
            missingFieldMessage(errors, {
              name: "a name",
              startDate: isHeloc ? "the date the line opens" : "the date the loan starts",
              amount: mode === "existing" ? "the balance still owed" : isHeloc ? "the amount drawn" : "how much is borrowed",
              termYears: isHeloc ? "the repayment period" : mode === "existing" ? "the years remaining" : "the loan's term",
              drawYears: "the draw period",
              securedByAccountId: "the home it's secured by",
            })
          )
        )}
        className="flex flex-col gap-3"
      >
        <ErrorBanner message={error} />

        {!isEditing && (
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            <button type="button" onClick={() => switchKind("fixed")} className={segment(!isHeloc)}>
              Fixed loan
            </button>
            <button type="button" onClick={() => switchKind("heloc")} className={segment(isHeloc)}>
              Home equity line (HELOC)
            </button>
          </div>
        )}
        {!isEditing && (
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            <button type="button" onClick={() => switchMode("existing")} className={segment(mode === "existing")}>
              Already have it
            </button>
            <button type="button" onClick={() => switchMode("new")} className={segment(mode === "new")}>
              {isHeloc ? "Opening it later" : "Taking it out later"}
            </button>
          </div>
        )}
        {isHeloc && !isEditing && (
          <p className="-mt-1 text-xs text-dim">
            A line of credit against your home. Payments cover interest only while you can still draw on it; when the draw period ends,
            what you owe is paid back over the repayment period. Selling the home pays it off.
          </p>
        )}

        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder={isHeloc ? "e.g. HELOC" : "e.g. Car loan"} />
        </Field>

        {isHeloc && (
          <Field label="Secured By" hint="The home this line is written against. It is paid off when that home sells.">
            <SelectInput reg={register("securedByAccountId", { required: true })} options={homeOptions} />
          </Field>
        )}

        {mode === "new" && (
          <Field label={isHeloc ? "Date the Line Opens" : "Date the Loan Starts"}>
            <TextInput reg={register("startDate", { required: true })} type="date" />
          </Field>
        )}

        <Field
          label={mode === "existing" ? "Balance Still Owed" : isHeloc ? "Amount Drawn" : "Amount Borrowed"}
          hint={
            mode === "new"
              ? isHeloc
                ? "What you actually take out on that date, in today's dollars -- not the credit limit. Draw more later with another HELOC event."
                : "Today's dollars -- inflated forward to the date the loan starts."
              : undefined
          }
        >
          <MoneyInput reg={register("amount", { required: true })} placeholder="e.g. 40,000" />
        </Field>

        <FieldRow>
          <Field label="Interest Rate (per year)" hint={isHeloc ? "HELOC rates float; one rate stands in for the whole life here." : undefined}>
            <PercentInput reg={register("annualInterestRatePct")} placeholder={isHeloc ? "e.g. 8" : "e.g. 7"} />
          </Field>
          {isHeloc ? (
            <Field label={mode === "existing" ? "Draw Years Left" : "Draw Period (years)"} hint="Interest-only while it runs. 0 = already repaying.">
              <TextInput reg={register("drawYears", { required: true })} type="number" step="1" min="0" />
            </Field>
          ) : (
            <Field label={mode === "existing" ? "Years Remaining" : "Term (years)"}>
              <TextInput reg={register("termYears", { required: true })} type="number" step="1" min="1" />
            </Field>
          )}
        </FieldRow>

        {isHeloc && (
          <Field label="Repayment Period (years)" hint="How long you get to pay back what you owe once the draw period ends.">
            <TextInput reg={register("termYears", { required: true })} type="number" step="1" min="1" />
          </Field>
        )}

        {mode === "existing" && !isHeloc && (
          <Field label="Monthly Payment (optional)" hint="Leave blank to calculate it from the balance, rate, and years remaining.">
            <MoneyInput reg={register("monthlyPayment")} placeholder="auto" />
          </Field>
        )}

        <Field label="Extra Principal / month (optional)" hint="Paid on top of the scheduled payment -- pays it off early.">
          <MoneyInput reg={register("extraPrincipalMonthly")} placeholder="e.g. 100" />
        </Field>

        {mode === "new" && (
          <Field
            label="Where the Money Goes"
            hint={
              isHeloc
                ? "A HELOC draw is cash in hand -- a renovation, a bridge, a big bill. Name the account it lands in; from there it's spent like any other money."
                : "A car loan or tuition bill pays the seller directly -- nothing lands in your accounts, only the debt and its payments. A HELOC or personal loan puts real cash in an account; name it here."
            }
          >
            <SelectInput reg={register("proceedsAccountId")} options={proceedsOptions} />
          </Field>
        )}

        {principal > 0 && termMonths > 0 && (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-dim">Est. monthly payment</span>
              <span className="text-base font-semibold">{money0((isHeloc && drawYears > 0 ? interestOnly : pAndI) + extra)}</span>
            </div>
            <div className="flex flex-col gap-1 text-xs text-dim">
              {isHeloc && drawYears > 0 ? (
                <>
                  <div className="flex justify-between">
                    <span>Interest only, first {drawYears} {drawYears === 1 ? "year" : "years"}</span>
                    <span>{money0(interestOnly)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Then principal &amp; interest over {termMonths / 12} years</span>
                    <span>{money0(pAndI)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <span>Principal &amp; interest</span>
                  <span>{money0(pAndI)}</span>
                </div>
              )}
              {extra > 0 && (
                <div className="flex justify-between">
                  <span>Extra principal</span>
                  <span>{money0(extra)}</span>
                </div>
              )}
            </div>
            <p className="mt-2 text-[11px] text-dim">Paid automatically from your spending account each month.</p>
          </div>
        )}

        <DrawerFooter
          submitLabel={isEditing ? "Save" : `Add ${noun}`}
          onDelete={isEditing ? handleDelete : undefined}
          deleteConfirmText={`Delete ${account?.name ?? "this loan"}? You can undo from the toast afterwards.`}
        />
      </form>
    </Drawer>
  );
}
