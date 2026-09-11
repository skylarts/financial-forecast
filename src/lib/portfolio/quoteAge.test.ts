import { describe, expect, it } from "vitest";
import { isStaleQuote, lastCompletedTradingDay, quoteAgeDays } from "./quoteAge";

describe("lastCompletedTradingDay", () => {
  it("is yesterday on a midweek day", () => {
    // 2026-09-10 is a Thursday.
    expect(lastCompletedTradingDay("2026-09-10")).toBe("2026-09-09");
  });

  it("is Friday on Saturday, Sunday and Monday", () => {
    expect(lastCompletedTradingDay("2026-09-12")).toBe("2026-09-11"); // Saturday
    expect(lastCompletedTradingDay("2026-09-13")).toBe("2026-09-11"); // Sunday
    expect(lastCompletedTradingDay("2026-09-14")).toBe("2026-09-11"); // Monday
  });
});

describe("isStaleQuote", () => {
  it("calls yesterday's close current on a weekday, before or after today's close", () => {
    expect(isStaleQuote("2026-09-10", "2026-09-11")).toBe(false);
    expect(isStaleQuote("2026-09-11", "2026-09-11")).toBe(false);
  });

  it("calls the day before yesterday stale on a weekday", () => {
    expect(isStaleQuote("2026-09-09", "2026-09-11")).toBe(true);
  });

  it("calls Friday's close current on Sunday and Monday", () => {
    expect(isStaleQuote("2026-09-11", "2026-09-13")).toBe(false);
    expect(isStaleQuote("2026-09-11", "2026-09-14")).toBe(false);
  });

  it("calls Thursday's close stale on Sunday", () => {
    expect(isStaleQuote("2026-09-10", "2026-09-13")).toBe(true);
  });

  it("never calls an undated price stale", () => {
    expect(isStaleQuote("", "2026-09-10")).toBe(false);
    expect(isStaleQuote(null, "2026-09-10")).toBe(false);
  });
});

describe("quoteAgeDays", () => {
  it("counts calendar days", () => {
    expect(quoteAgeDays("2026-09-07", "2026-09-10")).toBe(3);
  });
});
