"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { Account, OpenLoanEvent } from "@/domain";
import { Drawer } from "@/components/ui/Drawer";
import { DrawerFooter, ErrorBanner, Field, TextInput, PercentInput, MoneyInput, SelectInput, missingFieldMessage } from "@/components/ui/formFields";
import { accountOptions as labelledAccountOptions } from "@/lib/people";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { usePlanStore } from "@/store/usePlanStore";
import { addExistingLoan, updateExistingLoan, removeExistingLoan, EXISTING_LOAN_DEFAULTS } from "@/lib/existingLoan";
import { openNewLoan, updateOpenedLoan, removeOpenedLoan, OPEN_LOAN_DEFAULTS } from "@/lib/openLoan";
import { computeMonthlyPayment } from "@/engine/amortization";
import { todayISO } from "@/engine/dateMath";

type Mode = "existing" | "new";

interface FormValues {
  name: string;
  startDate: string;
  amount: string;
  annualInterestRatePct: string;
  termYears: string;
  monthlyPayment: string;
  extraPrincipalMonthly: string;
  proceedsAccountId: string;
}

function defaultsForMode(mode: Mode): FormValues {
  return mode === "existing"
    ? {
        name: "Loan",
        startDate: "",
        amount: "",
        annualInterestRatePct: EXISTING_LOAN_DEFAULTS.annualInterestRatePct,
        termYears: EXISTING_LOAN_DEFAULTS.yearsRemaining,
        monthlyPayment: "",
        extraPrincipalMonthly: "",
        proceedsAccountId: "",
      }
    : {
        name: "",
        startDate: "",
        amount: "",
        annualInterestRatePct: OPEN_LOAN_DEFAULTS.annualInterestRatePct,
        termYears: OPEN_LOAN_DEFAULTS.termYears,
        monthlyPayment: "",
        extraPrincipalMonthly: "",
        proceedsAccountId: "",
      };
}

function toFormValues(mode: Mode, account?: Account, event?: OpenLoanEvent): FormValues {
  if (!account) return defaultsForMode(mode);
  const terms = account.loanTerms;
  const shared = {
    annualInterestRatePct: terms ? fractionToPercentStr(terms.annualInterestRatePct) : EXISTING_LOAN_DEFAULTS.annualInterestRatePct,
    termYears: terms ? Math.round(terms.termMonths / 12).toString() : EXISTING_LOAN_DEFAULTS.yearsRemaining,
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
}: {
  open: boolean;
  onClose: () => void;
  /** The loan account being edited; omitted when creating a new one. */
  account?: Account;
  /** The linked open_loan event, if this loan is taken out during the plan. */
  event?: OpenLoanEvent;
  /** For the "Deposit the money into" dropdown. */
  accounts: Account[];
  /** Only consulted when account is omitted (creating new). */
  initialMode?: Mode;
}) {
  const settings = usePlanStore((s) => s.activeScenario().settings);
  const effectiveStartDate = settings.startDate ?? todayISO();
  const people = usePlanStore((s) => s.activeScenario().household.people);
  const [error, setError] = useState<string | null>(null);

  const isEditing = !!account;
  const [mode, setMode] = useState<Mode>(event ? "new" : initialMode);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    getValues,
    formState: { isDirty },
  } = useForm<FormValues>({ defaultValues: toFormValues(mode, account, event) });

  /** Switching between "already have it" and "taking it out" on a new loan
   *  re-seeds that mode's defaults, keeping what was already typed. */
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    if (!isEditing) {
      reset({ ...defaultsForMode(next), name: getValues("name") || defaultsForMode(next).name, amount: getValues("amount") });
    }
  };

  useEffect(() => {
    const nextMode: Mode = event ? "new" : isEditing ? "existing" : initialMode;
    setMode(nextMode);
    reset(toFormValues(nextMode, account, event));
    setError(null);
    // Only re-run when the drawer opens or the underlying record changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, event, open, initialMode, reset]);

  // Live payment estimate -- a display aid only; the engine recomputes from
  // the saved terms independently.
  const principal = moneyStrToNumber(watch("amount")) ?? 0;
  const rate = percentStrToFraction(watch("annualInterestRatePct")) ?? 0;
  const termMonths = (Number(watch("termYears")) || 0) * 12;
  const typedPayment = moneyStrToNumber(watch("monthlyPayment"));
  const extra = moneyStrToNumber(watch("extraPrincipalMonthly")) ?? 0;
  const pAndI =
    typedPayment ?? (principal > 0 && termMonths > 0 ? computeMonthlyPayment(principal, rate, termMonths) : 0);
  const money0 = (n: number) => `$${Math.round(n).toLocaleString()}`;

  const proceedsOptions = [
    { value: "", label: "It paid for something outside the plan" },
    ...labelledAccountOptions(
      accounts.filter((a) => a.category === "asset" && a.class !== "real_estate" && a.class !== "other_asset"),
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

  return (
    <Drawer open={open} onClose={onClose} title={isEditing ? "Edit Loan" : "Add a Loan"} dirty={isDirty}>
      <form
        onSubmit={handleSubmit(onSubmit, (errors) =>
          setError(
            missingFieldMessage(errors, {
              name: "a name",
              startDate: "the date the loan starts",
              amount: mode === "existing" ? "the balance still owed" : "how much is borrowed",
              termYears: mode === "existing" ? "the years remaining" : "the loan's term",
            })
          )
        )}
        className="flex flex-col gap-3"
      >
        <ErrorBanner message={error} />

        {!isEditing && (
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            <button
              type="button"
              onClick={() => switchMode("existing")}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${mode === "existing" ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`}
            >
              Already have it
            </button>
            <button
              type="button"
              onClick={() => switchMode("new")}
              className={`flex-1 rounded px-3 py-1.5 font-medium ${mode === "new" ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"}`}
            >
              Taking it out later
            </button>
          </div>
        )}

        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Car loan" />
        </Field>

        {mode === "new" && (
          <Field label="Date the Loan Starts">
            <TextInput reg={register("startDate", { required: true })} type="date" />
          </Field>
        )}

        <Field
          label={mode === "existing" ? "Balance Still Owed" : "Amount Borrowed"}
          hint={mode === "new" ? "Today's dollars -- inflated forward to the date the loan starts." : undefined}
        >
          <MoneyInput reg={register("amount", { required: true })} placeholder="e.g. 40,000" />
        </Field>

        <div className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
          <Field label="Interest Rate (per year)">
            <PercentInput reg={register("annualInterestRatePct")} placeholder="e.g. 7" />
          </Field>
          <Field label={mode === "existing" ? "Years Remaining" : "Term (years)"}>
            <TextInput reg={register("termYears", { required: true })} type="number" step="1" min="1" />
          </Field>
        </div>

        {mode === "existing" && (
          <Field label="Monthly Payment (optional)" hint="Leave blank to calculate it from the balance, rate, and years remaining.">
            <MoneyInput reg={register("monthlyPayment")} placeholder="auto" />
          </Field>
        )}

        <Field label="Extra Principal / month (optional)" hint="Paid on top of the scheduled payment -- pays the loan off early.">
          <MoneyInput reg={register("extraPrincipalMonthly")} placeholder="e.g. 100" />
        </Field>

        {mode === "new" && (
          <Field
            label="Where the Money Goes"
            hint="A car loan or tuition bill pays the seller directly -- nothing lands in your accounts, only the debt and its payments. A HELOC or personal loan puts real cash in an account; name it here."
          >
            <SelectInput reg={register("proceedsAccountId")} options={proceedsOptions} />
          </Field>
        )}

        {principal > 0 && termMonths > 0 && (
          <div className="rounded-md border border-border p-3 text-sm">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-dim">Est. monthly payment</span>
              <span className="text-base font-semibold">{money0(pAndI + extra)}</span>
            </div>
            <div className="flex flex-col gap-1 text-xs text-dim">
              <div className="flex justify-between">
                <span>Principal &amp; interest</span>
                <span>{money0(pAndI)}</span>
              </div>
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
          submitLabel={isEditing ? "Save" : "Add Loan"}
          onDelete={isEditing ? handleDelete : undefined}
          deleteConfirmText={`Delete ${account?.name ?? "this loan"}? You can undo from the toast afterwards.`}
        />
      </form>
    </Drawer>
  );
}
