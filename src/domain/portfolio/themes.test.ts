import { describe, expect, it } from "vitest";
import { allThemes, normalizeThemeTag, normalizeThemes } from "./themes";

describe("normalizeThemeTag", () => {
  it("trims and collapses inner whitespace", () => {
    expect(normalizeThemeTag("  Dividend   growth  ")).toBe("Dividend growth");
  });
});

describe("normalizeThemes", () => {
  it("dedupes case-insensitively, keeping the first spelling seen", () => {
    expect(normalizeThemes(["AI", "ai", " Ai ", "Energy"])).toEqual(["AI", "Energy"]);
  });

  it("drops blank entries", () => {
    expect(normalizeThemes(["AI", "  ", ""])).toEqual(["AI"]);
  });
});

describe("allThemes", () => {
  it("collects every distinct tag across securities, alphabetically", () => {
    expect(allThemes([["AI", "Core"], ["Energy"], ["ai"]])).toEqual(["AI", "Core", "Energy"]);
  });

  it("returns nothing for an empty portfolio", () => {
    expect(allThemes([])).toEqual([]);
  });
});
