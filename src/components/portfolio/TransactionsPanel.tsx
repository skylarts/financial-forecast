"use client";

import { Fragment, useMemo, useState } from "react";
import {
  opensLotOn,
  closesLotOn,
  formatOptionSymbol,
  isOptionLifecycleType,
  normalizeSymbol,
  parseLotIds,
  signedCashFlow,
  signedQuantity,
  signedTransactionAmount,
  TRANSACTION_TYPE_GROUPS,
  TRANSACTION_TYPE_LABELS,
  type Portfolio,
  type PortfolioAccount,
  type Transaction,
  type TransactionType,
} from "@/domain/portfolio";
import { usePortfolioStore } from "@/store/usePortfolioStore";
import { scopedTo } from "@/lib/portfolio/scope";
import { accountPath, accountTreeRows } from "@/lib/portfolio/accountTree";
import { money, price, shares, shortDate, toneFor } from "@/lib/portfolio/format";
import { Btn } from "@/components/ui/controls";
import { SymbolField } from "./SymbolField";
import { useSort, type SortAccessors } from "./useSort";
import { HEAD, SortHeader } from "./SortHeader";
import {
  buildGroups,
  GroupHeaderRow,
  GroupMenu,
  groupedColumnMarker,
  useCollapsedGroups,
  type GroupingOption,
} from "./grouping";
import { FilterStatus } from "./FilterStatus";
import { MoreRows, useRowWindow } from "./rowWindow";

type TxGrouping = "none" | "symbol" | "account" | "type" | "month";

/** Every dimension names a column, month being the Date column read coarsely. */
const TX_GROUPINGS: readonly GroupingOption<TxGrouping>[] = [
  { value: "none", label: "No grouping" },
  { value: "symbol", label: "By stock", column: "symbol" },
  { value: "account", label: "By account", column: "account" },
  { value: "type", label: "By type", column: "type" },
  { value: "month", label: "By month", column: "date" },
];

const INPUT =
  "rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent";
/**
 * Form rows are a two-column grid on a phone and the original free-wrapping
 * flex row from `sm` up.
 *
 * Wrapping alone put fields wherever they happened to fall -- the two dates
 * landed on separate rows while the wide Type dropdown sat next to a short
 * date box. A grid makes the pairing a decision instead: short numerics pair
 * off (shares/price, amount/fees), and anything that needs the width says so
 * with `col-span-2`.
 */
const FORM_ROW = "grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap";
/** Labels are grid items, so they must be allowed to shrink inside a column. */
const FIELD = "min-w-0 text-[11.5px] text-dim-2";
/** Full-width in its column on a phone; the fixed width returns at `sm`. */
const FIELD_WIDE = "col-span-2 min-w-0 text-[11.5px] text-dim-2 sm:col-auto";
const CELL = "px-3 py-2 text-[12.5px] tabular-nums";

type TxColumn = "date" | "account" | "type" | "symbol" | "quantity" | "price" | "amount" | "lot";


interface TxFormState {
  accountId: string;
  date: string;
  type: TransactionType;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  fees: string;
  lotId: string;
  acquiredDate: string;
  spinoffSymbol: string;
  spinoffShareRatio: string;
  spinoffBasisRetained: string;
}

function blankForm(accountId: string): TxFormState {
  return {
    accountId,
    date: new Date().toISOString().slice(0, 10),
    type: "buy",
    symbol: "",
    quantity: "",
    price: "",
    amount: "",
    fees: "",
    lotId: "",
    acquiredDate: "",
    spinoffSymbol: "",
    spinoffShareRatio: "",
    spinoffBasisRetained: "",
  };
}

/** Converts a stored transaction back into editable form strings. */
function formFromTransaction(tx: Transaction): TxFormState {
  return {
    accountId: tx.accountId,
    date: tx.date,
    type: tx.type,
    symbol: tx.symbol ?? "",
    quantity: tx.quantity > 0 ? String(tx.quantity) : "",
    price: tx.price > 0 ? String(tx.price) : "",
    amount: tx.amount === null ? "" : String(tx.amount),
    fees: tx.fees > 0 ? String(tx.fees) : "",
    lotId: tx.lotId ?? "",
    acquiredDate: tx.acquiredDate ?? "",
    spinoffSymbol: tx.spinoffSymbol ?? "",
    spinoffShareRatio: tx.spinoffShareRatio === null ? "" : String(tx.spinoffShareRatio),
    spinoffBasisRetained: tx.spinoffBasisRetained === null ? "" : String(tx.spinoffBasisRetained),
  };
}

/** Turns the basis-retained form field into a 0-1 fraction, tolerant of "88.34" or "0.8834". */
function parseBasisRetained(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number.parseFloat(trimmed);
  if (Number.isNaN(value)) return null;
  return value > 1 ? value / 100 : value;
}

/**
 * The add and edit forms are the same fields end to end, so they share one
 * component -- keeping them separate would mean every future field (or every
 * future bug) has to be fixed twice.
 */
function TransactionForm({
  accounts,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  /** After a successful add, clear everything but account/date/type -- a
   *  statement is almost always entered as a run of similar rows. Editing
   *  never sets this: there is exactly one save, and it should close. */
  resetAfterSubmit = false,
}: {
  accounts: PortfolioAccount[];
  initial: TxFormState;
  submitLabel: string;
  onSubmit: (form: TxFormState) => void;
  onCancel: () => void;
  resetAfterSubmit?: boolean;
}) {
  const [form, setForm] = useState(initial);

  const set = (patch: Partial<TxFormState>) => setForm((f) => ({ ...f, ...patch }));

  const needsSymbol =
    form.type !== "cash_deposit" &&
    form.type !== "cash_withdrawal" &&
    form.type !== "interest" &&
    form.type !== "fee";
  const isSpinoff = form.type === "spinoff";
  const spinoffBasisRetained = parseBasisRetained(form.spinoffBasisRetained);
  const spinoffValid =
    !isSpinoff ||
    (form.spinoffSymbol.trim() !== "" &&
      Number.parseFloat(form.spinoffShareRatio) > 0 &&
      spinoffBasisRetained !== null &&
      spinoffBasisRetained >= 0 &&
      spinoffBasisRetained <= 1);
  const canSubmit =
    form.date !== "" && form.accountId !== "" && (!needsSymbol || form.symbol.trim() !== "") && spinoffValid;
  const opensLot = opensLotOn(form.type) !== null;
  const closesLot = closesLotOn(form.type) !== null;
  const lotHint = closesLot
    ? "Which lots this trade closes. Left blank it fills in oldest-first; clear it any time to re-derive. Separate several lots with commas."
    : opensLot
      ? "This lot's name. Left blank one is generated from the symbol and date."
      : "Only buys and sells carry a lot.";

  return (
    <div className="mb-4 rounded-md border border-border bg-panel-2 p-3">
      {/* Account gets its own line -- it holds a name, not a number, and is
          the one field here that is routinely long. Date and Type then split
          the next line evenly rather than the dropdown crowding out the date. */}
      <div className={FORM_ROW}>
        <label className={FIELD_WIDE}>
          <span className="mb-0.5 block">Account</span>
          <select
            value={form.accountId}
            onChange={(e) => set({ accountId: e.target.value })}
            className={`${INPUT} w-full sm:w-36`}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className={FIELD}>
          <span className="mb-0.5 block">Date</span>
          <input
            type="date"
            value={form.date}
            onChange={(e) => set({ date: e.target.value })}
            className={`${INPUT} w-full sm:w-auto`}
          />
        </label>
        <label className={FIELD}>
          <span className="mb-0.5 block">Type</span>
          <select
            value={form.type}
            onChange={(e) => set({ type: e.target.value as TransactionType })}
            className={`${INPUT} w-full sm:w-auto`}
          >
            {TRANSACTION_TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {TRANSACTION_TYPE_LABELS[type]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {needsSymbol && (
        <div className="mt-2 flex">
          <SymbolField
            value={form.symbol}
            onChange={(symbol) => set({ symbol })}
            label={isSpinoff ? "Existing symbol" : "Symbol"}
          />
        </div>
      )}

      {isSpinoff && (
        <div className={`${FORM_ROW} mt-2 rounded-md border border-border-soft bg-panel p-2`}>
          <SymbolField
            value={form.spinoffSymbol}
            onChange={(spinoffSymbol) => set({ spinoffSymbol })}
            label="New symbol"
          />
          <label className={FIELD}>
            <span className="mb-0.5 block">Share ratio</span>
            <input
              value={form.spinoffShareRatio}
              onChange={(e) => set({ spinoffShareRatio: e.target.value })}
              placeholder="0.3333"
              title="New shares issued per one existing share, e.g. 1 VLTO for every 3 DHR is 0.3333."
              className={`${INPUT} w-full text-right sm:w-24`}
            />
          </label>
          <label className={FIELD}>
            <span className="mb-0.5 block">Basis retained</span>
            <input
              value={form.spinoffBasisRetained}
              onChange={(e) => set({ spinoffBasisRetained: e.target.value })}
              placeholder="88.34"
              title="Percent of cost basis staying with the existing symbol -- from the company's Form 8937. 0 for a full exchange or reorganization, where the existing symbol stops existing."
              className={`${INPUT} w-full text-right sm:w-24`}
            />
          </label>
        </div>
      )}

      <div className={`${FORM_ROW} mt-2`}>
        {!isSpinoff && (
          <>
            <label className={FIELD}>
              <span className="mb-0.5 block">
                {form.type === "split" ? "Ratio" : isOptionLifecycleType(form.type) ? "Contracts" : "Shares"}
              </span>
              <input
                value={form.quantity}
                onChange={(e) => set({ quantity: e.target.value })}
                placeholder={form.type === "split" ? "2" : isOptionLifecycleType(form.type) ? "1" : "10"}
                className={`${INPUT} w-full text-right sm:w-24`}
              />
            </label>
            <label className={FIELD}>
              <span className="mb-0.5 block">Price</span>
              <input
                value={form.price}
                onChange={(e) => set({ price: e.target.value })}
                // Retiring a contract carries no price of its own: an expiry is
                // worth nothing, and an exercise settles through its stock leg.
                disabled={isOptionLifecycleType(form.type)}
                placeholder={isOptionLifecycleType(form.type) ? "—" : "220.50"}
                className={`${INPUT} w-full text-right disabled:opacity-40 sm:w-24`}
              />
            </label>
            <label className={FIELD}>
              <span className="mb-0.5 block">Amount</span>
              <input
                value={form.amount}
                onChange={(e) => set({ amount: e.target.value })}
                placeholder="auto"
                title="Leave blank to compute from shares × price."
                className={`${INPUT} w-full text-right sm:w-24`}
              />
            </label>
            <label className={FIELD}>
              <span className="mb-0.5 block">Fees</span>
              <input
                value={form.fees}
                onChange={(e) => set({ fees: e.target.value })}
                placeholder="0"
                className={`${INPUT} w-full text-right sm:w-20`}
              />
            </label>
          </>
        )}
        {(opensLot || closesLot) && (
          <label className={FIELD_WIDE}>
            <span className="mb-0.5 block">Lot ID</span>
            <input
              value={form.lotId}
              onChange={(e) => set({ lotId: e.target.value })}
              placeholder="auto"
              title={lotHint}
              className={`${INPUT} w-full sm:w-44`}
            />
          </label>
        )}
        {opensLot && (
          <label className={FIELD_WIDE}>
            <span className="mb-0.5 block">Acquired</span>
            <input
              type="date"
              value={form.acquiredDate}
              onChange={(e) => set({ acquiredDate: e.target.value })}
              title="For transferred-in shares, the original purchase date that starts the holding period."
              className={`${INPUT} w-full sm:w-auto`}
            />
          </label>
        )}
        <div className="col-span-2 flex items-center gap-1.5 sm:col-auto">
          <Btn
            variant="primary"
            onClick={() => {
              if (!canSubmit) return;
              onSubmit(form);
              if (resetAfterSubmit) {
                setForm({ ...blankForm(form.accountId), date: form.date, type: form.type });
              }
            }}
            className={canSubmit ? "" : "pointer-events-none opacity-40"}
          >
            {submitLabel}
          </Btn>
          <Btn onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * The lot cell. A sale that drained several lots names all of them, which is
 * far too wide for a column, so only the first is shown with a count of the
 * rest -- the full list is in the tooltip. Clicking a lot searches for it,
 * which pulls the purchase and every sale that drew on it into one view.
 */
function LotCell({ tx, onSearch }: { tx: Transaction; onSearch: (query: string) => void }) {
  const ids = parseLotIds(tx.lotId);
  if (ids.length === 0) return <span className="text-dim-2">—</span>;
  return (
    <button
      type="button"
      onClick={() => onSearch(ids[0])}
      title={ids.length === 1 ? `Show everything in lot ${ids[0]}` : `Closes ${ids.join(", ")}`}
      className="text-left hover:text-foreground hover:underline"
    >
      {ids[0]}
      {ids.length > 1 && <span className="text-dim-2"> +{ids.length - 1}</span>}
    </button>
  );
}

/** Blank strings mean "use the computed default" for shares/price/fees, but an
 *  explicit zero (a $0 fee, a dividend's 0 shares) must survive as zero, not
 *  vanish into the same default. */
function num(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

export function TransactionsPanel({
  portfolio,
  scopeAccountIds,
  search,
  onSearchChange,
}: {
  portfolio: Portfolio;
  /** null = every account (the "all" scope); otherwise the account ids the
   *  header's person-or-account picker currently covers. */
  scopeAccountIds: readonly string[] | null;
  /** Owned by the shared filter bar above the tabs. It still matches lot IDs
   *  here as well as tickers -- one search box, read the way each tab can. */
  search: string;
  /** Clicking a lot ID searches for it, which now writes to the shared box. */
  onSearchChange: (next: string) => void;
}) {
  const addTransaction = usePortfolioStore((s) => s.addTransaction);
  const updateTransaction = usePortfolioStore((s) => s.updateTransaction);
  const removeTransaction = usePortfolioStore((s) => s.removeTransaction);
  const removeTransactions = usePortfolioStore((s) => s.removeTransactions);
  const moveTransactions = usePortfolioStore((s) => s.moveTransactions);
  const splitTransactions = usePortfolioStore((s) => s.splitTransactions);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [splitPct, setSplitPct] = useState("50");
  const [adding, setAdding] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TransactionType | "all" | `group:${string}`>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [grouping, setGrouping] = useState<TxGrouping>("none");

  // Qualified with the parent, so a row filed under a sleeve reads as
  // "401(k) / Roth" rather than a bare "Roth" that could be anyone's.
  const accountNames = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, accountPath(portfolio.accounts, a)])),
    [portfolio.accounts],
  );

  const accessors = useMemo<SortAccessors<Transaction, TxColumn>>(
    () => ({
      date: (tx) => tx.date,
      account: (tx) => accountNames.get(tx.accountId) ?? "",
      type: (tx) => TRANSACTION_TYPE_LABELS[tx.type],
      symbol: (tx) => tx.symbol ?? "",
      quantity: (tx) => signedQuantity(tx),
      price: (tx) => tx.price,
      amount: (tx) => signedTransactionAmount(tx),
      lot: (tx) => tx.lotId ?? "",
    }),
    [accountNames],
  );
  const { sort, toggle, apply } = useSort<Transaction, TxColumn>(accessors, "date");

  const tickers = useMemo(
    () =>
      Array.from(
        new Set(portfolio.transactions.map((tx) => tx.symbol).filter((s): s is string => Boolean(s))),
      ).sort(),
    [portfolio.transactions],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toUpperCase();
    // A group selection matches every type in that group, so "Short" pulls both
    // the opening sale and the cover without needing two passes.
    const groupTypes =
      typeFilter.startsWith("group:")
        ? TRANSACTION_TYPE_GROUPS.find((g) => g.label === typeFilter.slice(6))?.types ?? []
        : null;
    // A query that's an exact ticker (picked from the datalist, or just typed
    // in full) narrows to that one symbol -- otherwise short tickers like "U"
    // would wildcard-match every lot id and symbol that merely contains a U.
    const exactTicker = tickers.includes(query) ? query : null;

    return portfolio.transactions
      .filter(scopeAccountIds === null ? () => true : scopedTo(scopeAccountIds))
      // One box covers both symbol and lot id. Generated ids lead with the
      // symbol, so a plain "VTI" still finds every VTI row and a full id
      // narrows to the purchase and the sales that drew on it -- which is the
      // whole point of being able to search a lot at all.
      .filter((tx) => {
        if (!query) return true;
        if (exactTicker) return (tx.symbol ?? "") === exactTicker;
        return (tx.symbol ?? "").includes(query) || (tx.lotId ?? "").toUpperCase().includes(query);
      })
      .filter((tx) =>
        typeFilter === "all" ? true : groupTypes ? groupTypes.includes(tx.type) : tx.type === typeFilter,
      )
      .filter((tx) => (!fromDate || tx.date >= fromDate) && (!toDate || tx.date <= toDate));
  }, [portfolio.transactions, scopeAccountIds, search, typeFilter, fromDate, toDate, tickers]);

  const rows = useMemo(() => apply(filtered), [apply, filtered]);
  // Only this tab's own filters -- the shared search has its own way out in
  // the bar that owns it.
  const filtersActive = typeFilter !== "all" || fromDate !== "" || toDate !== "";

  const groups = useMemo(() => {
    if (grouping === "none") return [{ key: "", label: "", rows }];
    const labelFor = (tx: Transaction) =>
      grouping === "symbol"
        ? tx.symbol ?? "Cash & fees"
        : grouping === "account"
          ? accountNames.get(tx.accountId) ?? "Unknown account"
          : grouping === "type"
            ? TRANSACTION_TYPE_LABELS[tx.type]
            : tx.date.slice(0, 7);

    return buildGroups(rows, labelFor);
  }, [rows, grouping, accountNames]);

  // Keyed on `rows`, so any filter, sort, or ledger change starts the table
  // back at its first page instead of re-drawing a previous expansion.
  const rowWindow = useRowWindow(rows);

  // Opens collapsed: picking a grouping here is asking for the subtotals --
  // the hundreds of underlying rows are what the grouping was meant to fold away.
  const collapse = useCollapsedGroups(grouping, { defaultCollapsed: true });
  const groupedColumn = TX_GROUPINGS.find((g) => g.value === grouping)?.column;

  // A scope naming exactly one account (a single-account person, or the
  // account picker itself) is the obvious default; anything broader -- "all",
  // or a person who holds several accounts -- falls back to the first account
  // overall, same as the pre-owner behavior for "all".
  const defaultAccountId =
    scopeAccountIds?.length === 1 ? scopeAccountIds[0] : portfolio.accounts[0]?.id;

  // Selection only ever means rows currently on screen: a filter change that
  // hides a selected row must not leave it silently queued for a bulk move.
  const visibleIds = useMemo(() => rows.map((tx) => tx.id), [rows]);
  const selectedVisible = useMemo(
    () => visibleIds.filter((id) => selected.has(id)),
    [visibleIds, selected],
  );
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearSelection = () => setSelected(new Set());

  // Where a bulk action can send rows. Sleeves are the point of this, but any
  // account is fair game -- rows land in the wrong account for plenty of
  // reasons besides a pre-tax/Roth split.
  const moveTargets = useMemo(() => accountTreeRows(portfolio.accounts), [portfolio.accounts]);
  const splitFraction = Number(splitPct) / 100;
  const splitValid = splitFraction > 0 && splitFraction < 1;

  return (
    <div className="px-3 py-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-foreground">
          Transactions
          <span className="ml-2 text-[12px] font-normal text-dim-2">{rows.length} rows</span>
        </h2>
        <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto sm:items-center">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className={`${INPUT} w-full sm:w-auto`}
          >
            <option value="all">All types</option>
            {TRANSACTION_TYPE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                <option value={`group:${group.label}`}>All {group.label.toLowerCase()}</option>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {TRANSACTION_TYPE_LABELS[type]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* From and To are one control -- a range -- so they share a unit and
              are never split by a wrap. Each label sits inline to the left of
              its own box rather than above it, and the box is sized to its
              content (a short date) rather than stretched -- a stretched,
              stacked pair was the fix for a real overflow bug, but the
              overflow came from forcing the box to 100% of a too-narrow grid
              column, not from the box needing the width. Left to size itself,
              it doesn't overflow, and the pair fits on one row. */}
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 sm:w-auto">
            <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
              <span>From</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className={INPUT}
              />
            </label>
            <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
              <span>To</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className={INPUT}
              />
            </label>
          </div>
          <FilterStatus
            shown={rows.length}
            total={portfolio.transactions.length}
            active={filtersActive}
            onClear={() => {
              setTypeFilter("all");
              setFromDate("");
              setToDate("");
            }}
          />
          {/* Deletes exactly what the filters are showing, so the same control
              covers emptying the ledger before re-importing a corrected file
              and clearing one bad account or date range. */}
          {rows.length > 0 &&
            (confirmingClear ? (
              <>
                <Btn
                  onClick={() => {
                    removeTransactions(rows.map((tx) => tx.id));
                    setConfirmingClear(false);
                    setEditingId(null);
                  }}
                  title="This cannot be undone"
                >
                  Delete {rows.length}
                </Btn>
                <Btn onClick={() => setConfirmingClear(false)}>Keep</Btn>
              </>
            ) : (
              <Btn
                onClick={() => setConfirmingClear(true)}
                title={
                  filtersActive
                    ? `Delete the ${rows.length} transactions matching these filters`
                    : `Delete all ${rows.length} transactions in this portfolio`
                }
              >
                {filtersActive ? `Delete ${rows.length} shown` : "Delete all"}
              </Btn>
            ))}
          {portfolio.accounts.length > 0 && (
            <Btn
              variant="primary"
              onClick={() => {
                setEditingId(null);
                setAdding((v) => !v);
              }}
            >
              {adding ? "Hide form" : "Add transaction"}
            </Btn>
          )}
        </div>
      </div>

      {adding && defaultAccountId && (
        <TransactionForm
          accounts={portfolio.accounts}
          initial={blankForm(defaultAccountId)}
          submitLabel="Add"
          resetAfterSubmit
          onCancel={() => setAdding(false)}
          onSubmit={(form) =>
            addTransaction({
              accountId: form.accountId,
              date: form.date,
              type: form.type,
              symbol: form.symbol.trim() ? normalizeSymbol(form.symbol) : null,
              quantity: num(form.quantity),
              price: num(form.price),
              amount: form.amount.trim() === "" ? null : num(form.amount),
              fees: num(form.fees),
              lotId: form.lotId.trim() || null,
              acquiredDate: form.acquiredDate || null,
              spinoffSymbol: form.spinoffSymbol.trim() ? normalizeSymbol(form.spinoffSymbol) : null,
              spinoffShareRatio: form.spinoffShareRatio.trim() === "" ? null : num(form.spinoffShareRatio),
              spinoffBasisRetained: parseBasisRetained(form.spinoffBasisRetained),
              note: "",
              importBatchId: null,
              sourceHash: null,
            })
          }
        />
      )}

      {selectedVisible.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
          <span className="text-[12px] font-medium text-foreground">
            {selectedVisible.length} selected
          </span>

          <select
            value={bulkAccountId}
            onChange={(e) => setBulkAccountId(e.target.value)}
            className={INPUT}
          >
            <option value="">— pick an account —</option>
            {moveTargets.map(({ account, depth }) => (
              <option key={account.id} value={account.id}>
                {depth > 0 ? `\u00a0\u00a0↳ ${account.name}` : account.name}
              </option>
            ))}
          </select>

          <Btn
            onClick={() => {
              if (!bulkAccountId) return;
              moveTransactions(selectedVisible, bulkAccountId);
              clearSelection();
            }}
            className={bulkAccountId ? "" : "pointer-events-none opacity-40"}
            title="File every selected row under that account. Lot ids are re-derived there, since a lot belongs to one account's ledger."
          >
            Move all
          </Btn>

          <span className="text-dim-2">|</span>

          <label className="flex items-center gap-1 text-[11.5px] text-dim-2">
            Split
            <input
              type="number"
              min={1}
              max={99}
              value={splitPct}
              onChange={(e) => setSplitPct(e.target.value)}
              className={`${INPUT} w-16 text-right tabular-nums`}
            />
            %
          </label>

          <Btn
            onClick={() => {
              if (!bulkAccountId || !splitValid) return;
              splitTransactions(selectedVisible, bulkAccountId, splitFraction);
              clearSelection();
            }}
            className={bulkAccountId && splitValid ? "" : "pointer-events-none opacity-40"}
            title="Divide each selected row in two: that percentage moves to the chosen account, the rest stays. The halves add back to the original exactly. For statements that report activity combined and the pre-tax/Roth split only as a quarterly summary."
          >
            Split into it
          </Btn>

          <Btn onClick={clearSelection}>Clear</Btn>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-dim">
          No transactions yet. Import a statement or add one by hand.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-panel">
          <table className="w-full border-collapse">
            <thead>
              <tr className="sticky top-0 z-10 border-b border-border bg-panel-2">
                <th className={`${HEAD} w-8 text-center`}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleIds))}
                    title={
                      allVisibleSelected
                        ? "Deselect every row shown"
                        : `Select all ${visibleIds.length} rows shown`
                    }
                  />
                </th>
                <SortHeader
                  label={`Date${groupedColumnMarker(groupedColumn, "date")}`}
                  column="date"
                  align="left"
                  sort={sort}
                  onToggle={toggle}
                  after={
                    <GroupMenu
                      options={TX_GROUPINGS}
                      value={grouping}
                      onChange={setGrouping}
                      collapse={collapse}
                    />
                  }
                />
                <SortHeader
                  label={`Account${groupedColumnMarker(groupedColumn, "account")}`}
                  column="account"
                  align="left"
                  sort={sort}
                  onToggle={toggle}
                />
                <SortHeader
                  label={`Type${groupedColumnMarker(groupedColumn, "type")}`}
                  column="type"
                  align="left"
                  sort={sort}
                  onToggle={toggle}
                />
                <SortHeader
                  label={`Symbol${groupedColumnMarker(groupedColumn, "symbol")}`}
                  column="symbol"
                  align="left"
                  sort={sort}
                  onToggle={toggle}
                />
                <SortHeader label="Shares" column="quantity" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Price" column="price" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Amount" column="amount" align="right" sort={sort} onToggle={toggle} />
                <SortHeader label="Lot" column="lot" align="left" sort={sort} onToggle={toggle} />
                <th className={`${HEAD} text-right`}></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const netCash = group.rows.reduce((sum, tx) => sum + signedCashFlow(tx), 0);
                const netQuantity = group.rows.reduce((sum, tx) => sum + signedQuantity(tx), 0);
                const collapsed = grouping !== "none" && collapse.isCollapsed(group.key);
                return (
                  <Fragment key={group.key || "all"}>
                    {grouping !== "none" && (
                      <GroupHeaderRow
                        label={group.label}
                        count={group.rows.length}
                        noun="row"
                        collapsed={collapsed}
                        onToggle={() => collapse.toggle(group.key)}
                        // Date, Account, Type, Symbol -- none of which totals
                        // across rows of different types.
                        labelSpan={5}
                        cells={[
                          <span
                            key="qty"
                            title="Net shares this group moved: buys less sells. Reconciles against the position's share count."
                          >
                            {shares(netQuantity)}
                          </span>,
                          null,
                          <span
                            key="net"
                            className={toneFor(netCash)}
                            title="Net cash this group moved: money in less money out."
                          >
                            {money(netCash)}
                          </span>,
                          null,
                          null,
                        ]}
                      />
                    )}
                    {!collapsed &&
                      group.rows.slice(0, rowWindow.limit(group.key)).map((tx: Transaction) =>
                        editingId === tx.id ? (
                        <tr key={tx.id}>
                          <td colSpan={10} className="p-0">
                            <TransactionForm
                              accounts={portfolio.accounts}
                              initial={formFromTransaction(tx)}
                              submitLabel="Save"
                              onCancel={() => setEditingId(null)}
                              onSubmit={(form) => {
                                updateTransaction(tx.id, {
                                  accountId: form.accountId,
                                  date: form.date,
                                  type: form.type,
                                  symbol: form.symbol.trim() ? normalizeSymbol(form.symbol) : null,
                                  quantity: num(form.quantity),
                                  price: num(form.price),
                                  amount: form.amount.trim() === "" ? null : num(form.amount),
                                  fees: num(form.fees),
                                  lotId: form.lotId.trim() || null,
                                  acquiredDate: form.acquiredDate || null,
                                  spinoffSymbol: form.spinoffSymbol.trim() ? normalizeSymbol(form.spinoffSymbol) : null,
                                  spinoffShareRatio: form.spinoffShareRatio.trim() === "" ? null : num(form.spinoffShareRatio),
                                  spinoffBasisRetained: parseBasisRetained(form.spinoffBasisRetained),
                                });
                                setEditingId(null);
                              }}
                            />
                          </td>
                        </tr>
                      ) : (
                        <tr
                          key={tx.id}
                          className={`border-b border-border-soft hover:bg-panel-2 ${
                            selected.has(tx.id) ? "bg-accent/10" : ""
                          }`}
                        >
                          <td className={`${CELL} text-center`}>
                            <input
                              type="checkbox"
                              checked={selected.has(tx.id)}
                              onChange={() => toggleRow(tx.id)}
                            />
                          </td>
                          <td className={`${CELL} text-left text-dim`}>{shortDate(tx.date)}</td>
                          <td className={`${CELL} text-left text-dim`}>
                            {accountNames.get(tx.accountId) ?? "—"}
                          </td>
                          <td className={`${CELL} text-left text-foreground`}>
                            {TRANSACTION_TYPE_LABELS[tx.type]}
                          </td>
                          <td
                            className={`${CELL} text-left font-semibold text-foreground`}
                            // A contract symbol is unreadable at a glance, so the
                            // statement wording is one hover away.
                            title={tx.symbol ? formatOptionSymbol(tx.symbol) : undefined}
                          >
                            {tx.symbol ?? "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>
                            {tx.quantity > 0 ? shares(signedQuantity(tx)) : "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>
                            {tx.price > 0 ? price(tx.price) : "—"}
                          </td>
                          <td className={`${CELL} text-right text-dim`}>{money(signedTransactionAmount(tx))}</td>
                          <td className={`${CELL} text-left text-dim-2`}>
                            <LotCell tx={tx} onSearch={onSearchChange} />
                          </td>
                          <td className={`${CELL} text-right`}>
                            <div className="flex items-center justify-end gap-2.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setAdding(false);
                                  setEditingId(tx.id);
                                }}
                                title="Edit this transaction"
                                className="text-dim-2 hover:text-foreground"
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                onClick={() => removeTransaction(tx.id)}
                                title="Delete this transaction"
                                className="text-dim-2 hover:text-negative"
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>
                      ),
                      )}
                    {!collapsed && group.rows.length > rowWindow.limit(group.key) && (
                      <tr>
                        <td colSpan={10} className="px-3 py-2">
                          <MoreRows
                            shown={rowWindow.limit(group.key)}
                            total={group.rows.length}
                            onMore={(count) => rowWindow.more(count, group.key)}
                            onAll={() => rowWindow.all(group.rows.length, group.key)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="sticky bottom-0 z-10 border-t border-border bg-panel-2 font-semibold">
                <td className={`${CELL} text-left text-foreground`} colSpan={5}>
                  Total
                </td>
                {(() => {
                  const netQuantity = rows.reduce((sum, tx) => sum + signedQuantity(tx), 0);
                  return (
                    <td
                      className={`${CELL} text-right text-foreground`}
                      title="Net shares all rows moved: buys less sells. Reconciles against the position's share count."
                    >
                      {shares(netQuantity)}
                    </td>
                  );
                })()}
                <td className={CELL}></td>
                {(() => {
                  const netCash = rows.reduce((sum, tx) => sum + signedCashFlow(tx), 0);
                  return (
                    <td className={`${CELL} text-right ${toneFor(netCash)}`} title="Net cash all rows moved.">
                      {money(netCash)}
                    </td>
                  );
                })()}
                <td className={CELL}></td>
                <td className={CELL}></td>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
