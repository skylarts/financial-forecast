import { fetchDividends } from "@/lib/portfolio/priceFeed";

const ALLOWED_RANGES = new Set(["1y", "2y", "5y", "10y", "max"]);

/**
 * Ten years by default, and it is the sensible ceiling too: this is the only
 * endpoint where "max" is safe to allow, since dividend events carry their own
 * dates and are not downsampled the way daily closes are.
 */
const DEFAULT_RANGE = "10y";

const MAX_SYMBOLS = 60;

/** Declared dividends per symbol, as ex-date and dollars per share. */
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

  if (symbols.length === 0) return Response.json({ dividends: {} });

  const results = await Promise.all(
    symbols.map(async (symbol) => [symbol, await fetchDividends(symbol, range)] as const),
  );

  const dividends: Record<string, { date: string; amount: number }[]> = {};
  for (const [symbol, events] of results) {
    if (events.length > 0) dividends[symbol] = events;
  }

  return Response.json({ dividends });
}
