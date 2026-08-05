import { fetchHistory } from "@/lib/portfolio/priceFeed";

const ALLOWED_RANGES = new Set(["1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"]);
const DEFAULT_RANGE = "5y";

/**
 * A caution for callers: every range up to 10y comes back as daily closes, but
 * "max" does not -- the upstream feed downsamples it to month-end prices and
 * ignores the daily interval it was asked for. Anything computing short-window
 * returns from the response wants 10y, not max.
 */

/**
 * Enough symbols for a real portfolio plus its benchmarks, few enough that one
 * request can't be turned into an unbounded fan-out at the upstream feed.
 */
const MAX_SYMBOLS = 60;

/**
 * Daily closes for many symbols at once.
 *
 * A performance series needs history for every symbol ever held in the window,
 * not just the ones still open, which on a real ledger is dozens of requests.
 * Firing them from the browser one at a time is what rate-limits the feed into
 * returning nothing; the fetch layer already batches with a bounded fan-out and
 * caches for twelve hours, so routing them through here is both faster and
 * gentler than the client doing it itself.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const requested = params.get("range") ?? DEFAULT_RANGE;
  const range = ALLOWED_RANGES.has(requested) ? requested : DEFAULT_RANGE;

  const symbols = [
    ...new Set(
      (params.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_SYMBOLS);

  if (symbols.length === 0) return Response.json({ histories: {} });

  const results = await Promise.all(symbols.map((symbol) => fetchHistory(symbol, range)));

  const histories: Record<string, { date: string; close: number }[]> = {};
  for (const result of results) {
    // A symbol the feed has nothing for is omitted rather than sent as an empty
    // array, so the caller can tell "no history" apart from "no data yet".
    if (result.points.length > 0) histories[result.symbol] = result.points;
  }

  return Response.json({ histories });
}
