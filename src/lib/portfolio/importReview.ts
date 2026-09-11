import type { PortfolioAccountType, TransactionType } from "@/domain/portfolio";
import type { ImportRow } from "./importer";
import { suggestSleeve } from "./taxSource";

/**
 * The decisions the import dialog makes about each row before anything is
 * written -- which pile it sits in, which account it lands in, and what type
 * it goes in as -- pulled out of the component so they can be tested as
 * plain functions.
 */

/**
 * Which pile a row is in. Exactly one each, so the tab counts add up to the
 * file's length and a row can never hide from every filter.
 *
 * "Unrecognised" comes first because it is the one pile that blocks the
 * import: a type the broker's table did not vouch for is a guess, and a guess
 * about direction is precisely what corrupts a cash balance if it lands
 * unread.
 */
export type ReviewBucket = "unrecognised" | "ready" | "flagged" | "duplicate" | "ignored" | "error";

export function bucketOf(row: ImportRow): ReviewBucket {
  if (row.ignored) return "ignored";
  if (row.skip) return "error";
  if (row.unrecognised) return "unrecognised";
  if (row.duplicate) return "duplicate";
  return row.issues.length > 0 ? "flagged" : "ready";
}

/**
 * What each money-source label resolves to: the user's choice if they made
 * one, else the guess read off the label, else "" -- which leaves those rows
 * on the parent as unassigned rather than picking a pot for them.
 */
export function resolveRouting<T extends { id: string; type: PortfolioAccountType }>(
  labels: readonly string[],
  chosen: Readonly<Record<string, string>>,
  sleeves: readonly T[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of labels) {
    out[label] = chosen[label] ?? suggestSleeve(label, sleeves)?.id ?? "";
  }
  return out;
}

/**
 * The account a row lands in: its source label's sleeve when the file is
 * being routed and the label resolved to one, else the account picked at the
 * top of the dialog.
 */
export function accountForRow(
  row: Pick<ImportRow, "taxSourceLabel">,
  accountId: string,
  routable: boolean,
  routing: Readonly<Record<string, string>>,
): string {
  return (routable && routing[row.taxSourceLabel]) || accountId;
}

/** The row with the type the user picked over the guess, or the row itself. */
export function withTypeOverride(row: ImportRow, type: TransactionType | undefined): ImportRow {
  return type && type !== row.draft.type ? { ...row, draft: { ...row.draft, type } } : row;
}

/**
 * Whether a row goes in. A row that could not be read never does. A guessed
 * type goes in only once confirmed. Everything else follows the tick, which
 * defaults on except for a duplicate while duplicates are being skipped.
 */
export function isRowChecked(
  row: ImportRow,
  pick: boolean | undefined,
  decision: "confirm" | "skip" | undefined,
  skipDuplicates: boolean,
): boolean {
  if (row.skip) return false;
  if (row.unrecognised) return decision === "confirm";
  return pick ?? !(skipDuplicates && row.duplicate);
}
