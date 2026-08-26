"use client";

import { useEffect, useMemo, useState } from "react";
import { isOptionSymbol, normalizeSymbol, type Portfolio } from "@/domain/portfolio";
import {
  proposeDividends,
  type DividendEvent,
  type ProposedDividend,
} from "@/engine/portfolio/dividends";
import { money, shortDate } from "@/lib/portfolio/format";
import { Btn } from "@/components/ui/controls";

const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

/**
 * Finds the dividends the ledger is missing and offers them for review.
 *
 * Nothing is written until it is accepted. These rows land in the same ledger
 * every holding, tax lot and return figure is replayed from, so a run that
 * quietly added a few hundred transactions -- some of them duplicating what a
 * statement import already recorded -- would be very hard to unpick afterwards.
 * Reviewing them costs one click and makes the whole thing legible.
 */
export function DividendSyncDialog({
  portfolio,
  scopeAccountIds,
  onClose,
  onApply,
}: {
  portfolio: Portfolio;
  /** null = every account (the "all" scope); otherwise the account ids the
   *  header's person-or-account picker currently covers. */
  scopeAccountIds: readonly string[] | null;
  onClose: () => void;
  onApply: (proposals: ProposedDividend[]) => void;
}) {
  const [loaded, setLoaded] = useState<{
    events: Map<string, DividendEvent[]>;
    failed: boolean;
  } | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());

  const accountNames = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a.name])),
    [portfolio.accounts],
  );

  const scopedTransactions = useMemo(
    () =>
      scopeAccountIds === null
        ? portfolio.transactions
        : portfolio.transactions.filter((tx) => scopeAccountIds.includes(tx.accountId)),
    [portfolio.transactions, scopeAccountIds],
  );

  /**
   * Symbols worth asking about.
   *
   * Every stock the ledger ever touched belongs here -- a dividend can be owed
   * on a position that has since been sold. Option contracts do not: they pay
   * nothing, and a ledger with a few years of them behind it would spend most
   * of this request asking the feed about expired tickers it will never answer
   * for, crowding out the holdings that do pay.
   */
  const symbols = useMemo(() => {
    const set = new Set<string>();
    for (const tx of scopedTransactions) {
      if (!tx.symbol) continue;
      const symbol = normalizeSymbol(tx.symbol);
      if (isOptionSymbol(symbol)) continue;
      set.add(symbol);
    }
    return [...set].sort();
  }, [scopedTransactions]);

  const symbolKey = symbols.join(",");

  useEffect(() => {
    if (!symbolKey) return;

    let cancelled = false;
    fetch(`/api/prices/dividends?symbols=${encodeURIComponent(symbolKey)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { dividends?: Record<string, DividendEvent[]> }) => {
        if (cancelled) return;
        setLoaded({ events: new Map(Object.entries(body.dividends ?? {})), failed: false });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ events: new Map(), failed: true });
      });

    return () => {
      cancelled = true;
    };
  }, [symbolKey]);

  const { proposals, skippedExisting } = useMemo(() => {
    if (!loaded) return { proposals: [] as ProposedDividend[], skippedExisting: 0 };
    return proposeDividends(scopedTransactions, loaded.events, {
      accountIds: scopeAccountIds ?? undefined,
    });
  }, [loaded, scopedTransactions, scopeAccountIds]);

  const selected = useMemo(
    () => proposals.filter((p) => !excluded.has(p.key)),
    [proposals, excluded],
  );
  const total = selected.reduce((sum, p) => sum + p.amount, 0);

  /** Grouped by symbol, newest first inside each, because that is how the
   *  question gets asked: "did I get everything on VTI". */
  const groups = useMemo(() => {
    const map = new Map<string, ProposedDividend[]>();
    for (const proposal of proposals) {
      const bucket = map.get(proposal.symbol);
      if (bucket) bucket.push(proposal);
      else map.set(proposal.symbol, [proposal]);
    }
    return [...map.entries()]
      .map(([symbol, rows]) => ({
        symbol,
        rows: [...rows].sort((a, b) => (a.date < b.date ? 1 : -1)),
        total: rows.reduce((sum, r) => sum + r.amount, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [proposals]);

  const toggle = (key: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const toggleSymbol = (symbol: string) => {
    const rows = groups.find((g) => g.symbol === symbol)?.rows ?? [];
    const allOn = rows.every((r) => !excluded.has(r.key));
    setExcluded((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (allOn) next.add(row.key);
        else next.delete(row.key);
      }
      return next;
    });
  };

  // A portfolio with no symbols has nothing to fetch and nothing to wait for,
  // so it reads as settled rather than as perpetually loading.
  const loading = symbolKey !== "" && loaded === null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[15px] font-semibold text-foreground">Dividends from the price feed</h2>
          <p className="mt-1 max-w-2xl text-[12px] text-dim">
            Worked out from what you held on each ex-dividend date. Anything your statements already
            recorded is left alone. Nothing is added until you say so.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="py-10 text-center text-[13px] text-dim">Checking every holding…</p>
          ) : loaded?.failed ? (
            <p className="py-10 text-center text-[13px] text-dim">
              Couldn&apos;t reach the price feed. It may be rate-limiting — try again shortly.
            </p>
          ) : proposals.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-dim">
              {skippedExisting > 0
                ? `Nothing missing. ${skippedExisting} payment${
                    skippedExisting === 1 ? " is" : "s are"
                  } already in your ledger.`
                : "No dividends found for these holdings."}
            </p>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => {
                const allOn = group.rows.every((r) => !excluded.has(r.key));
                return (
                  <div key={group.symbol}>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="flex items-center gap-2 text-[12.5px] font-semibold text-foreground">
                        <input type="checkbox" checked={allOn} onChange={() => toggleSymbol(group.symbol)} />
                        {group.symbol}
                        <span className="font-normal text-dim-2">
                          {group.rows.length} payment{group.rows.length === 1 ? "" : "s"}
                        </span>
                      </label>
                      <span className="text-[12.5px] font-semibold tabular-nums text-foreground">
                        {money(group.total)}
                      </span>
                    </div>
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          <th className={`${HEAD} text-left`}>Ex-date</th>
                          <th className={`${HEAD} text-left`}>Account</th>
                          <th className={`${HEAD} text-right`}>Shares</th>
                          <th className={`${HEAD} text-right`}>Per share</th>
                          <th className={`${HEAD} text-right`}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((row) => (
                          <tr
                            key={row.key}
                            onClick={() => toggle(row.key)}
                            className={`cursor-pointer border-b border-border-soft transition-colors hover:bg-panel-2 ${
                              excluded.has(row.key) ? "opacity-40" : ""
                            }`}
                          >
                            <td className={`${CELL} text-left text-dim`}>
                              <span className="flex items-center gap-2">
                                <input type="checkbox" readOnly checked={!excluded.has(row.key)} />
                                {shortDate(row.date)}
                              </span>
                            </td>
                            <td className={`${CELL} text-left text-dim`}>
                              {accountNames.get(row.accountId) ?? "—"}
                            </td>
                            <td className={`${CELL} text-right text-dim`}>
                              {row.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                            </td>
                            <td className={`${CELL} text-right text-dim`}>
                              ${row.perShare.toFixed(4)}
                            </td>
                            <td className={`${CELL} text-right font-semibold text-foreground`}>
                              {money(row.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="text-[12px] text-dim">
            {proposals.length > 0 && (
              <>
                <span className="font-semibold text-foreground">
                  {selected.length} of {proposals.length}
                </span>{" "}
                selected · {money(total)}
                {skippedExisting > 0 && (
                  <span className="ml-2 text-dim-2">
                    {skippedExisting} already recorded, skipped
                  </span>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn
              variant="primary"
              onClick={() => selected.length > 0 && onApply(selected)}
              className={selected.length === 0 ? "pointer-events-none opacity-40" : ""}
            >
              Add {selected.length} dividend{selected.length === 1 ? "" : "s"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
