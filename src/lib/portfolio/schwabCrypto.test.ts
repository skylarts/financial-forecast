import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, encryptionConfigured, MissingEncryptionKey } from "./schwabCrypto";

const KEY = "0".repeat(64);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("schwabCrypto", () => {
  it("round-trips a secret", () => {
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    const token = "refresh-token-value";
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("never writes the plaintext into the stored value", () => {
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    expect(encryptSecret("refresh-token-value")).not.toContain("refresh-token-value");
  });

  it("produces a different ciphertext each time", () => {
    // A fixed nonce would make identical tokens store identically, which leaks
    // that two rows hold the same credential.
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("refuses to encrypt with no key rather than storing plaintext", () => {
    // The failure that matters: a silent fallback is how a brokerage token
    // ends up readable in a database everyone assumed was encrypted.
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("secret")).toThrow(MissingEncryptionKey);
    expect(encryptionConfigured()).toBe(false);
  });

  it("rejects a tampered value instead of returning something", () => {
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    const sealed = encryptSecret("refresh-token-value");
    const parts = sealed.split(".");
    // Flip the ciphertext; GCM's tag should refuse it.
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(decryptSecret(parts.join("."))).toBeNull();
  });

  it("treats a value written under another key as no connection", () => {
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    const sealed = encryptSecret("refresh-token-value");
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", "1".repeat(64));
    // Null rather than a thrown error: the right response to a rotated key is
    // to ask the user to sign in again.
    expect(decryptSecret(sealed)).toBeNull();
  });

  it("rejects a malformed value", () => {
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    expect(decryptSecret("not-a-sealed-value")).toBeNull();
    expect(decryptSecret("v9.a.b.c")).toBeNull();
  });

  it("accepts a key given as hex or base64", () => {
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", KEY);
    expect(encryptionConfigured()).toBe(true);
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    expect(encryptionConfigured()).toBe(true);
    // A short key is not a key.
    vi.stubEnv("SCHWAB_ENCRYPTION_KEY", "tooshort");
    expect(encryptionConfigured()).toBe(false);
  });
});
