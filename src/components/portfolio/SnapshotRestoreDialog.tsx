"use client";

import { useEffect, useState } from "react";
import {
  listSnapshots,
  readSnapshot,
  SNAPSHOT_LIMIT,
  type SnapshotMeta,
} from "@/lib/portfolio/portfolioSnapshots";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { Btn } from "@/components/ui/controls";

/**
 * The way back to a ledger that has gone missing.
 *
 * The tracker keeps a copy of the transactions every time a change would lose
 * some of them -- a bulk delete, an undone import, a restore, a cloud load
 * that came back thinner than what was already here. This is where those
 * copies are read back.
 *
 * Deliberately shows the transaction count next to each entry rather than just
 * a timestamp: the question someone opens this dialog asking is "which one
 * still has my history in it", and the count answers it directly.
 */

function whenLabel(iso: string): string {
  const at = new Date(iso);
  const date = at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

export function SnapshotRestoreDialog({ onClose }: { onClose: () => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadPortfolio = usePortfolioStore((s) => s.loadPortfolio);
  const currentCount = usePortfolioStore((s) => s.portfolio.transactions.length);

  useEffect(() => {
    void listSnapshots().then(setSnapshots);
  }, []);

  const restore = async (id: number) => {
    setRestoring(id);
    setError(null);
    const portfolio = await readSnapshot(id);
    if (!portfolio) {
      setError("That snapshot could not be read. Try another one.");
      setRestoring(null);
      return;
    }
    // Restoring is itself a wholesale replacement, so the store snapshots
    // whatever is on screen now before swapping it out -- picking the wrong
    // entry here is undoable.
    loadPortfolio(portfolio);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-panel p-4">
        <h2 className="text-[15px] font-semibold text-foreground">Restore a local snapshot</h2>
        <p className="mt-1 text-[12px] text-dim">
          Saved automatically in this browser whenever a change would have lost transactions. The
          last {SNAPSHOT_LIMIT} are kept, and they are never touched by cloud sync.
        </p>

        {snapshots === null && <p className="mt-4 text-[12.5px] text-dim-2">Looking…</p>}

        {snapshots !== null && snapshots.length === 0 && (
          <p className="mt-4 text-[12.5px] text-dim-2">
            No snapshots yet. One is written the first time a change would lose transactions —
            nothing has, so there is nothing here, which is the good case.
          </p>
        )}

        {snapshots !== null && snapshots.length > 0 && (
          <ul className="mt-3 divide-y divide-border-soft">
            {snapshots.map((snapshot) => (
              <li key={snapshot.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[12.5px] text-foreground">
                    {snapshot.transactionCount.toLocaleString()} transactions
                    <span className="text-dim-2"> · {snapshot.accountCount} accounts</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-dim">
                    {whenLabel(snapshot.takenAt)} — before {snapshot.reason}
                  </div>
                </div>
                <Btn
                  onClick={() => {
                    if (restoring !== null) return;
                    void restore(snapshot.id);
                  }}
                  className={restoring !== null ? "pointer-events-none opacity-40" : ""}
                  title={
                    snapshot.transactionCount < currentCount
                      ? `This snapshot has fewer transactions (${snapshot.transactionCount.toLocaleString()}) than what is loaded now (${currentCount.toLocaleString()}).`
                      : undefined
                  }
                >
                  {restoring === snapshot.id ? "Restoring…" : "Restore"}
                </Btn>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="mt-3 text-[12px] text-negative">{error}</p>}

        <div className="mt-4 flex justify-end">
          <Btn onClick={onClose}>Close</Btn>
        </div>
      </div>
    </div>
  );
}
