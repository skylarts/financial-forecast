import type { ISODate, Id } from "@/domain";
import {
  contractMultiplier,
  normalizeSymbol,
  signedCashFlow,
  type Transaction,
} from "@/domain/portfolio";
import { replayableCash } from "./cash";

export interface PricePoint {
  date: ISODate;
  close: number;
}

/**
 * A split as the feed reports it: the day the new shares began trading, and how
 * many shares one share became. Reverse splits carry a ratio below one.
 */
export interface SplitEvent {
  date: ISODate;
  ratio: number;
}

export interface PerformancePoint {
  date: ISODate;
  /**
   * What the account was worth at that day's close: positions plus the cash
   * beside them on an `account` basis, positions alone on a `securities` one.
   * See {@link PerformanceSeries.basis}.
   */
  value: number;
  /** Net money moved in from outside that day; negative is money out. */
  flow: number;
  /** Time-weighted growth of one dollar, 1 at the start of the window. */
  index: number;
}

export interface PerformanceSeries {
  points: PerformancePoint[];
  /**
   * Symbols *still held* at the window's close that the feed had no history
   * for, so their closing value is a guess carried forward from the last price
   * paid. The UI names them because that guess sits in the final number.
   *
   * A position the ledger already closed is deliberately not listed here even
   * when it leaned on the same fallback. Its cost and its proceeds are both
   * recorded facts, so the return it contributed is exact -- an expired option
   * is worth zero and the ledger says so. Only the shape of the line in
   * between is approximate, and naming every dead contract for that would bury
   * the cases where the *answer* is uncertain under years of noise.
   */
  approximated: string[];
  /**
   * Which portfolio the returns describe.
   *
   * `account` is the real one: securities plus the cash sitting beside them,
   * replayed from the ledger's own cash movements. A sale converts securities
   * into cash rather than shrinking the portfolio, so only money crossing the
   * account boundary counts as a flow, and idle cash shows up as the drag it is.
   *
   * `securities` is the fallback for a ledger that cannot say what its cash was
   * doing -- see {@link replayableCash}. It values positions alone, which
   * makes every purchase look like a contribution arriving and every sale like a
   * withdrawal leaving. That still chains into a defensible return, but a day
   * the ledger emptied out has no base left to measure the next one against.
   */
  basis: "account" | "securities";
}

/** Types whose share movement is a transfer of value, not a purchase. */
const TRANSFER_TYPES = new Set(["transfer_in", "transfer_out"]);

/**
 * How large a day's flow may be, relative to what was invested going into it,
 * before that day stops being a measurement. Applies on a `securities` basis
 * only, which is the one that cannot see the cash a sale left behind.
 *
 * A time-weighted return divides the day's earnings by the base it opened on,
 * which only says anything while that base is the larger of the two. Once more
 * money moves than was invested to begin with, the quotient is describing the
 * size of the trade rather than what the holdings did, so one is the ceiling:
 * the day's flow may not exceed the base it started from.
 *
 * This is a blunt instrument -- it discards whatever the holdings really did
 * that day -- and it is a symptom of the basis rather than a fix. On an
 * `account` basis the cash is in the denominator, the collapse never starts,
 * and the day is measured like any other.
 */
const FLOW_DOMINANCE = 1;

/**
 * Every brokerage in this ledger prints share quantities to 5 decimal places.
 * A spinoff's child quantity is computed at full floating-point precision
 * (parent shares times a ratio like 1/3), so rounding it to that same
 * precision keeps it from drifting a few millionths of a share away from
 * whatever a later sale of the child names. Kept local rather than shared
 * with the lot ledger's copy -- this file is deliberately independent of it.
 */
const SHARE_DECIMALS = 5;

function roundToShareDecimals(quantity: number): number {
  return Math.round(quantity * 10 ** SHARE_DECIMALS) / 10 ** SHARE_DECIMALS;
}

/**
 * Rounds to the nearest cent, the smallest unit real money moves in.
 *
 * `cash` here is a running sum of every cash flow the ledger has ever
 * recorded, replayed one transaction at a time. Left unrounded, ordinary
 * binary floating-point error accumulates across years of additions, so an
 * account that is genuinely down to the last cent can drift to something
 * like 3e-11 instead of 0 -- and that residue becomes the `previousValue` a
 * later day's return is divided by. A real return divided by a base that
 * should have been zero but reads as a trillionth of a cent is how one day's
 * ordinary gain turns into a trillion-dollar chart. `replayableCash` in
 * `./cash` guards the same arithmetic for the opening-balance inference.
 */
function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Running share count per symbol, by transaction.
 *
 * Deliberately simpler than the lot ledger: valuing a portfolio needs only how
 * many shares were held, not which lots they came from, and replaying the full
 * ledger for every day of a ten-year window would cost far more than it buys.
 * Shorts carry a negative count, which is exactly right for valuation -- a
 * short position is worth what covering it would cost, as a liability.
 */
function applyToShares(held: Map<string, number>, tx: Transaction): void {
  if (tx.symbol === null) return;
  const symbol = normalizeSymbol(tx.symbol);
  const current = held.get(symbol) ?? 0;

  switch (tx.type) {
    case "buy":
    case "reinvest":
    case "transfer_in":
    case "buy_to_cover":
      held.set(symbol, current + tx.quantity);
      break;
    case "sell":
    case "transfer_out":
      held.set(symbol, current - tx.quantity);
      break;
    case "short_sell":
      held.set(symbol, current - tx.quantity);
      break;
    case "split":
      // `quantity` is the ratio here, not a share count.
      if (tx.quantity > 0) held.set(symbol, current * tx.quantity);
      break;
    case "option_expire":
    case "option_exercise":
    case "option_assign":
      // Retires the contract from whichever side it was held on.
      held.set(symbol, current > 0 ? current - tx.quantity : current + tx.quantity);
      break;
    case "spinoff": {
      // Moves shares into the new symbol, scaled by the statement's ratio --
      // without this the child never gets credited here (it's tracked by cost
      // basis in the lot ledger, not share count, so this file has no other
      // way to learn about it). A full exchange also retires the parent the
      // same way the lot ledger does, or it sits at its pre-spinoff count
      // forever, valued at whatever it last traded for.
      if (tx.spinoffSymbol === null || tx.spinoffShareRatio === null || tx.spinoffBasisRetained === null) break;
      const childSymbol = normalizeSymbol(tx.spinoffSymbol);
      const childCurrent = held.get(childSymbol) ?? 0;
      held.set(childSymbol, childCurrent + roundToShareDecimals(current * tx.spinoffShareRatio));
      if (tx.spinoffBasisRetained <= 0) held.set(symbol, 0);
      break;
    }
    default:
      break;
  }
}

/**
 * Money entering the invested pool on a transaction, from the investor's side.
 *
 * This is the figure a time-weighted return has to strip out: adding money to a
 * portfolio isn't performance, and neither is taking it out. Buys are money in,
 * sales money out. A dividend paid in cash leaves the pool, so it counts as
 * money out -- which is what makes it show up as return rather than vanishing,
 * since the share price already dropped by it.
 *
 * Deposits, interest and account fees carry no symbol and never touch the
 * invested pool at all, so they are not flows here. Counting a deposit would
 * report cash sitting idle in the account as a drag on the investments.
 */
function flowFor(tx: Transaction, priceOn: (symbol: string) => number | null): number {
  if (tx.symbol === null) return 0;

  if (TRANSFER_TYPES.has(tx.type)) {
    // Shares arriving or leaving move value without moving cash, so the flow is
    // what they were worth on the day. Without this a transfer in reads as an
    // instant gain of the entire position.
    const symbol = normalizeSymbol(tx.symbol);
    const price = priceOn(symbol);
    if (price === null) return 0;
    const value = tx.quantity * price * contractMultiplier(symbol);
    return tx.type === "transfer_in" ? value : -value;
  }

  // Cash flow is signed from the account's side, so a buy reads negative there
  // and positive here: what leaves the cash balance is what enters the pool.
  return -signedCashFlow(tx);
}

/**
 * Money crossing the account's boundary on a transaction.
 *
 * The flow a time-weighted return has to strip out is the money the investor
 * put in or took out -- nothing else. Once cash is tracked alongside the
 * positions, a purchase stops qualifying: it swaps cash for securities and
 * leaves the account worth exactly what it was a moment earlier. So do sales,
 * and so does a dividend, which moves value out of the share price and into the
 * cash balance without a dollar entering or leaving.
 *
 * That leaves deposits, withdrawals, and securities carried in or out of the
 * account by a custodian transfer. Fees are deliberately not flows either: the
 * money genuinely left, and a return that quietly excused its own costs would
 * flatter every account that pays them.
 */
function externalFlowFor(tx: Transaction, priceOn: (symbol: string) => number | null): number {
  if (TRANSFER_TYPES.has(tx.type)) {
    if (tx.symbol === null) return 0;
    const symbol = normalizeSymbol(tx.symbol);
    const price = priceOn(symbol);
    if (price === null) return 0;
    const value = tx.quantity * price * contractMultiplier(symbol);
    return tx.type === "transfer_in" ? value : -value;
  }
  if (tx.type === "cash_deposit" || tx.type === "cash_withdrawal") return signedCashFlow(tx);
  return 0;
}

/**
 * The close on the given day, or the last one before it.
 *
 * Binary search rather than a walk from the front, because this is the hot
 * path of the whole series: it runs once per held symbol per day, and the
 * arrays are years of daily closes. Scanning them was quadratic in the size of
 * the window -- a five-year chart over a wide ledger spent seconds inside this
 * function alone, on the main thread, before anything could be drawn.
 *
 * Requires `points` sorted ascending by date, which is how the feed builds
 * them.
 */
function lastOnOrBefore(points: readonly PricePoint[], date: ISODate): number | null {
  let low = 0;
  let high = points.length - 1;
  let answer: number | null = null;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (points[mid].date <= date) {
      answer = points[mid].close;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return answer;
}

/**
 * How far a feed close may sit from the price the ledger paid the same day
 * before the gap is read as a change of units rather than ordinary movement.
 *
 * A fill and that day's close differ by a percent or two. Ten percent is well
 * clear of that and far under the smallest split anyone runs, so a symbol whose
 * two sources already agree is left exactly as the feed reported it.
 */
const RESCALE_THRESHOLD = 0.1;

/**
 * Per-symbol factors that restate feed history in the ledger's own units.
 *
 * The feed reports history split-adjusted -- what one of today's shares was
 * worth back then -- while the ledger holds share counts and prices as they
 * were actually traded. Multiplying one by the other prices a position by every
 * split since, in whichever direction the splits ran, and both directions were
 * badly wrong on the ledger this was written for. SCHD's three-for-one valued a
 * $2,500 purchase at $834 the day it was made; NVDA's four-for-one and
 * ten-for-one together put it at a thirty-ninth. In the other direction a $10
 * holding in SOXS -- a leveraged fund that reverse splits repeatedly to stay
 * off the floor -- priced at $2,565,000 a share and was worth $3.1M against an
 * account of $10,000, burying every other position in it.
 *
 * The correction needs no split calendar, because every transaction is already
 * an observation of what a share cost that day. Dividing the feed's close by
 * the ledger's price gives the factor between the two sets of units, and the
 * factor only moves when a split lands -- so the observations are kept as a
 * series and read piecewise, the same way prices are. A ratio near one is
 * snapped to exactly one, so nothing is rescaled on the strength of a fill
 * landing a few cents off the close.
 *
 * The residue is the stretch between the last trade before a split and the
 * first after it, where the old factor is carried until a trade reveals the new
 * one. That window is priced on the wrong side of the split, which is worth far
 * less than being wrong across the entire history.
 */
function priceScales(
  ordered: readonly Transaction[],
  histories: ReadonlyMap<string, readonly PricePoint[]>,
): Map<string, PricePoint[]> {
  const scales = new Map<string, PricePoint[]>();

  for (const tx of ordered) {
    if (tx.symbol === null || tx.price <= 0) continue;
    const symbol = normalizeSymbol(tx.symbol);
    const points = histories.get(symbol);
    if (!points || points.length === 0) continue;
    const close = lastOnOrBefore(points, tx.date);
    if (close === null || close <= 0) continue;

    const ratio = close / tx.price;
    const scale = Math.abs(ratio - 1) <= RESCALE_THRESHOLD ? 1 : ratio;
    const series = scales.get(symbol);
    if (series) series.push({ date: tx.date, close: scale });
    else scales.set(symbol, [{ date: tx.date, close: scale }]);
  }

  // A symbol that never disagreed needs no entry at all, which keeps the
  // ordinary case -- almost every symbol, every day -- to a single lookup.
  for (const [symbol, series] of scales) {
    if (series.every((point) => point.close === 1)) scales.delete(symbol);
  }

  return scales;
}

/**
 * A date early enough to sit before any ledger, used to open a piecewise series
 * whose first real breakpoint still needs a value in front of it.
 */
const BEFORE_ANY_LEDGER = "0000-01-01" as ISODate;

/**
 * How far a broker may date a split from the day the feed says it took effect
 * before the two stop describing the same event.
 *
 * Brokers post the share adjustment when it settles, which routinely lands a
 * day or two after new shares begin trading, and a weekend can stretch that
 * further. Across the ledgers this was measured on the gap ran to four days --
 * IGM's six-for-one traded from 7 March 2024 and was posted on the 11th -- so
 * a week is the working figure rather than a tight fit around the worst case
 * observed. It costs nothing to be generous: the ratios have to agree to within
 * a percent as well, and nothing legitimate puts two splits of one symbol
 * inside the same week.
 */
const SPLIT_MATCH_DAYS = 7;

/** Tolerance on a split ratio, which brokers occasionally record rounded. */
const RATIO_TOLERANCE = 0.01;

function daysBetween(a: ISODate, b: ISODate): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** The split rows the ledger itself records, per symbol. */
function ledgerSplits(ordered: readonly Transaction[]): Map<string, SplitEvent[]> {
  const bySymbol = new Map<string, SplitEvent[]>();
  for (const tx of ordered) {
    if (tx.type !== "split" || tx.symbol === null || tx.quantity <= 0) continue;
    const symbol = normalizeSymbol(tx.symbol);
    // `quantity` is the ratio on a split row, not a share count.
    const event = { date: tx.date, ratio: tx.quantity };
    const series = bySymbol.get(symbol);
    if (series) series.push(event);
    else bySymbol.set(symbol, [event]);
  }
  return bySymbol;
}

/**
 * Exact restatement factors, built from a known split calendar.
 *
 * The feed quotes every close in *today's* shares. The ledger counts shares as
 * they were held, applying each split on the day the broker posted it. So a
 * close from before a split has to be multiplied back up by every split since
 * before it can meet the share count of that day -- and that product is a
 * known, dated quantity rather than something to be inferred.
 *
 * This supersedes {@link priceScales}, which recovered the same factor by
 * dividing the feed's close by the price the ledger paid. That inference is
 * sound but it can only learn a new factor from a *trade*, so between the last
 * trade before a split and the first after it the old factor stood -- while the
 * share count had already multiplied. Both sides moved by the split and the
 * position was carried at the square of it. Alphabet's twenty-for-one on
 * 18 July 2022 was not traded again until the 22nd, and for those four days the
 * holding was worth four hundred times what it should have been; Amazon's, in
 * June, went seven weeks before the next trade. The same thing happened to IGM
 * in the Roth over 11-13 March 2024. Reading the calendar directly removes the
 * gap entirely: the factor changes on the day the split does.
 *
 * Returned in the same shape and convention as {@link priceScales} -- a
 * piecewise series read by date, where the day's price is the close divided by
 * the scale -- so both can feed one lookup.
 */
function splitScales(events: readonly SplitEvent[]): PricePoint[] {
  const ordered = [...events].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Walked backwards, because the factor for a given day is the product of
  // everything that happened *after* it, and the most recent stretch is 1.
  const series: PricePoint[] = [];
  let scale = 1;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    series.unshift({ date: ordered[i].date, close: scale });
    scale /= ordered[i].ratio;
  }
  series.unshift({ date: BEFORE_ANY_LEDGER, close: scale });
  return series;
}

/**
 * The ledger's own rows for the splits the feed reports, or null if it did not
 * record all of them.
 *
 * The factor restates prices into the units of the day, which is only the right
 * thing to meet the share count with if the ledger moved its shares on the same
 * days. A ledger that records the split does; one that silently kept a
 * pre-split share count does not, and scaling its prices would compound the
 * mismatch rather than resolve it. That ledger is better served by the
 * inference, which measures whatever units it is in fact keeping. So every
 * split the feed reports has to be matched, and the check runs per symbol --
 * one holding whose broker never posted a split says nothing about the rest.
 *
 * What comes back is the *ledger's* rows rather than the feed's, and that is
 * the point of returning them at all. The feed dates a split to the day the new
 * shares began trading; a broker posts it when it settles, a day or two later.
 * Taking the price's breakpoint from the feed and the share count's from the
 * ledger would leave the days between them priced in one set of shares and
 * counted in the other -- a one-day trough of the whole split ratio, which is
 * the same bug in miniature. Reading both from the ledger row puts the two
 * changes on the same morning, whichever morning the broker chose. The feed's
 * role is to say the split happened and what it was worth, not when the ledger
 * acted on it.
 */
function matchedSplits(
  feed: readonly SplitEvent[],
  ledger: readonly SplitEvent[],
): SplitEvent[] | null {
  const matched: SplitEvent[] = [];
  for (const event of feed) {
    const row = ledger.find(
      (candidate) =>
        daysBetween(candidate.date, event.date) <= SPLIT_MATCH_DAYS &&
        Math.abs(candidate.ratio / event.ratio - 1) <= RATIO_TOLERANCE,
    );
    if (row === undefined) return null;
    matched.push(row);
  }
  return matched;
}

/**
 * Every date the series should carry a point for: the trading days the feed
 * knows about, which is the only calendar that has prices attached.
 */
function tradingDays(
  histories: ReadonlyMap<string, readonly PricePoint[]>,
  from: ISODate,
  to: ISODate,
): ISODate[] {
  const days = new Set<ISODate>();
  for (const points of histories.values()) {
    for (const point of points) {
      if (point.date >= from && point.date <= to) days.add(point.date);
    }
  }
  return [...days].sort();
}

/**
 * The symbols a window actually needs prices for.
 *
 * Asking for every symbol the ledger ever touched is what broke this: a few
 * years of option contracts is easily a hundred dead tickers, all of them
 * needing a request the feed will never answer, and all of them competing for
 * room in a capped list that was sorted alphabetically. A position closed years
 * before the window has no bearing on it, and neither does a contract that
 * expired long ago.
 *
 * Needed means either still held going into the window, or traded during it.
 */
export function symbolsForWindow(
  transactions: readonly Transaction[],
  from: ISODate,
  to: ISODate,
  accountIds?: readonly Id[],
  /** Narrows to a facet-filtered subset of symbols -- everything else is
   *  treated as though it were never traded, so it's never fetched or priced. */
  symbols?: ReadonlySet<string>,
): string[] {
  const scopeIds = accountIds ? new Set(accountIds) : null;
  const scoped = (scopeIds ? transactions.filter((tx) => scopeIds.has(tx.accountId)) : transactions).filter(
    (tx) => symbols === undefined || (tx.symbol !== null && symbols.has(normalizeSymbol(tx.symbol))),
  );
  const ordered = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const needed = new Set<string>();
  const openingPosition = new Map<string, number>();
  const closingPosition = new Map<string, number>();

  for (const tx of ordered) {
    if (tx.date > to) break;
    if (tx.symbol === null) continue;

    if (tx.date < from) {
      // Still building the position the window opens on.
      applyToShares(openingPosition, tx);
    } else {
      // Traded inside the window, so it matters whichever way it moved.
      needed.add(normalizeSymbol(tx.symbol));
    }
    applyToShares(closingPosition, tx);
  }

  // Whatever was still on the books when the window opened has to be valued
  // through it, even if it was never traded again.
  for (const [symbol, shares] of openingPosition) {
    if (Math.abs(shares) > 1e-9) needed.add(symbol);
  }

  // Still-open positions lead, because the caller's list is a priority order
  // against a capped request and these are the ones that decide the closing
  // figure. Sorting the whole list alphabetically instead is what let a ledger
  // wide enough to overflow the cap drop every holding past the cut-off and
  // price them at the last figure paid -- the same failure the benchmarks were
  // already pulled to the front to escape.
  const stillHeld = (symbol: string) => Math.abs(closingPosition.get(symbol) ?? 0) > 1e-9;
  const all = [...needed].sort();
  return [...all.filter(stillHeld), ...all.filter((s) => !stillHeld(s))];
}

export interface SeriesOptions {
  from: ISODate;
  to: ISODate;
  /** Narrows to one or more accounts; omit for everything. */
  accountIds?: readonly Id[];
  /**
   * The feed's split calendar per symbol. Optional, and the series is still
   * built without it -- the units are then inferred from the ledger's own
   * prices, which is right except in the days around a split. See
   * {@link splitScales}.
   */
  splits?: ReadonlyMap<string, readonly SplitEvent[]>;
  /**
   * Cash the accounts in scope held before their ledgers begin. Seeds the replay
   * so a window opening mid-history inherits it, and so this series and the
   * Accounts tab's balance are built on the same footing rather than drifting.
   */
  openingCash?: number;
  /**
   * Narrows the series to only these symbols' own trades and price action --
   * a facet-filtered slice of the portfolio (only ETFs, only a theme) rather
   * than the whole account. Forces the "securities" basis unconditionally: a
   * slice has no cash balance of its own to replay.
   */
  symbols?: ReadonlySet<string>;
}

/**
 * Replays the ledger against daily closes into a time-weighted return series.
 *
 * Time-weighted rather than money-weighted because this is the figure that gets
 * compared to an index. A money-weighted return answers "how did my money do",
 * which depends on when you happened to add to the account -- so a good year
 * you didn't have much invested for counts for little. Against a benchmark that
 * is unfair in both directions: the only honest comparison strips contribution
 * timing out entirely, which is what chaining daily returns does.
 *
 * The portfolio is the account: positions plus cash. A stored cash balance is
 * only ever a snapshot, but the ledger is the history behind it -- replaying
 * its own money movements says what cash was sitting there on any past day
 * without inventing a figure. That matters beyond tidiness, because valuing
 * securities alone makes a portfolio that sold everything look like a portfolio
 * worth nothing, and the next purchase then divides a full position by the
 * float dust the sale left behind.
 *
 * A ledger that does not account for the money it spends cannot support that,
 * so it falls back to valuing positions alone. See {@link PerformanceSeries.basis}.
 */
export function buildPerformanceSeries(
  transactions: readonly Transaction[],
  histories: ReadonlyMap<string, readonly PricePoint[]>,
  options: SeriesOptions,
): PerformanceSeries {
  const { from, to, accountIds, splits, openingCash = 0, symbols } = options;
  const scopeIds = accountIds ? new Set(accountIds) : null;
  const scoped = (scopeIds ? transactions.filter((tx) => scopeIds.has(tx.accountId)) : [...transactions]).filter(
    (tx) => symbols === undefined || (tx.symbol !== null && symbols.has(normalizeSymbol(tx.symbol))),
  );
  const ordered = [...scoped].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const days = tradingDays(histories, from, to);
  const relevant = ordered.filter((tx) => tx.date <= to);
  const funding = replayableCash(relevant, openingCash);
  // A filtered slice has no cash balance of its own -- forcing "securities"
  // is what makes a buy of an included symbol count as money entering the
  // slice rather than as a transfer the (irrelevant, whole-account) cash
  // floor is expected to explain.
  const basis: "account" | "securities" = symbols !== undefined ? "securities" : funding.solvent ? "account" : "securities";
  if (days.length === 0) return { points: [], approximated: [], basis };

  /**
   * Prices the ledger itself supplies, for a symbol the feed cannot cover.
   *
   * Kept as a series rather than one figure per symbol, and read as the last
   * price traded on or before the day being valued. A single price has to be
   * the last one ever paid, which is applied backwards over the whole window --
   * so a delisted SPAC bought at $25 and sold at $10 a year later is carried at
   * $10 on the day it was bought, booking a loss on the purchase and handing it
   * back over the months that follow. Every trade the ledger holds is a real
   * observation of that day's price, and using the nearest one keeps the line
   * flat between trades instead of wrong at both ends.
   */
  const ledgerPrices = new Map<string, PricePoint[]>();
  for (const tx of ordered) {
    if (tx.symbol === null || tx.price <= 0) continue;
    const symbol = normalizeSymbol(tx.symbol);
    const series = ledgerPrices.get(symbol);
    if (series) series.push({ date: tx.date, close: tx.price });
    else ledgerPrices.set(symbol, [{ date: tx.date, close: tx.price }]);
  }

  // The feed's calendar where the ledger tracks it, the inference everywhere
  // else. Per symbol rather than all-or-nothing: a holding whose broker never
  // posted its split still gets the treatment that suits it, without costing
  // every other holding the exact answer.
  const scales = priceScales(ordered, histories);
  if (splits) {
    const posted = ledgerSplits(ordered);
    for (const [symbol, events] of splits) {
      if (events.length === 0) continue;
      const rows = matchedSplits(events, posted.get(symbol) ?? []);
      if (rows === null) continue;
      scales.set(symbol, splitScales(rows));
    }
  }

  const usedFallback = new Set<string>();
  const priceOn = (symbol: string, date: ISODate): number | null => {
    const points = histories.get(symbol);
    const close = points ? lastOnOrBefore(points, date) : null;
    if (close !== null) {
      const series = scales.get(symbol);
      if (series === undefined) return close;
      const scale = lastOnOrBefore(series, date) ?? series[0].close;
      return scale === 1 ? close : close / scale;
    }
    const series = ledgerPrices.get(symbol);
    if (series === undefined) return null;
    // Before the first trade the ledger has nothing to say, but neither is
    // there a position yet, so the earliest price stands in for that edge.
    const fallback = lastOnOrBefore(series, date) ?? series[0].close;
    usedFallback.add(symbol);
    return fallback;
  };

  const held = new Map<string, number>();
  let cash = roundToCents(openingCash + funding.floor);
  let cursor = 0;

  // Everything before the window opens is history: replay it so the window
  // starts from the position and the cash actually held, not from an empty
  // portfolio. The opening balance is the whole point of replaying it -- a
  // window that begins mid-ledger inherits both sides of what came before.
  while (cursor < ordered.length && ordered[cursor].date < from) {
    applyToShares(held, ordered[cursor]);
    cash = roundToCents(cash + signedCashFlow(ordered[cursor]));
    cursor += 1;
  }

  const valueOn = (date: ISODate): number => {
    let total = 0;
    for (const [symbol, shares] of held) {
      if (shares === 0) continue;
      const price = priceOn(symbol, date);
      if (price === null) continue;
      total += shares * price * contractMultiplier(symbol);
    }
    return basis === "account" ? total + cash : total;
  };

  const points: PerformancePoint[] = [];
  let index = 1;
  let previousValue = valueOn(days[0]);

  for (const day of days) {
    let flow = 0;
    while (cursor < ordered.length && ordered[cursor].date <= day) {
      const tx = ordered[cursor];
      const on = (symbol: string) => priceOn(symbol, day);
      flow += basis === "account" ? externalFlowFor(tx, on) : flowFor(tx, on);
      applyToShares(held, tx);
      cash = roundToCents(cash + signedCashFlow(tx));
      cursor += 1;
    }

    const value = valueOn(day);

    // The return the account earned, with the day's contributions and
    // withdrawals taken back out. A day that opened with nothing has no return
    // to measure -- money arriving is not performance -- so the index holds flat
    // rather than reporting the first deposit as an infinite gain.
    //
    // A position also cannot lose more than all of itself in a day, so a factor
    // at or below zero is a valuation failure rather than a return: the feed
    // could not price something and it fell back to the last figure paid.
    //
    // On a securities basis the base can also be merely negligible rather than
    // empty, because a ledger that sold out entirely reads as near-zero even
    // though the cash is sitting right there waiting to be redeployed. Buying
    // back in weeks later then divides a full position by the float dust the
    // sale left behind, and one such day permanently rescales every day after
    // it. Neutralising the day is a blunt guard -- it throws away whatever the
    // holdings really did -- and it is needed only because that basis cannot
    // see the cash. Tracking the cash removes the collapse at its source, so
    // the guard does not apply there: a deposit larger than the account is
    // ordinary early on, and it arrives in the value as well as the flow.
    const measurable =
      basis === "account" || Math.abs(flow) <= previousValue * FLOW_DOMINANCE;
    if (previousValue > 0 && measurable) {
      const factor = (value - flow) / previousValue;
      if (factor > 0) index *= factor;
    }

    points.push({ date: day, value, flow, index });
    previousValue = value;
  }

  // Only a fallback still propping up an open position leaves the answer
  // uncertain; one that merely coloured in a since-closed position does not.
  const approximated = [...usedFallback]
    .filter((symbol) => Math.abs(held.get(symbol) ?? 0) > 1e-9)
    .sort();

  return { points, approximated, basis };
}

/** Growth over the whole window, or null when there was nothing to measure. */
export function totalReturn(points: readonly PerformancePoint[]): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1].index;
  if (!Number.isFinite(last) || last <= 0) return null;
  return last / points[0].index - 1;
}

const DAYS_PER_YEAR = 365;

function spanYears(points: readonly PerformancePoint[]): number {
  const first = Date.parse(`${points[0].date}T00:00:00Z`);
  const last = Date.parse(`${points[points.length - 1].date}T00:00:00Z`);
  return (last - first) / 86_400_000 / DAYS_PER_YEAR;
}

/**
 * Annualized growth rate. Windows under a year are left un-annualized and
 * reported as-is: projecting a good month out to a yearly rate produces a
 * number that looks like a forecast and isn't one.
 */
export function annualizedReturn(points: readonly PerformancePoint[]): number | null {
  const total = totalReturn(points);
  if (total === null) return null;
  const years = spanYears(points);
  if (years < 1) return total;
  return Math.pow(1 + total, 1 / years) - 1;
}

export interface IndexedPoint {
  date: ISODate;
  index: number;
}

/**
 * A price history rebased so it starts at 1, which is what lets a benchmark sit
 * on the same axis as the portfolio. Two series at different price levels can
 * only be compared once both are expressed as growth.
 */
export function indexPrices(points: readonly PricePoint[], from: ISODate, to: ISODate): IndexedPoint[] {
  const window = points.filter((p) => p.date >= from && p.date <= to);
  const base = window[0]?.close;
  if (!base || base <= 0) return [];
  return window.map((p) => ({ date: p.date, index: p.close / base }));
}

/** Growth of a rebased series across the window. */
export function indexedReturn(points: readonly IndexedPoint[]): number | null {
  if (points.length < 2) return null;
  return points[points.length - 1].index / points[0].index - 1;
}

/**
 * The oldest date any of these histories reaches back to.
 *
 * What "covered" is measured against. Checking instead whether a trading day
 * lands on the window's own first date reports a window opening on New Year's
 * Day or a Sunday as having no data at all, which is how YTD used to read as a
 * dash for the first days of every January.
 */
export function earliestCoveredDate(
  histories: ReadonlyMap<string, readonly PricePoint[]>,
): ISODate | null {
  let earliest: ISODate | null = null;
  for (const points of histories.values()) {
    const first = points[0]?.date;
    if (first !== undefined && (earliest === null || first < earliest)) earliest = first;
  }
  return earliest;
}

/**
 * A window's return read off an already-built series.
 *
 * A time-weighted index is a running product of daily factors that each depend
 * only on that day's own value and the day before it, never on where the series
 * happened to start accumulating. So the ratio between any two of its points
 * reproduces exactly what building a fresh series for that narrower window
 * would report -- which is what lets a handful of windows be read off one build
 * instead of costing one apiece.
 *
 * `historyStart` is what the loaded prices actually reach back to. A window
 * opening before that reports null rather than a figure quietly measured over
 * a shorter span than its own label claims.
 */
export function windowReturn(
  points: readonly PerformancePoint[],
  from: ISODate,
  to: ISODate,
  historyStart: ISODate | null,
): { total: number | null; annualized: number | null } {
  const windowed = points.filter((p) => p.date >= from && p.date <= to);
  if (windowed.length < 2 || historyStart === null || from < historyStart) {
    return { total: null, annualized: null };
  }
  return { total: totalReturn(windowed), annualized: annualizedReturn(windowed) };
}
