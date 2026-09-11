import { describe, expect, it } from "vitest";
import type { SplitEvent } from "@/engine/portfolio/performance";
import { feedSplitHash, splitDraft, suggestSplitRows, type SplitLedgerRow } from "./importSplits";

const row = (date: string, type: SplitLedgerRow["type"], symbol: string | null, quantity: number): SplitLedgerRow => ({
  date,
  type,
  symbol,
  quantity,
});

const calendar = (entries: Record<string, SplitEvent[]>) => new Map(Object.entries(entries));

describe("suggestSplitRows", () => {
  it("offers a split the position was held through", () => {
    const out = suggestSplitRows(
      [row("2022-01-10", "buy", "UVXY", 10)],
      [],
      calendar({ UVXY: [{ date: "2022-07-01", ratio: 0.1 }] }),
    );
    expect(out).toEqual([
      { symbol: "UVXY", date: "2022-07-01", ratio: 0.1, sharesBefore: 10, sharesAfter: 1 },
    ]);
  });

  it("offers nothing for a split after the position was closed", () => {
    const out = suggestSplitRows(
      [row("2022-01-10", "buy", "UVXY", 10), row("2022-01-15", "sell", "UVXY", 10)],
      [],
      calendar({ UVXY: [{ date: "2022-07-01", ratio: 0.1 }] }),
    );
    expect(out).toEqual([]);
  });

  it("offers nothing for a split before the first trade", () => {
    const out = suggestSplitRows(
      [row("2022-06-01", "buy", "NVDA", 10)],
      [],
      calendar({ NVDA: [{ date: "2021-07-20", ratio: 4 }, { date: "2024-06-10", ratio: 10 }] }),
    );
    expect(out.map((s) => s.date)).toEqual(["2024-06-10"]);
    expect(out[0].sharesAfter).toBe(100);
  });

  it("counts what the ledger already holds, not just the file", () => {
    const out = suggestSplitRows(
      [row("2024-07-01", "buy", "NVDA", 5)],
      [row("2023-01-05", "buy", "NVDA", 10)],
      calendar({ NVDA: [{ date: "2024-06-10", ratio: 10 }] }),
    );
    expect(out[0].sharesBefore).toBe(10);
  });

  it("stays quiet when a split row is already on the books", () => {
    const out = suggestSplitRows(
      [row("2023-01-05", "buy", "NVDA", 10)],
      [row("2024-06-11", "split", "NVDA", 10)],
      calendar({ NVDA: [{ date: "2024-06-10", ratio: 10 }] }),
    );
    expect(out).toEqual([]);
  });

  it("treats a spinoff near the feed's event as the explanation for it", () => {
    const out = suggestSplitRows(
      [row("2023-01-05", "buy", "DHR", 10)],
      [row("2023-10-02", "spinoff", "DHR", 1)],
      calendar({ DHR: [{ date: "2023-10-02", ratio: 0.8834 }] }),
    );
    expect(out).toEqual([]);
  });

  it("applies an earlier split before measuring a later one", () => {
    const out = suggestSplitRows(
      [row("2021-01-05", "buy", "NVDA", 10)],
      [],
      calendar({ NVDA: [{ date: "2021-07-20", ratio: 4 }, { date: "2024-06-10", ratio: 10 }] }),
    );
    expect(out.map((s) => [s.date, s.sharesBefore, s.sharesAfter])).toEqual([
      ["2021-07-20", 10, 40],
      ["2024-06-10", 40, 400],
    ]);
  });

  it("ignores option contracts and symbols the feed said nothing about", () => {
    const out = suggestSplitRows(
      [row("2022-01-10", "buy", "MQ270115C00005500", 1), row("2022-01-10", "buy", "ZZZZ", 10)],
      [],
      calendar({ MQ: [{ date: "2026-02-19", ratio: 0.25 }] }),
    );
    expect(out).toEqual([]);
  });

  it("measures a short position through a split too", () => {
    const out = suggestSplitRows(
      [row("2022-01-10", "short_sell", "UVXY", 10)],
      [],
      calendar({ UVXY: [{ date: "2022-07-01", ratio: 0.1 }] }),
    );
    expect(out[0].sharesBefore).toBe(-10);
  });
});

describe("splitDraft", () => {
  it("becomes the ledger's own split row, fingerprinted so a re-import knows it", () => {
    const draft = splitDraft({ symbol: "UVXY", date: "2022-07-01", ratio: 0.1, sharesBefore: 10, sharesAfter: 1 });
    expect(draft.type).toBe("split");
    expect(draft.quantity).toBe(0.1);
    expect(draft.symbol).toBe("UVXY");
    expect(draft.sourceHash).toBe(feedSplitHash("UVXY", "2022-07-01"));
  });
});
