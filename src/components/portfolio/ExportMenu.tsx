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
import { Btn } from "@/components/ui/controls";

/**
 * Gets the ledger back out of the browser.
 *
 * Two formats rather than one because they answer different questions: the CSV
 * is for reading and correcting the transactions somewhere else and importing
 * them back, the JSON is the whole portfolio for backup. Both are worth having
 * where the data lives only in this browser's local storage.
 */
export function ExportMenu({ portfolio }: { portfolio: Portfolio }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

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
        </div>
      )}
    </div>
  );
}
