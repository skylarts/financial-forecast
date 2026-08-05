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

/** An option root: alphanumeric, up to six characters, never leading with a digit. */
const ROOT = "[A-Z][A-Z0-9]{0,5}";

/**
 * OCC symbology: a root, a six-digit expiry, C or P, then a strike. The canonical
 * strike field is eight digits of thousandths-of-a-dollar, but brokerages write
 * it in plain dollars at least as often -- "KLAR260508C15" and
 * "KLAR260508C00015000" are the same contract, and only one of them used to
 * parse. The strike is matched loosely and interpreted below.
 */
const OCC_PATTERN = new RegExp(`^(${ROOT})[ ]?(\\d{2})(\\d{2})(\\d{2})([CP])(\\d{1,8}(?:\\.\\d{1,3})?)$`);

/** Right as a statement might spell it, in either the terse or the long form. */
const RIGHT_WORDS: Record<string, OptionRight> = {
  C: "call",
  CALL: "call",
  CALLS: "call",
  P: "put",
  PUT: "put",
  PUTS: "put",
};

/**
 * Dollars a strike field means.
 *
 * A full eight-digit field is OCC's thousandths encoding, so 00017500 is $17.50.
 * Anything shorter is a brokerage writing plain dollars, where 15 is $15 -- not
 * 1.5 cents. Getting this backwards misprices a contract by 1000x, so the two
 * cases are separated on width rather than guessed at from magnitude.
 */
function strikeFromField(field: string): number {
  return /^\d{8}$/.test(field) ? Number(field) / 1000 : Number(field);
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Builds an ISO expiry, or null when the pieces don't name a real day. February
 * is allowed 29 days in every year: an expiry is validated here to catch a
 * transposed statement, not to run a calendar.
 */
function isoExpiry(year: number, month: number, day: number): ISODate | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}` as ISODate;
}

const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/** A month written as a name or an abbreviation, 1-based, or null. */
function monthFromName(token: string): number | null {
  const index = MONTH_NAMES.indexOf(token.slice(0, 3));
  return index === -1 ? null : index + 1;
}

/**
 * Reads the expiry out of the date tokens of a human-written contract.
 *
 * Handles the forms statements actually use: 01/21/2028, 2028-01-21, and
 * "Jan 21 2028" (which is how this app renders a contract, so a symbol copied
 * off its own holdings page reads back in).
 */
function parseExpiryTokens(tokens: string[]): ISODate | null {
  if (tokens.length === 1) {
    const token = tokens[0];

    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
    if (iso) return isoExpiry(Number(iso[1]), Number(iso[2]), Number(iso[3]));

    // US order, the only order a brokerage writes with slashes. A two-digit
    // year is 20xx for the same reason an OCC year is.
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(token);
    if (us) {
      const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
      return isoExpiry(year, Number(us[1]), Number(us[2]));
    }
    return null;
  }

  if (tokens.length === 3) {
    // "Jan 21 2028" or "21 Jan 2028"; the year is always last.
    const year = Number(tokens[2]);
    if (!/^\d{4}$/.test(tokens[2])) return null;
    const monthFirst = monthFromName(tokens[0]);
    if (monthFirst !== null) return isoExpiry(year, monthFirst, Number(tokens[1]));
    const monthSecond = monthFromName(tokens[1]);
    if (monthSecond !== null) return isoExpiry(year, monthSecond, Number(tokens[0]));
  }

  return null;
}

/**
 * Reads a contract written the way a person or a statement writes one, e.g.
 * "KLAR 01/21/2028 17.50 C" or "AAPL Sep 18 2026 250 Call".
 *
 * Tokenised rather than pattern-matched because the pieces show up in more than
 * one order and the date itself can be one token or three. The rules are: the
 * first token is the root, the right can sit anywhere after it, and the strike
 * is the last number left -- every statement writes the strike after the date.
 */
function parseWrittenContract(text: string): OptionContract | null {
  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length < 4) return null;

  const [root, ...rest] = tokens;
  if (!new RegExp(`^${ROOT}$`).test(root)) return null;

  const rightIndex = rest.findIndex((token) => token in RIGHT_WORDS);
  if (rightIndex === -1) return null;
  const right = RIGHT_WORDS[rest[rightIndex]];

  const dateAndStrike = rest.filter((_, i) => i !== rightIndex);
  if (dateAndStrike.length < 2) return null;

  const strikeToken = dateAndStrike[dateAndStrike.length - 1].replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(strikeToken)) return null;
  const strike = Number(strikeToken);

  const expiry = parseExpiryTokens(dateAndStrike.slice(0, -1));
  if (!expiry) return null;

  return { underlying: root, expiry, right, strike };
}

/**
 * Reads a contract symbol in any form the app accepts, or returns null for
 * anything that isn't one.
 *
 * Null rather than a throw because this runs against every symbol in the
 * ledger, the vast majority of which are ordinary tickers -- "not an option"
 * is the common case, not an error.
 */
export function parseOptionSymbol(symbol: string): OptionContract | null {
  const text = symbol.trim().toUpperCase().replace(/\s+/g, " ");

  const match = OCC_PATTERN.exec(text);
  if (match) {
    const [, underlying, yy, mm, dd, right, strikeField] = match;
    // OCC years are two-digit with no century. Listed options run at most a few
    // years out, so every one of them is 20xx -- there is no 1900s contract to
    // disambiguate against.
    const expiry = isoExpiry(2000 + Number(yy), Number(mm), Number(dd));
    const strike = strikeFromField(strikeField);
    if (!expiry || !Number.isFinite(strike) || strike <= 0) return null;
    return { underlying, expiry, right: RIGHT_WORDS[right], strike };
  }

  const written = parseWrittenContract(text);
  if (written && written.strike > 0) return written;
  return null;
}

/**
 * A contract in the one form the quote feed indexes: OCC with an unpadded root
 * and the strike in eight digits of thousandths.
 *
 * Every symbol the app stores, prices, or groups by is put through this. The
 * alternative is a ledger where one contract appears three times because three
 * statements wrote it three different ways -- and where none of the three
 * prices, because the feed knows only this spelling.
 */
export function toOccSymbol(contract: OptionContract): string {
  const [year, month, day] = contract.expiry.split("-");
  const right = contract.right === "call" ? "C" : "P";
  const strike = String(Math.round(contract.strike * 1000)).padStart(8, "0");
  return `${contract.underlying}${year.slice(2)}${month}${day}${right}${strike}`;
}

/**
 * The storage form of any symbol: contracts rewritten to canonical OCC,
 * ordinary tickers just trimmed and upper-cased.
 */
export function canonicalizeSymbol(raw: string): string {
  const text = raw.trim().toUpperCase().replace(/\s+/g, " ");
  const contract = parseOptionSymbol(text);
  return contract ? toOccSymbol(contract) : text;
}

/** The ticker a contract is written on, or the symbol itself when it isn't one. */
export function underlyingSymbol(symbol: string): string {
  return parseOptionSymbol(symbol)?.underlying ?? canonicalizeSymbol(symbol);
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
