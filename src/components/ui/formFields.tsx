import type { ReactNode } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

export const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground";
export const labelClass = "flex flex-col gap-1 text-xs text-dim";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={labelClass}>
      {label}
      {children}
    </label>
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
