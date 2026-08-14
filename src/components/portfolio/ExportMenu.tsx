"use client";

import { useEffect, useRef, useState } from "react";
import type { Portfolio } from "@/domain/portfolio";
import {
  backupFilename,
  csvFilename,
  download,
  toBackupJson,
  toCsv,
} from "@/lib/portfolio/exportLedger";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { Btn } from "@/components/ui/controls";

/**
 * Gets the ledger back out of the browser, and back in.
 *
 * Export offers two formats because they answer different questions: the CSV
 * is for reading and correcting the transactions somewhere else and importing
 * them back through the ordinary Import dialog, the JSON is the whole
 * portfolio for backup. Restore is the JSON's other half -- `importJson`
 * already existed on the store, reachable only from the console, which meant
 * fixing a bad row still meant hand-editing localStorage. This is the button
 * for it.
 */
export function ExportMenu({ portfolio }: { portfolio: Portfolio }) {
  const [open, setOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importJson = usePortfolioStore((s) => s.importJson);

  // Close on an outside click or on Escape, so the menu never strands itself
  // open over the page.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = portfolio.transactions.length;
  const item =
    "block w-full px-3 py-2 text-left text-[12.5px] text-foreground hover:bg-panel-2";

  return (
    <div ref={wrap} className="relative">
      <Btn
        onClick={() => setOpen((v) => !v)}
        title={count ? `Download ${count} transactions` : "Nothing to export yet"}
        className={count ? "" : "pointer-events-none opacity-40"}
        ariaHasPopup="menu"
        ariaExpanded={open}
      >
        Export ▾
      </Btn>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-md border border-border bg-panel shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              download(csvFilename(), "text/csv;charset=utf-8", toCsv(portfolio));
              setOpen(false);
            }}
          >
            Transactions (CSV)
            <span className="mt-0.5 block text-[11px] text-dim">
              {count.toLocaleString()} rows, ready to import back
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${item} border-t border-border-soft`}
            onClick={() => {
              download(
                backupFilename(),
                "application/json",
                toBackupJson(portfolio),
              );
              setOpen(false);
            }}
          >
            Full backup (JSON)
            <span className="mt-0.5 block text-[11px] text-dim">
              Accounts, transactions and securities
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${item} border-t border-border-soft`}
            onClick={() => {
              setOpen(false);
              fileInput.current?.click();
            }}
          >
            Restore backup (JSON)…
            <span className="mt-0.5 block text-[11px] text-dim">
              Replaces everything currently loaded
            </span>
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // lets the same file be picked again after an error
          if (!file) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(await file.text());
          } catch {
            setRestoreError("That file isn't valid JSON.");
            return;
          }
          const result = importJson(parsed);
          setRestoreError(result.ok ? null : result.error);
        }}
      />
      {restoreError && (
        <div
          role="alert"
          className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-border bg-panel px-3 py-2 text-[12px] text-foreground shadow-lg"
        >
          {restoreError}
          <button
            type="button"
            onClick={() => setRestoreError(null)}
            className="ml-2 text-dim underline hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
