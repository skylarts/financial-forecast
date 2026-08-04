import { z } from "zod";
import { isoDateSchema } from "../common";

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
   * Overrides the quote feed. Set for anything the feed can't price -- private
   * holdings, an obscure fund, a stale delisted ticker on a closed position.
   */
  manualPrice: z.number().nonnegative().nullable().default(null),
  manualPriceDate: isoDateSchema.nullable().default(null),
});
export type Security = z.infer<typeof securitySchema>;

export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}
