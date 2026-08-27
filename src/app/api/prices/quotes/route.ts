import { fetchQuotes, QUOTE_CACHE_CONTROL } from "@/lib/portfolio/priceFeed";

/** Guards against one request fanning out into hundreds of upstream fetches. */
const MAX_SYMBOLS = 60;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbols") ?? "";
  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_SYMBOLS);

  const results = await fetchQuotes(symbols);

  const quotes: Record<
    string,
    { price: number; date: string; name: string; previousClose: number | null; stale?: boolean }
  > = {};
  /** Symbols the feed genuinely doesn't know -- a ticker to fix or price by hand. */
  const unknown: string[] = [];
  /** Symbols whose fetch failed. Transient: worth another try, not a bad ticker. */
  const unavailable: string[] = [];

  for (const symbol of symbols) {
    const result = results.get(symbol);
    if (result?.quote) {
      const { price, date, name, previousClose, stale } = result.quote;
      quotes[result.quote.symbol] = stale
        ? { price, date, name, previousClose, stale }
        : { price, date, name, previousClose };
    } else if (result?.failure === "unknown_symbol") {
      unknown.push(symbol);
    } else {
      unavailable.push(symbol);
    }
  }

  return Response.json(
    {
      quotes,
      unknown,
      unavailable,
      /** Everything unpriced, for callers that don't care why. */
      missing: [...unknown, ...unavailable],
    },
    { headers: { "Cache-Control": QUOTE_CACHE_CONTROL } },
  );
}
