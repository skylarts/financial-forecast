import { describe, expect, it, vi } from "vitest";

const storageMode = vi.hoisted(() => vi.fn());
vi.mock("./schwabTokenStore", () => ({ storageMode }));
vi.mock("./schwabAuth", () => ({ appOrigin: () => "https://forecast.example" }));

const { requireSameOrigin, requireSchwabAccess } = await import("./schwabGuard");

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

/**
 * The session lives in a cookie, so every request a browser sends to these
 * routes arrives authenticated whether or not the user meant to send it.
 */
describe("requireSameOrigin", () => {
  const request = (origin: string | null) =>
    new Request("https://forecast.example/api/schwab/app", {
      method: "PUT",
      headers: origin === null ? {} : { origin },
    });

  it("lets through a request from this app's own page", () => {
    expect(requireSameOrigin(request("https://forecast.example")).ok).toBe(true);
  });

  it("refuses one from somebody else's page", () => {
    // Otherwise a form on any site the user visits could replace the Schwab
    // application behind their connection, or tear the connection down.
    const guard = requireSameOrigin(request("https://evil.example"));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(403);
  });

  it("refuses one with no Origin at all", () => {
    // Treated as a refusal rather than a pass, because the alternative is a
    // rule any caller can opt out of by omitting a header.
    expect(requireSameOrigin(request(null)).ok).toBe(false);
  });
});
