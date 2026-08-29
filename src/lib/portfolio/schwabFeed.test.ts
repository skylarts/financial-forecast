import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSchwabFeedQueue, schwabProvider } from "./schwabFeed";

// The feed is exercised against recorded response shapes rather than the live
// API: the live one needs a brokerage login that expires weekly, which is
// exactly the thing a test must not depend on.
vi.mock("./schwabAuth", () => ({
  schwabConfigured: () => true,
  schwabAccessToken: async () => "test-access-token",
}));

interface Call {
  url: URL;
}

let calls: Call[] = [];
let respond: (url: URL) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  resetSchwabFeedQueue();
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({ url });
    const { status, body } = respond(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One equity entry in the shape Schwab's /quotes returns. */
function equity(symbol: string, last: number, close: number, description = "") {
  return {
    symbol,
    assetMainType: "EQUITY",
    reference: { description },
    quote: { lastPrice: last, closePrice: close, tradeTime: Date.parse("2026-08-27T20:00:00Z") },
  };
}

describe("schwab quotes", () => {
  it("takes the previous close from the field that states it outright", async () => {
    // The whole reason quotes prefer this feed: `closePrice` *is* the prior
    // session's close. The public feed has no such field, and recovering the
    // same number there means walking a daily series backwards.
    respond = () => ({ status: 200, body: { AAPL: equity("AAPL", 231.5, 228.4, "Apple Inc") } });

    const outcome = await schwabProvider.quote("AAPL");
    expect(outcome).toEqual({
      status: "ok",
      value: {
        symbol: "AAPL",
        price: 231.5,
        date: "2026-08-27",
        name: "Apple Inc",
        previousClose: 228.4,
        source: "schwab",
      },
    });
  });

  it("coalesces symbols asked for in the same tick into one request", async () => {
    respond = () => ({
      status: 200,
      body: { AAPL: equity("AAPL", 231.5, 228.4), MSFT: equity("MSFT", 501.2, 498.0) },
    });

    const [aapl, msft] = await Promise.all([
      schwabProvider.quote("AAPL"),
      schwabProvider.quote("MSFT"),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("symbols")).toBe("AAPL,MSFT");
    expect(aapl.status).toBe("ok");
    expect(msft.status).toBe("ok");
  });

  it("sends Schwab's spelling and reads the response back under it", async () => {
    respond = (url) => {
      expect(url.searchParams.get("symbols")).toBe("$SPX");
      return { status: 200, body: { $SPX: equity("$SPX", 6400, 6380, "S&P 500 Index") } };
    };

    const outcome = await schwabProvider.quote("^GSPC");
    expect(outcome.status).toBe("ok");
    expect(outcome.status === "ok" && outcome.value.symbol).toBe("^GSPC");
  });

  it("prices a fund off its NAV when there is no last trade", async () => {
    respond = () => ({
      status: 200,
      body: {
        VFIAX: {
          symbol: "VFIAX",
          assetMainType: "MUTUAL_FUND",
          reference: { description: "Vanguard 500 Index Admiral" },
          quote: { nAV: 512.33, closePrice: 509.1, tradeTime: Date.parse("2026-08-27T20:00:00Z") },
        },
      },
    });

    const outcome = await schwabProvider.quote("VFIAX");
    expect(outcome.status === "ok" && outcome.value.price).toBe(512.33);
  });

  it("shrugs at a symbol missing from the response rather than failing", async () => {
    // A symbol Schwab does not carry must fall through to the other feed, not
    // register as an outage that would suppress the ticker everywhere.
    respond = () => ({ status: 200, body: {} });
    expect(await schwabProvider.quote("VFIAX")).toEqual({ status: "unknown_symbol" });
  });

  it("calls a bad response a failure, which keeps a good ticker alive", async () => {
    respond = () => ({ status: 500, body: {} });
    expect(await schwabProvider.quote("AAPL")).toEqual({ status: "fetch_failed" });
  });
});

describe("schwab history", () => {
  it("maps the app's range onto Schwab's period vocabulary", async () => {
    respond = (url) => {
      expect(url.searchParams.get("periodType")).toBe("year");
      expect(url.searchParams.get("period")).toBe("10");
      expect(url.searchParams.get("frequencyType")).toBe("daily");
      return {
        status: 200,
        body: { candles: [{ close: 100, datetime: Date.parse("2026-08-26T20:00:00Z") }] },
      };
    };

    const outcome = await schwabProvider.history("AAPL", "10y");
    expect(outcome.status).toBe("ok");
  });

  it("reads candle timestamps as milliseconds, not seconds", async () => {
    // The two feeds differ here and the failure is silent: seconds read as
    // milliseconds date every close to 1970.
    respond = () => ({
      status: 200,
      body: {
        candles: [
          { close: 100, datetime: Date.parse("2026-08-25T20:00:00Z") },
          { close: 101, datetime: Date.parse("2026-08-26T20:00:00Z") },
        ],
      },
    });

    const outcome = await schwabProvider.history("AAPL", "1y");
    expect(outcome.status === "ok" && outcome.value.points).toEqual([
      { date: "2026-08-25", close: 100 },
      { date: "2026-08-26", close: 101 },
    ]);
  });

  it("admits it was never told about splits", async () => {
    // The reason this feed does not lead on history. Schwab adjusts the closes
    // for splits and never reports one, so an empty list here is silence --
    // reporting it as a confident "no splits" is what would let a pre-split
    // close be read as the price the ledger's own shares traded at.
    respond = () => ({
      status: 200,
      body: { candles: [{ close: 100, datetime: Date.parse("2026-08-26T20:00:00Z") }] },
    });

    const outcome = await schwabProvider.history("AAPL", "1y");
    expect(outcome.status === "ok" && outcome.value.splits).toEqual([]);
    expect(outcome.status === "ok" && outcome.value.splitsKnown).toBe(false);
  });

  it("treats an empty series as nothing to say, so the other feed is asked", async () => {
    respond = () => ({ status: 200, body: { candles: [], empty: true } });
    expect(await schwabProvider.history("AAPL", "1y")).toEqual({ status: "unknown_symbol" });
  });
});
