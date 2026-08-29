import { readAppCredentials, storageMode, type StoredApp } from "./schwabTokenStore";

/**
 * Which Schwab developer application a request authenticates through.
 *
 * Schwab has no notion of a multi-tenant integration. Every OAuth flow runs
 * against an application registered by a human at developer.schwab.com, and
 * that application's owner is the party Schwab holds responsible for its
 * traffic. So "let other people use this tool" has to mean "let other people
 * bring their own application" -- otherwise every user's brokerage moves
 * through one person's registration, sharing its rate limits and its standing.
 *
 * The resolution order is short and the fallback is the interesting half:
 *
 *  1. The caller's own registered app, saved encrypted against their account.
 *  2. The deployment's app from the environment -- but only where that is
 *     unambiguously the caller's own machine, or where the operator has said
 *     in as many words that they are lending it out.
 */

export type AppSource = "user" | "deployment";

export interface ResolvedApp extends StoredApp {
  source: AppSource;
}

function envApp(): StoredApp | null {
  const appKey = process.env.SCHWAB_APP_KEY ?? "";
  const appSecret = process.env.SCHWAB_APP_SECRET ?? "";
  return appKey && appSecret ? { appKey, appSecret } : null;
}

/**
 * Whether the deployment's own app may stand in for a user who has not
 * registered one.
 *
 * Off by default on a deployment, and that default is the point. Lending the
 * environment's application to every signed-in visitor is a decision with
 * consequences for the person whose developer account it is, so it is made
 * once, explicitly, by whoever set the environment up -- not implied by the
 * fact that a variable happens to be set.
 *
 * The single-user file mode is exempt: there is only one person there, and the
 * environment is theirs by definition.
 */
async function deploymentAppAllowed(): Promise<boolean> {
  const { mode } = await storageMode();
  // A caller with no identity gets nothing, whatever the operator has opted
  // into. Every route above this already refuses an unauthenticated request,
  // so this is redundant -- which is the point: it is the layer that still
  // holds if one of them is ever changed to stop checking.
  if (mode === "none") return false;
  if (mode === "file") return true;
  return process.env.SCHWAB_SHARED_APP === "true";
}

/**
 * The application this caller's Schwab traffic runs through, or null when
 * there is none -- which is a supported state meaning "offer to set one up",
 * not an error.
 */
export async function resolveSchwabApp(): Promise<ResolvedApp | null> {
  const own = await readAppCredentials();
  if (own) return { ...own, source: "user" };

  if (!(await deploymentAppAllowed())) return null;
  const shared = envApp();
  return shared ? { ...shared, source: "deployment" } : null;
}

/** Whether this caller could start a Schwab connection at all. */
export async function schwabAppAvailable(): Promise<boolean> {
  return (await resolveSchwabApp()) !== null;
}

/**
 * Shape check for credentials arriving from the settings form.
 *
 * Deliberately loose on format -- Schwab has changed the look of these before
 * and rejecting a valid key on a guessed pattern is worse than letting the
 * consent flow report a bad one. It only rejects what cannot possibly work.
 */
export function validateAppCredentials(appKey: unknown, appSecret: unknown): StoredApp | null {
  if (typeof appKey !== "string" || typeof appSecret !== "string") return null;
  const key = appKey.trim();
  const secret = appSecret.trim();
  if (key.length < 8 || key.length > 256) return null;
  if (secret.length < 8 || secret.length > 256) return null;
  return { appKey: key, appSecret: secret };
}
