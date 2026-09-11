"use client";

import { useMemo, useState } from "react";
import type { PortfolioAccount } from "@/domain/portfolio";
import {
  dedupeByDate,
  parseStatementValuations,
} from "@/lib/portfolio/statementValuations";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * Loads period-end account values from a custodian statement export, so the
 * tracker's own replayed series has something authoritative to be checked
 * against. See `StatementValuation` for why these are recorded rather than
 * computed.
 */
export function StatementValuationsDialog({
  accounts,
  existingCounts,
  onImport,
  onClose,
}: {
  accounts: readonly PortfolioAccount[];
  /** How many valuations each account already has, by account id. */
  existingCounts: Readonly<Record<string, number>>;
  onImport: (accountId: string, rows: ReturnType<typeof dedupeByDate>) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");

  const parsed = useMemo(() => parseStatementValuations(text), [text]);
  const rows = useMemo(() => dedupeByDate(parsed.rows), [parsed.rows]);
  const existing = existingCounts[accountId] ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div className="mt-10 w-full max-w-2xl rounded-lg border border-border bg-panel p-5 shadow-xl">
        <h2 className="text-base font-semibold text-foreground">Import statement values</h2>
        <p className="mt-1 text-[12.5px] text-dim">
          Period-end account values from your custodian. They never change a holding or a
          transaction — they give the Performance tab something to check its own arithmetic
          against.
        </p>

        <label className="mt-4 block text-[12.5px] text-dim">
          Account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-base px-2.5 py-1.5 text-[13px] text-foreground"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {(existingCounts[a.id] ?? 0) > 0 ? ` — ${existingCounts[a.id]} on file` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-[12.5px] text-dim">
          Paste a JSON export or a CSV
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            spellCheck={false}
            placeholder={'date,value\n2026-07-31,35302.52\n2026-08-31,35778.69'}
            className="mt-1 w-full rounded-md border border-border bg-base px-2.5 py-2 font-mono text-[12px] text-foreground"
          />
        </label>
        <p className="text-[11.5px] text-dim-2">
          Takes a <code>valuations</code> array from a portfolio terminal&apos;s JSON, or a CSV
          with <code>date</code> and <code>value</code> columns. A <code>2026-08</code> style
          month is read as that month&apos;s last day.
        </p>

        {text.trim() !== "" && (
          <div className="mt-3 rounded-md border border-border-soft bg-base px-3 py-2 text-[12.5px]">
            {rows.length === 0 ? (
              <span className="text-rose-400">Nothing readable in that paste.</span>
            ) : (
              <>
                <span className="text-foreground">
                  {rows.length} period{rows.length === 1 ? "" : "s"}, {rows[0].date} to{" "}
                  {rows[rows.length - 1].date}
                </span>
                <span className="ml-2 text-dim-2">
                  ending {money(rows[rows.length - 1].value)}
                </span>
              </>
            )}
            {parsed.skipped.length > 0 && (
              <div className="mt-1 text-[11.5px] text-amber-400">
                Skipped {parsed.skipped.length}: {parsed.skipped.slice(0, 3).join(" · ")}
                {parsed.skipped.length > 3 ? " …" : ""}
              </div>
            )}
            {existing > 0 && rows.length > 0 && (
              <div className="mt-1 text-[11.5px] text-dim-2">
                Replaces the {existing} already on this account.
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-[13px] text-dim hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={rows.length === 0 || accountId === ""}
            onClick={() => onImport(accountId, rows)}
            className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-[13px] text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            Import {rows.length > 0 ? rows.length : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
