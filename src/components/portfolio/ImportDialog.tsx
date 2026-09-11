"use client";

import { useEffect, useMemo, useState } from "react";
import { useModalDialog } from "@/components/ui/useModalDialog";
import { SchwabFetchPanel } from "./SchwabFetchPanel";
import type { PortfolioAccount, Transaction, TransactionType } from "@/domain/portfolio";
import { TRANSACTION_TYPE_GROUPS, TRANSACTION_TYPE_LABELS, isOptionSymbol } from "@/domain/portfolio";
import {
  buildImportRows,
  guessMapping,
  parseDelimited,
  IMPORT_FIELD_LABELS,
  type ColumnMapping,
  type DraftTransaction,
  type ImportField,
  type ImportRow,
} from "@/lib/portfolio/importer";
import {
  detectPreset,
  IMPORT_PRESETS,
  isPlanCashName,
  KNOWN_FUND_TICKERS,
  presetById,
  type ImportPreset,
  type ImportPresetId,
} from "@/lib/portfolio/importPresets";
import { splitDraft, suggestSplitRows, type SplitSuggestion } from "@/lib/portfolio/importSplits";
import { usePriceHistories } from "@/lib/portfolio/usePriceHistories";
import { money, price, shares, shortDate } from "@/lib/portfolio/format";
import { Btn } from "@/components/ui/controls";
import { accountFamilyIds, accountTreeRows, sleevesOf } from "@/lib/portfolio/accountTree";
import { suggestSleeve } from "@/lib/portfolio/taxSource";

/** One transaction to write and the account it lands in. */
export interface ImportAssignment {
  accountId: string;
  draft: DraftTransaction;
  /** A sync-written dividend this row supersedes, to be removed. */
  syncMatchId: string | null;
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
const SELECT = "rounded-md border border-border bg-panel-2 px-2 py-1 text-[11.5px] text-foreground";

const SAMPLE = `Run Date,Action,Symbol,Quantity,Price,Amount
01/10/2024,YOU BOUGHT,VTI,10,220.50,-2205.00
04/15/2024,DIVIDEND RECEIVED,VTI,,,42.10`;

/**
 * Which pile a row is in. Exactly one each, so the tab counts add up to the
 * file's length and a row can never hide from every filter.
 *
 * "Unrecognised" comes first because it is the one pile that blocks the
 * import: a type the broker's table did not vouch for is a guess, and a guess
 * about direction is precisely what corrupts a cash balance if it lands
 * unread.
 */
type Bucket = "unrecognised" | "ready" | "flagged" | "duplicate" | "ignored" | "error";

function bucketOf(row: ImportRow): Bucket {
  if (row.ignored) return "ignored";
  if (row.skip) return "error";
  if (row.unrecognised) return "unrecognised";
  if (row.duplicate) return "duplicate";
  return row.issues.length > 0 ? "flagged" : "ready";
}

const BUCKET_LABELS: Record<Bucket, string> = {
  unrecognised: "Needs a decision",
  ready: "Ready",
  flagged: "Needs a look",
  duplicate: "Already imported",
  ignored: "Not a transaction",
  error: "Can't import",
};

const BUCKET_ORDER: Bucket[] = ["unrecognised", "ready", "flagged", "duplicate", "ignored", "error"];

/**
 * Rows drawn before the "show more" controls appear. A statement backfill runs
 * to thousands of rows and putting them all in the DOM at once locks the
 * dialog up, but the filters are what make a long file navigable anyway --
 * this is the starting window, not a cap on what can be reviewed.
 */
const PAGE = 250;

/**
 * How long the pasted text is left alone before the split calendar is asked
 * about it. A paste is one event, but a hand-typed sample changes every
 * keystroke, and each distinct symbol list would otherwise be a fetch.
 */
const SPLIT_LOOKUP_SETTLE_MS = 800;

/** How far back the split calendar is read: the deepest daily range the feed
 *  answers, and the same range every other chart uses, so it is cached. */
const SPLIT_HISTORY_RANGE = "10y";

type PresetChoice = ImportPresetId | "auto" | "none";

/** A confirmed or declined guess, per unrecognised row. */
type Decision = "confirm" | "skip";

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
   *  dividend -- Schwab names the company in prose and the symbol nowhere --
   *  and to seed fund-name aliases for a workplace export. */
  securities: readonly { symbol: string; name: string }[];
  onImport: (assignments: ImportAssignment[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const box = useModalDialog<HTMLDivElement>(onClose);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [presetChoice, setPresetChoice] = useState<PresetChoice>("auto");
  const [mappingOverride, setMappingOverride] = useState<Partial<ColumnMapping>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  /** Money-source label -> the sleeve its rows belong in. Only what the user
   *  has actually chosen; unset labels fall back to a guess. */
  const [routing, setRouting] = useState<Record<string, string>>({});
  /** Fund name -> ticker, as typed. Names nobody typed fall back to the seeds. */
  const [aliasesTyped, setAliasesTyped] = useState<Record<string, string>>({});
  const [addSplits, setAddSplits] = useState(true);

  const table = useMemo(() => parseDelimited(text), [text]);
  const detected = useMemo(() => detectPreset(table.headers, table.rows), [table]);
  const preset: ImportPreset | null =
    presetChoice === "auto" ? detected : presetChoice === "none" ? null : presetById(presetChoice);

  // The preset names its columns outright and the header patterns fill in
  // whatever it leaves; a manual pick beats both.
  const mapping = useMemo<ColumnMapping>(
    () => ({ ...guessMapping(table.headers), ...(preset?.mapping(table.headers) ?? {}), ...mappingOverride }),
    [table.headers, preset, mappingOverride],
  );

  // A split account's file fans out across its sleeves, so duplicate and
  // synced-dividend detection has to look at the whole family rather than
  // just the account named in the picker.
  const familyIds = useMemo(
    () => (accountId ? accountFamilyIds(accounts, accountId) : []),
    [accounts, accountId],
  );

  /** The distinct fund names a name-keyed file carries, in file order. */
  const fundNames = useMemo(() => {
    if (!preset?.symbolIsName || mapping.symbol === null) return [];
    const seen: string[] = [];
    for (const row of table.rows) {
      const name = (row[mapping.symbol] ?? "").trim();
      // The plan's cash fund is the account's cash, never a position.
      if (name && !isPlanCashName(name) && !seen.includes(name)) seen.push(name);
    }
    return seen;
  }, [preset, mapping.symbol, table.rows]);

  /**
   * What each fund name resolves to: what was typed, else a ticker the app
   * has confirmed for that exact name, else a security in the ledger whose
   * name matches. The plan's own cash fund is never a position and stays
   * blank on purpose.
   */
  const aliases = useMemo(() => {
    const byLedgerName = new Map(securities.map((s) => [s.name.trim().toLowerCase(), s.symbol]));
    const out: Record<string, string> = {};
    for (const name of fundNames) {
      const typed = aliasesTyped[name];
      if (typed !== undefined) {
        out[name] = typed;
        continue;
      }
      out[name] = KNOWN_FUND_TICKERS[name] ?? byLedgerName.get(name.toLowerCase()) ?? "";
    }
    return out;
  }, [fundNames, aliasesTyped, securities]);

  // Cash rows in every account *outside* the target family are what a
  // deposit here can be the other half of.
  const transferCandidates = useMemo(
    () =>
      existingTransactions.filter(
        (tx) =>
          !familyIds.includes(tx.accountId) &&
          (tx.type === "cash_deposit" || tx.type === "cash_withdrawal") &&
          !tx.transferPeerId,
      ),
    [existingTransactions, familyIds],
  );

  const rows = useMemo(
    () =>
      buildImportRows(table, mapping, existingTransactions, familyIds, {
        preset,
        symbolAliases: aliases,
        transferCandidates,
      }),
    [table, mapping, existingTransactions, familyIds, preset, aliases, transferCandidates],
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
   * touched -- everything else follows the default), which guesses they have
   * confirmed or declined and with what type, and how far down the list they
   * have asked to see.
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
    decisions: Record<number, Decision>;
    types: Record<number, TransactionType>;
    visible: number;
  }
  const fresh: Review = { rows, filter: "all", picks: {}, decisions: {}, types: {}, visible: PAGE };
  const [review, setReview] = useState<Review>(fresh);
  const { filter, picks: selection, decisions, types: typeOverrides, visible } =
    review.rows === rows ? review : fresh;

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
  const decide = (index: number, decision: Decision) =>
    amend((base) => ({ decisions: { ...base.decisions, [index]: decision } }));
  const decideAll = (indices: number[], decision: Decision) =>
    amend((base) => {
      const next = { ...base.decisions };
      for (const index of indices) next[index] = decision;
      return { decisions: next };
    });
  const setType = (index: number, type: TransactionType) =>
    amend((base) => ({ types: { ...base.types, [index]: type } }));

  const defaultChecked = (row: ImportRow) => !row.skip && !(skipDuplicates && row.duplicate);
  // A row that couldn't be read has nothing to import, so it can't be ticked
  // back on -- no override survives that. A guess imports only once confirmed.
  const isChecked = (row: ImportRow, index: number) => {
    if (row.skip) return false;
    if (row.unrecognised) return decisions[index] === "confirm";
    return selection[index] ?? defaultChecked(row);
  };

  const indexed = useMemo(() => rows.map((row, index) => ({ row, index })), [rows]);
  const chosen = indexed.filter(({ row, index }) => isChecked(row, index));
  /** The rows going in, with any type the user picked over the guess. */
  const importable = chosen.map(({ row, index }) => {
    const type = typeOverrides[index];
    return type && type !== row.draft.type ? { ...row, draft: { ...row.draft, type } } : row;
  });

  const undecided = indexed.filter(
    ({ row, index }) => row.unrecognised && !row.skip && decisions[index] === undefined,
  );

  const counts = useMemo(() => {
    const tally: Record<Bucket, number> = {
      unrecognised: 0,
      ready: 0,
      flagged: 0,
      duplicate: 0,
      ignored: 0,
      error: 0,
    };
    for (const row of rows) tally[bucketOf(row)] += 1;
    return tally;
  }, [rows]);

  const filtered = useMemo(
    () => (filter === "all" ? indexed : indexed.filter(({ row }) => bucketOf(row) === filter)),
    [indexed, filter],
  );
  // The header checkbox acts on what is filtered, not on what is drawn, so
  // "untick every duplicate" is one click on a file of any length. Guesses
  // are left to their own confirm/skip controls.
  const togglable = filtered.filter(({ row }) => !row.skip && !row.unrecognised);
  const allChecked =
    togglable.length > 0 && togglable.every(({ row, index }) => isChecked(row, index));
  const setAll = (on: boolean) =>
    setPicks((prev) => {
      const next = { ...prev };
      for (const { index } of togglable) next[index] = on;
      return next;
    });

  // ---------------------------------------------------------------------
  // Splits the file leaves the ledger needing
  // ---------------------------------------------------------------------

  /** The symbols and earliest date the split calendar is asked about, settled
   *  a moment after the text stops changing. */
  const [splitQuery, setSplitQuery] = useState<{ symbols: string[]; from: string }>({ symbols: [], from: "" });
  const wantedSymbols = useMemo(() => {
    const symbols = new Set<string>();
    let from = "";
    for (const row of importable) {
      if (row.draft.symbol === null || isOptionSymbol(row.draft.symbol)) continue;
      symbols.add(row.draft.symbol);
      if (!from || row.draft.date < from) from = row.draft.date;
    }
    return { symbols: [...symbols].sort(), from };
  }, [importable]);
  const wantedKey = `${wantedSymbols.from}|${wantedSymbols.symbols.join(",")}`;
  useEffect(() => {
    const timer = setTimeout(() => {
      const [from, list] = wantedKey.split("|");
      setSplitQuery({ symbols: list ? list.split(",") : [], from });
    }, SPLIT_LOOKUP_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [wantedKey]);

  const { splits: feedSplits, loading: splitsLoading } = usePriceHistories(
    splitQuery.symbols,
    SPLIT_HISTORY_RANGE,
    splitQuery.from || "1970-01-01",
  );

  /** Suggested split rows, grouped by the account they belong in: a split
   *  applies to the shares an account holds, so a file fanning out across
   *  sleeves gets one row per sleeve that holds the symbol. */
  const splitSuggestions = useMemo(() => {
    if (splitQuery.symbols.length === 0 || feedSplits.size === 0) return [];
    const fileByAccount = new Map<string, ImportRow[]>();
    for (const row of importable) {
      const target = accountForRow(row);
      const list = fileByAccount.get(target);
      if (list) list.push(row);
      else fileByAccount.set(target, [row]);
    }
    const out: { accountId: string; suggestion: SplitSuggestion }[] = [];
    for (const [target, fileRows] of fileByAccount) {
      const ledgerRows = existingTransactions.filter((tx) => tx.accountId === target);
      for (const suggestion of suggestSplitRows(fileRows.map((r) => r.draft), ledgerRows, feedSplits)) {
        out.push({ accountId: target, suggestion });
      }
    }
    return out;
    // accountForRow is a closure over routing state that is itself a memo input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importable, existingTransactions, feedSplits, splitQuery.symbols.length, resolvedRouting, accountId, routable]);

  const unrouted = routable
    ? importable.filter((row) => !resolvedRouting[row.taxSourceLabel]).length
    : 0;
  const skipped = rows.length - importable.length;
  const flagged = importable.filter((row) => row.issues.length > 0).length;
  const replacing = importable.filter((row) => row.syncMatchId !== null).length;
  const transfers = importable.filter((row) => row.transferPeer !== null).length;
  const splitsToAdd = addSplits ? splitSuggestions.length : 0;
  const total = importable.length + splitsToAdd;
  const blocked = !accountId || total === 0 || undecided.length > 0;

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "—";

  const submit = () => {
    if (blocked) return;
    const assignments: ImportAssignment[] = importable.map((row) => ({
      accountId: accountForRow(row),
      draft: row.draft,
      syncMatchId: row.syncMatchId,
    }));
    if (addSplits) {
      for (const { accountId: target, suggestion } of splitSuggestions) {
        assignments.push({ accountId: target, draft: splitDraft(suggestion), syncMatchId: null });
      }
    }
    onImport(assignments);
  };

  // Full-bleed on a phone. This dialog's whole job is a paste area, and inset
  // by a margin inside a centred card there was barely room to see what you
  // pasted -- the sample CSV alone filled it. Centred card returns at `sm`.
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      // A stray click outside the card closes an empty dialog, which is what
      // a stray click means. Once something has been pasted it does nothing:
      // a thousand rows of statement are not to be lost to a misplaced click,
      // and Escape or the Close button are still there for closing on purpose.
      onClick={text.trim() === "" ? onClose : undefined}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden border-border bg-panel sm:rounded-lg sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id="import-dialog-title" className="text-[15px] font-semibold text-foreground">
            Import transactions
          </h2>
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
                    {depth > 0 ? `  ↳ ${account.name}` : account.name}
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
            rows={10}
            className="w-full rounded-md border border-border bg-panel-2 px-3 py-2 font-mono text-[11.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
          />

          {table.headers.length > 0 && (
            <>
              {/* The preset sits above the column mapping because it decides
                  most of it. Auto is the default and says what it found, so a
                  wrong guess is visible rather than silent. */}
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-[12px] text-dim">
                  <span className="mb-1 block text-dim-2">File format</span>
                  <select
                    value={presetChoice}
                    onChange={(e) => setPresetChoice(e.target.value as PresetChoice)}
                    className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground"
                  >
                    <option value="auto">
                      {detected ? `Detected: ${detected.label}` : "Detect automatically (nothing matched)"}
                    </option>
                    {IMPORT_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                    <option value="none">Generic — guess from wording</option>
                  </select>
                </label>
                <p className="max-w-xl text-[11.5px] text-dim-2">
                  {preset
                    ? preset.hint
                    : "No broker preset applies, so the type of every row is read from its wording. Anything read from a sign alone is held for a decision."}
                </p>
              </div>

              {preset?.symbolIsName && fundNames.length > 0 && (
                <div className="mt-4 rounded-md border border-border bg-panel-2/40 p-3">
                  <h3 className="text-[12.5px] font-semibold text-foreground">
                    Fund tickers
                    <span className="ml-2 font-normal text-dim-2">
                      this file names {fundNames.length} fund{fundNames.length === 1 ? "" : "s"} — give
                      each the ticker its prices are quoted under.
                    </span>
                  </h3>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {fundNames.map((name) => (
                      <label key={name} className="flex items-center gap-2 text-[11.5px]">
                        <span className="min-w-0 flex-1 truncate text-dim" title={name}>
                          {name}
                        </span>
                        <input
                          value={aliases[name] ?? ""}
                          onChange={(e) =>
                            setAliasesTyped((prev) => ({ ...prev, [name]: e.target.value.toUpperCase() }))
                          }
                          placeholder="Ticker"
                          spellCheck={false}
                          className={`w-28 rounded-md border bg-panel-2 px-2 py-1 font-mono text-[11.5px] uppercase text-foreground outline-none focus:border-accent ${
                            aliases[name] ? "border-border" : "border-accent/60"
                          }`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <h3 className="mb-2 mt-4 text-[12.5px] font-semibold text-foreground">
                Column mapping
                <span className="ml-2 font-normal text-dim-2">
                  {preset ? "set by the preset — change anything it got wrong" : "guessed from your header row — change anything it got wrong"}
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
                      className={`w-full ${SELECT}`}
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
                          className={`w-full rounded-md border bg-panel-2 px-2 py-1 text-[11.5px] text-foreground sm:w-44 ${
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
                    if (count === 0 && key !== "all") return null;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setFilter(key);
                        }}
                        className={`rounded-md border px-2 py-1 text-[11px] ${
                          filter === key
                            ? "border-accent bg-panel-2 text-foreground"
                            : key === "unrecognised" && undecided.length > 0
                              ? "border-accent/60 text-accent hover:text-foreground"
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

              {counts.unrecognised > 0 && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[11.5px]">
                  <span className="text-foreground">
                    {undecided.length > 0
                      ? `${undecided.length} row${undecided.length === 1 ? "" : "s"} ${
                          undecided.length === 1 ? "has" : "have"
                        } a type ${preset ? `the ${preset.label} table` : "the wording"} couldn't vouch for. Confirm or skip each one before importing.`
                      : `Every guessed type has been decided.`}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        decideAll(
                          indexed.filter(({ row }) => row.unrecognised && !row.skip).map(({ index }) => index),
                          "confirm",
                        )
                      }
                      className="rounded-md border border-border px-2 py-0.5 text-dim hover:text-foreground"
                    >
                      Confirm all as read
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        decideAll(
                          indexed.filter(({ row }) => row.unrecognised && !row.skip).map(({ index }) => index),
                          "skip",
                        )
                      }
                      className="rounded-md border border-border px-2 py-0.5 text-dim hover:text-foreground"
                    >
                      Skip all
                    </button>
                  </span>
                </div>
              )}

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
                      const decision = decisions[index];
                      const type = typeOverrides[index] ?? row.draft.type;
                      const dimmed = !checked && !(row.unrecognised && decision === undefined);
                      return (
                        <tr
                          key={index}
                          className={`border-b border-border-soft ${dimmed ? "opacity-45" : ""}`}
                        >
                          <td className={`${CELL} text-left`}>
                            {row.unrecognised && !row.skip ? (
                              <span
                                className="inline-block h-3 w-3 rounded-sm border border-accent"
                                title="Confirm or skip this row in its Status column"
                                aria-hidden
                              />
                            ) : (
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={row.skip}
                                onChange={(e) =>
                                  setPicks((prev) => ({ ...prev, [index]: e.target.checked }))
                                }
                                title={row.skip ? "This row can't be imported" : undefined}
                              />
                            )}
                          </td>
                          <td className={`${CELL} text-left text-dim`}>
                            {row.draft.date ? shortDate(row.draft.date) : "—"}
                          </td>
                          <td className={`${CELL} text-left text-foreground`}>
                            {row.unrecognised && !row.skip ? (
                              <select
                                value={type}
                                onChange={(e) => setType(index, e.target.value as TransactionType)}
                                className={SELECT}
                                aria-label="Transaction type"
                              >
                                {TRANSACTION_TYPE_GROUPS.map((group) => (
                                  <optgroup key={group.label} label={group.label}>
                                    {group.types.map((t) => (
                                      <option key={t} value={t}>
                                        {TRANSACTION_TYPE_LABELS[t]}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            ) : (
                              TRANSACTION_TYPE_LABELS[row.draft.type]
                            )}
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
                            {row.ignored ? (
                              <span className="text-dim-2" title={row.ignored}>
                                Not a transaction
                              </span>
                            ) : row.skip ? (
                              <span className="text-negative">{row.issues[0]}</span>
                            ) : row.unrecognised ? (
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className="max-w-[18rem] truncate font-mono text-[11px] text-foreground"
                                  title={row.issues[0]}
                                >
                                  {row.action}
                                </span>
                                {decision === "confirm" ? (
                                  <span className="text-positive">Confirmed</span>
                                ) : decision === "skip" ? (
                                  <span className="text-dim-2">Skipped</span>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => decide(index, "confirm")}
                                  className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${
                                    decision === "confirm"
                                      ? "border-positive text-positive"
                                      : "border-border text-dim hover:text-foreground"
                                  }`}
                                >
                                  Confirm
                                </button>
                                <button
                                  type="button"
                                  onClick={() => decide(index, "skip")}
                                  className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${
                                    decision === "skip"
                                      ? "border-border text-foreground"
                                      : "border-border text-dim hover:text-foreground"
                                  }`}
                                >
                                  Skip
                                </button>
                              </span>
                            ) : row.duplicateVia === "exact" ? (
                              <span className="text-dim-2">Already imported</span>
                            ) : row.duplicateVia === "match" ? (
                              <span
                                className="text-dim-2"
                                title="This file doesn't match one already imported byte for byte, but a transaction in this account describes the same event."
                              >
                                Same as an existing row
                              </span>
                            ) : row.transferPeer ? (
                              <span className="text-accent" title={row.issues[0]}>
                                Transfer ↔ {accountName(row.transferPeer.transaction.accountId)}
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

              {/* Splits the file leaves the ledger needing. Offered with the
                  rows they would add in full view, and on by default: a split
                  held through with no row for it is what values a position at
                  a multiple of what it is worth. */}
              {(splitSuggestions.length > 0 || (splitsLoading && splitQuery.symbols.length > 0)) && (
                <div className="mt-4 rounded-md border border-border bg-panel-2/40 p-3">
                  <h3 className="text-[12.5px] font-semibold text-foreground">
                    Splits
                    <span className="ml-2 font-normal text-dim-2">
                      {splitsLoading && splitSuggestions.length === 0
                        ? "checking the price feed's split calendar…"
                        : `the feed lists ${splitSuggestions.length} split${
                            splitSuggestions.length === 1 ? "" : "s"
                          } these positions were held through that the file doesn't record`}
                    </span>
                  </h3>
                  {splitSuggestions.length > 0 && (
                    <>
                      <table className="mt-2 w-full border-collapse">
                        <thead>
                          <tr className="border-b border-border">
                            <th className={`${HEAD} text-left`}>Symbol</th>
                            <th className={`${HEAD} text-left`}>Date</th>
                            <th className={`${HEAD} text-right`}>Ratio</th>
                            <th className={`${HEAD} text-right`}>Shares before</th>
                            <th className={`${HEAD} text-right`}>Shares after</th>
                            {routable && <th className={`${HEAD} text-left`}>Account</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {splitSuggestions.map(({ accountId: target, suggestion }) => (
                            <tr key={`${target}:${suggestion.symbol}:${suggestion.date}`} className="border-b border-border-soft">
                              <td className={`${CELL} text-left font-semibold text-foreground`}>{suggestion.symbol}</td>
                              <td className={`${CELL} text-left text-dim`}>{shortDate(suggestion.date)}</td>
                              <td className={`${CELL} text-right text-dim`}>
                                {suggestion.ratio >= 1
                                  ? `${formatRatio(suggestion.ratio)} for 1`
                                  : `1 for ${formatRatio(1 / suggestion.ratio)}`}
                              </td>
                              <td className={`${CELL} text-right text-dim`}>{shares(suggestion.sharesBefore)}</td>
                              <td className={`${CELL} text-right text-foreground`}>{shares(suggestion.sharesAfter)}</td>
                              {routable && <td className={`${CELL} text-left text-dim`}>{accountName(target)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <label className="mt-2 flex items-center gap-1.5 text-[11.5px] text-dim">
                        <input
                          type="checkbox"
                          checked={addSplits}
                          onChange={(e) => setAddSplits(e.target.checked)}
                        />
                        Add {splitSuggestions.length === 1 ? "this split row" : `these ${splitSuggestions.length} split rows`} with the import, so the shares are counted in today&apos;s units.
                      </label>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-[11.5px] text-dim-2">
            {undecided.length > 0 && (
              <span className="text-accent">
                {undecided.length} row{undecided.length === 1 ? "" : "s"} still need
                {undecided.length === 1 ? "s" : ""} a decision.{" "}
              </span>
            )}
            {unrouted > 0 && (
              <span className="text-accent">
                {unrouted} row{unrouted === 1 ? " has" : "s have"} no sleeve and will sit on the
                parent as unassigned.{" "}
              </span>
            )}
            {transfers > 0 &&
              `${transfers} ${transfers === 1 ? "is" : "are"} the other half of a transfer between your accounts. `}
            {replacing > 0 &&
              `${replacing} of these replace${replacing === 1 ? "s" : ""} a dividend the price-feed sync added earlier — that entry will be removed.`}
          </p>
          <div className="flex items-center gap-2">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn
              variant="primary"
              onClick={submit}
              className={blocked ? "pointer-events-none opacity-40" : ""}
              title={
                undecided.length > 0
                  ? "Decide the rows marked 'Needs a decision' first"
                  : undefined
              }
            >
              Import {total} transaction{total === 1 ? "" : "s"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "3", "1.5", "0.2500" — only as many decimals as the ratio needs. */
function formatRatio(ratio: number): string {
  const rounded = Math.round(ratio * 10_000) / 10_000;
  return String(rounded);
}
