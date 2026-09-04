import { z } from "zod";
import { idSchema } from "../common";

/**
 * A named group of holdings the owner treats as one position.
 *
 * Deliberately not a theme. A theme is a label that can sit on a holding
 * alongside other labels, and a holding tagged twice counts at full value in
 * both -- so themes overlap and their slices don't partition anything. A
 * basket is the opposite: it stands *in place of* its members, so a symbol
 * belongs to at most one (enforced in the store, not here), and the basket's
 * slice is exactly the sum of what's inside it. That exclusivity is what lets
 * the by-holding breakdown swap a basket in for its members without the total
 * changing.
 *
 * Membership lives here rather than as a field on each security, so a basket
 * can exist with nothing in it yet -- which is the first thing that happens
 * when you set one up.
 */
export const basketSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  /** Canonical symbols, in the order they were added. */
  symbols: z.array(z.string()).default([]),
});
export type Basket = z.infer<typeof basketSchema>;

/** Same trim-and-collapse as a theme tag: "  AI  core " and "AI core" are one name. */
export function normalizeBasketName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Which basket each symbol belongs to, ready for the by-holding breakdown.
 *
 * A later basket can't steal a symbol an earlier one already claimed -- the
 * store keeps membership exclusive on write, and this is the read side of the
 * same rule, so a hand-edited backup with one symbol in two baskets still
 * resolves to a single answer instead of counting it in both.
 */
export function basketBySymbol(baskets: readonly Basket[]): Map<string, Basket> {
  const map = new Map<string, Basket>();
  for (const basket of baskets) {
    for (const symbol of basket.symbols) {
      if (!map.has(symbol)) map.set(symbol, basket);
    }
  }
  return map;
}
