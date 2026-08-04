import { fetchHistory } from "@/lib/portfolio/priceFeed";

const ALLOWED_RANGES = new Set(["1mo", "6mo", "1y", "5y", "10y", "max"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const symbol = (params.get("symbol") ?? "").trim().toUpperCase();
  const requested = params.get("range") ?? "10y";
  const range = ALLOWED_RANGES.has(requested) ? requested : "10y";

  if (!symbol) return Response.json({ symbol: "", points: [] });
  return Response.json(await fetchHistory(symbol, range));
}
