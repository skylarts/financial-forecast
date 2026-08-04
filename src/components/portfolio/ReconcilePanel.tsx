"use client";

import { useMemo, useState } from "react";
import type { PortfolioAccount } from "@/domain/portfolio";
import type { Holding } from "@/engine/portfolio/metrics";
import {
  parseHoldingsStatement,
  reconcileHoldings,
  type ReconcileRow,
  type ReconcileStatus,
} from "@/lib/portfolio/reconcile";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { money, shares } from "@/lib/portfolio/format";
import { Btn } from "@/components/ui/controls";

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";
const HEAD = "px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

const SAMPLE = `Symbol,Quantity,Total Cost
VTI,30,5981.25
AAPL,25,3768.75`;

const STATUS_STYLE: Record<ReconcileStatus, { label: string; className: string }> = {
  match: { label: "Match", className: "text-positive" },
  missing_buys: { label: "Missing buys", className: "text-negative" },
  missing_sells: { label: "Missing sells", className: "text-negative" },
  not_held: { label: "Not on statement", className: "text-accent" },
  unknown_position: { label: "No history", className: "text-negative" },
};

export function ReconcilePanel({
  accounts,
  holdings,
}: {
  accounts: PortfolioAccount[];
  holdings: Holding[];
}) {
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [hideMatches, setHideMatches] = useState(false);
  const [fixed, setFixed] = useState<Set<string>>(new Set());

  const statement = useMemo(() => parseHoldingsStatement(text), [text]);
  const result = useMemo(
    () => reconcileHoldings(statement, holdings, accountId),
    [statement, holdings, accountId],
  );

  const visible = hideMatches ? result.rows.filter((r) => r.status !== "match") : result.rows;

  /**
   * Writes the one transaction that would make the ledger agree with the
   * statement. Recorded as a transfer in/out rather than a buy or sell: you
   * don't know the real trade date or price, and inventing one would quietly
   * corrupt cost basis and holding period. A transfer carries an explicit basis
   * and is obviously a placeholder to go back and correct.
   */
  const addBalancingEntry = (row: ReconcileRow) => {
    const missing = Math.abs(row.difference);
    const addingShares = row.difference > 0;
    const perShare =
      row.statementCostBasis !== null && row.statementQuantity > 0
        ? row.statementCostBasis / row.statementQuantity
        : 0;

    addTransaction({
      accountId,
      date: asOf,
      type: addingShares ? "transfer_in" : "transfer_out",
      symbol: row.symbol,
      quantity: missing,
      price: perShare,
      amount: perShare > 0 ? perShare * missing : null,
      fees: 0,
      lotId: null,
      acquiredDate: null,
      note: `Balancing entry from holdings reconciliation on ${asOf}`,
      importBatchId: null,
      sourceHash: null,
    });
    setFixed((prev) => new Set(prev).add(`${row.symbol}::${row.side}`));
  };

  return (
    <div className="p-5">
      <div className="mb-3">
        <h2 className="text-[14px] font-semibold text-foreground">Reconcile against a statement</h2>
        <p className="mt-0.5 max-w-3xl text-[12px] text-dim">
          The oversell warning can only catch a gap at the moment you sell. Paste what you actually
          hold today and this finds the gaps in positions you&apos;ve never sold — which is most of
          them.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Account</span>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={INPUT}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Statement date</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={INPUT} />
        </label>
        <label className="text-[11.5px] text-dim-2">
          <span className="mb-0.5 block">Or upload a file</span>
          <input
            type="file"
            accept=".csv,.txt,.md,.tsv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setText(await file.text());
            }}
            className="text-[12px] text-dim file:mr-2 file:rounded-md file:border file:border-border file:bg-panel-2 file:px-2 file:py-1 file:text-[12px] file:text-foreground"
          />
        </label>
        {result.rows.length > 0 && (
          <label className="flex items-center gap-1.5 text-[12px] text-dim">
            <input
              type="checkbox"
              checked={hideMatches}
              onChange={(e) => setHideMatches(e.target.checked)}
            />
            Show only problems
          </label>
        )}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Paste your current holdings, for example:\n\n${SAMPLE}\n\nA bare "VTI 30" per line works too. Negative quantities are read as short positions.`}
        rows={7}
        className="w-full rounded-md border border-border bg-panel-2 px-3 py-2 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
      />

      {statement.length === 0 && text.trim() !== "" && (
        <p className="mt-2 text-[12.5px] text-negative">
          No positions could be read from that. Each line needs a symbol and a share count.
        </p>
      )}

      {result.rows.length > 0 && (
        <>
          <div className="mt-4 flex items-center gap-4">
            <h3 className="text-[12.5px] font-semibold text-foreground">
              {result.discrepancies === 0
                ? `All ${result.matched} positions agree with your transaction history.`
                : `${result.discrepancies} position${result.discrepancies === 1 ? "" : "s"} to fix`}
            </h3>
            {result.matched > 0 && result.discrepancies > 0 && (
              <span className="text-[12px] text-dim-2">{result.matched} already agree</span>
            )}
          </div>

          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse">
              <thead className="bg-panel-2">
                <tr className="border-b border-border">
                  <th className={`${HEAD} text-left`}>Symbol</th>
                  <th className={`${HEAD} text-right`}>Your ledger</th>
                  <th className={`${HEAD} text-right`}>Statement</th>
                  <th className={`${HEAD} text-right`}>Difference</th>
                  <th className={`${HEAD} text-left`}>Status</th>
                  <th className={`${HEAD} text-left`}>What it means</th>
                  <th className={`${HEAD} text-right`}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const key = `${row.symbol}::${row.side}`;
                  const style = STATUS_STYLE[row.status];
                  return (
                    <tr key={key} className="border-b border-border-soft">
                      <td className={`${CELL} text-left font-semibold text-foreground`}>
                        {row.symbol}
                        {row.side === "short" && (
                          <span className="ml-1.5 rounded-sm border border-negative px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-negative">
                            Short
                          </span>
                        )}
                      </td>
                      <td className={`${CELL} text-right text-dim`}>{shares(row.ledgerQuantity)}</td>
                      <td className={`${CELL} text-right text-dim`}>{shares(row.statementQuantity)}</td>
                      <td
                        className={`${CELL} text-right ${
                          row.status === "match" ? "text-dim-2" : "text-foreground"
                        }`}
                      >
                        {row.difference > 0 ? "+" : ""}
                        {shares(row.difference)}
                      </td>
                      <td className={`${CELL} text-left ${style.className}`}>{style.label}</td>
                      <td className="px-3 py-2 text-[12px] text-dim">{row.advice}</td>
                      <td className={`${CELL} text-right`}>
                        {row.status !== "match" &&
                          (fixed.has(key) ? (
                            <span className="text-[11.5px] text-positive">Entry added</span>
                          ) : (
                            <Btn
                              onClick={() => addBalancingEntry(row)}
                              title={
                                row.statementCostBasis !== null
                                  ? `Add a ${
                                      row.difference > 0 ? "transfer in" : "transfer out"
                                    } for ${shares(Math.abs(row.difference))} shares at ${money(
                                      (row.statementCostBasis / row.statementQuantity) *
                                        Math.abs(row.difference),
                                    )} basis`
                                  : "Add a placeholder transfer for the missing shares — edit its date and basis afterwards"
                              }
                            >
                              Add balancing entry
                            </Btn>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {result.discrepancies > 0 && (
            <p className="mt-2 max-w-3xl text-[11.5px] text-dim-2">
              A balancing entry is recorded as a transfer, not a trade: without the real date and
              price, calling it a purchase would put a wrong cost basis and holding period into your
              tax lots. Find the original transaction when you can and correct it.
            </p>
          )}
        </>
      )}
    </div>
  );
}
