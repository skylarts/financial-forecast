import { describe, expect, test } from "vitest";
import { coversRequest, type CachedHistoryEntry } from "./priceHistoryCache";

function entry(overrides: Partial<CachedHistoryEntry> = {}): CachedHistoryEntry {
  return {
    points: [],
    splits: [],
    from: "2020-01-01" as never,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("coversRequest", () => {
  test("covers a request starting later than the cached entry", () => {
    expect(coversRequest(entry({ from: "2020-01-01" as never }), "2022-01-01" as never)).toBe(true);
  });

  test("covers a request starting on the same day the entry reaches back to", () => {
    expect(coversRequest(entry({ from: "2020-01-01" as never }), "2020-01-01" as never)).toBe(true);
  });

  test("does not cover a request starting earlier than the cached entry", () => {
    expect(coversRequest(entry({ from: "2022-01-01" as never }), "2020-01-01" as never)).toBe(false);
  });

  test("does not cover a request once the entry has aged past the TTL", () => {
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const now = Date.now();
    expect(
      coversRequest(entry({ from: "2020-01-01" as never, fetchedAt: now - TWELVE_HOURS_MS - 1 }), "2022-01-01" as never, now),
    ).toBe(false);
  });

  test("covers a request just inside the TTL", () => {
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    const now = Date.now();
    expect(
      coversRequest(entry({ from: "2020-01-01" as never, fetchedAt: now - TWELVE_HOURS_MS + 1 }), "2022-01-01" as never, now),
    ).toBe(true);
  });
});
