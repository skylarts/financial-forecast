import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The middleware's one hard requirement: it must not be able to take the site
 * down while trying to refresh a session cookie.
 *
 * `auth-js` retries a failed refresh with exponential backoff for up to
 * `AUTO_REFRESH_TICK_DURATION_MS` -- 30 seconds. The platform kills a
 * middleware invocation at 25. Those two numbers were the whole bug: any
 * sustained trouble reaching Supabase's auth server did not slow a page down,
 * it replaced the page with a 504, and only ever for signed-in visitors,
 * because a request with no session to refresh never makes the call at all.
 */

const getUser = vi.hoisted(() => vi.fn());

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

const { middleware } = await import("./middleware");

function pageRequest(): NextRequest {
  return new NextRequest(new URL("https://example.test/portfolio"), {
    headers: { cookie: "sb-project-auth-token=a-session" },
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  getUser.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("when Supabase answers normally", () => {
  it("refreshes the session and serves the page", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const response = await middleware(pageRequest());

    expect(response.status).toBe(200);
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});

describe("when Supabase does not answer", () => {
  /**
   * The exact shape of the outage: `getUser` never settles, because inside it
   * a refresh is being retried on a backoff longer than the platform will wait.
   */
  it("still serves the page instead of hanging until the platform kills it", async () => {
    vi.useFakeTimers();
    getUser.mockReturnValue(new Promise(() => {}));

    const pending = middleware(pageRequest());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Nothing has given up yet -- the refresh is still allowed its budget.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);

    // Past the deadline, the page is served regardless.
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;

    expect(response.status).toBe(200);
  });

  /**
   * The deadline has to be under the platform's own limit by a real margin,
   * not merely under `auth-js`'s 30-second retry budget. A number between the
   * two would keep the bug and only make it rarer.
   */
  it("gives up well inside the platform's limit", async () => {
    vi.useFakeTimers();
    getUser.mockReturnValue(new Promise(() => {}));

    const pending = middleware(pageRequest());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
  });

  it("does not call Supabase at all when it is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const response = await middleware(pageRequest());

    expect(response.status).toBe(200);
    expect(getUser).not.toHaveBeenCalled();
  });
});
