"use client";

import { useState } from "react";
import type { Account, LedgerEvent, Person, ScenarioEvent, TimelineRow } from "@/domain";
import { EventDrawer } from "./EventDrawer";

const EVENT_TYPE_LABELS: Record<string, string> = {
  retire: "Retire",
  buy_home: "Buy a home",
  social_security_start: "Social Security",
  have_a_kid: "Have a kid",
  custom_transfer: "Transfer",
  growth_rate_change: "Growth rate",
};

const LEDGER_KIND_LABELS: Record<LedgerEvent["kind"], string> = {
  rmd: "RMD",
  deficit_withdrawal: "Withdrawal",
  mortgage_payment: "Mortgage",
};

function fmt(n: number): string {
  return `$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function EventsTable({
  timeline,
  ledger,
  accounts,
  events,
  editableAccounts,
  people,
}: {
  timeline: TimelineRow[];
  ledger: LedgerEvent[];
  accounts: Account[];
  events: ScenarioEvent[];
  editableAccounts: Account[];
  people: Person[];
}) {
  const [drawerEvent, setDrawerEvent] = useState<ScenarioEvent | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sortedTimeline = [...timeline].sort((a, b) => a.date.localeCompare(b.date));
  const sortedLedger = [...ledger].sort((a, b) => a.date.localeCompare(b.date));
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "an account";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setDrawerEvent(undefined);
            setDrawerOpen(true);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          + Add Event
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-panel">
        <div className="border-b border-border px-2 py-2 text-xs font-semibold text-dim">Timeline</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-dim">
              <th className="py-2 pl-2 font-medium">Date</th>
              <th className="py-2 font-medium">Type</th>
              <th className="py-2 pr-2 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {sortedTimeline.map((row) => (
              <tr
                key={row.eventId}
                className="cursor-pointer border-t border-border hover:bg-background/40"
                onClick={() => {
                  const found = events.find((e) => e.id === row.eventId);
                  if (found) {
                    setDrawerEvent(found);
                    setDrawerOpen(true);
                  }
                }}
              >
                <td className="py-2 pl-2 text-dim">{row.date}</td>
                <td className="py-2">
                  <span className="rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
                    {EVENT_TYPE_LABELS[row.eventType]}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  {row.description}
                  {row.isExcluded && <span className="ml-2 text-xs text-dim">(excluded)</span>}
                </td>
              </tr>
            ))}
            {sortedTimeline.length === 0 && (
              <tr>
                <td colSpan={3} className="py-8 text-center text-dim">No events yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-panel">
        <div className="border-b border-border px-2 py-2 text-xs font-semibold text-dim">
          Automatic Withdrawals &amp; RMDs
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-dim">
              <th className="py-2 pl-2 font-medium">Date</th>
              <th className="py-2 font-medium">Kind</th>
              <th className="py-2 font-medium">Detail</th>
              <th className="py-2 pr-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="max-h-64 overflow-y-auto">
            {sortedLedger.slice(0, 500).map((entry, i) => (
              <tr key={i} className="border-t border-border hover:bg-background/40">
                <td className="py-1.5 pl-2 text-dim">{entry.date}</td>
                <td className="py-1.5">
                  <span className="rounded bg-positive/20 px-2 py-0.5 text-xs text-positive">
                    {LEDGER_KIND_LABELS[entry.kind]}
                  </span>
                </td>
                <td className="py-1.5 text-dim">
                  {accountName(entry.accountId)}
                  {entry.toAccountId ? ` → ${accountName(entry.toAccountId)}` : ""} — {entry.note}
                </td>
                <td className="py-1.5 pr-2 text-right">{fmt(entry.amount)}</td>
              </tr>
            ))}
            {sortedLedger.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-dim">None in this scenario.</td>
              </tr>
            )}
          </tbody>
        </table>
        {sortedLedger.length > 500 && (
          <p className="border-t border-border px-2 py-2 text-xs text-dim">
            Showing the first 500 of {sortedLedger.length} entries.
          </p>
        )}
      </div>

      <EventDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        event={drawerEvent}
        accounts={editableAccounts}
        people={people}
      />
    </div>
  );
}
