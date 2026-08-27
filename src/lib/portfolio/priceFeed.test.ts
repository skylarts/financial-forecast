import { describe, expect, it } from "vitest";
import { priorSessionClose, type ChartResult } from "./priceFeed";

/** Epoch seconds for a US session's open on the given day. */
const at = (day: string) => Math.floor(Date.parse(`${day}T13:30:00Z`) / 1000);
const close4pm = (day: string) => Math.floor(Date.parse(`${day}T20:00:00Z`) / 1000);

function chart(
  bars: [day: string, close: number | null][],
  marketTime: number,
  meta: Partial<ChartResult["meta"]> = {},
): ChartResult {
  return {
    meta: { regularMarketTime: marketTime, ...meta },
    timestamp: bars.map(([day]) => at(day)),
    indicators: { quote: [{ close: bars.map(([, c]) => c) }] },
  };
}

describe("priorSessionClose", () => {
  it("takes the close before the latest session, not the one before the range", () => {
    // The shape of a real 5d quote: ORR on 2026-08-26. `chartPreviousClose`
    // here is the close before 08-20, which is what made a five-day move
    // print as the day's.
    const result = chart(
      [
        ["2026-08-20", 38.17],
        ["2026-08-21", 38.69],
        ["2026-08-24", 38.882],
        ["2026-08-25", 39.11],
        ["2026-08-26", 38.981],
      ],
      close4pm("2026-08-26"),
      { chartPreviousClose: 37.825 },
    );
    expect(priorSessionClose(result)).toBe(39.11);
  });

  it("compares against yesterday while today's bar is still open", () => {
    const result = chart(
      [
        ["2026-08-25", 200.47],
        ["2026-08-26", 201.27],
        ["2026-08-27", 203.5],
      ],
      // Midday, so the last bar is today and its close is the live price.
      Math.floor(Date.parse("2026-08-27T17:12:00Z") / 1000),
      { chartPreviousClose: 197.81 },
    );
    expect(priorSessionClose(result)).toBe(201.27);
  });

  it("skips bars the feed left empty", () => {
    const result = chart(
      [
        ["2026-08-24", 10],
        ["2026-08-25", null],
        ["2026-08-26", 12],
      ],
      close4pm("2026-08-26"),
    );
    expect(priorSessionClose(result)).toBe(10);
  });

  it("falls back to the plain quote field when nothing precedes the session", () => {
    const result = chart([["2026-08-26", 12]], close4pm("2026-08-26"), { previousClose: 11 });
    expect(priorSessionClose(result)).toBe(11);
  });

  it("reports nothing rather than measuring against the wrong day", () => {
    // A symbol listed inside the window: one bar, and only the range's own
    // prior close on offer -- which is not this symbol's previous session.
    const result = chart([["2026-08-26", 12]], close4pm("2026-08-26"), {
      chartPreviousClose: 9,
    });
    expect(priorSessionClose(result)).toBeNull();
  });
});
