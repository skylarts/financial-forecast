import { searchSymbols } from "@/lib/portfolio/symbolLookup";

/** Enough matches to recognise the right one, few enough to scan at a glance. */
const LIMIT = 8;

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();

  // A single character matches most of the market; waiting for the second one
  // costs nothing and saves the feed a request per keystroke.
  if (query.length < 2) return Response.json({ matches: [] });

  return Response.json({ matches: await searchSymbols(query, LIMIT) });
}
