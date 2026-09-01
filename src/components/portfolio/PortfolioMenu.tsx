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
import { AccountTopMenuItem, SignOutMenuItem } from "@/components/auth/LoginButton";
import { SchwabSettingsDialog } from "./SchwabSettingsDialog";
import { SnapshotRestoreDialog } from "./SnapshotRestoreDialog";

/**
 * Everything the header used to spell out in buttons of its own.
 *
 * The header had grown to seven controls, of which exactly two get used in a
 * normal sitting: scope and Import. Export, Restore, the sample ledger, the
 * Schwab app registration and the sign-in menu are all things done once, or
 * once a year, so they moved in here -- one button, grouped by what the item
 * is for rather than by which component happened to own it.
 */

const ITEM = "block w-full px-3 py-2 text-left text-[12.5px] text-foreground hover:bg-panel-2";
const HINT = "mt-0.5 block text-[11px] text-dim";

function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border-soft py-1 first:border-t-0">
      {label && (
        <div className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-dim-2">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

export function PortfolioMenu({
  portfolio,
  canLoadDemo,
  onLoadDemo,
}: {
  portfolio: Portfolio;
  canLoadDemo: boolean;
  onLoadDemo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [schwabOpen, setSchwabOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
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

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="rounded-md border border-border bg-panel px-2.5 py-1.5 text-sm text-dim hover:border-accent hover:text-foreground"
      >
        ⋯
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-md border border-border bg-panel shadow-lg"
        >
          {canLoadDemo && (
            <Group>
              <button
                type="button"
                role="menuitem"
                className={ITEM}
                onClick={() => {
                  onLoadDemo();
                  setOpen(false);
                }}
              >
                Load sample data
                <span className={HINT}>A fictional ledger to look around in</span>
              </button>
            </Group>
          )}

          <Group label="Your data">
            <button
              type="button"
              role="menuitem"
              className={`${ITEM} ${count ? "" : "pointer-events-none opacity-40"}`}
              onClick={() => {
                download(csvFilename(), "text/csv;charset=utf-8", toCsv(portfolio));
                setOpen(false);
              }}
            >
              Export transactions (CSV)
              <span className={HINT}>{count.toLocaleString()} rows, ready to import back</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${ITEM} ${count ? "" : "pointer-events-none opacity-40"}`}
              onClick={() => {
                download(backupFilename(), "application/json", toBackupJson(portfolio));
                setOpen(false);
              }}
            >
              Download full backup (JSON)
              <span className={HINT}>Accounts, transactions and securities</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              onClick={() => {
                setOpen(false);
                fileInput.current?.click();
              }}
            >
              Restore from backup…
              <span className={HINT}>Replaces everything currently loaded</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              onClick={() => {
                setOpen(false);
                setSnapshotsOpen(true);
              }}
            >
              Restore a local snapshot…
              <span className={HINT}>
                Automatic copies kept in this browser, out of reach of cloud sync
              </span>
            </button>
          </Group>

          <Group label="Connections">
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              onClick={() => {
                setOpen(false);
                setSchwabOpen(true);
              }}
            >
              Schwab connection…
              <span className={HINT}>Sign in, or register your own Schwab app</span>
            </button>
          </Group>

          <Group label="Account">
            <AccountTopMenuItem onClose={() => setOpen(false)} />
            <SignOutMenuItem onClose={() => setOpen(false)} />
          </Group>
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
          className="absolute right-0 z-30 mt-1 w-72 rounded-md border border-border bg-panel px-3 py-2 text-[12px] text-foreground shadow-lg"
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

      {snapshotsOpen && <SnapshotRestoreDialog onClose={() => setSnapshotsOpen(false)} />}
      {schwabOpen && <SchwabSettingsDialog onClose={() => setSchwabOpen(false)} />}
    </div>
  );
}
