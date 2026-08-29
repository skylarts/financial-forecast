import { parseOptionSymbol } from "@/domain/portfolio";

/**
 * Translation between the app's spelling of a symbol and Schwab's.
 *
 * The two feeds disagree about how to write the same security, and the
 * disagreements are not cosmetic -- send Yahoo's spelling to Schwab and it
 * answers "unknown symbol", which would quietly push every index, every
 * share class, and every option contract onto the fallback feed forever.
 * Kept in its own file because the transaction sync has to read the same
 * spellings back the other way.
 */

/**
 * Indexes. Yahoo prefixes with a caret, Schwab with a dollar sign, and the
 * roots differ often enough that guessing is worse than a table -- Yahoo's
 * `^GSPC` is Schwab's `$SPX`, not `$GSPC`.
 */
const INDEX_TO_SCHWAB: Record<string, string> = {
  "^GSPC": "$SPX",
  "^DJI": "$DJI",
  "^IXIC": "$COMPX",
  "^RUT": "$RUT",
  "^VIX": "$VIX",
  "^NDX": "$NDX",
};

const INDEX_FROM_SCHWAB: Record<string, string> = Object.fromEntries(
  Object.entries(INDEX_TO_SCHWAB).map(([yahoo, schwab]) => [schwab, yahoo]),
);

/**
 * Schwab writes a contract in OCC's fixed-width form: the root padded to six
 * characters with spaces, then the six-digit expiry, C or P, and the strike in
 * thousandths. The app stores the same contract unpadded. The padding is not
 * optional on Schwab's side -- `AAPL240119C00150000` is rejected where
 * `AAPL  240119C00150000` is accepted.
 */
function toSchwabOption(symbol: string): string | null {
  const contract = parseOptionSymbol(symbol);
  if (!contract) return null;
  const [year, month, day] = contract.expiry.split("-");
  const right = contract.right === "call" ? "C" : "P";
  const strike = String(Math.round(contract.strike * 1000)).padStart(8, "0");
  return `${contract.underlying.padEnd(6, " ")}${year.slice(2)}${month}${day}${right}${strike}`;
}

/** The app's symbol as Schwab spells it. */
export function toSchwabSymbol(symbol: string): string {
  const key = symbol.toUpperCase();
  const index = INDEX_TO_SCHWAB[key];
  if (index) return index;

  const option = toSchwabOption(key);
  if (option) return option;

  // Share classes: Yahoo's BRK-B is Schwab's BRK/B. Only a single trailing
  // class letter is rewritten -- a hyphen anywhere else is part of the ticker.
  return key.replace(/^([A-Z]{1,5})-([A-Z])$/, "$1/$2");
}

/** Schwab's symbol back in the app's spelling, for reading responses. */
export function fromSchwabSymbol(symbol: string): string {
  const key = symbol.toUpperCase().trim();
  const index = INDEX_FROM_SCHWAB[key];
  if (index) return index;

  // A padded contract collapses back by dropping the padding; the app's
  // canonical form is the unpadded one.
  const unpadded = key.replace(/\s+/g, "");
  if (parseOptionSymbol(unpadded)) return unpadded;

  return key.replace(/^([A-Z]{1,5})\/([A-Z])$/, "$1-$2");
}
