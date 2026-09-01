import { describe, expect, it } from "vitest";
import { safeToPush, shouldAcceptCloudLedger } from "./syncSafety";

describe("safeToPush", () => {
  it("allows a normal push of a populated ledger", () => {
    expect(safeToPush(1200, true)).toBe(true);
  });

  it("allows a populated ledger even on a session that started empty", () => {
    // A fresh browser that just imported a backup: nothing was seen
    // beforehand, but there is plainly something to sync now.
    expect(safeToPush(1200, false)).toBe(true);
  });

  it("allows the user to genuinely clear a ledger they had loaded", () => {
    expect(safeToPush(0, true)).toBe(true);
  });

  it("REFUSES an empty ledger the session never held -- the 2026-08-31 wipe", () => {
    // Local storage was empty and the cloud pull had failed, so the store held
    // nothing through no action of the user's. The quote-refresh writeback then
    // stamped a save, and this push went out over a real ledger.
    expect(safeToPush(0, false)).toBe(false);
  });
});

describe("shouldAcceptCloudLedger", () => {
  it("takes the cloud copy in the ordinary case", () => {
    expect(shouldAcceptCloudLedger(1200, 900)).toBe(true);
  });

  it("takes the cloud copy onto a fresh device", () => {
    expect(shouldAcceptCloudLedger(1200, 0)).toBe(true);
  });

  it("accepts an empty cloud ledger when there is nothing local to lose", () => {
    expect(shouldAcceptCloudLedger(0, 0)).toBe(true);
  });

  it("REFUSES to let an empty cloud ledger erase a local one", () => {
    // Exactly the state after the 2026-08-31 wipe: the cloud row holds no
    // transactions, and the browser has a freshly restored backup that must
    // survive long enough to be pushed back up.
    expect(shouldAcceptCloudLedger(0, 4200)).toBe(false);
  });
});
