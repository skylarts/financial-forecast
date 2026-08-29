"use client";

import { useCallback, useState } from "react";
import type { PortfolioAccount } from "@/domain/portfolio";
import { accountForSchwabHash, schwabRowsToCsv, type KnownSecurity } from "@/lib/portfolio/schwabLedger";
import type { SchwabLedgerRow } from "@/lib/portfolio/schwabTransactions";
import { useSchwabAccounts } from "@/lib/portfolio/useSchwabAccounts";
import { useSchwabStatus } from "@/lib/portfolio/useSchwabStatus";

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
  accounts,
  securities,
  onFetched,
}: {
  /** The ledger's own accounts, used to find which one this Schwab account is
   *  linked to (see `PortfolioAccount.schwabAccountHash`), if any. */
  accounts: readonly PortfolioAccount[];
  securities: readonly KnownSecurity[];
  /** `linkedAccountId` is set when the fetched Schwab account is linked to one
   *  of `accounts`, so the caller can land the import there without asking. */
  onFetched: (csv: string, linkedAccountId: string | null) => void;
}) {
  const { status } = useSchwabStatus();
  const schwabAccounts = useSchwabAccounts();
  const [chosenAccount, setChosenAccount] = useState("");
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<FetchOutcome | null>(null);

  const connected = status?.connected === true;
  // Falls back to the first account the list arrives with, rather than
  // syncing that default into state -- there is nothing to reset if the list
  // reloads, and a manual pick always wins once one exists.
  const account = chosenAccount || schwabAccounts?.[0]?.hashValue || "";

  const linked = account ? accountForSchwabHash(accounts, account) : null;

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
      onFetched(schwabRowsToCsv(body.rows, securities), linked?.id ?? null);
      setOutcome({ rowCount: body.rows.length, ignored: body.ignored });
    } catch {
      setError("Schwab didn't answer. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [account, days, linked, onFetched, securities]);

  if (!connected) return null;

  return (
    <div className="rounded-md border border-border bg-panel-2 p-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[12px] text-dim">
          <span className="mb-1 block text-dim-2">Fetch from Schwab</span>
          <select
            value={account}
            onChange={(e) => setChosenAccount(e.target.value)}
            className="rounded-md border border-border bg-panel px-2 py-1 text-[12px] text-foreground outline-none focus:border-accent"
          >
            {(schwabAccounts ?? []).map((a) => (
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

        {/* Tells the user where this is about to land, or that it doesn't know
            yet -- silently guessing the wrong account is worse than asking. */}
        <span className="text-[11.5px] text-dim-2">
          {linked ? (
            <>
              → <span className="text-foreground">{linked.name}</span>
            </>
          ) : (
            "not linked — set this on the Accounts tab"
          )}
        </span>
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
