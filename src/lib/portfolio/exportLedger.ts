import type { Portfolio } from "@/domain/portfolio";
import { accountPath } from "./accountTree";

/**
 * Getting the ledger back out, in the two shapes it is actually wanted in.
 *
 * The CSV is deliberately round-trippable: its headers are the ones the importer
 * matches on and its type column carries the raw transaction type, which
 * `inferType` resolves before it tries any wording patterns. So an export can be
 * opened in a spreadsheet, corrected, and imported back without a mapping step --
 * which is the whole point, since reconciling against a statement is exactly when
 * you need to edit rows in bulk.
 *
 * The JSON is the whole portfolio as stored, and pairs with `importJson` in the
 * store for backup and restore.
 */

/** Header text chosen to match what the importer looks for. */
const COLUMNS = [
  "Date",
  "Action",
  "Symbol",
  "Quantity",
  "Price",
  "Amount",
  "Fees",
  "Lot ID",
  "Date Acquired",
  "Description",
  "Account",
] as const;

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The ledger as CSV, oldest first.
 *
 * A null `amount` is written as an empty cell rather than a zero: the ledger
 * treats "no amount" as "derive it from quantity x price", and a literal 0 would
 * import as a trade that moved no money.
 */
export function toCsv(portfolio: Portfolio): string {
  // Sleeves are named for their pot -- "Pre-tax", "Roth" -- which says nothing
  // on its own once a file leaves the app. Qualifying each with its parent
  // makes the column readable in a spreadsheet, where this export is read.
  const accountName = new Map(
    portfolio.accounts.map((a) => [a.id, accountPath(portfolio.accounts, a)]),
  );
  const rows = [...portfolio.transactions].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const lines = [COLUMNS.join(",")];
  for (const t of rows) {
    lines.push(
      [
        t.date,
        t.type,
        t.symbol,
        t.quantity,
        t.price,
        t.amount,
        t.fees,
        t.lotId,
        t.acquiredDate,
        t.note,
        accountName.get(t.accountId) ?? t.accountId,
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n");
}

/** The whole portfolio, in the shape `importJson` reads back. */
export function toBackupJson(portfolio: Portfolio): string {
  return JSON.stringify(portfolio, null, 2);
}

/** Today's date, for stamping a filename. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function csvFilename(): string {
  return `portfolio-transactions-${today()}.csv`;
}

export function backupFilename(): string {
  return `portfolio-backup-${today()}.json`;
}

/**
 * Hands the browser a file to save.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari
 * reads the href after the click handler returns, and revoking synchronously
 * cancels the download it was about to start.
 */
export function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
