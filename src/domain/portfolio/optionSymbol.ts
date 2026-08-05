import type { ISODate } from "../common";

/**
 * Every listed US option trades in blocks of 100 shares, so a contract quoted
 * at $2.40 is worth $240. The feed quotes the per-share premium, which is what
 * a statement shows as the price -- the multiplier is the difference between
 * the two, and forgetting it undervalues a position by 100x.
 */
export const OPTION_CONTRACT_MULTIPLIER = 100;

export type OptionRight = "call" | "put";

export interface OptionContract {
  /** The ticker the contract is written on, e.g. AAPL. */
  underlying: string;
  expiry: ISODate;
  right: OptionRight;
  strike: number;
}

/**
 * OCC 21-character symbology: a root padded to six, a six-digit expiry, C or P,
 * then a strike in thousandths padded to eight. Brokerages emit it unpadded far
 * more often than padded, so the root and strike are matched loosely and the
 * fixed-width middle carries the parse.
 */
const OCC_PATTERN = /^([A-Z]{1,6})[ ]?(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/**
 * Reads an OCC contract symbol, or returns null for anything that isn't one.
 *
 * Null rather than a throw because this runs against every symbol in the
 * ledger, the vast majority of which are ordinary tickers -- "not an option"
 * is the common case, not an error.
 */
export function parseOptionSymbol(symbol: string): OptionContract | null {
  const match = OCC_PATTERN.exec(symbol.trim().toUpperCase());
  if (!match) return null;

  const [, underlying, yy, mm, dd, right, strikeThousandths] = match;

  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // OCC years are two-digit with no century. Listed options run at most a few
  // years out, so every one of them is 20xx -- there is no 1900s contract to
  // disambiguate against.
  const expiry = `20${yy}-${mm}-${dd}` as ISODate;

  const strike = Number(strikeThousandths) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;

  return { underlying, expiry, right: right === "C" ? "call" : "put", strike };
}

/** True when `symbol` is an option contract rather than an ordinary ticker. */
export function isOptionSymbol(symbol: string): boolean {
  return parseOptionSymbol(symbol) !== null;
}

/**
 * Dollars one unit of `symbol` is worth per point of quoted price: 100 for an
 * option contract, 1 for everything else. Every place that multiplies a
 * quantity by a price has to go through this.
 */
export function contractMultiplier(symbol: string): number {
  return isOptionSymbol(symbol) ? OPTION_CONTRACT_MULTIPLIER : 1;
}

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * A contract symbol rendered the way a statement reads it, e.g.
 * "AAPL Sep 18 2026 250 Call". Falls back to the raw symbol when it doesn't
 * parse, so this is safe to call on any holding.
 */
export function formatOptionSymbol(symbol: string): string {
  const contract = parseOptionSymbol(symbol);
  if (!contract) return symbol;

  const [year, month, day] = contract.expiry.split("-");
  const monthLabel = MONTH_ABBREVIATIONS[Number(month) - 1] ?? month;
  // Strikes are usually whole dollars; only show decimals when they carry
  // information, so "250" doesn't render as "250.000".
  const strike = contract.strike % 1 === 0 ? String(contract.strike) : contract.strike.toFixed(2);
  const right = contract.right === "call" ? "Call" : "Put";

  return `${contract.underlying} ${monthLabel} ${Number(day)} ${year} ${strike} ${right}`;
}

/** True when the contract expired on or before `asOf`, so no feed will price it. */
export function isExpiredOption(symbol: string, asOf: ISODate): boolean {
  const contract = parseOptionSymbol(symbol);
  return contract !== null && contract.expiry < asOf;
}
