import { describe, expect, it } from "vitest";
import {
  firstAnswer,
  isValidSymbol,
  type MarketDataProvider,
  type ProviderOutcome,
} from "./marketDataProvider";

type Answer<T> = ProviderOutcome<T> | "throw";

/** A feed that always answers the same way, recording whether it was asked. */
function feed(name: string, answer: Answer<string>, configured = true) {
  const asked: string[] = [];
  const provider: MarketDataProvider = {
    name,
    configured: () => configured,
    quote: async (symbol) => {
      asked.push(symbol);
      if (answer === "throw") throw new Error("upstream exploded");
      return answer as ProviderOutcome<never>;
    },
    history: async () => ({ status: "fetch_failed" }),
  };
  return { provider, asked };
}

const ok: ProviderOutcome<string> = { status: "ok", value: "priced" };
const unknown: ProviderOutcome<string> = { status: "unknown_symbol" };
const failed: ProviderOutcome<string> = { status: "fetch_failed" };

const ask = (providers: MarketDataProvider[]) =>
  firstAnswer(providers, (p) => p.quote("AAPL") as Promise<ProviderOutcome<string>>);

describe("firstAnswer", () => {
  it("takes the first feed's answer and never asks the next", async () => {
    const first = feed("first", ok);
    const second = feed("second", ok);

    expect(await ask([first.provider, second.provider])).toEqual(ok);
    expect(second.asked).toEqual([]);
  });

  it("skips a feed that isn't configured without calling it", async () => {
    const off = feed("off", ok, false);
    const on = feed("on", ok);

    expect(await ask([off.provider, on.provider])).toEqual(ok);
    expect(off.asked).toEqual([]);
    expect(on.asked).toEqual(["AAPL"]);
  });

  it("falls through a shrug -- the feeds disagree about what exists", async () => {
    // The case this exists for: Schwab has never heard of ^GSPC, which is a
    // real index the other feed prices happily. Letting the first shrug end
    // the search is how a valid holding starts rendering as a typo.
    const first = feed("first", unknown);
    const second = feed("second", ok);

    expect(await ask([first.provider, second.provider])).toEqual(ok);
  });

  it("reports unknown only when every feed said so", async () => {
    expect(await ask([feed("a", unknown).provider, feed("b", unknown).provider])).toEqual(unknown);
  });

  it("lets a transient failure outrank a shrug", async () => {
    // One feed down and the other shrugging is "couldn't price it, try again",
    // not "your ticker is wrong" -- the latter would strand a good symbol.
    expect(await ask([feed("a", unknown).provider, feed("b", failed).provider])).toEqual(failed);
    expect(await ask([feed("a", failed).provider, feed("b", unknown).provider])).toEqual(failed);
  });

  it("treats a feed that throws as a failure of that feed alone", async () => {
    const boom = feed("boom", "throw");
    const good = feed("good", ok);

    expect(await ask([boom.provider, good.provider])).toEqual(ok);
  });

  it("calls it a failure when nothing is configured at all", async () => {
    expect(await ask([feed("off", ok, false).provider])).toEqual(failed);
  });
});

describe("isValidSymbol", () => {
  it("accepts tickers, indexes, and full-length option contracts", () => {
    expect(isValidSymbol("AAPL")).toBe(true);
    expect(isValidSymbol("BRK-B")).toBe(true);
    expect(isValidSymbol("^GSPC")).toBe(true);
    expect(isValidSymbol("KLAR260508C00015000")).toBe(true);
  });

  it("rejects anything that could not be a ticker", () => {
    expect(isValidSymbol("")).toBe(false);
    expect(isValidSymbol("AAPL AAPL")).toBe(false);
    expect(isValidSymbol("../etc/passwd")).toBe(false);
    expect(isValidSymbol("A".repeat(22))).toBe(false);
  });
});
