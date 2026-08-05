import { normalizeSymbol } from "@/domain/portfolio";
import { resolveProfiles } from "@/lib/portfolio/symbolLookup";

/** Guards against one request fanning out into hundreds of upstream lookups. */
const MAX_SYMBOLS = 60;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbols") ?? "";
  const symbols = [
    ...new Set(
      raw
        .split(",")
        .map((s) => normalizeSymbol(s))
        .filter(Boolean),
    ),
  ].slice(0, MAX_SYMBOLS);

  const profiles = await resolveProfiles(symbols);
  return Response.json({ profiles });
}
