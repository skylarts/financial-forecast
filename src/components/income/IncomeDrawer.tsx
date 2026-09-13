"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { IncomeCategory, IncomeSource, Person, RecurrenceFrequency, Account, TemporaryAdjustment } from "@/domain";
import { incomeSourceSchema } from "@/domain";
import { birthdayAtAge } from "@/engine/dateMath";
import { Drawer } from "@/components/ui/Drawer";
import {
  AdvancedDisclosure,
  DrawerFooter,
  ErrorBanner,
  Field,
  FieldNote,
  FieldRow,
  FREQUENCY_OPTIONS,
  MoneyInput,
  PercentInput,
  SelectInput,
  CheckboxInput,
  TextInput,
  implausibleRateMessage,
  missingFieldMessage,
} from "@/components/ui/formFields";
import { fractionToPercentStr, percentStrToFraction, moneyToStr, moneyStrToNumber } from "@/lib/inputFormat";
import { accountOptions, ownerOptions } from "@/lib/people";
import { usePlanStore } from "@/store/usePlanStore";
import { AdjustmentsEditor, adjustmentsIssue } from "@/components/ui/AdjustmentsEditor";

const CATEGORY_OPTIONS: { value: IncomeCategory; label: string }[] = [
  { value: "salary", label: "Salary" },
  { value: "social_security", label: "Social Security" },
  { value: "pension", label: "Pension" },
  { value: "rental", label: "Rental" },
  { value: "other", label: "Other" },
];

const REQUIRED_LABELS = { name: "a name", amount: "an amount", startDate: "a start date" };

interface FormValues {
  name: string;
  ownerId: string;
  /** Money string ("7,500"). */
  amount: string;
  /** Money string; blank = not provided (engine behaves as before this field existed). Salary only. */
  grossAmount: string;
  frequency: RecurrenceFrequency;
  startDate: string;
  endDate: string;
  /** Percent string ("5" = 5%/yr); blank = matches inflation. */
  growthRatePct: string;
  intervalYears: string;
  depositAccountId: string;
  /** Blank until the user picks one -- everything below is hidden until then. */
  category: IncomeCategory | "";
  isExcluded: boolean;
  /** Social Security / pension: the age the benefit starts (fills the start date). */
  claimAge: string;
  /** Pension: percent string, the share that continues to a survivor. */
  survivorPct: string;
}

function toFormValues(income?: IncomeSource): FormValues {
  return {
    name: income?.name ?? "",
    ownerId: income?.ownerId ?? "",
    amount: income ? moneyToStr(income.amount) : "",
    grossAmount: income?.grossAmount != null ? moneyToStr(income.grossAmount) : "",
    frequency: income?.frequency ?? "monthly",
    startDate: income?.startDate ?? "",
    endDate: income?.endDate ?? "",
    growthRatePct: fractionToPercentStr(income?.growthRatePct),
    intervalYears: income?.intervalYears?.toString() ?? "",
    depositAccountId: income?.depositAccountId ?? "",
    category: income?.category ?? "",
    isExcluded: income?.isExcluded ?? false,
    claimAge: income?.claimAge != null ? String(income.claimAge) : "",
    survivorPct: income?.survivorPct != null ? fractionToPercentStr(income.survivorPct) : "",
  };
}

/** Categories where the person matters to the engine (retirement stop, claiming age, survivor rules). */
const OWNED_CATEGORIES = new Set<IncomeCategory | "">(["salary", "social_security", "pension"]);

export function IncomeDrawer({
  open,
  onClose,
  income,
  people,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  income?: IncomeSource;
  people: Person[];
  accounts: Account[];
}) {
  const addIncomeSource = usePlanStore((s) => s.addIncomeSource);
  const updateIncomeSource = usePlanStore((s) => s.updateIncomeSource);
  const removeIncomeSource = usePlanStore((s) => s.removeIncomeSource);
  const [error, setError] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<TemporaryAdjustment[]>(income?.adjustments ?? []);
  const [adjustmentsKey, setAdjustmentsKey] = useState(() => JSON.stringify(income?.adjustments ?? []));
  const [advancedOpen, setAdvancedOpen] = useState(
    !!income && ((income.adjustments?.length ?? 0) > 0 || income.isExcluded === true || income.grossAmount != null)
  );
  const inflationRatePct = usePlanStore((s) => s.activeScenario().settings.inflationRatePct);
  const inflationPctLabel = fractionToPercentStr(inflationRatePct) || "0";

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    getValues,
    formState: { isDirty },
  } = useForm<FormValues>({
    defaultValues: toFormValues(income),
  });
  const category = watch("category");
  const ownerId = watch("ownerId");
  const frequency = watch("frequency");
  const endDate = watch("endDate");
  const isOneTime = frequency === "one_time";
  const isBenefit = category === "social_security" || category === "pension";
  const dirty = isDirty || JSON.stringify(adjustments) !== adjustmentsKey;

  // Re-sync the form whenever the drawer opens on a different income item --
  // without this, a reused drawer instance shows the previous item's values.
  useEffect(() => {
    reset(toFormValues(income));
    setAdjustments(income?.adjustments ?? []);
    setAdjustmentsKey(JSON.stringify(income?.adjustments ?? []));
    setError(null);
    setAdvancedOpen(
      !!income && ((income.adjustments?.length ?? 0) > 0 || income.isExcluded === true || income.grossAmount != null)
    );
  }, [income, open, reset]);

  /** The start date for a claiming age: the owner's birthday at that age. */
  const syncStartDateFromAge = (ageStr: string, ownerIdNow: string) => {
    const age = Number(ageStr);
    const owner = people.find((p) => p.id === ownerIdNow) ?? people[0];
    if (owner && Number.isFinite(age) && age > 0) {
      setValue("startDate", birthdayAtAge(owner.birthDate, age), { shouldDirty: true });
    }
  };

  const onSubmit = (values: FormValues) => {
    if (!values.category) {
      setError("Select a category.");
      return;
    }
    const growth = percentStrToFraction(values.growthRatePct);
    const rateIssue = implausibleRateMessage("The growth rate", growth);
    if (rateIssue) {
      setError(rateIssue);
      return;
    }
    const amount = moneyStrToNumber(values.amount) ?? 0;
    if (amount <= 0) {
      setError("The amount needs to be more than zero.");
      return;
    }
    const adjIssue = adjustmentsIssue(adjustments);
    if (adjIssue) {
      setError(adjIssue);
      setAdvancedOpen(true);
      return;
    }
    const benefit = values.category === "social_security" || values.category === "pension";
    const candidate = {
      name: values.name.trim(),
      ownerId: values.ownerId || null,
      amount,
      grossAmount: values.category === "salary" ? (moneyStrToNumber(values.grossAmount) ?? undefined) : undefined,
      frequency: values.frequency,
      startDate: values.startDate,
      endDate: values.frequency === "one_time" ? null : values.endDate || null,
      // A pension left blank has NO cost-of-living raise (most public and
      // private pensions have none); every other category's blank means
      // "keep pace with inflation".
      growthRatePct: values.category === "pension" && growth === null ? 0 : growth,
      // A one-time item is one-time: never carry a hidden repeat interval.
      intervalYears: values.frequency !== "one_time" && values.intervalYears.trim() !== "" ? Number(values.intervalYears) : undefined,
      depositAccountId: values.depositAccountId === "" ? null : values.depositAccountId,
      category: values.category,
      adjustments,
      isExcluded: values.isExcluded,
      claimAge: benefit && values.claimAge.trim() !== "" ? Number(values.claimAge) : undefined,
      survivorPct: values.category === "pension" ? percentStrToFraction(values.survivorPct) ?? undefined : undefined,
    };

    const result = incomeSourceSchema.omit({ id: true }).safeParse(candidate);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? "Invalid income source.");
      return;
    }

    if (income) updateIncomeSource(income.id, result.data);
    else addIncomeSource(result.data);
    onClose();
  };

  const onInvalid = (errors: Record<string, unknown>) => setError(missingFieldMessage(errors, REQUIRED_LABELS));

  const jointSalaryWarning = category === "salary" && ownerId === "" && !endDate && !isOneTime;
  const jointBenefitWarning = isBenefit && ownerId === "";

  return (
    <Drawer open={open} onClose={onClose} title={income ? "Edit Income" : "Add Income"} dirty={dirty}>
      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="flex flex-col gap-3">
        <ErrorBanner message={error} />
        <Field label="Name">
          <TextInput reg={register("name", { required: true })} placeholder="e.g. Alex Salary" />
        </Field>
        <Field label="Category">
          <SelectInput
            reg={register("category", {
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                const next = e.target.value as IncomeCategory | "";
                if (next === "social_security") setValue("frequency", "monthly");
                // A new salary, benefit or pension belongs to someone: a joint
                // salary never stops at retirement, and a benefit needs an
                // owner for its claiming age and survivor rules.
                if (!income && OWNED_CATEGORIES.has(next) && getValues("ownerId") === "" && people[0]) {
                  setValue("ownerId", people[0].id);
                }
              },
            })}
            options={income ? CATEGORY_OPTIONS : [{ value: "", label: "Select a category..." }, ...CATEGORY_OPTIONS]}
          />
        </Field>
        {category !== "" && (
          <>
            <Field label="Owner">
              <SelectInput
                reg={register("ownerId", {
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                    // The claiming age is that person's age: re-derive the date.
                    const age = getValues("claimAge");
                    if (isBenefit && age.trim() !== "") syncStartDateFromAge(age, e.target.value);
                  },
                })}
                options={ownerOptions(people)}
              />
              {jointSalaryWarning && (
                <FieldNote>A joint salary never stops at anyone&rsquo;s retirement. Pick an owner, or give it an end date.</FieldNote>
              )}
              {jointBenefitWarning && (
                <FieldNote>Give this an owner: the claiming age and the survivor rules are that person&rsquo;s.</FieldNote>
              )}
            </Field>
            <Field
              label={isBenefit ? "Amount (GROSS, before tax)" : "Amount"}
              hint={
                isBenefit
                  ? `Per occurrence, today's dollars. Enter the gross benefit -- what's on your SSA statement${category === "pension" ? " or pension paperwork" : ""}, before withholding. The engine computes real tax on it each year.`
                  : "Per occurrence, today's dollars, as take-home pay."
              }
            >
              <MoneyInput reg={register("amount", { required: true })} placeholder="e.g. 7,500" />
            </Field>
            {isBenefit && (
              <Field
                label={category === "social_security" ? "Claiming Age" : "Age the pension starts"}
                hint="Typing an age fills the start date below with the owner's birthday at that age -- adjust the exact date freely afterward. Enter the benefit amount you would get at this age."
              >
                <TextInput
                  reg={register("claimAge", {
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) => syncStartDateFromAge(e.target.value, getValues("ownerId")),
                  })}
                  type="number"
                  placeholder={category === "social_security" ? "e.g. 67" : "e.g. 52"}
                />
              </Field>
            )}
            {category === "pension" && (
              <Field
                label="Survivor benefit"
                hint="The share of this pension that continues to a surviving household member after the owner's modelled death (the person's planning-end age in Assumptions). 0 or blank = it stops. Social Security needs no entry: the survivor keeps the larger of the two benefits."
              >
                <PercentInput reg={register("survivorPct")} placeholder="e.g. 50" />
              </Field>
            )}
            {/* Frequency and "every N years" are alternatives, not independent
                settings -- the second overrides the first -- so they sit side
                by side where "Or" reads as the choice it is. */}
            {category !== "social_security" &&
              (isOneTime ? (
                <Field label="Frequency">
                  <SelectInput reg={register("frequency")} options={FREQUENCY_OPTIONS} />
                </Field>
              ) : (
                <FieldRow>
                  <Field label="Frequency">
                    <SelectInput reg={register("frequency")} options={FREQUENCY_OPTIONS} />
                  </Field>
                  <Field label="Or every N years" hint="Optional. For a cyclical windfall (e.g. a bonus every few years). Overrides Frequency.">
                    <TextInput reg={register("intervalYears")} type="number" min="1" step="1" placeholder="e.g. 10" />
                  </Field>
                </FieldRow>
              ))}
            {isOneTime ? (
              <Field label="Date">
                <TextInput reg={register("startDate", { required: true })} type="date" />
              </Field>
            ) : (
              <FieldRow>
                <Field label="Start Date">
                  <TextInput reg={register("startDate", { required: true })} type="date" />
                </Field>
                <Field label="End Date" hint="Optional -- leave blank to continue indefinitely (a salary stops at its owner's Retire event).">
                  <TextInput reg={register("endDate")} type="date" />
                </Field>
              </FieldRow>
            )}
            <Field label="Deposit Account">
              <SelectInput
                reg={register("depositAccountId")}
                options={[
                  { value: "", label: "Extra Savings (Default)" },
                  ...accountOptions(
                    accounts.filter((a) => !a.isExtraSavings),
                    people
                  ),
                ]}
              />
            </Field>
            {!isOneTime && (
              <Field
                label="Annual Growth Rate"
                hint={
                  category === "social_security"
                    ? `Percent per year, e.g. 2.5 for a 2.5% COLA -- actual raises, including inflation. Social Security steps once each January, not continuously. Blank = matches your inflation assumption (${inflationPctLabel}%), keeping the benefit flat in today's dollars.`
                    : category === "pension"
                      ? "Cost-of-living raise per year, if the pension has one. Most public and private pensions have none, so blank = 0 (the dollar amount stays the same for life and buys less each year)."
                      : `Percent per year, e.g. 5 for 5% -- actual raises, including inflation. Blank = matches your inflation assumption (${inflationPctLabel}%); 0 = flat in nominal terms (shrinks in real terms).`
                }
              >
                <PercentInput
                  reg={register("growthRatePct")}
                  placeholder={category === "pension" ? "blank = no COLA (0%)" : `blank = inflation (${inflationPctLabel}%)`}
                />
              </Field>
            )}

            <AdvancedDisclosure open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
              {category === "salary" && (
                <Field
                  label="Gross Income (optional)"
                  hint="Per occurrence, today's dollars, before income tax withholding but after pre-tax deductions like a 401(k) (your W-2 Box 1 wages). Only used to correctly tax capital gains and account withdrawals you take while still working -- without it, the model assumes you have no other taxable income during your working years. Take-home Amount above is unaffected either way."
                >
                  <MoneyInput reg={register("grossAmount")} placeholder="e.g. 9,200" />
                </Field>
              )}
              {!isOneTime && (
                <AdjustmentsEditor
                  adjustments={adjustments}
                  onChange={setAdjustments}
                  helpText="A temporary raise, pause, or cut over a date range (a career break: −100)."
                />
              )}
              <CheckboxInput reg={register("isExcluded")} label="Excluded (kept visible for reference, no effect on the projection)" />
            </AdvancedDisclosure>
          </>
        )}

        <DrawerFooter
          submitLabel={income ? "Save" : "Add Income"}
          onDelete={
            income
              ? () => {
                  removeIncomeSource(income.id);
                  onClose();
                }
              : undefined
          }
          deleteConfirmText={`Delete ${income?.name ?? "this income"}? You can undo from the toast afterwards.`}
        />
      </form>
    </Drawer>
  );
}
