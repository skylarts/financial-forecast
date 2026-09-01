import { describe, expect, it } from "vitest";
import { isDestructiveChange, supersedesSessionBest } from "./portfolioSnapshots";

describe("isDestructiveChange", () => {
  it("fires when transactions are lost", () => {
    expect(isDestructiveChange(4200, 4199)).toBe(true);
  });

  it("fires on the wipe this was written for", () => {
    // A cloud pull returning nothing, loaded over a full ledger.
    expect(isDestructiveChange(4200, 0)).toBe(true);
  });

  it("stays quiet on an import", () => {
    expect(isDestructiveChange(4200, 14200)).toBe(false);
  });

  it("stays quiet when nothing about the count changed", () => {
    // The quote-refresh writeback stamps a save constantly; snapshotting it
    // would churn the rolling window and evict the copies that matter.
    expect(isDestructiveChange(4200, 4200)).toBe(false);
  });

  it("stays quiet when there was nothing to lose", () => {
    expect(isDestructiveChange(0, 0)).toBe(false);
  });
});

describe("supersedesSessionBest", () => {
  it("takes the first snapshot of a session", () => {
    expect(supersedesSessionBest(4200, null)).toBe(true);
  });

  it("keeps the fullest copy when a delete runs row by row", () => {
    // Deleting a thousand rows one at a time must not write a thousand
    // ever-thinner snapshots and evict the only useful one.
    expect(supersedesSessionBest(4199, 4200)).toBe(false);
    expect(supersedesSessionBest(3000, 4200)).toBe(false);
  });

  it("takes a fuller copy when the ledger has grown since", () => {
    expect(supersedesSessionBest(9000, 4200)).toBe(true);
  });
});
