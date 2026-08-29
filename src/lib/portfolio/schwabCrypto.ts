import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for anything that would be a live brokerage credential if it
 * leaked.
 *
 * The database already encrypts at rest, which protects against a stolen disk
 * and nothing else. This protects against the realistic failure: a dump, a
 * leaked backup, an over-broad query, a support export. The key lives in the
 * environment rather than the database, so possessing the data is not the same
 * as being able to use it.
 *
 * AES-256-GCM rather than a plain cipher because it authenticates as well as
 * encrypts -- a tampered ciphertext fails to open instead of decrypting to
 * something else.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class MissingEncryptionKey extends Error {
  constructor() {
    super(
      "SCHWAB_ENCRYPTION_KEY is not set. Refusing to store a brokerage credential in plaintext.",
    );
    this.name = "MissingEncryptionKey";
  }
}

/**
 * The key, as 32 raw bytes.
 *
 * Accepts hex or base64 so it can be generated with whatever is to hand --
 * `openssl rand -hex 32` and `openssl rand -base64 32` both work.
 */
function key(): Buffer | null {
  const raw = process.env.SCHWAB_ENCRYPTION_KEY ?? "";
  if (!raw) return null;

  const candidates = [
    /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : null,
    Buffer.from(raw, "base64"),
  ];
  const found = candidates.find((buffer) => buffer?.length === KEY_BYTES);
  return found ?? null;
}

export function encryptionConfigured(): boolean {
  return key() !== null;
}

/**
 * Encrypts a secret for storage.
 *
 * Throws rather than falling back to plaintext when no key is configured. A
 * silent fallback is how a credential ends up readable in a database that
 * everyone assumed was encrypted.
 */
export function encryptSecret(plaintext: string): string {
  const secret = key();
  if (!secret) throw new MissingEncryptionKey();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, secret, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Version prefix so the format can change later without guessing at what an
  // existing row was written with.
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

/**
 * Opens a stored secret, or returns null when it cannot be trusted.
 *
 * Null covers a rotated key, a truncated value, and a tampered one alike --
 * every case where the right move is to treat the connection as gone and ask
 * the user to sign in again, rather than to surface a decryption error.
 */
export function decryptSecret(stored: string): string | null {
  const secret = key();
  if (!secret) return null;

  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;

  try {
    const decipher = createDecipheriv(ALGORITHM, secret, Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
