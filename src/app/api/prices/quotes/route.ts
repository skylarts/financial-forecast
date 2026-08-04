import { fetchQuote } from "@/lib/portfolio/priceFeed";

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

  const results = await Promise.all(symbols.map(fetchQuote));
  const quotes: Record<string, { price: number; date: string; name: string }> = {};
  for (const quote of results) {
    if (quote) quotes[quote.symbol] = { price: quote.price, date: quote.date, name: quote.name };
  }

  return Response.json({ quotes, missing: symbols.filter((s) => !quotes[s]) });
}
