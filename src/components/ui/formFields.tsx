import type { ReactNode } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

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
      <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 hidden w-56 rounded-md border border-border bg-panel p-2 text-xs font-normal normal-case text-foreground shadow-lg group-hover:block group-focus:block">
        {text}
      </span>
    </span>
  );
}

export function TextInput({ reg, ...props }: { reg: UseFormRegisterReturn } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...reg} {...props} className={inputClass} />;
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
