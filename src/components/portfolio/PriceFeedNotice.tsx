"use client";

import { formatOptionSymbol } from "@/domain/portfolio";

interface PriceFeedNoticeProps {
  /** Symbols the feed doesn't recognise at all. */
  unknown: string[];
  /** Symbols whose fetch failed and will likely recover. */
  unavailable: string[];
  /** Symbols priced from cache because a refresh failed. */
  stale: string[];
  onRetry: () => void;
  retrying: boolean;
}

/** Caps the symbol list so one bad import can't paper the header over. */
const MAX_LISTED = 6;

function symbolList(symbols: string[]): string {
  const shown = symbols.slice(0, MAX_LISTED).map(formatOptionSymbol).join(", ");
  const rest = symbols.length - MAX_LISTED;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/**
 * Explains why a holding has no price, which the table alone can't say.
 *
 * An unpriced position falls back to its cost basis, so it still shows a
 * plausible dollar figure -- the number looks fine and is quietly wrong. That
 * silence is the whole problem this banner exists to break, which is why a
 * transient failure reads differently from a symbol the feed rejects: one is
 * worth retrying, the other needs a manual price.
 */
export function PriceFeedNotice({
  unknown,
  unavailable,
  stale,
  onRetry,
  retrying,
}: PriceFeedNoticeProps) {
  if (unknown.length === 0 && unavailable.length === 0 && stale.length === 0) return null;

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-panel p-3 text-[12.5px]">
      {unavailable.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-negative">Couldn&apos;t reach the price feed for</span>
          <span className="font-medium text-foreground">{symbolList(unavailable)}</span>
          <span className="text-dim-2">
            — valued at cost basis for now. This is usually temporary.
          </span>
          <button
            onClick={onRetry}
            disabled={retrying}
            className="rounded border border-border px-2 py-0.5 text-[12px] text-foreground hover:border-accent disabled:opacity-50"
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-dim">No price available for</span>
          <span className="font-medium text-foreground">{symbolList(unknown)}</span>
          <span className="text-dim-2">
            — expired, delisted, or not on the feed. Set a manual price to value it.
          </span>
        </div>
      )}

      {stale.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-dim">Showing the last known price for</span>
          <span className="font-medium text-foreground">{symbolList(stale)}</span>
          <span className="text-dim-2">— the latest refresh didn&apos;t go through.</span>
        </div>
      )}
    </div>
  );
}
