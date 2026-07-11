import { describe, it, expect } from "vitest";
import { rmdDivisor, RMD_START_AGE } from "./rmd";

describe("rmdDivisor", () => {
  it("is null below the RMD start age", () => {
    expect(rmdDivisor(RMD_START_AGE - 1)).toBeNull();
  });
  it("matches the known divisor at exactly 73", () => {
    expect(rmdDivisor(73)).toBe(26.5);
  });
  it("clamps beyond the table's max age", () => {
    expect(rmdDivisor(150)).toBe(rmdDivisor(120));
  });
});
