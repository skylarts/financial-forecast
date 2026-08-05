/** Whole dollars — right for totals, where cents are noise. */
export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Dollars and cents — right for per-share prices, where cents are the point. */
export function price(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Leading + on gains, so a column of returns reads at a glance. */
export function signedMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${money(n)}`;
}

export function percent(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}

/** Trims trailing zeros so whole-share counts don't read as "10.0000". */
export function shares(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Tailwind class colouring a figure by sign, neutral at exactly zero. */
export function toneFor(n: number): string {
  if (n > 0) return "text-positive";
  if (n < 0) return "text-negative";
  return "text-dim";
}

export function shortDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/**
 * How a closed lot's holding period reads in a table.
 *
 * An untaxed disposal has no meaningful term, so it names the reason instead --
 * shares that merely moved accounts, or an option whose premium was folded into
 * the shares it delivered rather than realized on its own.
 */
export function lotTermLabel(lot: {
  taxable: boolean;
  term: "long" | "short";
  untaxedReason?: "transfer" | "premium_absorbed";
}): string {
  if (lot.taxable) return lot.term === "long" ? "Long" : "Short";
  return lot.untaxedReason === "premium_absorbed" ? "In basis" : "Transfer";
}
