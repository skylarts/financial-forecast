import { describe, expect, it } from "vitest";
import { nextHiddenAccountIds, nextHiddenAfterGroupToggle } from "./NetWorthChart";

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

describe("nextHiddenAfterGroupToggle", () => {
  it("shows the whole group when any of it is hidden", () => {
    const result = nextHiddenAfterGroupToggle(new Set(["a", "c"]), ["a", "b"]);
    expect(result).toEqual(new Set(["c"]));
  });

  it("hides the group when all of it is showing", () => {
    const result = nextHiddenAfterGroupToggle(new Set(["c"]), ["a", "b"]);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("never touches accounts outside the group", () => {
    const result = nextHiddenAfterGroupToggle(new Set(["x", "y"]), ["a"]);
    expect(result.has("x")).toBe(true);
    expect(result.has("y")).toBe(true);
  });

  it("picks the group back out after Hide all, in one click", () => {
    const result = nextHiddenAfterGroupToggle(new Set(["a", "b", "c", "d"]), ["a", "b"]);
    expect(result).toEqual(new Set(["c", "d"]));
  });
});
