"use client";

import { useCallback, useEffect, useState } from "react";
import { schwabRowsToCsv, type KnownSecurity } from "@/lib/portfolio/schwabLedger";
import type { SchwabLedgerRow } from "@/lib/portfolio/schwabTransactions";
import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";

interface SchwabAccountOption {
  hashValue: string;
  masked: string;
}

interface FetchOutcome {
  rowCount: number;
  ignored: { description: string; reason: string }[];
}

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

/**
 * Pulls a Schwab account's history into the import box.
 *
 * It fills the same textarea a pasted statement goes into rather than writing
 * to the ledger directly, so everything downstream -- the column mapping, the
 * duplicate check, the sleeve routing, the row-by-row review -- happens
 * exactly as it does for a file. Schwab is a statement that fetches itself,
 * not a second way in.
 *
 * Renders nothing unless a brokerage is actually connected, because the whole
 * import path has to keep working for someone who has no Schwab app at all.
 */
export function SchwabFetchPanel({
  securities,
  onFetched,
}: {
  securities: readonly KnownSecurity[];
  onFetched: (csv: string) => void;
}) {
  const { status } = useSchwabStatus();
  const [accounts, setAccounts] = useState<SchwabAccountOption[] | null>(null);
  const [account, setAccount] = useState("");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<FetchOutcome | null>(null);

  const connected = status?.connected === true;

  useEffect(() => {
    if (!connected) return;
    let active = true;
    fetch("/api/schwab/accounts")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { accounts?: SchwabAccountOption[] } | null) => {
        if (!active || !body?.accounts) return;
        setAccounts(body.accounts);
        setAccount((current) => current || (body.accounts?.[0]?.hashValue ?? ""));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected]);

  const run = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await fetch(
        `/api/schwab/transactions?account=${encodeURIComponent(account)}&days=${days}`,
      );
      if (!response.ok) {
        setError(
          response.status === 404
            ? "Schwab isn't connected any more — sign in again."
            : "Schwab didn't answer. Try again in a moment.",
        );
        return;
      }
      const body = (await response.json()) as {
        rows: SchwabLedgerRow[];
        ignored: { description: string; reason: string }[];
      };
      onFetched(schwabRowsToCsv(body.rows, securities));
      setOutcome({ rowCount: body.rows.length, ignored: body.ignored });
    } catch {
      setError("Schwab didn't answer. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [account, days, onFetched, securities]);

  if (!connected) return null;

  return (
    <div className="rounded-md border border-border bg-panel-2 p-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[12px] text-dim">
          <span className="mb-1 block text-dim-2">Fetch from Schwab</span>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="rounded-md border border-border bg-panel px-2 py-1 text-[12px] text-foreground outline-none focus:border-accent"
          >
            {(accounts ?? []).map((a) => (
              <option key={a.hashValue} value={a.hashValue}>
                {a.masked}
              </option>
            ))}
          </select>
        </label>

        <label className="text-[12px] text-dim">
          <span className="mb-1 block text-dim-2">Going back</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border border-border bg-panel px-2 py-1 text-[12px] text-foreground outline-none focus:border-accent"
          >
            {WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={run}
          disabled={busy || !account}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-accent disabled:opacity-50"
        >
          {busy ? "Fetching…" : "Fetch"}
        </button>
      </div>

      {error && <p className="mt-2 text-[11.5px] text-negative">{error}</p>}

      {outcome && (
        <p className="mt-2 text-[11.5px] text-dim-2">
          Loaded {outcome.rowCount} {outcome.rowCount === 1 ? "row" : "rows"} below — review them
          before importing.
          {/* Every event Schwab sent is accounted for. Most of what's left out
              is cash journalled between the cash and margin sides of the same
              account, which is not a deposit and would inflate cash if it were
              treated as one -- but saying so beats a silent shortfall. */}
          {outcome.ignored.length > 0 && (
            <>
              {" "}
              {outcome.ignored.length} internal or non-ledger{" "}
              {outcome.ignored.length === 1 ? "event was" : "events were"} left out.
            </>
          )}
        </p>
      )}
    </div>
  );
}
