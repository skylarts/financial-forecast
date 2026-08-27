import { fetchHistories, HISTORY_CACHE_CONTROL } from "@/lib/portfolio/priceFeed";
import { HISTORY_BATCH_LIMIT } from "@/lib/portfolio/historyBatch";

const ALLOWED_RANGES = new Set(["1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"]);
const DEFAULT_RANGE = "5y";

/**
 * A caution for callers: every range up to 10y comes back as daily closes, but
 * "max" does not -- the upstream feed downsamples it to month-end prices and
 * ignores the daily interval it was asked for. Anything computing short-window
 * returns from the response wants 10y, not max.
 */

/**
 * Ceiling on symbols per request, so one call can't be turned into an
 * unbounded sweep of the upstream feed.
 *
 * Anything over it is reported back as `skipped` rather than dropped in
 * silence. Silent truncation is what made this endpoint lie: the list arrived
 * alphabetically sorted, so a ledger with enough option contracts pushed every
 * late-alphabet ticker -- SPY, VTI, VOO -- past the cut, and the page rendered
 * as though the feed simply had nothing for them.
 */
const MAX_SYMBOLS = HISTORY_BATCH_LIMIT;

/**
 * Daily closes for many symbols at once.
 *
 * A performance series needs history for every symbol ever held in the window,
 * not just the ones still open, which on a real ledger is dozens of requests.
 * Firing them from the browser one at a time is what rate-limits the feed into
 * returning nothing. `fetchHistories` holds the fan-out to a few requests at a
 * time and caches for twelve hours, so routing them through here is both faster
 * and gentler than the client doing it itself.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requestedRange = params.get("range") ?? DEFAULT_RANGE;
  const range = ALLOWED_RANGES.has(requestedRange) ? requestedRange : DEFAULT_RANGE;

  const requested = [
    ...new Set(
      (params.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];

  // Order is the caller's priority order, not alphabetical: whatever it listed
  // first is what survives the cap.
  const symbols = requested.slice(0, MAX_SYMBOLS);
  const skipped = requested.slice(MAX_SYMBOLS);

  if (symbols.length === 0) {
    return Response.json(
      { histories: {}, splits: {}, skipped },
      { headers: { "Cache-Control": HISTORY_CACHE_CONTROL } },
    );
  }

  const results = await fetchHistories(symbols, range);

  // Ranges are tiered so neighbouring windows share one cached upstream fetch,
  // which means a three-year chart is answered out of a ten-year pull and two
  // thirds of what comes back predates anything it will draw. The upstream
  // fetch stays keyed by range -- switching windows still reuses it -- and only
  // the reply is cut down, because sending closes the caller cannot plot costs
  // it a download and a parse of tens of megabytes before the first pixel.
  const from = params.get("from");
  const trim = (points: { date: string; close: number }[]) => {
    if (!from) return points;
    const first = points.findIndex((point) => point.date >= from);
    if (first === -1) return points.slice(-1);
    // One close from before the window comes too: a position is valued from
    // the last price on or before each day, and the first day of the window
    // usually has to reach back past it.
    return points.slice(Math.max(0, first - 1));
  };

  const histories: Record<string, { date: string; close: number }[]> = {};
  const splits: Record<string, { date: string; ratio: number }[]> = {};
  for (const [symbol, result] of results) {
    // A symbol the feed has nothing for is omitted rather than sent as an empty
    // array, so the caller can tell "no history" apart from "no data yet".
    if (result.points.length > 0) histories[symbol] = trim(result.points);
    // Splits are deliberately *not* trimmed to the window. A split after the
    // window still sets the units every close inside it is quoted in, so
    // dropping it would restate the whole window by the wrong factor.
    if (result.splits.length > 0) splits[symbol] = result.splits;
  }

  return Response.json(
    { histories, splits, skipped },
    { headers: { "Cache-Control": HISTORY_CACHE_CONTROL } },
  );
}
