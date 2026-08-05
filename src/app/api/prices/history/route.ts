import { fetchHistory } from "@/lib/portfolio/priceFeed";

/**
 * Ranges the upstream feed understands. Anything outside this list is an
 * interpolation into an outbound URL, so it is rejected rather than escaped.
 */
const ALLOWED_RANGES = new Set(["1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"]);
const DEFAULT_RANGE = "1y";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  const requested = params.get("range") ?? DEFAULT_RANGE;
  const range = ALLOWED_RANGES.has(requested) ? requested : DEFAULT_RANGE;

  if (!symbol) return Response.json({ symbol: "", points: [] });
  return Response.json(await fetchHistory(symbol, range));
}
