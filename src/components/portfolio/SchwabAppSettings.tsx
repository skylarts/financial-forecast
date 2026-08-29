"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Registering your own Schwab developer application.
 *
 * This is the whole of what "let someone else use this tool" means for Schwab.
 * There is no multi-tenant integration to invite people into: every OAuth flow
 * runs against one application registered by a human at developer.schwab.com,
 * and Schwab holds that application's owner responsible for its traffic. So a
 * second user brings a second application, and this is where they put it.
 *
 * The secret is write-only from here. It goes to the server, is encrypted
 * before storage, and the only thing that ever comes back is the last four
 * characters of the key -- enough to recognise which registration is saved and
 * of no use to anyone who reads it.
 */

interface AppState {
  hasOwnApp: boolean;
  appSource: "user" | "deployment" | null;
  appKeyHint: string | null;
  callbackUrl: string | null;
  canStore: boolean;
}

const SETUP_STEPS = [
  "Sign in at developer.schwab.com and create an app with the Accounts and Trading Production API.",
  "Register the callback URL below on it, character for character.",
  "Wait for Schwab to move the app to Ready For Use — approval takes a day or two.",
  "Paste the app key and secret here, then connect.",
];

export function SchwabAppSettings({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<AppState | null>(null);
  const [open, setOpen] = useState(false);
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/schwab/app");
      setState(response.ok ? ((await response.json()) as AppState) : null);
    } catch {
      setState(null);
    }
  }, []);

  // Fetched through the promise chain rather than by awaiting `load` here, so
  // the state lands in a callback instead of synchronously in the effect body
  // -- the same shape the sibling panels use.
  useEffect(() => {
    let active = true;
    fetch("/api/schwab/app")
      .then((response) => (response.ok ? (response.json() as Promise<AppState>) : null))
      .then((body) => {
        if (active) setState(body);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/schwab/app", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey, appSecret }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(
          body.error === "no_encryption_key"
            ? "This install has no SCHWAB_ENCRYPTION_KEY set, so there is nowhere safe to store a secret. Saving was refused rather than storing it in the clear."
            : body.error === "bad_credentials"
              ? "That key and secret do not look like a Schwab app. Check both and try again."
              : "Could not save that. Try again in a moment.",
        );
        return;
      }
      // Cleared on success rather than left in the form: there is no reason
      // for a live app secret to stay sitting in a DOM node afterwards.
      setAppKey("");
      setAppSecret("");
      setMessage("Saved. Connect Schwab to finish — the sign-in now runs through your own app.");
      await load();
      onChanged?.();
    } catch {
      setMessage("Could not save that. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [appKey, appSecret, load, onChanged]);

  const remove = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await fetch("/api/schwab/app", { method: "DELETE" });
      setMessage("Removed, along with the connection that was built on it.");
      await load();
      onChanged?.();
    } catch {
      setMessage("Could not remove that. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [load, onChanged]);

  if (!state) return null;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12px] text-dim underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {state.hasOwnApp
          ? `Your Schwab app (${state.appKeyHint})`
          : "Use your own Schwab app"}
      </button>

      {open && (
        <div className="mt-2 max-w-2xl rounded-md border border-border bg-panel p-3 text-[12px]">
          <p className="text-dim-2">
            Schwab has no shared integration — every connection runs through an app registered by a
            person. Register your own so your brokerage is never reached through anyone else&apos;s.
          </p>

          <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-dim-2">
            {SETUP_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          {state.callbackUrl && (
            <p className="mt-2 text-dim-2">
              Callback URL:{" "}
              <code className="rounded bg-panel-2 px-1 py-0.5 text-foreground">
                {state.callbackUrl}
              </code>
            </p>
          )}

          {state.appSource === "deployment" && !state.hasOwnApp && (
            <p className="mt-2 text-dim">
              Right now you are using this deployment&apos;s shared app. Your brokerage data stays
              yours either way, but its traffic counts against the owner&apos;s Schwab registration.
            </p>
          )}

          {!state.canStore && (
            <p className="mt-2 text-dim">
              This install has no encryption key configured, so an app secret cannot be stored here.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-dim">
              <span className="mb-1 block text-dim-2">App key</span>
              <input
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="w-64 rounded-md border border-border bg-panel-2 px-2 py-1 text-foreground outline-none focus:border-accent"
              />
            </label>

            <label className="text-dim">
              <span className="mb-1 block text-dim-2">App secret</span>
              <input
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="w-64 rounded-md border border-border bg-panel-2 px-2 py-1 text-foreground outline-none focus:border-accent"
              />
            </label>

            <button
              type="button"
              onClick={save}
              disabled={busy || !appKey || !appSecret || !state.canStore}
              className="rounded border border-border px-2 py-1 text-foreground hover:border-accent disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>

            {state.hasOwnApp && (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="rounded border border-border px-2 py-1 text-dim hover:border-accent disabled:opacity-40"
              >
                Remove
              </button>
            )}
          </div>

          {message && <p className="mt-2 text-dim">{message}</p>}
        </div>
      )}
    </div>
  );
}
