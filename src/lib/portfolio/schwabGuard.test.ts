import { describe, expect, it, vi } from "vitest";

const storageMode = vi.hoisted(() => vi.fn());
vi.mock("./schwabTokenStore", () => ({ storageMode }));

const { requireSchwabAccess } = await import("./schwabGuard");

/**
 * The rule these pin down is the one that decides whether this app can be
 * hosted at all: a deployed request with nobody signed in must never reach a
 * brokerage connection.
 */
describe("requireSchwabAccess", () => {
  it("lets a signed-in user through to their own connection", async () => {
    storageMode.mockResolvedValue({ mode: "supabase", userId: "user-1" });
    expect((await requireSchwabAccess()).ok).toBe(true);
  });

  it("lets the single-user local mode through", async () => {
    // Only reachable when Supabase is not configured at all -- the same
    // condition under which this app has no login to begin with.
    storageMode.mockResolvedValue({ mode: "file", userId: null });
    expect((await requireSchwabAccess()).ok).toBe(true);
  });

  it("refuses a deployed request with nobody signed in", async () => {
    // Without this, /api/schwab/transactions returned a full trading history
    // to anyone who visited the URL.
    storageMode.mockResolvedValue({ mode: "none", userId: null });
    const guard = await requireSchwabAccess();

    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(401);
      expect(guard.response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
