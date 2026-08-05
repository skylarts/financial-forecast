import {
  formatOptionSymbol,
  isExpiredOption,
  normalizeSymbol,
  parseOptionSymbol,
  type AssetClass,
} from "@/domain/portfolio";
import type { ISODate } from "@/domain";
import { fetchQuoteResult } from "@/lib/portfolio/priceFeed";
import { confirmContract, resolveProfile } from "@/lib/portfolio/symbolLookup";

/**
 * How a symbol came back.
 *
 * "unlisted" is deliberately separate from "unknown": a contract the exchange
 * never listed is a strike or expiry off, while an unrecognised ticker is a
 * different kind of typo, and the fix for each is different.
 */
type Status = "ok" | "unlisted" | "expired" | "unknown" | "unavailable";

interface Verdict {
  /** What was typed, rewritten into the form everything else stores. */
  symbol: string;
  kind: "ticker" | "contract";
  /** Human-readable: a company name, or a contract as a statement reads it. */
  label: string;
  status: Status;
  name: string;
  assetClass: AssetClass | null;
  /** Why that asset class, in one phrase. */
  basis: string;
  price: number | null;
  priceDate: string | null;
}

export async function GET(request: Request) {
  const raw = (new URL(request.url).searchParams.get("symbol") ?? "").trim();
  if (!raw) return Response.json({ verdict: null });

  const symbol = normalizeSymbol(raw);
  const contract = parseOptionSymbol(symbol);

  if (contract) {
    const label = formatOptionSymbol(symbol);
    const today = new Date().toISOString().slice(0, 10) as ISODate;
    const profile = await resolveProfile(symbol);
    const base: Verdict = {
      symbol,
      kind: "contract",
      label,
      status: "ok",
      name: profile.name,
      assetClass: profile.assetClass,
      basis: profile.basis,
      price: null,
      priceDate: null,
    };

    // An expired contract is gone from every feed, so there is nothing to
    // confirm against -- but the symbol still parses, and saying so is more
    // useful than reporting it as a bad ticker.
    if (isExpiredOption(symbol, today)) {
      return Response.json({ verdict: { ...base, status: "expired" } });
    }

    const listed = await confirmContract(symbol);
    if (!listed) return Response.json({ verdict: { ...base, status: "unlisted" } });

    const { quote } = await fetchQuoteResult(symbol);
    return Response.json({
      verdict: {
        ...base,
        status: quote ? "ok" : "unavailable",
        price: quote?.price ?? null,
        priceDate: quote?.date ?? null,
      },
    });
  }

  const profile = await resolveProfile(symbol);
  if (!profile.found) {
    return Response.json({
      verdict: {
        symbol,
        kind: "ticker",
        label: symbol,
        status: "unknown",
        name: "",
        assetClass: null,
        basis: "",
        price: null,
        priceDate: null,
      } satisfies Verdict,
    });
  }

  const { quote } = await fetchQuoteResult(symbol);
  return Response.json({
    verdict: {
      symbol,
      kind: "ticker",
      label: profile.name || symbol,
      status: quote ? "ok" : "unavailable",
      name: profile.name,
      assetClass: profile.assetClass,
      basis: profile.basis,
      price: quote?.price ?? null,
      priceDate: quote?.date ?? null,
    } satisfies Verdict,
  });
}
