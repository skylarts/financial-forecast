"use client";

import { useMemo, useState } from "react";
import { SchwabFetchPanel } from "./SchwabFetchPanel";
import type { PortfolioAccount, Transaction } from "@/domain/portfolio";
import { TRANSACTION_TYPE_LABELS } from "@/domain/portfolio";
import {
  buildImportRows,
  guessMapping,
  parseDelimited,
  IMPORT_FIELD_LABELS,
  type ColumnMapping,
  type ImportField,
  type ImportRow,
} from "@/lib/portfolio/importer";
import { money, price, shares, shortDate } from "@/lib/portfolio/format";
import { Btn } from "@/components/ui/controls";
import { accountFamilyIds, accountTreeRows, sleevesOf } from "@/lib/portfolio/accountTree";
import { suggestSleeve } from "@/lib/portfolio/taxSource";

/** One importable row and the account it has been routed to. */
export interface ImportAssignment {
  accountId: string;
  row: ImportRow;
}

const FIELD_ORDER: ImportField[] = [
  "date",
  "type",
  "symbol",
  "quantity",
  "price",
  "amount",
  "fees",
  "lotId",
  "acquiredDate",
  "taxSource",
  "note",
];

const HEAD = "px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-dim-2";
const CELL = "px-2 py-1.5 text-[11.5px] tabular-nums";

const SAMPLE = `Run Date,Action,Symbol,Quantity,Price,Amount
01/10/2024,YOU BOUGHT,VTI,10,220.50,-2205.00
04/15/2024,DIVIDEND RECEIVED,VTI,,,42.10`;

export function ImportDialog({
  accounts,
  existingTransactions,
  securities,
  onImport,
  onClose,
}: {
  accounts: PortfolioAccount[];
  existingTransactions: Transaction[];
  /** The ledger's own securities, used to put a symbol back on a Schwab
   *  dividend -- Schwab names the company in prose and the symbol nowhere. */
  securities: readonly { symbol: string; name: string }[];
  onImport: (assignments: ImportAssignment[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [mappingOverride, setMappingOverride] = useState<Partial<ColumnMapping>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  /** Money-source label -> the sleeve its rows belong in. Only what the user
   *  has actually chosen; unset labels fall back to a guess. */
  const [routing, setRouting] = useState<Record<string, string>>({});

  const table = useMemo(() => parseDelimited(text), [text]);
  const mapping = useMemo<ColumnMapping>(
    () => ({ ...guessMapping(table.headers), ...mappingOverride }),
    [table.headers, mappingOverride],
  );
  // A split account's file fans out across its sleeves, so duplicate and
  // synced-dividend detection has to look at the whole family rather than
  // just the account named in the picker.
  const familyIds = useMemo(
    () => (accountId ? accountFamilyIds(accounts, accountId) : []),
    [accounts, accountId],
  );
  const rows = useMemo(
    () => buildImportRows(table, mapping, existingTransactions, familyIds),
    [table, mapping, existingTransactions, familyIds],
  );

  // The sleeves rows can be routed to, and the distinct source labels the file
  // actually contains -- in first-seen order, so the table reads like the file.
  const sleeves = useMemo(() => sleevesOf(accounts, accountId), [accounts, accountId]);
  const sourceLabels = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) {
      if (row.taxSourceLabel && !seen.includes(row.taxSourceLabel)) seen.push(row.taxSourceLabel);
    }
    return seen;
  }, [rows]);
  const routable = sleeves.length > 0 && sourceLabels.length > 0;

  // What each label resolves to: the user's choice if they made one, else the
  // guess read off the label, else nothing -- which leaves those rows on the
  // parent as unassigned rather than picking a pot for them.
  const resolvedRouting = useMemo(() => {
    const out: Record<string, string> = {};
    for (const label of sourceLabels) {
      out[label] = routing[label] ?? suggestSleeve(label, sleeves)?.id ?? "";
    }
    return out;
  }, [sourceLabels, routing, sleeves]);

  const accountForRow = (row: ImportRow) =>
    (routable && resolvedRouting[row.taxSourceLabel]) || accountId;

  const importable = rows.filter((row) => !row.skip && !(skipDuplicates && row.duplicate));
  const unrouted = routable
    ? importable.filter((row) => !resolvedRouting[row.taxSourceLabel]).length
    : 0;
  const skipped = rows.length - importable.length;
  const flagged = importable.filter((row) => row.issues.length > 0).length;
  const replacing = importable.filter((row) => row.syncMatchId !== null).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-[15px] font-semibold text-foreground">Import transactions</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-dim hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="text-[12px] text-dim">
              <span className="mb-1 block text-dim-2">Import into</span>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
              >
                {accountTreeRows(accounts).map(({ account, depth }) => (
                  <option key={account.id} value={account.id}>
                    {depth > 0 ? `\u00a0\u00a0↳ ${account.name}` : account.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[12px] text-dim">
              <span className="mb-1 block text-dim-2">Or upload a file</span>
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

            <label className="flex items-center gap-1.5 text-[12px] text-dim">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
              />
              Skip rows already imported
            </label>
          </div>

          {/* Above the box rather than beside the file picker: fetching fills
              the same box, so it reads as one more way to get text in. */}
          <SchwabFetchPanel
            accounts={accounts}
            securities={securities}
            onFetched={(csv, linkedAccountId) => {
              setText(csv);
              // Only when a link exists -- an unlinked fetch leaves whatever
              // the picker above already had, rather than silently landing
              // rows wherever the picker happened to be pointed.
              if (linkedAccountId) setAccountId(linkedAccountId);
            }}
          />

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Paste a CSV or markdown table here, for example:\n\n${SAMPLE}`}
            rows={7}
            className="w-full rounded-md border border-border bg-panel-2 px-3 py-2 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
          />

          {table.headers.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-[12.5px] font-semibold text-foreground">
                Column mapping
                <span className="ml-2 font-normal text-dim-2">
                  guessed from your header row — change anything it got wrong
                </span>
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {FIELD_ORDER.map((field) => (
                  <label key={field} className="text-[11.5px] text-dim">
                    <span className="mb-0.5 block text-dim-2">{IMPORT_FIELD_LABELS[field]}</span>
                    <select
                      value={mapping[field] ?? ""}
                      onChange={(e) =>
                        setMappingOverride((prev) => ({
                          ...prev,
                          [field]: e.target.value === "" ? null : Number(e.target.value),
                        }))
                      }
                      className="w-full rounded-md border border-border bg-panel-2 px-2 py-1 text-[11.5px] text-foreground"
                    >
                      <option value="">— none —</option>
                      {table.headers.map((header, index) => (
                        <option key={index} value={index}>
                          {header || `Column ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              {routable && (
                <div className="mt-4 rounded-md border border-border bg-panel-2/40 p-3">
                  <h3 className="text-[12.5px] font-semibold text-foreground">
                    Money source
                    <span className="ml-2 font-normal text-dim-2">
                      this file names {sourceLabels.length} source
                      {sourceLabels.length === 1 ? "" : "s"} — send each to the sleeve it belongs in
                    </span>
                  </h3>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {sourceLabels.map((label) => (
                      <label key={label} className="flex items-center gap-2 text-[11.5px]">
                        <span
                          className="min-w-0 flex-1 truncate text-dim"
                          title={label}
                        >
                          {label}
                        </span>
                        <select
                          value={resolvedRouting[label]}
                          onChange={(e) =>
                            setRouting((prev) => ({ ...prev, [label]: e.target.value }))
                          }
                          className={`w-44 rounded-md border bg-panel-2 px-2 py-1 text-[11.5px] text-foreground ${
                            resolvedRouting[label] ? "border-border" : "border-negative"
                          }`}
                        >
                          <option value="">— leave unassigned —</option>
                          {sleeves.map((sleeve) => (
                            <option key={sleeve.id} value={sleeve.id}>
                              {sleeve.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-dim-2">
                    Anything left unassigned stays on the parent account and is held back from the
                    forecast, rather than being counted as pre-tax or Roth on a guess.
                  </p>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between">
                <h3 className="text-[12.5px] font-semibold text-foreground">
                  Preview
                  <span className="ml-2 font-normal text-dim-2">
                    {importable.length} to import
                    {skipped > 0 && `, ${skipped} skipped`}
                    {flagged > 0 && `, ${flagged} needing a look`}
                  </span>
                </h3>
              </div>

              <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-panel-2">
                    <tr className="border-b border-border">
                      <th className={`${HEAD} text-left`}>Date</th>
                      <th className={`${HEAD} text-left`}>Type</th>
                      <th className={`${HEAD} text-left`}>Symbol</th>
                      <th className={`${HEAD} text-right`}>Shares</th>
                      <th className={`${HEAD} text-right`}>Price</th>
                      <th className={`${HEAD} text-right`}>Amount</th>
                      {routable && <th className={`${HEAD} text-left`}>Goes to</th>}
                      <th className={`${HEAD} text-left`}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 200).map((row, index) => {
                      const dropped = row.skip || (skipDuplicates && row.duplicate);
                      return (
                        <tr
                          key={index}
                          className={`border-b border-border-soft ${dropped ? "opacity-45" : ""}`}
                        >
                          <td className={`${CELL} text-left text-dim`}>
                            {row.draft.date ? shortDate(row.draft.date) : "—"}
                          </td>
                          <td className={`${CELL} text-left text-foreground`}>
                            {TRANSACTION_TYPE_LABELS[row.draft.type]}
                          </td>
                          <td className={`${CELL} text-left text-dim`}>{row.draft.symbol ?? "—"}</td>
                          <td className={`${CELL} text-right text-dim`}>
                            {row.draft.quantity > 0 ? shares(row.draft.quantity) : "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>
                            {row.draft.price > 0 ? price(row.draft.price) : "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>
                            {row.draft.amount === null ? "—" : money(row.draft.amount)}
                          </td>
                          {routable && (
                            <td className={`${CELL} text-left`}>
                              {resolvedRouting[row.taxSourceLabel] ? (
                                <span className="text-dim">
                                  {sleeves.find((a) => a.id === resolvedRouting[row.taxSourceLabel])?.name}
                                </span>
                              ) : (
                                <span className="text-accent">Unassigned</span>
                              )}
                            </td>
                          )}
                          <td className={`${CELL} text-left`}>
                            {row.skip ? (
                              <span className="text-negative">{row.issues[0]}</span>
                            ) : row.duplicate ? (
                              <span className="text-dim-2">Already imported</span>
                            ) : row.syncMatchId ? (
                              <span className="text-accent">Replaces a synced dividend</span>
                            ) : row.issues.length > 0 ? (
                              <span className="text-accent">{row.issues[0]}</span>
                            ) : (
                              <span className="text-positive">Ready</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length > 200 && (
                <p className="mt-1 text-[11.5px] text-dim-2">
                  Showing the first 200 of {rows.length} rows. All {importable.length} importable rows
                  will be added.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-[11.5px] text-dim-2">
            {unrouted > 0 && (
              <span className="text-accent">
                {unrouted} row{unrouted === 1 ? " has" : "s have"} no sleeve and will sit on the
                parent as unassigned.{" "}
              </span>
            )}
            {replacing > 0 &&
              `${replacing} of these replace${replacing === 1 ? "s" : ""} a dividend the price-feed sync added earlier — that entry will be removed.`}
          </p>
          <div className="flex items-center gap-2">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn
              variant="primary"
              onClick={() => {
                if (!accountId || importable.length === 0) return;
                onImport(importable.map((row) => ({ accountId: accountForRow(row), row })));
              }}
            >
              Import {importable.length} transaction{importable.length === 1 ? "" : "s"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
