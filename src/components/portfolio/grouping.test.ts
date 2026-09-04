import { describe, expect, it } from "vitest";
import { buildNestedGroups, orderGroupsBy, type NestedLabel } from "./grouping";

interface Row {
  account: string;
  value: number;
}

const at = (key: string, label: string, subKey: string | null, subLabel: string | null): NestedLabel => ({
  key,
  label,
  subKey,
  subLabel,
});

const labelFor = (row: Row): NestedLabel =>
  row.account === "brokerage"
    ? at("brokerage", "Brokerage", null, null)
    : at("k401", "401(k)", row.account, row.account === "pre" ? "Pre-tax" : "Roth");

const rows: Row[] = [
  { account: "pre", value: 100 },
  { account: "brokerage", value: 40 },
  { account: "roth", value: 30 },
  { account: "pre", value: 10 },
];

describe("buildNestedGroups", () => {
  it("puts each parent's subdivisions directly beneath it", () => {
    const groups = buildNestedGroups(rows, labelFor);
    expect(groups.map((g) => [g.key, g.depth])).toEqual([
      ["k401", 0],
      ["pre", 1],
      ["roth", 1],
      ["brokerage", 0],
    ]);
  });

  it("totals a split parent over the whole family while drawing none of its rows", () => {
    const [parent] = buildNestedGroups(rows, labelFor);
    expect(parent.totalRows).toHaveLength(3);
    expect(parent.rows).toEqual([]);
  });

  it("leaves an undivided account holding its own rows", () => {
    const brokerage = buildNestedGroups(rows, labelFor).find((g) => g.key === "brokerage");
    expect(brokerage?.rows).toHaveLength(1);
    expect(brokerage?.parentKey).toBeNull();
  });

  it("keeps a single-sleeve parent whole rather than repeating itself one indent in", () => {
    const only = rows.filter((r) => r.account === "pre");
    expect(buildNestedGroups(only, labelFor).map((g) => g.depth)).toEqual([0]);
  });
});

describe("orderGroupsBy with nesting", () => {
  it("ranks parents by the family total and carries their subdivisions along", () => {
    const groups = buildNestedGroups(rows, labelFor);
    const sorted = orderGroupsBy(groups, (r) => r.reduce((s, row) => s + row.value, 0), "asc");
    expect(sorted.map((g) => g.key)).toEqual(["brokerage", "k401", "pre", "roth"]);
  });
});
