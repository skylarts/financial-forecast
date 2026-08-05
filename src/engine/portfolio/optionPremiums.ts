import type { Id } from "@/domain";
import {
  closesLotOn,
  deliversShares,
  isOptionLifecycleType,
  lotOpenValue,
  normalizeSymbol,
  opensLotOn,
  parseOptionSymbol,
  type PositionSide,
  type Transaction,
} from "@/domain/portfolio";

/** Matches the ledger's own tolerance for a lot worn down to nothing. */
const EPSILON = 1e-9;

export interface PremiumPairing {
  /**
   * Dollars the premium moves the stock leg by, already signed: added to a
   * buy's cost basis, added to a sell's proceeds. Negative where the premium
   * works the other way.
   */
  adjustment: number;
  /** The contract that delivered these shares, for explaining the number. */
  optionSymbol: string;
  optionTxId: Id;
}

export interface OptionPremiumResult {
  /** Basis or proceeds adjustments, keyed by the stock transaction they land on. */
  pairings: Map<Id, PremiumPairing>;
  /** Exercise or assignment legs with no stock trade to attach to. */
  unpaired: { txId: Id; date: string; symbol: string; message: string }[];
}

interface PremiumLot {
  quantity: number;
  value: number;
}

/**
 * Premium carried by the contracts one lifecycle event retires, drawn
 * oldest-first out of the contract's open lots.
 *
 * This runs ahead of the main replay rather than inside it. An exercise closes
 * a contract and opens a stock lot on the same day, and the ledger deliberately
 * sorts openings first -- so by the time the stock leg is built, the option leg
 * that has to adjust it hasn't been seen yet. Resolving premiums up front side-
 * steps that ordering entirely, and stays correct even when a contract is
 * bought and exercised on the same date.
 */
function premiumsByLifecycleTx(transactions: readonly Transaction[]): Map<Id, { value: number; side: PositionSide }> {
  const byTx = new Map<Id, { value: number; side: PositionSide }>();

  // Only option contracts matter here, and each position is independent.
  const positions = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.symbol === null) continue;
    const symbol = normalizeSymbol(tx.symbol);
    if (!parseOptionSymbol(symbol)) continue;
    const key = `${tx.accountId}::${symbol}`;
    const bucket = positions.get(key);
    if (bucket) bucket.push(tx);
    else positions.set(key, [tx]);
  }

  for (const bucket of positions.values()) {
    // Openings first within a date, mirroring the main ledger, so a contract
    // bought and exercised the same day still has a lot to draw from.
    const ordered = [...bucket].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return Number(Boolean(opensLotOn(b.type))) - Number(Boolean(opensLotOn(a.type)));
    });

    const lots: Record<PositionSide, PremiumLot[]> = { long: [], short: [] };

    for (const tx of ordered) {
      const openSide = opensLotOn(tx.type);
      if (openSide) {
        if (tx.quantity > 0) lots[openSide].push({ quantity: tx.quantity, value: lotOpenValue(tx) });
        continue;
      }

      const lifecycle = isOptionLifecycleType(tx.type);
      const closeSide = lifecycle
        ? // The event applies to whichever side the contract is actually held
          // on; a written call and a bought call both simply expire.
          lots.long.some((lot) => lot.quantity > EPSILON)
          ? "long"
          : "short"
        : closesLotOn(tx.type);
      if (!closeSide || tx.quantity <= 0) continue;

      let remaining = tx.quantity;
      let drawn = 0;
      for (const lot of lots[closeSide]) {
        if (remaining <= EPSILON) break;
        if (lot.quantity <= EPSILON) continue;
        const taken = Math.min(lot.quantity, remaining);
        const share = (lot.value / lot.quantity) * taken;
        lot.quantity -= taken;
        lot.value -= share;
        remaining -= taken;
        drawn += share;
      }

      if (lifecycle) byTx.set(tx.id, { value: drawn, side: closeSide });
    }
  }

  return byTx;
}

/**
 * Ties each exercise or assignment to the stock trade that delivered its shares
 * and works out how the premium adjusts it.
 *
 * Neither event realizes a gain on the contract itself. A premium paid for a
 * call you exercise becomes part of what the shares cost you; a premium
 * collected on a put you're assigned reduces it. Booking the premium as its own
 * gain and the shares at bare strike would report the same dollars twice, in
 * the wrong tax year and often at the wrong term.
 */
export function resolveOptionPremiums(transactions: readonly Transaction[]): OptionPremiumResult {
  const premiums = premiumsByLifecycleTx(transactions);
  const pairings = new Map<Id, PremiumPairing>();
  const unpaired: OptionPremiumResult["unpaired"] = [];
  const claimed = new Set<Id>();

  for (const tx of transactions) {
    if (!deliversShares(tx.type) || tx.symbol === null) continue;

    const optionSymbol = normalizeSymbol(tx.symbol);
    const contract = parseOptionSymbol(optionSymbol);
    if (!contract) {
      unpaired.push({
        txId: tx.id,
        date: tx.date,
        symbol: optionSymbol,
        message: `"${optionSymbol}" isn't an option contract, so there is nothing to exercise or assign. Record it as a buy or sell instead.`,
      });
      continue;
    }

    const premium = premiums.get(tx.id);
    // A call you exercise and a put you're assigned on both bring shares in; a
    // put you exercise and a call you're assigned on both send them out.
    const acquiresShares =
      premium?.side === "long" ? contract.right === "call" : contract.right === "put";

    const stockLeg = transactions.find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        candidate.accountId === tx.accountId &&
        candidate.date === tx.date &&
        candidate.symbol !== null &&
        normalizeSymbol(candidate.symbol) === contract.underlying &&
        (acquiresShares
          ? opensLotOn(candidate.type) === "long"
          : closesLotOn(candidate.type) === "long"),
    );

    if (!stockLeg) {
      const action = acquiresShares ? "buy" : "sell";
      unpaired.push({
        txId: tx.id,
        date: tx.date,
        symbol: optionSymbol,
        message: `No matching ${contract.underlying} ${action} on ${tx.date} to attach this ${
          tx.type === "option_assign" ? "assignment" : "exercise"
        } to, so the $${Math.abs(premium?.value ?? 0).toFixed(
          2,
        )} premium isn't in the share basis. Add the ${action} of ${contract.underlying} at the $${
          contract.strike
        } strike.`,
      });
      continue;
    }

    claimed.add(stockLeg.id);

    // Long premiums were paid out, short premiums taken in, and shares coming
    // in carry the premium into their cost while shares going out carry it into
    // their proceeds. Those two flips give the four cases one rule.
    const direction = (premium?.side === "short" ? -1 : 1) * (acquiresShares ? 1 : -1);
    pairings.set(stockLeg.id, {
      adjustment: direction * (premium?.value ?? 0),
      optionSymbol,
      optionTxId: tx.id,
    });
  }

  return { pairings, unpaired };
}
