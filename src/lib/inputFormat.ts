/**
 * Conversions between the app's STORED number conventions and what users see
 * in input boxes:
 *
 * - Rates are STORED as decimal fractions (0.05625) but ENTERED/DISPLAYED as
 *   percent units ("5.625" meaning 5.625%). A blank rate input means null --
 *   for growth rates that's "match the plan's inflation rate".
 * - Money is STORED as plain numbers but DISPLAYED with thousands separators
 *   ("250,000"), parsed leniently ("$250,000.50" is fine).
 */

/** 0.05625 -> "5.625"; null/undefined -> "". Trims float artifacts (0.065*100 = 6.500000000000001). */
export function fractionToPercentStr(fraction: number | null | undefined): string {
  if (fraction == null) return "";
  const pct = fraction * 100;
  // Round to 6 decimals to kill binary-float noise, then drop trailing zeros.
  return String(Number(pct.toFixed(6)));
}

/** "5.625" -> 0.05625; ""/whitespace -> null; junk -> null. Accepts an optional trailing "%". */
export function percentStrToFraction(s: string): number | null {
  const cleaned = s.replace(/%/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Number((n / 100).toFixed(8));
}

/** 250000.5 -> "250,000.5"; null/undefined -> "". */
export function moneyToStr(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "$250,000.50" -> 250000.5; ""/junk -> null. */
export function moneyStrToNumber(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Re-formats a money input's current text with thousands separators (used on blur). */
export function reformatMoneyStr(s: string): string {
  const n = moneyStrToNumber(s);
  return n == null ? "" : moneyToStr(n);
}
