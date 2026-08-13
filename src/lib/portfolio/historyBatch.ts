/**
 * How many symbols one price-history request may carry, shared by the route
 * that enforces it and the client that splits its list to fit.
 *
 * The client needs the number rather than a guess: a ledger with hundreds of
 * closed positions still needs every one of them priced to measure a long
 * window, and a single capped call can only ever answer for part of it.
 */
export const HISTORY_BATCH_LIMIT = 120;

/** Splits a symbol list into request-sized groups, preserving priority order. */
export function chunkSymbols(
  symbols: readonly string[],
  size: number = HISTORY_BATCH_LIMIT,
): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += size) {
    chunks.push(symbols.slice(i, i + size));
  }
  return chunks;
}
