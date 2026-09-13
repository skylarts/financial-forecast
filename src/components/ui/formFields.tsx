"use client";

import { useState, type ReactNode } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import type { RecurrenceFrequency } from "@/domain";
import { reformatMoneyStr } from "@/lib/inputFormat";
import { useDrawer } from "./Drawer";

export const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground";
export const labelClass = "flex flex-col gap-1 text-xs text-dim";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className={labelClass}>
      <span className="inline-flex items-center gap-1">
        {label}
        {hint && <InfoTooltip text={hint} />}
      </span>
      {children}
    </label>
  );
}

/**
 * Two fields sharing one line.
 *
 * The drawers stack every field full width, which is right for a name or an
 * account picker but wrong for a pair that is really a single idea -- a start
 * and an end date most of all. Stacked, the two dates read as unrelated
 * settings that happen to be adjacent, and each spends a whole line on a box
 * that needs about half of one. Side by side they read as the range they are.
 *
 * `items-end` so the inputs line up along their bottom edge even when one
 * label wraps to two lines and the other doesn't.
 */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 items-end gap-3">{children}</div>;
}

/** Small "i" badge that reveals `text` in a tooltip on hover/focus -- for
 *  explanatory detail that shouldn't sit inline and lengthen a label. */
export function InfoTooltip({ text }: { text: string }) {
  return (
    <span tabIndex={0} className="group relative inline-flex cursor-help items-center normal-case">
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-dim/60 text-[9px] leading-none text-dim">
        i
      </span>
      {/* Anchored to the icon's left edge rather than centered -- most call
          sites place this right after a short label near the drawer's left
          margin, where a centered w-56 tooltip would overflow off-screen. */}
      <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 hidden w-56 whitespace-normal rounded-md border border-border bg-panel p-2 text-xs font-normal normal-case text-foreground shadow-lg group-hover:block group-focus:block">
        {text}
      </span>
    </span>
  );
}

export function TextInput({ reg, ...props }: { reg: UseFormRegisterReturn } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...reg} {...props} className={inputClass} />;
}

/**
 * A rate input in PERCENT units: the user types "5.625" to mean 5.625%/yr
 * (stored as the fraction 0.05625 -- callers convert at the form boundary
 * with fractionToPercentStr / percentStrToFraction). For growth rates, blank
 * means "match the plan's inflation rate", which callers surface via the
 * placeholder. Registered fields hold the percent STRING, not a number.
 */
export function PercentInput({
  reg,
  ...props
}: { reg?: UseFormRegisterReturn } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="relative block w-full">
      <input {...(reg ?? {})} type="text" inputMode="decimal" {...props} className={`${inputClass} pr-6`} />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-dim">%</span>
    </span>
  );
}

/**
 * A currency input: shows a "$" prefix, keeps thousands separators
 * ("250,000"), and re-formats on blur. The field value is a lenient money
 * STRING -- callers parse at the form boundary with moneyStrToNumber.
 */
export function MoneyInput({
  reg,
  ...props
}: { reg?: UseFormRegisterReturn } & React.InputHTMLAttributes<HTMLInputElement>) {
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.value = reformatMoneyStr(e.target.value);
    // Let react-hook-form (or the caller) see the reformatted value too.
    reg?.onChange({ target: e.target, type: "change" });
    reg?.onBlur(e);
    props.onBlur?.(e);
  };
  return (
    <span className="relative block w-full">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-dim">$</span>
      <input {...(reg ?? {})} type="text" inputMode="decimal" {...props} onBlur={handleBlur} className={`${inputClass} pl-5`} />
    </span>
  );
}

export function SelectInput({
  reg,
  options,
  ...props
}: { reg: UseFormRegisterReturn; options: { value: string; label: string }[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...reg} {...props} className={inputClass}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CheckboxInput({ reg, label }: { reg: UseFormRegisterReturn; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input type="checkbox" {...reg} className="h-4 w-4" />
      {label}
    </label>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
      {message}
    </div>
  );
}

/** The one frequency list every recurring thing in the app offers. */
export const FREQUENCY_OPTIONS: { value: RecurrenceFrequency; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "weekly", label: "Weekly" },
  { value: "annual", label: "Annual" },
  { value: "one_time", label: "One time" },
];

/** A short note under a field: a warning the user should read before saving, or a plain remark. */
export function FieldNote({ tone = "warn", children }: { tone?: "warn" | "info"; children: ReactNode }) {
  return <span className={`text-[11px] ${tone === "warn" ? "text-gold" : "text-dim-2"}`}>{children}</span>;
}

/**
 * The message for a form submitted with a required field blank. react-hook-
 * form stops the submit silently; every drawer used to leave the click
 * unanswered. `labels` names each field the way the form does.
 */
export function missingFieldMessage(errors: Record<string, unknown>, labels: Record<string, string>): string {
  const field = Object.keys(errors)[0];
  const label = field ? labels[field] : undefined;
  return label ? `This still needs ${label}.` : "A required field is still blank.";
}

/** The "Advanced" fold every drawer uses: a small disclosure with its children indented under a rule. */
export function AdvancedDisclosure({
  open,
  onToggle,
  label = "Advanced",
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label?: string;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide text-dim hover:text-foreground"
      >
        <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && <div className="flex flex-col gap-3 border-l border-border pl-3">{children}</div>}
    </>
  );
}

/**
 * The footer every drawer shares: Delete on the left (a two-step, in place,
 * so a stray click never destroys anything; the store's Undo toast is the
 * second safety net), Cancel and the submit button on the right. Cancel goes
 * through the drawer's own close request, so an unsaved form is asked about.
 */
export function DrawerFooter({
  submitLabel,
  onDelete,
  deleteLabel = "Delete",
  deleteConfirmText = "Delete this? You can undo from the toast afterwards.",
  deleteNote,
  left,
}: {
  submitLabel: string;
  /** Present when editing something that can be deleted. */
  onDelete?: () => void;
  deleteLabel?: string;
  deleteConfirmText?: string;
  /** Shown instead of a delete button (e.g. "Extra Savings can't be deleted"). */
  deleteNote?: ReactNode;
  /** Something else for the left slot, e.g. a "← Back" link. */
  left?: ReactNode;
}) {
  const { requestClose } = useDrawer();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-2">
      {confirming && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-sm">
          <span>{deleteConfirmText}</span>
          <span className="flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setConfirming(false)}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-dim hover:text-foreground"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete?.();
              }}
              className="rounded-md bg-negative px-2.5 py-1 text-xs font-semibold text-background"
            >
              {deleteLabel}
            </button>
          </span>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {deleteNote ? (
          <span className="text-xs text-dim">{deleteNote}</span>
        ) : onDelete ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-negative/40 px-3 py-1.5 text-sm text-negative hover:bg-negative/10"
          >
            {deleteLabel}
          </button>
        ) : (
          left ?? <span />
        )}
        <div className="flex gap-2">
          <button type="button" onClick={requestClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-dim">
            Cancel
          </button>
          <button type="submit" className="rounded-md bg-pri px-3 py-1.5 text-sm font-semibold text-pri-fg">
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A rate that is almost certainly a slipped finger ("30" for 3%): refuse it with a pointer to the unit. */
export function implausibleRateMessage(label: string, fraction: number | null, maxAbs = 0.5): string | null {
  if (fraction === null || Math.abs(fraction) <= maxAbs) return null;
  return `${label} is ${Number((fraction * 100).toFixed(2))}% a year. Enter a percent like 7 for 7%, not a fraction or a dollar amount.`;
}
