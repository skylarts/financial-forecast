import type { SchwabLedgerRow } from "./schwabTransactions";

/**
 * Schwab's rows rendered as the delimited text the importer already reads.
 *
 * Going through the file format rather than around it is deliberate. The
 * import path already knows how to guess columns, infer a type, spot a row the
 * ledger has seen before, route a workplace account's money sources into
 * sleeves, and show all of it for approval before anything is written. A sync
 * that bypassed that would be a second, less careful way into the same ledger.
 * This way Schwab is just a statement that fetches itself.
 *
 * The headers below are chosen to match what `guessMapping` looks for, and the
 * type column carries the app's own vocabulary so `inferType` reads it exactly
 * rather than pattern-matching prose.
 */

export const SCHWAB_HEADERS = [
  "Trade Date",
  "Action",
  "Symbol",
  "Quantity",
  "Price",
  "Fees & Comm",
  "Amount",
  "Description",
  // Unmapped by design: nothing reads it as a field, but every cell feeds the
  // row fingerprint, so carrying Schwab's own id makes an imported row
  // recognisable again even if Schwab restates a price or reworks a
  // description. Without it, dedupe would rest on values that can drift.
  "Activity ID",
] as const;

/** A security the ledger already knows, used to put a name back to a symbol. */
export interface KnownSecurity {
  symbol: string;
  name: string;
}

/**
 * Words that appear in a brokerage's rendering of a company name without
 * helping to identify it. Dropped before matching so "ALPHABET INC CLASS
 * CLASS C" and "Alphabet Inc." can still meet.
 */
const NOISE = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|the|class|cl|common|stock|shares?|sponsored|adr|reps?|ord|new|holdings?|hldgs?|group|grp)\b/gi;

/**
 * How much agreement counts as identification.
 *
 * Long enough that two unrelated companies sharing an opening word cannot
 * reach it, short enough that a name Schwab has truncated still can.
 */
const MIN_NAME_MATCH = 8;

/**
 * How far two names agree from the start.
 *
 * Matched on a shared opening rather than one name containing the other,
 * because Schwab pads its name field to a fixed width and runs the overflow
 * together: "Taiwan Semiconductor Manufacturing" arrives as "TAIWAN
 * SEMICONDUCTOR M FSPONSORED ADR", which contains nothing and is contained by
 * nothing. The first twenty-two characters still agree, and that is the
 * evidence.
 */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function normalizeName(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The symbol a dividend belongs to, worked out from the security's name.
 *
 * Schwab names the company in prose on a dividend and puts the symbol nowhere
 * at all -- the only leg on the event is the cash. Since a dividend is
 * essentially always paid on something already held, the ledger's own
 * securities are a better source for that symbol than any guess from the text,
 * and the match is deliberately conservative: an unmatched row keeps a blank
 * symbol and surfaces in the review step rather than being attached to the
 * wrong holding.
 */
export function resolveSymbolByName(
  description: string,
  securities: readonly KnownSecurity[],
): string | null {
  const target = normalizeName(description);
  if (!target) return null;

  let best = { symbol: "", score: 0 };
  let runnerUp = 0;

  for (const security of securities) {
    const candidate = normalizeName(security.name);
    if (!candidate) continue;

    const score = commonPrefixLength(target, candidate);
    if (score > best.score) {
      runnerUp = best.score;
      best = { symbol: security.symbol, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  // Long enough to be a name rather than a coincidence, and clearly ahead of
  // whatever came second -- a tie means the description does not identify one
  // holding, and a blank the review step flags beats income attached to the
  // wrong position.
  return best.score >= MIN_NAME_MATCH && best.score > runnerUp ? best.symbol : null;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function money(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

function quantity(value: number): string {
  if (value === 0) return "";
  // Fractional share counts are real and must survive; trailing zeros are not.
  return String(Number(value.toFixed(6)));
}

/**
 * Renders fetched rows as CSV for the import dialog.
 *
 * `securities` supplies the names needed to put a symbol on a dividend; pass
 * the ledger's own list. Rows whose symbol cannot be resolved are still
 * written -- blank, so the review step flags them -- rather than dropped.
 */
export function schwabRowsToCsv(
  rows: readonly SchwabLedgerRow[],
  securities: readonly KnownSecurity[] = [],
): string {
  const lines = [SCHWAB_HEADERS.join(",")];

  for (const row of rows) {
    const symbol =
      row.symbol ??
      (row.type === "dividend" ? resolveSymbolByName(row.description, securities) : null) ??
      "";

    lines.push(
      [
        row.date,
        row.type ?? "",
        symbol,
        quantity(row.quantity),
        row.price === 0 ? "" : String(row.price),
        row.fees === 0 ? "" : money(row.fees),
        money(row.amount),
        row.description,
        row.activityId,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return lines.join("\n");
}
