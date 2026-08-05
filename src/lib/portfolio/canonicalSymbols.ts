import { normalizeSymbol, type Portfolio, type Security } from "@/domain/portfolio";

/**
 * Rewrites every symbol in a ledger into its canonical form.
 *
 * Option contracts arrive spelled a dozen ways -- "KLAR 01/21/2028 17.50 C" from
 * one statement, "KLAR280121C17.5" from another -- and stored as typed they
 * become separate holdings that no feed will price. Reading them back through
 * `normalizeSymbol` folds them onto the one spelling the quote feed knows.
 *
 * Runs over the whole ledger on load rather than as a one-shot migration, so a
 * portfolio arriving from anywhere -- an old browser, a restored backup, a
 * hand-edited JSON file -- comes back consistent.
 */
export function withCanonicalSymbols(portfolio: Portfolio): Portfolio {
  let changed = false;

  const transactions = portfolio.transactions.map((tx) => {
    if (tx.symbol === null) return tx;
    const symbol = normalizeSymbol(tx.symbol);
    if (symbol === tx.symbol) return tx;
    changed = true;
    return { ...tx, symbol };
  });

  // Two spellings of one contract can carry two security records. They collapse
  // into one here, first one wins -- a later duplicate would otherwise shadow
  // whatever name or class the user had already set on the first.
  const securities: Security[] = [];
  const seen = new Set<string>();
  for (const security of portfolio.securities) {
    const symbol = normalizeSymbol(security.symbol);
    if (seen.has(symbol)) {
      changed = true;
      continue;
    }
    seen.add(symbol);
    if (symbol !== security.symbol) changed = true;
    securities.push(symbol === security.symbol ? security : { ...security, symbol });
  }

  // Returning the same object when nothing moved keeps this off the hot path:
  // an identity change here would push a no-op save to the cloud on every load.
  return changed ? { ...portfolio, transactions, securities } : portfolio;
}
