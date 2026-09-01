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
 * How much of a holding's value sits in each asset class. A single-class
 * security (almost everything) carries one row at weight 1; a fund like VT
 * that spans US and international stock carries one row per class, summing
 * to 1 -- so its dollars split across both instead of piling entirely onto
 * whichever class `assetClass` names.
 */
export const exposureSchema = z.object({
  assetClass: assetClassSchema,
  /** Share of the position, 0-1. Renormalized on read, so a hand-edited set
   *  that doesn't quite sum to 1 still resolves to something sane. */
  weight: z.number().positive(),
});
export type Exposure = z.infer<typeof exposureSchema>;

export const instrumentTypeSchema = z.enum([
  "stock",
  "etf",
  "mutual_fund",
  "option",
  "crypto",
  "cash",
  "other",
]);
export type InstrumentType = z.infer<typeof instrumentTypeSchema>;

export const INSTRUMENT_TYPE_LABELS: Record<InstrumentType, string> = {
  stock: "Stock",
  etf: "ETF",
  mutual_fund: "Mutual fund",
  option: "Option",
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
   * How this position splits across asset classes. Empty means "all of
   * `assetClass`" -- the overwhelming common case, and how every security
   * saved before this field existed reads, so nothing needs migrating.
   */
  exposures: z.array(exposureSchema).default([]),
  instrumentType: instrumentTypeSchema.default("other"),
  /** Same auto/manual convention as `assetClassSource`, tracked separately
   *  because a security's type and its class can be corrected independently. */
  instrumentTypeSource: z.enum(["auto", "manual"]).default("manual"),
  /**
   * Free-form theme tags -- "AI", "Dividend growth", whatever groupings matter
   * to the person holding it. Unlike asset class, these are never inferred:
   * nothing in a quote feed says what a holding *means* to its owner.
   */
  themes: z.array(z.string()).default([]),
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
  /**
   * The day the feed was last asked to classify this symbol, whatever it
   * answered. Set even when the answer was "never heard of it", which is the
   * whole point: a delisted ticker is a permanent miss, and without a record
   * that it was asked about, every session re-asks the feed about every dead
   * symbol the ledger has ever held and gets the same silence back.
   *
   * Null on every security saved before this field existed, so they are asked
   * once and then settle.
   */
  profileCheckedAt: isoDateSchema.nullable().default(null),
});
export type Security = z.infer<typeof securitySchema>;

/**
 * The one spelling of a symbol the rest of the app works in. Ordinary tickers
 * are just upper-cased; option contracts are rewritten to canonical OCC, so the
 * three ways a statement might spell one contract all land on the same holding
 * and all reach the quote feed under the name it knows.
 */
/**
 * Memoized because this sits under every hot loop in the app and is far more
 * expensive than it looks: canonicalizing runs a trim, an upper-case, a
 * whitespace collapse and a full option-contract parse, and the engine calls
 * it once per transaction per holding. A ledger only ever contains a few
 * hundred distinct spellings, so the cache is small and effectively permanent.
 */
const normalized = new Map<string, string>();

/**
 * Guards against a pathological ledger (or a fuzz test) growing the cache
 * without bound. Clearing wholesale rather than evicting one entry keeps this
 * free in the normal case, where the ceiling is never reached.
 */
const NORMALIZE_CACHE_LIMIT = 50_000;

export function normalizeSymbol(raw: string): string {
  const hit = normalized.get(raw);
  if (hit !== undefined) return hit;
  const value = canonicalizeSymbol(raw);
  if (normalized.size >= NORMALIZE_CACHE_LIMIT) normalized.clear();
  normalized.set(raw, value);
  return value;
}

/**
 * The exposures a security's value should actually be split across, renormalized
 * to sum to exactly 1.
 *
 * Empty `exposures` (every security saved before the field existed, and every
 * single-class security since) resolves to the whole position under
 * `assetClass` -- the one case that has to keep working without anyone having
 * touched a new field. A hand-edited set that sums to 0.9 or 1.1 still resolves
 * to a clean split rather than silently losing or inventing value.
 */
export function resolveExposures(security: Pick<Security, "assetClass" | "exposures">): Exposure[] {
  if (security.exposures.length === 0) return [{ assetClass: security.assetClass, weight: 1 }];
  const total = security.exposures.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return [{ assetClass: security.assetClass, weight: 1 }];
  return security.exposures.map((e) => ({ assetClass: e.assetClass, weight: e.weight / total }));
}
