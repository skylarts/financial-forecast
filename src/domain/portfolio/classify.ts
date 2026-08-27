import type { AssetClass, Exposure, InstrumentType } from "./security";

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
  /** How the position's value splits across classes. A single-class result
   *  (almost everything) carries one row at weight 1, same as `assetClass`. */
  exposures: Exposure[];
  instrumentType: InstrumentType;
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

/**
 * Region-specific keywords that reach the `intl_equity` rule above. Any of
 * these mean the fund is explicitly ex-US or one particular region -- as
 * opposed to "world" or "global" alone, which own a slice of the whole planet,
 * US included.
 */
const REGION_ONLY_KEYWORDS = [
  "foreign", "international", "emerging", "europe", "japan", "china", "india",
  "pacific", "latin america", "eafe", "ex-us", "ex-u.s.", "developed markets",
  "diversified emerging",
];

const WORLD_KEYWORDS = ["world", "global"];

/**
 * A fund whose category or name says "world" or "global" without naming a
 * specific region owns a market-cap slice of the whole planet, not just
 * outside it -- Vanguard Total World Stock (VT) is the standard example, and
 * filing its entire value under "International" hides that most of it is US
 * stock. "Global Bond" and "Global Real Estate" never reach this check: the
 * bond and real-estate rules above run first and already claim them.
 */
function isWorldStock(text: string): boolean {
  const haystack = text.toLowerCase();
  if (REGION_ONLY_KEYWORDS.some((keyword) => haystack.includes(keyword))) return false;
  return WORLD_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

/** A world-stock fund's default split, at the market's long-run rough
 *  weighting between US and non-US equity. Editable per security afterward --
 *  this is a starting point, not a claim about any one fund's actual mix. */
const WORLD_STOCK_SPLIT: Exposure[] = [
  { assetClass: "us_equity", weight: 0.6 },
  { assetClass: "intl_equity", weight: 0.4 },
];

function single(assetClass: AssetClass): Exposure[] {
  return [{ assetClass, weight: 1 }];
}

function exposuresFor(assetClass: AssetClass, text: string): Exposure[] {
  return assetClass === "intl_equity" && isWorldStock(text) ? WORLD_STOCK_SPLIT : single(assetClass);
}

function instrumentTypeFor(quoteType: string): InstrumentType {
  switch (quoteType) {
    case "CRYPTOCURRENCY":
      return "crypto";
    case "CURRENCY":
      return "cash";
    case "ETF":
      return "etf";
    case "MUTUALFUND":
      return "mutual_fund";
    case "EQUITY":
      return "stock";
    default:
      return "other";
  }
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
  const instrumentType = instrumentTypeFor(quoteType);

  if (quoteType === "CRYPTOCURRENCY") {
    return { assetClass: "crypto", basis: "traded as a cryptocurrency", exposures: single("crypto"), instrumentType };
  }
  if (quoteType === "CURRENCY") {
    return { assetClass: "cash", basis: "a currency pair", exposures: single("cash"), instrumentType };
  }
  if (quoteType === "FUTURE") {
    return { assetClass: "commodity", basis: "a futures contract", exposures: single("commodity"), instrumentType };
  }

  if (FUND_TYPES.has(quoteType)) {
    const label = quoteType === "ETF" ? "ETF" : "fund";

    if (profile.category) {
      const fromCategory = matchText(profile.category);
      if (fromCategory) {
        return {
          assetClass: fromCategory,
          basis: `${label} in the ${profile.category} category`,
          exposures: exposuresFor(fromCategory, profile.category),
          instrumentType,
        };
      }
      // A category the rules don't recognise is almost always a flavour of
      // domestic stock fund -- "Large Blend", "Mid-Cap Growth", and the rest.
      return {
        assetClass: "us_equity",
        basis: `${label} in the ${profile.category} category`,
        exposures: single("us_equity"),
        instrumentType,
      };
    }

    const fromName = matchText(profile.name);
    if (fromName) {
      return {
        assetClass: fromName,
        basis: `read from the ${label} name`,
        exposures: exposuresFor(fromName, profile.name),
        instrumentType,
      };
    }
    return {
      assetClass: "us_equity",
      basis: `${label} with no stated category`,
      exposures: single("us_equity"),
      instrumentType,
    };
  }

  if (quoteType === "EQUITY") {
    // A REIT is a share like any other, but what it owns is buildings, and an
    // allocation view that files it under equity hides real estate exposure.
    if (profile.sector.toLowerCase() === "real estate") {
      return {
        assetClass: "real_estate",
        basis: "a real-estate sector company",
        exposures: single("real_estate"),
        instrumentType,
      };
    }
    if (US_EXCHANGES.has(profile.exchange.toUpperCase())) {
      return {
        assetClass: "us_equity",
        basis: `listed on ${profile.exchangeName || "a US exchange"}`,
        exposures: single("us_equity"),
        instrumentType,
      };
    }
    return {
      assetClass: "intl_equity",
      basis: `listed on ${profile.exchangeName || "a non-US exchange"}`,
      exposures: single("intl_equity"),
      instrumentType,
    };
  }

  return {
    assetClass: "other",
    basis: profile.quoteType ? `a ${profile.quoteType.toLowerCase()}` : "unrecognised",
    exposures: single("other"),
    instrumentType,
  };
}
