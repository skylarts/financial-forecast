import { fetchDividendsFor } from "@/lib/portfolio/priceFeed";

const ALLOWED_RANGES = new Set(["1y", "2y", "5y", "10y", "max"]);

/**
 * Ten years by default, and it is the sensible ceiling too: this is the only
 * endpoint where "max" is safe to allow, since dividend events carry their own
 * dates and are not downsampled the way daily closes are.
 */
const DEFAULT_RANGE = "10y";

const MAX_SYMBOLS = 120;

/** Declared dividends per symbol, as ex-date and dollars per share. */
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

  const symbols = requested.slice(0, MAX_SYMBOLS);
  const skipped = requested.slice(MAX_SYMBOLS);

  if (symbols.length === 0) return Response.json({ dividends: {}, skipped });

  const results = await fetchDividendsFor(symbols, range);

  const dividends: Record<string, { date: string; amount: number }[]> = {};
  for (const [symbol, events] of results) {
    if (events.length > 0) dividends[symbol] = events;
  }

  return Response.json({ dividends, skipped });
}
