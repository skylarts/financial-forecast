import type { ISODate, Id } from "@/domain";
import { parseOptionSymbol, type PositionSide, type TransactionType } from "@/domain/portfolio";
import type { Holding, PriceMap } from "./metrics";

/**
 * What almost certainly happened to a contract left open past its expiry.
 *
 * A contract that finished out of the money expired worthless. One that
 * finished in the money was exercised or assigned instead -- nobody lets a
 * profitable contract lapse. Recording the wrong one is not a cosmetic error:
 * an expiry realizes the premium immediately, while an exercise rolls it into
 * the shares, so the two differ in the amount, the tax year, and often the
 * rate.
 */
export type ExpiryOutcome = "worthless" | "settled" | "unknown";

export interface ExpiredContract {
  holdingKey: string;
  accountId: Id;
  symbol: string;
  side: PositionSide;
  /** Contracts still open on the books. */
  quantity: number;
  expiry: ISODate;
  strike: number;
  right: "call" | "put";
  underlying: string;
  /**
   * The underlying's latest quote, when we hold one. This is today's price, not
   * the price on expiry day, so it only ever supports a suggestion -- never a
   * silent correction.
   */
  underlyingPrice: number | null;
  outcome: ExpiryOutcome;
  /** The transaction type to record, or null when it can't be inferred. */
  suggestedType: TransactionType | null;
}

/**
 * True when a contract finished with intrinsic value. Exactly at the strike
 * counts as out of the money: it is worth nothing to exercise.
 */
function isInTheMoney(right: "call" | "put", strike: number, underlying: number): boolean {
  return right === "call" ? underlying > strike : underlying < strike;
}

/**
 * Finds contracts sitting open past their expiry date.
 *
 * These are pure bookkeeping leftovers: a contract cannot survive its expiry,
 * so an open lot past that date means the closing event was never recorded.
 * Left alone the position keeps its premium as an unrealized figure forever and
 * quietly overstates the portfolio, which is exactly the kind of wrong number
 * that looks right.
 */
export function findExpiredContracts(
  holdings: readonly Holding[],
  prices: PriceMap,
  asOf: ISODate,
): ExpiredContract[] {
  const expired: ExpiredContract[] = [];

  for (const holding of holdings) {
    const contract = parseOptionSymbol(holding.symbol);
    if (!contract || contract.expiry >= asOf) continue;

    const underlyingPrice = prices[contract.underlying]?.price ?? null;

    let outcome: ExpiryOutcome = "unknown";
    if (underlyingPrice !== null) {
      outcome = isInTheMoney(contract.right, contract.strike, underlyingPrice)
        ? "settled"
        : "worthless";
    }

    // A contract you hold is one you exercise; one you wrote is one you're
    // assigned on. Without a price for the underlying we suggest nothing rather
    // than guess, because the two outcomes are not close to interchangeable.
    const suggestedType: TransactionType | null =
      outcome === "worthless"
        ? "option_expire"
        : outcome === "settled"
          ? holding.side === "long"
            ? "option_exercise"
            : "option_assign"
          : null;

    expired.push({
      holdingKey: holding.key,
      accountId: holding.accountId,
      symbol: holding.symbol,
      side: holding.side,
      quantity: holding.quantity,
      expiry: contract.expiry,
      strike: contract.strike,
      right: contract.right,
      underlying: contract.underlying,
      underlyingPrice,
      outcome,
      suggestedType,
    });
  }

  // Longest overdue first: the oldest leftover is the one distorting the books
  // for the longest, and is usually the one the user has forgotten about.
  return expired.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
}
