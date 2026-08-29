import type { ISODate } from "@/domain";

/**
 * The shape every price source is normalized into, and the rules for falling
 * from one source to the next.
 *
 * The app used to speak Yahoo's chart format directly. It now has two feeds
 * with genuinely different strengths -- Schwab knows the real prior close and
 * quotes the user's own broker, Yahoo knows corporate actions -- so the
 * fetching layer talks to this interface and neither feed's quirks leak into
 * the cache, the batching, or the routes.
 */

export interface PricePoint {
  date: ISODate;
  close: number;
}

export interface Quote {
  symbol: string;
  price: number;
  date: ISODate;
  /** The feed's own name for the security, used to auto-fill new holdings. */
  name: string;
  /**
   * The prior session's close, which is what a day move is measured against.
   *
   * Null when the feed didn't report one. A day change is the one figure here
   * that cannot be reconstructed from the ledger -- the ledger has no idea what
   * yesterday was worth -- so a missing previous close means the UI shows no
   * day move for that symbol rather than inventing one from the last trade.
   */
  previousClose: number | null;
  /**
   * True when this came from cache after a live refetch failed. The price is
   * real, just older than it looks -- the UI says so rather than presenting a
   * stale number as current.
   */
  stale?: boolean;
  /** Which feed answered, for the UI's provenance line and for debugging. */
  source?: string;
}

/**
 * A share split, as the feed records it.
 *
 * `ratio` is how many shares one share became -- 20 for Alphabet's 20-for-1,
 * 0.1 for a one-for-ten reverse. The date is the day the new shares began
 * trading, which is the first day the feed's closes are quoted in them.
 */
export interface SplitEvent {
  date: ISODate;
  ratio: number;
}

export interface SymbolHistory {
  symbol: string;
  points: PricePoint[];
  /**
   * Every split the feed knows of, oldest first.
   *
   * Carried with the history rather than fetched separately because the closes
   * are meaningless without it: the feed quotes all of them in *today's*
   * shares, so a price from before a split is not the price anyone paid that
   * day.
   *
   * Not every feed can fill this. Schwab adjusts its candles for splits but
   * never says one happened, so a Schwab history arrives with an empty list --
   * see `splitsKnown`.
   */
  splits: SplitEvent[];
  /**
   * Whether `splits` is an answer or an absence.
   *
   * An empty list means "no splits" from Yahoo and "I was never told" from
   * Schwab, and those must not be confused: treating Schwab's silence as "no
   * splits" would let the engine believe a pre-split close was the price the
   * ledger's shares actually traded at. Callers that reconstruct historical
   * share counts check this before trusting an empty list.
   */
  splitsKnown: boolean;
}

/**
 * Why a symbol has no price. The distinction matters: "the feed has never
 * heard of this" is a data-entry problem the user must fix, while "the request
 * failed" is weather and will likely fix itself on the next refresh. Collapsing
 * the two is what made a transient blip look like a bad ticker.
 */
export type QuoteFailure = "unknown_symbol" | "fetch_failed";

/**
 * Symbols are interpolated into an outbound URL, so the accepted shape is
 * locked down to what a real ticker can contain. Anything else is rejected
 * rather than escaped -- there is no legitimate ticker this excludes.
 *
 * The 21-character ceiling is set by OCC option symbology (a six-character
 * root, a six-digit expiry, C or P, an eight-digit strike). The previous
 * 12-character limit silently rejected every option contract before it ever
 * reached the feed.
 *
 * A leading caret is allowed because that is how an index is named here --
 * `^GSPC`, `^DJI`. Requiring the first character to be alphanumeric rejected
 * every one of them, which is why the market strip quotes indexes directly
 * rather than standing in ETFs for them.
 *
 * This is the app's own spelling of a symbol, not any feed's. A feed that
 * names things differently -- Schwab calls the same index `$SPX` -- translates
 * on its way out rather than widening what is accepted here.
 */
const SYMBOL_PATTERN = /^[A-Za-z0-9^][A-Za-z0-9.\-^]{0,20}$/;

export function isValidSymbol(symbol: string): boolean {
  return SYMBOL_PATTERN.test(symbol);
}

/**
 * One feed's answer, keeping "no such symbol" apart from "it broke" all the
 * way up so the chain below can tell a bad ticker from a bad afternoon.
 */
export type ProviderOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "unknown_symbol" }
  | { status: "fetch_failed" };

export interface MarketDataProvider {
  /** Short identifier recorded on the quote, e.g. "schwab". */
  readonly name: string;
  /**
   * Whether this feed can be called at all right now. Schwab answers false
   * until the user has connected an account; Yahoo always answers true.
   * A feed that isn't configured is skipped without a request, so an
   * unconnected install costs nothing and behaves exactly as it did before.
   */
  configured(): boolean;
  quote(symbol: string): Promise<ProviderOutcome<Quote>>;
  history(symbol: string, range: string): Promise<ProviderOutcome<SymbolHistory>>;
}

/**
 * Asks each configured feed in turn and returns the first real answer.
 *
 * The status folding is the whole point of this function. A symbol is only
 * reported unknown when *every* feed that answered said so, because the feeds
 * disagree about what exists: Schwab has never heard of `^GSPC` (it calls the
 * index `$SPX`) and does not carry every workplace-plan mutual fund, while
 * Yahoo carries both. Letting the first feed's shrug end the search is exactly
 * how a valid holding would start rendering as a typo.
 *
 * A transient failure anywhere outranks a shrug for the same reason in the
 * other direction: if one feed is down and the other says unknown, the honest
 * answer is "couldn't price it, try again", not "your ticker is wrong".
 */
export async function firstAnswer<T>(
  providers: readonly MarketDataProvider[],
  ask: (provider: MarketDataProvider) => Promise<ProviderOutcome<T>>,
): Promise<ProviderOutcome<T>> {
  let sawFailure = false;
  let sawAnswer = false;

  for (const provider of providers) {
    if (!provider.configured()) continue;

    let outcome: ProviderOutcome<T>;
    try {
      outcome = await ask(provider);
    } catch {
      // A feed throwing is a failure of that feed, not of the request. Fall
      // through to the next one rather than taking the page down with it.
      outcome = { status: "fetch_failed" };
    }

    sawAnswer = true;
    if (outcome.status === "ok") return outcome;
    if (outcome.status === "fetch_failed") sawFailure = true;
  }

  // No feed configured at all is a deployment problem, not a bad ticker.
  if (!sawAnswer) return { status: "fetch_failed" };
  return sawFailure ? { status: "fetch_failed" } : { status: "unknown_symbol" };
}
