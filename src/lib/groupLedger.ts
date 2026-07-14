import type { LedgerEvent } from "@/domain";

export interface LedgerGroup {
  key: string;
  year: number;
  kind: LedgerEvent["kind"];
  accountId: string;
  toAccountId?: string;
  totalAmount: number;
  entries: LedgerEvent[];
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** Groups ledger entries by year + kind + account (+ toAccount), summing amounts within each group. */
export function groupLedgerByYear(ledger: LedgerEvent[]): LedgerGroup[] {
  const groups = new Map<string, LedgerGroup>();

  for (const entry of ledger) {
    const year = yearOf(entry.date);
    const key = `${year}|${entry.kind}|${entry.accountId}|${entry.toAccountId ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        year,
        kind: entry.kind,
        accountId: entry.accountId,
        toAccountId: entry.toAccountId,
        totalAmount: 0,
        entries: [],
      };
      groups.set(key, group);
    }
    group.totalAmount += entry.amount;
    group.entries.push(entry);
  }

  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  return [...groups.values()].sort(
    (a, b) => a.year - b.year || a.kind.localeCompare(b.kind) || a.accountId.localeCompare(b.accountId)
  );
}
