import type { AssetClass } from "./security";

/**
 * What the quote feed knows about a symbol beyond its price. Every field is
 * best-effort: the feed answers some of these for a fund and others for an
 * operating company, and a thin answer still classifies, just less precisely.
 */
export interface SecurityProfile {
  symbol: string;
  name: string;
  /** EQUITY, ETF, MUTUALFUND, CRYPTOCURRENCY, CURRENCY, INDEX, FUTURE. */
  quoteType: string;
  /** Exchange code, e.g. NMS (Nasdaq), NYQ (NYSE), FRA (Frankfurt). */
  exchange: string;
  /** Human-readable exchange, e.g. "NasdaqGS". */
  exchangeName: string;
  /** Sector of an operating company; blank for funds. */
  sector: string;
  /** Fund category, e.g. "Large Blend", "Intermediate Core Bond". */
  category: string;
}

export interface Classification {
  assetClass: AssetClass;
  /** What the class was read off, in one phrase, so the UI can justify it. */
  basis: string;
}

/**
 * Exchanges that make a listing American. Used only to split ordinary shares
 * into domestic and international -- a fund's geography comes from its category,
 * because a fund of European stocks is still listed in New York.
 */
const US_EXCHANGES = new Set([
  "NYQ", "NMS", "NGM", "NCM", "NAS", "NYS", "PCX", "ASE", "BTS", "PNK", "OTC",
  "OQB", "OQX", "YHD", "NCM", "AMX", "IEX",
]);

/**
 * Keyword rules run against a fund's category, or its name when the feed has no
 * category for it. Order is the whole design: a "World Bond" fund is a bond
 * fund, not an international one, and "Global Real Estate" is real estate before
 * it is anything else. The first rule that matches wins.
 */
const TEXT_RULES: { assetClass: AssetClass; keywords: string[] }[] = [
  {
    assetClass: "crypto",
    keywords: ["digital asset", "crypto", "bitcoin", "ethereum", "blockchain"],
  },
  {
    assetClass: "cash",
    keywords: ["money market", "ultrashort bond", "stable value", "treasury bill"],
  },
  {
    assetClass: "real_estate",
    keywords: ["real estate", "reit", "mortgage-backed"],
  },
  {
    assetClass: "commodity",
    keywords: [
      "commodit", "precious metals", "gold shares", "gold trust", "silver trust",
      "physical gold", "physical silver", "broad basket",
    ],
  },
  {
    assetClass: "bond",
    keywords: [
      "bond", "treasury", "municipal", "muni ", "fixed income", "inflation-protected",
      "tips", "high yield", "bank loan", "aggregate", "government", "convertible",
      "preferred stock",
    ],
  },
  {
    assetClass: "intl_equity",
    keywords: [
      "foreign", "international", "global", "world", "emerging", "europe", "japan",
      "china", "india", "pacific", "latin america", "eafe", "ex-us", "ex-u.s.",
      "developed markets", "diversified emerging",
    ],
  },
];

function matchText(text: string): AssetClass | null {
  const haystack = text.toLowerCase();
  for (const rule of TEXT_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) return rule.assetClass;
  }
  return null;
}

const FUND_TYPES = new Set(["ETF", "MUTUALFUND"]);

/**
 * Works out which asset class a symbol belongs to from what the feed says about
 * it.
 *
 * Deliberately never returns "other" for something it recognises as a fund or a
 * share: an unclassified holding drops out of the allocation view entirely,
 * which is worse than a defensible guess the user can correct in one click.
 * Every result carries the reason it was reached, so a wrong guess is visible
 * rather than mysterious.
 */
export function classifySecurity(profile: SecurityProfile): Classification {
  const quoteType = profile.quoteType.toUpperCase();

  if (quoteType === "CRYPTOCURRENCY") {
    return { assetClass: "crypto", basis: "traded as a cryptocurrency" };
  }
  if (quoteType === "CURRENCY") {
    return { assetClass: "cash", basis: "a currency pair" };
  }
  if (quoteType === "FUTURE") {
    return { assetClass: "commodity", basis: "a futures contract" };
  }

  if (FUND_TYPES.has(quoteType)) {
    const label = quoteType === "ETF" ? "ETF" : "fund";

    if (profile.category) {
      const fromCategory = matchText(profile.category);
      if (fromCategory) {
        return { assetClass: fromCategory, basis: `${label} in the ${profile.category} category` };
      }
      // A category the rules don't recognise is almost always a flavour of
      // domestic stock fund -- "Large Blend", "Mid-Cap Growth", and the rest.
      return { assetClass: "us_equity", basis: `${label} in the ${profile.category} category` };
    }

    const fromName = matchText(profile.name);
    if (fromName) return { assetClass: fromName, basis: `read from the ${label} name` };
    return { assetClass: "us_equity", basis: `${label} with no stated category` };
  }

  if (quoteType === "EQUITY") {
    // A REIT is a share like any other, but what it owns is buildings, and an
    // allocation view that files it under equity hides real estate exposure.
    if (profile.sector.toLowerCase() === "real estate") {
      return { assetClass: "real_estate", basis: "a real-estate sector company" };
    }
    if (US_EXCHANGES.has(profile.exchange.toUpperCase())) {
      return { assetClass: "us_equity", basis: `listed on ${profile.exchangeName || "a US exchange"}` };
    }
    return {
      assetClass: "intl_equity",
      basis: `listed on ${profile.exchangeName || "a non-US exchange"}`,
    };
  }

  return { assetClass: "other", basis: profile.quoteType ? `a ${profile.quoteType.toLowerCase()}` : "unrecognised" };
}
