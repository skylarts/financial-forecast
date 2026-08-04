"use client";

import { useMemo, useState } from "react";
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
  onImport,
  onClose,
}: {
  accounts: PortfolioAccount[];
  existingTransactions: Transaction[];
  onImport: (accountId: string, rows: ImportRow[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [mappingOverride, setMappingOverride] = useState<Partial<ColumnMapping>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);

  const table = useMemo(() => parseDelimited(text), [text]);
  const mapping = useMemo<ColumnMapping>(
    () => ({ ...guessMapping(table.headers), ...mappingOverride }),
    [table.headers, mappingOverride],
  );
  const rows = useMemo(
    () => buildImportRows(table, mapping, existingTransactions),
    [table, mapping, existingTransactions],
  );

  const importable = rows.filter((row) => !row.skip && !(skipDuplicates && row.duplicate));
  const skipped = rows.length - importable.length;
  const flagged = importable.filter((row) => row.issues.length > 0).length;

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
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
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
                          <td className={`${CELL} text-left`}>
                            {row.skip ? (
                              <span className="text-negative">{row.issues[0]}</span>
                            ) : row.duplicate ? (
                              <span className="text-dim-2">Already imported</span>
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

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              if (accountId && importable.length > 0) onImport(accountId, importable);
            }}
          >
            Import {importable.length} transaction{importable.length === 1 ? "" : "s"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
