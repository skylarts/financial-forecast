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

/**
 * Which pile a row is in. Exactly one each, so the tab counts add up to the
 * file's length and a row can never hide from every filter.
 */
type Bucket = "ready" | "flagged" | "duplicate" | "error";

function bucketOf(row: ImportRow): Bucket {
  if (row.skip) return "error";
  if (row.duplicate) return "duplicate";
  return row.issues.length > 0 ? "flagged" : "ready";
}

const BUCKET_LABELS: Record<Bucket, string> = {
  ready: "Ready",
  flagged: "Needs a look",
  duplicate: "Already imported",
  error: "Can't import",
};

const BUCKET_ORDER: Bucket[] = ["ready", "flagged", "duplicate", "error"];

/**
 * Rows drawn before the "show more" controls appear. A statement backfill runs
 * to thousands of rows and putting them all in the DOM at once locks the
 * dialog up, but the filters are what make a long file navigable anyway --
 * this is the starting window, not a cap on what can be reviewed.
 */
const PAGE = 250;

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

  /**
   * How the user is reviewing this file: which group they are filtering to,
   * what they have ticked or unticked by hand (only the rows they actually
   * touched -- everything else follows the default), and how far down the list
   * they have asked to see.
   *
   * All of it is held against the row list it was chosen for. A new file, a
   * remapped column or a different target account rebuilds every row, and
   * none of those choices point at anything any more -- a filter least of all,
   * which would otherwise leave the next file looking empty. Comparing here
   * drops them in the same render, rather than an effect clearing them a
   * render too late with a stale table drawn in between.
   */
  interface Review {
    rows: ImportRow[];
    filter: Bucket | "all";
    picks: Record<number, boolean>;
    visible: number;
  }
  const fresh: Review = { rows, filter: "all", picks: {}, visible: PAGE };
  const [review, setReview] = useState<Review>(fresh);
  const { filter, picks: selection, visible } = review.rows === rows ? review : fresh;

  const amend = (change: (current: Review) => Partial<Review>) =>
    setReview((prev) => {
      const base = prev.rows === rows ? prev : fresh;
      return { ...base, ...change(base) };
    });
  const setFilter = (next: Bucket | "all") => amend(() => ({ filter: next, visible: PAGE }));
  const setPicks = (next: (picks: Record<number, boolean>) => Record<number, boolean>) =>
    amend((base) => ({ picks: next(base.picks) }));
  const setVisible = (next: (n: number) => number) =>
    amend((base) => ({ visible: next(base.visible) }));

  const defaultChecked = (row: ImportRow) => !row.skip && !(skipDuplicates && row.duplicate);
  // A row that couldn't be read has nothing to import, so it can't be ticked
  // back on -- no override survives that.
  const isChecked = (row: ImportRow, index: number) =>
    !row.skip && (selection[index] ?? defaultChecked(row));

  const indexed = useMemo(() => rows.map((row, index) => ({ row, index })), [rows]);
  const chosen = indexed.filter(({ row, index }) => isChecked(row, index));
  const importable = chosen.map(({ row }) => row);

  const counts = useMemo(() => {
    const tally: Record<Bucket, number> = { ready: 0, flagged: 0, duplicate: 0, error: 0 };
    for (const row of rows) tally[bucketOf(row)] += 1;
    return tally;
  }, [rows]);

  const filtered = useMemo(
    () => (filter === "all" ? indexed : indexed.filter(({ row }) => bucketOf(row) === filter)),
    [indexed, filter],
  );
  // The header checkbox acts on what is filtered, not on what is drawn, so
  // "untick every duplicate" is one click on a file of any length.
  const togglable = filtered.filter(({ row }) => !row.skip);
  const allChecked =
    togglable.length > 0 && togglable.every(({ row, index }) => isChecked(row, index));
  const setAll = (on: boolean) =>
    setPicks((prev) => {
      const next = { ...prev };
      for (const { index } of togglable) next[index] = on;
      return next;
    });

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
                onChange={(e) => {
                  setSkipDuplicates(e.target.checked);
                  // Read as a bulk action rather than a change of default, so
                  // it visibly moves every duplicate -- including ones already
                  // ticked by hand, which would otherwise sit there ignoring it.
                  setPicks(() => ({}));
                }}
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

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[12.5px] font-semibold text-foreground">
                  Review
                  <span className="ml-2 font-normal text-dim-2">
                    {importable.length} to import
                    {skipped > 0 && `, ${skipped} skipped`}
                    {flagged > 0 && `, ${flagged} needing a look`}
                  </span>
                </h3>
                <div className="flex flex-wrap items-center gap-1">
                  {(["all", ...BUCKET_ORDER] as const).map((key) => {
                    const count = key === "all" ? rows.length : counts[key];
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={count === 0 && key !== "all"}
                        onClick={() => {
                          setFilter(key);
                        }}
                        className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
                          filter === key
                            ? "border-accent bg-panel-2 text-foreground"
                            : "border-border text-dim hover:text-foreground"
                        }`}
                      >
                        {key === "all" ? "All" : BUCKET_LABELS[key]}{" "}
                        <span className="tabular-nums text-dim-2">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-2 max-h-[26rem] overflow-auto rounded-md border border-border">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-panel-2">
                    <tr className="border-b border-border">
                      <th className={`${HEAD} w-8 text-left`}>
                        <input
                          type="checkbox"
                          checked={allChecked}
                          disabled={togglable.length === 0}
                          onChange={(e) => setAll(e.target.checked)}
                          title={
                            allChecked
                              ? `Untick all ${togglable.length} shown`
                              : `Tick all ${togglable.length} shown`
                          }
                        />
                      </th>
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
                    {filtered.slice(0, visible).map(({ row, index }) => {
                      const checked = isChecked(row, index);
                      return (
                        <tr
                          key={index}
                          className={`border-b border-border-soft ${checked ? "" : "opacity-45"}`}
                        >
                          <td className={`${CELL} text-left`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={row.skip}
                              onChange={(e) =>
                                setPicks((prev) => ({ ...prev, [index]: e.target.checked }))
                              }
                              title={row.skip ? "This row can't be imported" : undefined}
                            />
                          </td>
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
                            ) : row.duplicateVia === "exact" ? (
                              <span className="text-dim-2">Already imported</span>
                            ) : row.duplicateVia === "match" ? (
                              <span
                                className="text-dim-2"
                                title="This file doesn't match one already imported byte for byte, but a transaction in this account describes the same event."
                              >
                                Same as an existing row
                              </span>
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
              {filtered.length === 0 && (
                <p className="mt-1 text-[11.5px] text-dim-2">
                  No rows in this group.
                </p>
              )}
              {filtered.length > visible && (
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-dim-2">
                  <span>
                    Showing {visible} of {filtered.length.toLocaleString()} rows. Ticking is
                    unaffected — the header checkbox covers all {filtered.length.toLocaleString()}.
                  </span>
                  <button
                    type="button"
                    onClick={() => setVisible((n) => n + PAGE * 2)}
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] text-dim hover:text-foreground"
                  >
                    Show {Math.min(PAGE * 2, filtered.length - visible).toLocaleString()} more
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisible(() => filtered.length)}
                    className="rounded-md border border-border px-2 py-0.5 text-[11px] text-dim hover:text-foreground"
                  >
                    Show all {filtered.length.toLocaleString()}
                  </button>
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
