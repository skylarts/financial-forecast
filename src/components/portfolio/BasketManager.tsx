"use client";

import { useMemo, useState } from "react";
import { formatOptionSymbol, type Basket } from "@/domain/portfolio";
import { CollapsibleSection } from "./CollapsibleSection";

/**
 * The basket's name, edited in place.
 *
 * Held as a draft rather than written through on every keystroke: the store
 * trims and collapses whitespace on the way in, so a write-through field eats
 * the space the moment you type it and "AI" can never become "AI core".
 */
function BasketNameInput({ name, onCommit }: { name: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? name;
  const commit = () => {
    if (draft !== null && draft.trim()) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      value={value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(null);
      }}
      aria-label="Basket name"
      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-semibold text-foreground outline-none hover:border-border focus:border-accent"
    />
  );
}

/**
 * Setting up baskets: groups of holdings the owner treats as one position.
 *
 * Collapsed to a single line by default, and it stays that way for everyone
 * who never opens it. Baskets are a power-user idea that most portfolios will
 * never use, so the cost of having them available has to be one line of type
 * under the charts -- not a permanent panel of controls competing with the
 * classify-holdings list it sits beside.
 */
export function BasketManager({
  baskets,
  symbols,
  onCreate,
  onRename,
  onRemove,
  onAssign,
}: {
  baskets: readonly Basket[];
  /** Every position symbol in scope, the pool a basket draws from. */
  symbols: readonly string[];
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  /** Null takes the symbol out of whichever basket holds it. */
  onAssign: (symbol: string, basketId: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  /** Which basket is one more click from being deleted. A basket is a bit of
   *  work to rebuild, and an undo stack for it would be more machinery than
   *  the feature is worth, so the second click is the confirmation. */
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const grouped = useMemo(() => new Set(baskets.flatMap((b) => b.symbols)), [baskets]);
  const unassigned = useMemo(
    () => symbols.filter((symbol) => !grouped.has(symbol)).sort((a, b) => a.localeCompare(b)),
    [symbols, grouped],
  );

  const held = baskets.reduce((sum, b) => sum + b.symbols.length, 0);

  const create = () => {
    const name = draft.trim();
    if (!name) return;
    onCreate(name);
    setDraft("");
  };

  return (
    <CollapsibleSection
      title="Baskets"
      summary={
        baskets.length === 0
          ? "Group holdings you treat as one position — they show as a single slice by holding."
          : `${baskets.length} basket${baskets.length === 1 ? "" : "s"} · ${held} holding${held === 1 ? "" : "s"}`
      }
    >
      <div className="space-y-2">
        {baskets.map((basket) => (
          <div key={basket.id} className="rounded-md border border-border bg-panel-2 px-2 py-1.5 text-[12px]">
            <div className="flex items-center gap-1.5">
              <BasketNameInput name={basket.name} onCommit={(next) => onRename(basket.id, next)} />
              <button
                type="button"
                onClick={() =>
                  confirmingRemove === basket.id
                    ? (onRemove(basket.id), setConfirmingRemove(null))
                    : setConfirmingRemove(basket.id)
                }
                onBlur={() => setConfirmingRemove((id) => (id === basket.id ? null : id))}
                title="Delete this basket. The holdings themselves are untouched."
                className={`shrink-0 text-[11px] ${
                  confirmingRemove === basket.id ? "text-negative" : "text-dim-2 hover:text-negative"
                }`}
              >
                {confirmingRemove === basket.id ? "Delete?" : "✕"}
              </button>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {basket.symbols.map((symbol) => (
                <span
                  key={symbol}
                  title={formatOptionSymbol(symbol)}
                  className="flex items-center gap-1 rounded bg-panel px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  {symbol}
                  <button
                    type="button"
                    onClick={() => onAssign(symbol, null)}
                    title="Take out of this basket"
                    className="text-dim-2 hover:text-negative"
                  >
                    ✕
                  </button>
                </span>
              ))}
              {/* A select rather than a free-text field: a basket holds
                  symbols the ledger already knows about, and typing one by
                  hand is how you end up with a basket full of names that
                  match no holding and quietly weigh nothing. */}
              <select
                value=""
                onChange={(e) => e.target.value && onAssign(e.target.value, basket.id)}
                aria-label={`Add a holding to ${basket.name}`}
                className="rounded border border-border bg-panel px-1.5 py-0.5 text-[11px] text-dim outline-none focus:border-accent"
              >
                <option value="">+ Add holding</option>
                {unassigned.map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {symbol}
                  </option>
                ))}
              </select>
              {basket.symbols.length === 0 && (
                <span className="text-[11px] text-dim-2">Empty — nothing to show yet.</span>
              )}
            </div>
          </div>
        ))}

        <div className="flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            onBlur={create}
            placeholder="Name a new basket, press Enter"
            className="w-56 rounded border border-border bg-panel px-1.5 py-1 text-[11.5px] text-foreground outline-none placeholder:text-dim-2 focus:border-accent"
          />
          <span className="text-[11px] text-dim-2">
            A holding belongs to one basket, so the totals still add up.
          </span>
        </div>
      </div>
    </CollapsibleSection>
  );
}
