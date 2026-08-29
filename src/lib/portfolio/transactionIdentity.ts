import { normalizeSymbol } from "@/domain/portfolio";

/**
 * Recognising a transaction the ledger already holds, by what it *means*
 * rather than by the bytes it arrived as.
 *
 * The importer's own fingerprint (`hashRow`) hashes every cell of the source
 * row, which makes it exact but brittle: it changes when a column is added,
 * when Schwab rewords a description, when "$1,234.00" comes back as "1234.00",
 * and -- most often -- when the file is this app's own CSV export, which
 * carries a Lot ID and an Account column that the original broker file never
 * had and that the app itself wrote after the fact.
 *
 * This key is built from what decides whether two rows are the same event:
 * when, what kind, which security, and either the shares-and-price of a trade
 * or the amount of a cash row. Nothing the app generates goes into it.
 *
 * It is derived, never stored -- every field lives on the transaction already,
 * so an existing ledger gets the new matching with no migration.
 */

/** The stored fields an identity is read from. Both `Transaction` and the
 *  importer's `DraftTransaction` satisfy this shape. */
export interface IdentityFields {
  date: string;
  type: string;
  symbol: string | null;
  quantity: number;
  price: number;
  amount: number | null;
}

/**
 * Rounds before stringifying so "220.5", "220.50" and the float noise left by
 * parsing "1,234.00" all land on one string. Quantities get more places than
 * money because fractional-share brokers report six.
 */
function num(value: number, decimals: number): string {
  const rounded = Number(Math.abs(value).toFixed(decimals));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * The key two rows share when they describe the same event.
 *
 * A trade is pinned by its shares and its price, and the amount is
 * deliberately left out -- it is the one number the two sides disagree about.
 * A statement folds the commission into it while the ledger keeps fees in
 * their own column, and the ledger is entitled to hold no amount at all and
 * derive it from shares x price. Neither disagreement means a different trade.
 *
 * A row with no shares behind it -- a dividend, a deposit, an interest credit,
 * a fee -- has nothing else to be told apart by, so there the amount is the
 * whole of the identity and every one of those is a separate event.
 */
export function transactionIdentity(tx: IdentityFields): string {
  const quantity = num(tx.quantity, 6);
  const priced = Math.abs(tx.quantity) > 0 && Math.abs(tx.price) > 0;
  const value = priced
    ? `${quantity}@${num(tx.price, 6)}`
    : `${quantity}#${tx.amount === null ? "" : num(tx.amount, 2)}`;

  return [tx.date, tx.type, tx.symbol ? normalizeSymbol(tx.symbol) : "", value].join("|");
}

/**
 * A count of what the ledger already holds under each identity, drawn down as
 * incoming rows claim it.
 *
 * Counting rather than testing membership is what keeps genuine repeats
 * importable. A partial fill really does put two identical rows on a
 * statement, and a monthly auto-invest really does buy the same dollar amount
 * of the same fund over and over. If the ledger holds two of an identity and
 * the file offers three, the first two are recognised and the third is new --
 * which is the same answer in both directions, so re-importing the whole file
 * adds nothing and importing a longer file adds only its tail.
 */
export function createIdentityPool(existing: Iterable<IdentityFields>) {
  const remaining = new Map<string, number>();
  for (const tx of existing) {
    const key = transactionIdentity(tx);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return {
    /** Claims one match for `key`, reporting whether there was one to claim. */
    take(key: string): boolean {
      const left = remaining.get(key) ?? 0;
      if (left <= 0) return false;
      remaining.set(key, left - 1);
      return true;
    },
    /**
     * Spends one match without reporting it, for a row already recognised by
     * its fingerprint. Without this the transaction it matched would still be
     * sitting in the pool, ready to mark some later row a duplicate of a thing
     * that has already been claimed.
     */
    drop(key: string): void {
      const left = remaining.get(key) ?? 0;
      if (left > 0) remaining.set(key, left - 1);
    },
  };
}
