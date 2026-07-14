import { describe, expect, it } from "vitest";
import { nextHiddenAccountIds } from "./NetWorthChart";

describe("nextHiddenAccountIds", () => {
  it("hides all accounts when some are visible", () => {
    const result = nextHiddenAccountIds(new Set(["a"]), ["a", "b", "c"]);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("shows all accounts when all are hidden", () => {
    const result = nextHiddenAccountIds(new Set(["a", "b", "c"]), ["a", "b", "c"]);
    expect(result).toEqual(new Set());
  });

  it("hides all when nothing is hidden", () => {
    const result = nextHiddenAccountIds(new Set(), ["a", "b"]);
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("handles empty account list", () => {
    const result = nextHiddenAccountIds(new Set(), []);
    expect(result).toEqual(new Set());
  });
});
