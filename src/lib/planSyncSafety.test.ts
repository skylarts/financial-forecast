import { describe, expect, it } from "vitest";
import { cloudChangedSinceSeen, safeToPushPlan, shouldAcceptCloudPlan } from "./planSyncSafety";

describe("safeToPushPlan", () => {
  it("refuses every push until a read has settled successfully", () => {
    expect(safeToPushPlan("not-started", true, true)).toBe(false);
    expect(safeToPushPlan("in-flight", true, true)).toBe(false);
    expect(safeToPushPlan("failed", true, true)).toBe(false);
  });

  it("allows a plan with content after a successful or empty read", () => {
    expect(safeToPushPlan("succeeded", true, false)).toBe(true);
    expect(safeToPushPlan("empty", true, false)).toBe(true);
  });

  it("allows an empty plan only when this session saw a real one", () => {
    expect(safeToPushPlan("succeeded", false, false)).toBe(false);
    expect(safeToPushPlan("succeeded", false, true)).toBe(true);
  });
});

describe("shouldAcceptCloudPlan", () => {
  it("lets a cloud plan with content win", () => {
    expect(shouldAcceptCloudPlan(true, true)).toBe(true);
    expect(shouldAcceptCloudPlan(true, false)).toBe(true);
  });
  it("never lets an empty cloud plan replace a local one with content", () => {
    expect(shouldAcceptCloudPlan(false, true)).toBe(false);
    expect(shouldAcceptCloudPlan(false, false)).toBe(true);
  });
});

describe("cloudChangedSinceSeen", () => {
  it("flags a row stamped differently from the last read or write", () => {
    expect(cloudChangedSinceSeen("2026-09-12T10:00:00Z", "2026-09-12T09:00:00Z")).toBe(true);
    expect(cloudChangedSinceSeen("2026-09-12T10:00:00Z", "2026-09-12T10:00:00Z")).toBe(false);
  });
  it("cannot flag anything before the first read", () => {
    expect(cloudChangedSinceSeen("2026-09-12T10:00:00Z", null)).toBe(false);
    expect(cloudChangedSinceSeen(null, "2026-09-12T10:00:00Z")).toBe(false);
  });
});
