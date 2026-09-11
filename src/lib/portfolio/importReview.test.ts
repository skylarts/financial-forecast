import { describe, expect, it } from "vitest";
import type { ImportRow } from "./importer";
import { accountForRow, bucketOf, isRowChecked, resolveRouting, withTypeOverride } from "./importReview";

function row(patch: Partial<ImportRow> = {}): ImportRow {
  return {
    raw: [],
    draft: {
      date: "2026-01-10",
      type: "buy",
      symbol: "VTI",
      quantity: 10,
      price: 100,
      amount: null,
      fees: 0,
      lotId: null,
      acquiredDate: null,
      spinoffSymbol: null,
      spinoffShareRatio: null,
      spinoffBasisRetained: null,
      note: "",
      sourceHash: "abc",
    },
    taxSourceLabel: "",
    issues: [],
    skip: false,
    duplicate: false,
    duplicateVia: null,
    syncMatchId: null,
    action: "Buy",
    typeSource: "preset",
    unrecognised: false,
    ignored: null,
    transferPeer: null,
    ...patch,
  };
}

const sleeves = [
  { id: "pre", type: "traditional_401k" as const },
  { id: "roth", type: "roth_401k" as const },
];

describe("bucketOf", () => {
  it("puts every row in exactly one pile, worst first", () => {
    expect(bucketOf(row())).toBe("ready");
    expect(bucketOf(row({ issues: ["note"] }))).toBe("flagged");
    expect(bucketOf(row({ duplicate: true, duplicateVia: "exact", issues: ["note"] }))).toBe("duplicate");
    expect(bucketOf(row({ unrecognised: true, duplicate: true }))).toBe("unrecognised");
    expect(bucketOf(row({ skip: true, unrecognised: true }))).toBe("error");
    expect(bucketOf(row({ skip: true, ignored: "bookkeeping" }))).toBe("ignored");
  });
});

describe("resolveRouting", () => {
  it("prefers what the user chose, then the label's own wording, then nothing", () => {
    const out = resolveRouting(
      ["ROTH CONTRIBUTION", "EMPLOYEE BEFORE TAX-VOLUNTARY", "Mystery source"],
      { "ROTH CONTRIBUTION": "pre" },
      sleeves,
    );
    expect(out).toEqual({
      "ROTH CONTRIBUTION": "pre",
      "EMPLOYEE BEFORE TAX-VOLUNTARY": "pre",
      "Mystery source": "",
    });
  });
});

describe("accountForRow", () => {
  it("routes by label only when routing is on and the label resolved", () => {
    const routing = { Roth: "roth", Mystery: "" };
    expect(accountForRow(row({ taxSourceLabel: "Roth" }), "parent", true, routing)).toBe("roth");
    expect(accountForRow(row({ taxSourceLabel: "Mystery" }), "parent", true, routing)).toBe("parent");
    expect(accountForRow(row({ taxSourceLabel: "Roth" }), "parent", false, routing)).toBe("parent");
  });
});

describe("withTypeOverride", () => {
  it("returns the same row when nothing changes, a copy when the type does", () => {
    const original = row();
    expect(withTypeOverride(original, undefined)).toBe(original);
    expect(withTypeOverride(original, "buy")).toBe(original);
    const changed = withTypeOverride(original, "dividend");
    expect(changed).not.toBe(original);
    expect(changed.draft.type).toBe("dividend");
    expect(original.draft.type).toBe("buy");
  });
});

describe("isRowChecked", () => {
  it("never imports a row that could not be read", () => {
    expect(isRowChecked(row({ skip: true }), true, "confirm", false)).toBe(false);
  });

  it("imports a guess only once it is confirmed", () => {
    const guess = row({ unrecognised: true });
    expect(isRowChecked(guess, true, undefined, false)).toBe(false);
    expect(isRowChecked(guess, undefined, "skip", false)).toBe(false);
    expect(isRowChecked(guess, undefined, "confirm", false)).toBe(true);
  });

  it("follows the tick, defaulting duplicates off while they are being skipped", () => {
    const dup = row({ duplicate: true, duplicateVia: "exact" });
    expect(isRowChecked(dup, undefined, undefined, true)).toBe(false);
    expect(isRowChecked(dup, undefined, undefined, false)).toBe(true);
    expect(isRowChecked(dup, true, undefined, true)).toBe(true);
    expect(isRowChecked(row(), false, undefined, true)).toBe(false);
  });
});
