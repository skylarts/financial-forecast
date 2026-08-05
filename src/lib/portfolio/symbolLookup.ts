import {
  classifySecurity,
  parseOptionSymbol,
  toOccSymbol,
  type AssetClass,
  type SecurityProfile,
} from "@/domain/portfolio";

/**
 * Symbol lookup against the same feed that prices the portfolio.
 *
 * This exists because a mistyped ticker is invisible: the holding still shows
 * up, valued silently at cost basis, and nothing on screen says the symbol was
 * never real. Confirming the symbol at entry is the only point where that is
 * cheap to catch.
 */

const UA = "Mozilla/5.0";
const TIMEOUT_MS = 10_000;

async function getJson<T>(url: string, cookie?: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": UA,
        ...(cookie ? { cookie } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Authenticated endpoints                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Two of the feed's endpoints -- fund profiles and option chains -- answer only
 * to a session cookie paired with a matching token. The chart and search
 * endpoints don't, which is why quotes have never needed this.
 *
 * Everything downstream treats a missing session as "that detail is
 * unavailable" rather than an error: without it, funds classify off their names
 * instead of their categories and the option picker asks for the expiry and
 * strike instead of listing them. Both still work.
 */
interface FeedSession {
  cookie: string;
  crumb: string;
}

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
let session: { value: FeedSession | null; obtainedAt: number } | null = null;
let sessionInFlight: Promise<FeedSession | null> | null = null;

async function openSession(): Promise<FeedSession | null> {
  try {
    // Answers 404, but sets the cookie on the way -- the status is not the
    // point of the request.
    const seed = await fetch("https://fc.yahoo.com/", {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cookie = seed.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    if (!cookie) return null;

    const response = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": UA, cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const crumb = (await response.text()).trim();

    // A crumb is a short opaque token. An HTML error page or an empty body
    // means the handshake failed in a way the status code didn't admit to.
    if (!crumb || crumb.length > 32 || crumb.includes("<")) return null;

    return { cookie, crumb };
  } catch {
    return null;
  }
}

async function feedSession(): Promise<FeedSession | null> {
  if (session && Date.now() - session.obtainedAt < SESSION_TTL_MS) return session.value;
  // A second caller arriving mid-handshake waits for the first rather than
  // starting its own; the feed hands out a fresh cookie per request and the
  // races invalidate each other.
  if (!sessionInFlight) {
    sessionInFlight = openSession().then((value) => {
      session = { value, obtainedAt: Date.now() };
      sessionInFlight = null;
      return value;
    });
  }
  return sessionInFlight;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

export interface SymbolMatch {
  symbol: string;
  name: string;
  /** Exchange as a person reads it, e.g. "NYSE". */
  exchange: string;
  /** Instrument kind as a person reads it, e.g. "Equity", "ETF". */
  type: string;
  assetClass: AssetClass;
  /** Why that class, in one phrase. */
  basis: string;
}

interface SearchQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  exchDisp?: string;
  quoteType?: string;
  typeDisp?: string;
  sector?: string;
  isYahooFinance?: boolean;
}

const searchCache = new Map<string, { value: SymbolMatch[]; fetchedAt: number }>();
const SEARCH_TTL_MS = 10 * 60 * 1000;

/** Kinds worth offering. A screener page or a news topic is not a holding. */
const HOLDABLE_TYPES = new Set([
  "EQUITY", "ETF", "MUTUALFUND", "CRYPTOCURRENCY", "INDEX", "CURRENCY", "FUTURE",
]);

function profileFromQuote(quote: SearchQuote, category = ""): SecurityProfile {
  return {
    symbol: (quote.symbol ?? "").toUpperCase(),
    name: quote.longname || quote.shortname || "",
    quoteType: quote.quoteType ?? "",
    exchange: quote.exchange ?? "",
    exchangeName: quote.exchDisp ?? "",
    sector: quote.sector ?? "",
    category,
  };
}

/** Symbols matching free text -- a ticker, a company name, or part of either. */
export async function searchSymbols(query: string, limit = 8): Promise<SymbolMatch[]> {
  const key = `${query.toLowerCase()}::${limit}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_TTL_MS) return cached.value;

  const body = await getJson<{ quotes?: SearchQuote[] }>(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      query,
    )}&quotesCount=${limit * 2}&newsCount=0&enableFuzzyQuery=false`,
  );
  if (!body) return cached?.value ?? [];

  const matches: SymbolMatch[] = [];
  for (const quote of body.quotes ?? []) {
    if (!quote.symbol || quote.isYahooFinance === false) continue;
    if (!HOLDABLE_TYPES.has((quote.quoteType ?? "").toUpperCase())) continue;

    // Classified from the search row alone, with no category -- good enough to
    // label the dropdown. The full profile is fetched once a symbol is chosen.
    const { assetClass, basis } = classifySecurity(profileFromQuote(quote));
    matches.push({
      symbol: quote.symbol.toUpperCase(),
      name: quote.longname || quote.shortname || quote.symbol,
      exchange: quote.exchDisp ?? "",
      type: quote.typeDisp ?? quote.quoteType ?? "",
      assetClass,
      basis,
    });
    if (matches.length >= limit) break;
  }

  searchCache.set(key, { value: matches, fetchedAt: Date.now() });
  return matches;
}

/* -------------------------------------------------------------------------- */
/* Profiles                                                                    */
/* -------------------------------------------------------------------------- */

export interface ResolvedProfile {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  basis: string;
  /** False when the feed has never heard of the symbol. */
  found: boolean;
}

const profileCache = new Map<string, { value: ResolvedProfile; fetchedAt: number }>();
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

interface FundProfileBody {
  quoteSummary?: { result?: { fundProfile?: { categoryName?: string } }[] };
}

/**
 * A fund's Morningstar category, e.g. "Foreign Large Blend". This is the single
 * most useful classifying fact there is -- it is the difference between knowing
 * VXUS is international stock and guessing from its name.
 */
async function fundCategory(symbol: string): Promise<string> {
  const auth = await feedSession();
  if (!auth) return "";

  const body = await getJson<FundProfileBody>(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol,
    )}?modules=fundProfile&crumb=${encodeURIComponent(auth.crumb)}`,
    auth.cookie,
  );
  return body?.quoteSummary?.result?.[0]?.fundProfile?.categoryName ?? "";
}

/**
 * Everything needed to file one symbol under an asset class.
 *
 * An option contract is classified as whatever its underlying is: a call on a
 * US bank is US equity exposure, and filing every contract under "other" would
 * quietly drop the option book out of the allocation view.
 */
export async function resolveProfile(symbol: string): Promise<ResolvedProfile> {
  const key = symbol.toUpperCase();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) return cached.value;

  const contract = parseOptionSymbol(key);
  if (contract) {
    const underlying = await resolveProfile(contract.underlying);
    const resolved: ResolvedProfile = {
      symbol: key,
      name: underlying.name ? `${underlying.name} option` : "",
      assetClass: underlying.assetClass,
      basis: `an option on ${contract.underlying}, which is ${underlying.basis}`,
      found: underlying.found,
    };
    profileCache.set(key, { value: resolved, fetchedAt: Date.now() });
    return resolved;
  }

  const body = await getJson<{ quotes?: SearchQuote[] }>(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      key,
    )}&quotesCount=6&newsCount=0&enableFuzzyQuery=false`,
  );

  // Only an exact ticker match counts. A search for a typo returns the nearest
  // real company, and silently classifying the holding as that company would be
  // worse than leaving it unclassified.
  const quote = (body?.quotes ?? []).find((q) => (q.symbol ?? "").toUpperCase() === key);
  if (!quote) {
    const missing: ResolvedProfile = {
      symbol: key,
      name: "",
      assetClass: "other",
      basis: "not found in the feed",
      found: false,
    };
    return missing;
  }

  const quoteType = (quote.quoteType ?? "").toUpperCase();
  const category =
    quoteType === "ETF" || quoteType === "MUTUALFUND" ? await fundCategory(key) : "";
  const profile = profileFromQuote(quote, category);
  const { assetClass, basis } = classifySecurity(profile);

  const resolved: ResolvedProfile = {
    symbol: key,
    name: profile.name,
    assetClass,
    basis,
    found: true,
  };
  profileCache.set(key, { value: resolved, fetchedAt: Date.now() });
  return resolved;
}

/** Profiles for many symbols, in small batches so the feed doesn't throttle. */
const PROFILE_BATCH = 5;

export async function resolveProfiles(symbols: readonly string[]): Promise<ResolvedProfile[]> {
  const out: ResolvedProfile[] = [];
  for (let i = 0; i < symbols.length; i += PROFILE_BATCH) {
    const batch = symbols.slice(i, i + PROFILE_BATCH);
    out.push(...(await Promise.all(batch.map(resolveProfile))));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Option chains                                                               */
/* -------------------------------------------------------------------------- */

export interface OptionChain {
  underlying: string;
  /** Every expiry the underlying has listed contracts for, ISO, soonest first. */
  expiries: string[];
  /** The expiry the contracts below belong to. */
  expiry: string;
  contracts: OptionQuote[];
}

export interface OptionQuote {
  /** Canonical OCC symbol -- exactly what to store. */
  symbol: string;
  strike: number;
  right: "call" | "put";
  /** Last traded premium per share, or null for a contract that hasn't traded. */
  lastPrice: number | null;
  openInterest: number;
}

interface ChainContract {
  contractSymbol?: string;
  strike?: number;
  lastPrice?: number;
  openInterest?: number;
}

interface ChainBody {
  optionChain?: {
    result?: {
      expirationDates?: number[];
      options?: { expirationDate?: number; calls?: ChainContract[]; puts?: ChainContract[] }[];
    }[];
  };
}

const chainCache = new Map<string, { value: OptionChain | null; fetchedAt: number }>();
const CHAIN_TTL_MS = 15 * 60 * 1000;

function isoFromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function toQuotes(raw: ChainContract[] | undefined, right: "call" | "put"): OptionQuote[] {
  return (raw ?? [])
    .filter((c) => typeof c.strike === "number" && typeof c.contractSymbol === "string")
    .map((c) => ({
      symbol: (c.contractSymbol as string).toUpperCase(),
      strike: c.strike as number,
      right,
      lastPrice: typeof c.lastPrice === "number" ? c.lastPrice : null,
      openInterest: c.openInterest ?? 0,
    }));
}

/**
 * The contracts actually listed on an underlying, for one expiry.
 *
 * Listing what exists is the difference between confirming a contract and
 * guessing at one: expiries and strikes are set by the exchange, and a
 * plausible-looking combination the exchange never listed prices at nothing
 * and looks identical to a typo.
 */
export async function fetchOptionChain(
  underlying: string,
  expiry?: string,
): Promise<OptionChain | null> {
  const root = underlying.toUpperCase();
  const key = `${root}::${expiry ?? ""}`;
  const cached = chainCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CHAIN_TTL_MS) return cached.value;

  const auth = await feedSession();
  if (!auth) return null;

  // The feed selects an expiry by its epoch-second timestamp, not by date.
  let dateParam = "";
  if (expiry) {
    const seconds = Math.floor(Date.parse(`${expiry}T00:00:00Z`) / 1000);
    if (Number.isFinite(seconds)) dateParam = `&date=${seconds}`;
  }

  const body = await getJson<ChainBody>(
    `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(
      root,
    )}?crumb=${encodeURIComponent(auth.crumb)}${dateParam}`,
    auth.cookie,
  );

  const result = body?.optionChain?.result?.[0];
  if (!result) {
    chainCache.set(key, { value: null, fetchedAt: Date.now() });
    return null;
  }

  const slice = result.options?.[0];
  const chain: OptionChain = {
    underlying: root,
    expiries: (result.expirationDates ?? []).map(isoFromEpochSeconds),
    expiry: slice?.expirationDate ? isoFromEpochSeconds(slice.expirationDate) : (expiry ?? ""),
    contracts: [...toQuotes(slice?.calls, "call"), ...toQuotes(slice?.puts, "put")].sort(
      (a, b) => a.strike - b.strike,
    ),
  };

  chainCache.set(key, { value: chain, fetchedAt: Date.now() });
  return chain;
}

/**
 * Confirms one contract exists, spelled the way the feed spells it.
 *
 * Falls back to the canonical form when the chain is unavailable, so a symbol
 * still gets normalised even if the listing can't be checked.
 */
export async function confirmContract(symbol: string): Promise<string | null> {
  const contract = parseOptionSymbol(symbol);
  if (!contract) return null;
  const canonical = toOccSymbol(contract);
  const chain = await fetchOptionChain(contract.underlying, contract.expiry);
  if (!chain) return canonical;
  return chain.contracts.some((c) => c.symbol === canonical) ? canonical : null;
}
