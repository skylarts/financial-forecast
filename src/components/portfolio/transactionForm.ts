import { normalizeSymbol, type Transaction, type TransactionType } from "@/domain/portfolio";

/**
 * The transaction form's state and the two conversions either side of it:
 * a stored row into editable strings, and the strings back into a row.
 *
 * Kept apart from the panel because the conversions carry the one rule that
 * is easy to get wrong and hard to see in a component: a blank field means
 * "use the default" while an explicit zero means zero, and the two must not
 * collapse into each other on the way in or the way out.
 */
export interface TxFormState {
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

export function blankForm(accountId: string, today: string = new Date().toISOString().slice(0, 10)): TxFormState {
  return {
    accountId,
    date: today,
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
export function formFromTransaction(tx: Transaction): TxFormState {
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
export function parseBasisRetained(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number.parseFloat(trimmed);
  if (Number.isNaN(value)) return null;
  return value > 1 ? value / 100 : value;
}

/**
 * A number field as the ledger stores it: positive, and zero when blank.
 *
 * Blank strings mean "use the computed default" for shares/price/fees, but an
 * explicit zero (a $0 fee, a dividend's 0 shares) must survive as zero, not
 * vanish into the same default. Both come out as 0 here; the difference is
 * carried by `amount`, the one field where blank and zero mean different
 * things and which is therefore kept nullable.
 */
export function num(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

/** The stored fields a form submission writes, for an add or an edit. */
export type TransactionFields = Omit<Transaction, "id" | "importBatchId" | "sourceHash" | "note" | "transferPeerId">;

/**
 * The row a form describes.
 *
 * `amount` is the field where blank and zero part ways: blank stays null so
 * the ledger derives shares x price, while a typed "0" is a real zero -- a
 * transfer that moved no cash, a dividend reversed to nothing.
 */
export function transactionFromForm(form: TxFormState): TransactionFields {
  return {
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
  };
}
