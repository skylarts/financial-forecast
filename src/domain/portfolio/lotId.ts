import type { ISODate } from "../common";
import { normalizeSymbol } from "./security";

/**
 * Lot ids are stored on a transaction as a single string, but one sale can
 * legitimately close several lots at once -- selling out of a position drains
 * every lot you hold. Those ids live in the same field, comma-separated, so a
 * sell can name exactly what it drew on without a second schema shape.
 */
const SEPARATOR = ", ";

/** Reads the one-or-more lot ids a transaction names. Empty for none. */
export function parseLotIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Writes lot ids back into the stored form. Null when there are none. */
export function formatLotIds(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(SEPARATOR);
}

/**
 * Ids are built from the symbol and acquisition date rather than being random,
 * because the user reads and searches them: `VTI-20240315-1` says what it is at
 * a glance, and typing "VTI" or "2024" into the filter finds it. The trailing
 * counter is what keeps two purchases of the same stock on the same day apart.
 */
function composeLotId(symbol: string, date: ISODate | "", sequence: number): string {
  const ticker = normalizeSymbol(symbol).replace(/[^A-Z0-9]/g, "") || "LOT";
  const day = date.replace(/-/g, "") || "UNDATED";
  return `${ticker}-${day}-${sequence}`;
}

/**
 * Hands out lot ids that don't collide with anything already issued.
 *
 * Ids are minted against a running set of what's taken, so backfilling an
 * existing ledger never renames a lot the user (or a statement) already named:
 * the generated ones fill in around them.
 */
export function createLotIdMinter(existing: Iterable<string> = []) {
  const taken = new Set(existing);
  return {
    reserve(id: string) {
      taken.add(id);
    },
    /** A fresh id for a lot opened on `date` in `symbol`. */
    mint(symbol: string, date: ISODate | ""): string {
      for (let sequence = 1; ; sequence += 1) {
        const id = composeLotId(symbol, date, sequence);
        if (!taken.has(id)) {
          taken.add(id);
          return id;
        }
      }
    },
  };
}
