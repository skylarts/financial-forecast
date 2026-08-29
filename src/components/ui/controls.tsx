"use client";

/**
 * Shared control primitives.
 *
 * These exist so the same button and segmented-toggle styling isn't re-typed
 * (and re-tweaked) in a dozen components. Every visual value comes from a
 * theme token, so a theme change lands here once.
 */

/** Secondary/neutral button — the default for most actions. */
export function Btn({
  children,
  onClick,
  title,
  id,
  type = "button",
  variant = "neutral",
  className = "",
  ariaHasPopup,
  ariaExpanded,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  id?: string;
  type?: "button" | "submit";
  /** "primary" is the deep accent fill; use it for at most one action per region. */
  variant?: "neutral" | "primary";
  className?: string;
  /** Set both when the button opens a menu, so it announces as one. */
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  /** Needed when the button's content is an icon rather than words. */
  ariaLabel?: string;
}) {
  const base =
    "rounded-md px-3 py-1.5 text-[12.5px] transition-colors disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-pri text-pri-fg font-semibold border border-transparent hover:brightness-110"
      : "border border-border bg-panel text-dim hover:border-accent hover:text-foreground";
  return (
    <button
      type={type}
      id={id}
      title={title}
      onClick={onClick}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel}
      className={`${base} ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Segmented toggle for mutually exclusive options (Nominal/Real, and so on).
 * The active segment uses the primary fill so it reads as the current state
 * rather than as a call to action.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-[11.5px]";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex rounded-md border border-border bg-panel-2 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded font-semibold transition-colors ${pad} ${
            o.value === value ? "bg-pri text-pri-fg" : "text-dim hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Small toggleable chip, used for the year-range presets. */
export function Chip({
  children,
  onClick,
  active = false,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border bg-panel-2 px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
        active ? "border-accent text-accent" : "border-border text-dim hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
