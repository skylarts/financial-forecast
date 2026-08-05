import { z } from "zod";
import { isoDateSchema } from "../common";
import { canonicalizeSymbol } from "./optionSymbol";

export const assetClassSchema = z.enum([
  "us_equity",
  "intl_equity",
  "bond",
  "real_estate",
  "commodity",
  "crypto",
  "cash",
  "other",
]);
export type AssetClass = z.infer<typeof assetClassSchema>;

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  us_equity: "US Equity",
  intl_equity: "International Equity",
  bond: "Bond",
  real_estate: "Real Estate",
  commodity: "Commodity",
  crypto: "Crypto",
  cash: "Cash",
  other: "Other",
};

/**
 * Per-symbol metadata the ledger can't derive on its own. Every field is
 * optional embellishment -- a symbol that appears only in transactions still
 * shows up as a holding, just with no friendly name and an unclassified
 * allocation.
 */
export const securitySchema = z.object({
  /** Uppercase ticker, the join key against transactions and quotes. */
  symbol: z.string().min(1),
  name: z.string().default(""),
  assetClass: assetClassSchema.default("other"),
  /**
   * Whether the class was worked out from the feed or chosen by hand. Only
   * "auto" rows are ever re-derived, so a class the user set stays set -- and
   * a security saved before this field existed reads as "manual", because the
   * only way it got a class back then was somebody picking one.
   */
  assetClassSource: z.enum(["auto", "manual"]).default("manual"),
  /**
   * Overrides the quote feed. Set for anything the feed can't price -- private
   * holdings, an obscure fund, a stale delisted ticker on a closed position.
   */
  manualPrice: z.number().nonnegative().nullable().default(null),
  manualPriceDate: isoDateSchema.nullable().default(null),
  /**
   * The last price the feed actually returned, kept as a fallback for when a
   * later request fails. Updated automatically on every successful quote --
   * distinct from `manualPrice`, which the user sets on purpose and the feed
   * is never allowed to overwrite.
   */
  lastKnownPrice: z.number().nonnegative().nullable().default(null),
  lastKnownPriceDate: isoDateSchema.nullable().default(null),
});
export type Security = z.infer<typeof securitySchema>;

/**
 * The one spelling of a symbol the rest of the app works in. Ordinary tickers
 * are just upper-cased; option contracts are rewritten to canonical OCC, so the
 * three ways a statement might spell one contract all land on the same holding
 * and all reach the quote feed under the name it knows.
 */
export function normalizeSymbol(raw: string): string {
  return canonicalizeSymbol(raw);
}
