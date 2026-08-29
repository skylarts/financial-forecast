import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How many times one request asks Supabase who is calling.
 *
 * `storageMode` is consulted several times over a single route -- the guard,
 * then the app resolver, then the token read, then the access-token cache key
 * -- and each of those used to open its own client and make its own round trip
 * to the auth server before any Schwab work began. Five, on a quote refresh.
 *
 * That is latency stacked in front of the one path that also has to finish a
 * brokerage round trip inside the platform's request limit, and it is invisible
 * from the outside: signed out, none of these calls happen at all, which is why
 * the signed-out routes answer in milliseconds while the signed-in ones are the
 * only ones that ever time out.
 */

const getUser = vi.hoisted(() => vi.fn());
const cookieStore = vi.hoisted(() => ({ current: {} as object }));

vi.mock("next/headers", () => ({
  // Next hands back the same store object for every call within a request and
  // a fresh one for the next, which is what makes it usable as a request key.
  cookies: async () => cookieStore.current,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
}));

const { storageMode } = await import("./schwabTokenStore");

/** Each test is its own request, so each gets its own store object. */
function newRequest(): void {
  cookieStore.current = {};
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  getUser.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  newRequest();
});

describe("resolving who is calling", () => {
  it("asks once however many times the request needs the answer", async () => {
    await storageMode();
    await storageMode();
    await storageMode();
    await storageMode();

    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("asks once when the callers overlap rather than starting several lookups", async () => {
    await Promise.all([storageMode(), storageMode(), storageMode()]);

    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("gives the same answer to every caller in the request", async () => {
    const answers = await Promise.all([storageMode(), storageMode()]);

    expect(answers[0]).toEqual({ mode: "supabase", userId: "user-1" });
    expect(answers[1]).toEqual(answers[0]);
  });

  /**
   * The memo must not outlive the request that created it. Keyed on the
   * request's own cookie store, a second request has no key in common with the
   * first, so there is no arrangement of concurrent traffic under which one
   * person's identity could be served to another.
   */
  it("does not carry one request's identity into the next", async () => {
    await storageMode();
    expect(getUser).toHaveBeenCalledTimes(1);

    newRequest();
    getUser.mockResolvedValue({ data: { user: { id: "user-2" } } });

    expect(await storageMode()).toEqual({ mode: "supabase", userId: "user-2" });
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it("does not remember a signed-in user for a request that has signed out", async () => {
    await storageMode();

    newRequest();
    getUser.mockResolvedValue({ data: { user: null } });

    expect(await storageMode()).toEqual({ mode: "none", userId: null });
  });
});
