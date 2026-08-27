import type { ISODate } from "@/domain";

/**
 * What the ledger still needs to know about the retired dividend sync.
 *
 * Dividends now come only from imported statements. Some ledgers still hold
 * rows the old price-feed sync wrote under an ex-date, so the importer keeps
 * matching a statement payment onto one of those and replacing it -- without
 * this, re-importing a history would double-count every dividend the sync
 * had already added.
 */

/** Marks a row the retired price-feed sync generated. */
const AUTO_PREFIX = "auto-div:";

/**
 * How far around an ex-date to look for a payment the ledger already has.
 *
 * A brokerage records the dividend on its pay date, which trails the ex-date by
 * two to six weeks -- so matching on the date alone would miss every
 * statement-imported dividend and leave the sync-written estimate in place
 * beside it. The window reaches forward far enough to cover that and stops well
 * short of the next quarterly ex-date, so one quarter's payment can never
 * suppress the following one.
 */
const MATCH_BEFORE_DAYS = 5;
const MATCH_AFTER_DAYS = 45;

function shiftDate(date: ISODate, days: number): ISODate {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Whether `otherDate` falls in the pay-date window that counts as the same
 * payment as `exDate`. Used by the statement importer: a statement dividend can
 * land weeks after a sync-written row for the same payment, and nothing about
 * the statement row's own hash would tell the importer that.
 */
export function isSameDividendWindow(exDate: ISODate, otherDate: ISODate): boolean {
  const windowStart = shiftDate(exDate, -MATCH_BEFORE_DAYS);
  const windowEnd = shiftDate(exDate, MATCH_AFTER_DAYS);
  return otherDate >= windowStart && otherDate <= windowEnd;
}

/** Whether a sourceHash marks a transaction the retired sync generated. */
export function isAutoDividendHash(hash: string | null): boolean {
  return hash !== null && hash.startsWith(AUTO_PREFIX);
}
