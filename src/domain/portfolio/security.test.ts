import { describe, expect, it } from "vitest";
import { resolveExposures } from "./security";

describe("resolveExposures", () => {
  it("falls back to the whole position under `assetClass` when exposures is empty", () => {
    expect(resolveExposures({ assetClass: "bond", exposures: [] })).toEqual([
      { assetClass: "bond", weight: 1 },
    ]);
  });

  it("passes a clean split through unchanged", () => {
    const exposures = [
      { assetClass: "us_equity" as const, weight: 0.6 },
      { assetClass: "intl_equity" as const, weight: 0.4 },
    ];
    expect(resolveExposures({ assetClass: "us_equity", exposures })).toEqual(exposures);
  });

  it("renormalizes a split that doesn't sum to 1", () => {
    const result = resolveExposures({
      assetClass: "us_equity",
      exposures: [
        { assetClass: "us_equity", weight: 0.5 },
        { assetClass: "intl_equity", weight: 0.3 },
      ],
    });
    expect(result[0].weight).toBeCloseTo(0.625, 6);
    expect(result[1].weight).toBeCloseTo(0.375, 6);
    expect(result[0].weight + result[1].weight).toBeCloseTo(1, 9);
  });

  it("falls back rather than dividing by zero when every weight is zero or negative", () => {
    expect(
      resolveExposures({ assetClass: "cash", exposures: [{ assetClass: "us_equity", weight: 0 }] }),
    ).toEqual([{ assetClass: "cash", weight: 1 }]);
  });
});
