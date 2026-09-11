import { afterEach, describe, expect, it, vi } from "vitest";

const readAppCredentials = vi.hoisted(() => vi.fn());
const storageMode = vi.hoisted(() => vi.fn());

vi.mock("./schwabTokenStore", () => ({ readAppCredentials, storageMode }));

const { resolveSchwabApp, validateAppCredentials } = await import("./schwabApp");

const deploymentApp = () => {
  vi.stubEnv("SCHWAB_APP_KEY", "deployment-key");
  vi.stubEnv("SCHWAB_APP_SECRET", "deployment-secret");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("whose Schwab application a request runs through", () => {
  it("prefers the caller's own registration", async () => {
    storageMode.mockResolvedValue({ mode: "supabase", userId: "user-1" });
    readAppCredentials.mockResolvedValue({ appKey: "mine", appSecret: "also-mine" });
    deploymentApp();

    expect(await resolveSchwabApp()).toEqual({
      appKey: "mine",
      appSecret: "also-mine",
      source: "user",
    });
  });

  it("does not lend the deployment's application out by default", async () => {
    // Schwab holds the registered app's owner responsible for its traffic, so
    // running every signed-in visitor's brokerage through one person's
    // registration is a decision that has to be made on purpose.
    storageMode.mockResolvedValue({ mode: "supabase", userId: "user-2" });
    readAppCredentials.mockResolvedValue(null);
    deploymentApp();

    expect(await resolveSchwabApp()).toBeNull();
  });

  it("lends it out when the operator says so in as many words", async () => {
    storageMode.mockResolvedValue({ mode: "supabase", userId: "user-2" });
    readAppCredentials.mockResolvedValue(null);
    deploymentApp();
    vi.stubEnv("SCHWAB_SHARED_APP", "true");

    expect(await resolveSchwabApp()).toEqual({
      appKey: "deployment-key",
      appSecret: "deployment-secret",
      source: "deployment",
    });
  });

  it("uses the environment freely on a single-user install", async () => {
    // There is only one person there and the environment is theirs.
    storageMode.mockResolvedValue({ mode: "file", userId: null });
    readAppCredentials.mockResolvedValue(null);
    deploymentApp();

    expect(await resolveSchwabApp()).toEqual({
      appKey: "deployment-key",
      appSecret: "deployment-secret",
      source: "deployment",
    });
  });

  it("has nothing to offer a signed-out caller", async () => {
    storageMode.mockResolvedValue({ mode: "none", userId: null });
    readAppCredentials.mockResolvedValue(null);
    deploymentApp();
    vi.stubEnv("SCHWAB_SHARED_APP", "true");

    expect(await resolveSchwabApp()).toBeNull();
  });

  it("reports no application rather than half of one", async () => {
    storageMode.mockResolvedValue({ mode: "file", userId: null });
    readAppCredentials.mockResolvedValue(null);
    vi.stubEnv("SCHWAB_APP_KEY", "key-with-no-secret");
    vi.stubEnv("SCHWAB_APP_SECRET", "");

    expect(await resolveSchwabApp()).toBeNull();
  });
});

describe("credentials arriving from the settings form", () => {
  it("accepts a plausible pair", () => {
    expect(validateAppCredentials("abcdefghij", "klmnopqrst")).toEqual({
      appKey: "abcdefghij",
      appSecret: "klmnopqrst",
    });
  });

  it("trims what a paste brings with it", () => {
    expect(validateAppCredentials("  abcdefghij \n", "\tklmnopqrst ")).toEqual({
      appKey: "abcdefghij",
      appSecret: "klmnopqrst",
    });
  });

  it("rejects what cannot possibly work", () => {
    expect(validateAppCredentials("short", "klmnopqrst")).toBeNull();
    expect(validateAppCredentials("abcdefghij", "")).toBeNull();
    expect(validateAppCredentials(null, "klmnopqrst")).toBeNull();
    expect(validateAppCredentials("abcdefghij", 12345)).toBeNull();
    expect(validateAppCredentials("x".repeat(300), "klmnopqrst")).toBeNull();
  });
});
