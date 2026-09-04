import { describe, expect, it } from "vitest";
import type { PortfolioAccount } from "@/domain/portfolio";
import {
  accountFamilyIds,
  accountGroups,
  accountPath,
  accountTreeRows,
  assertAssignableParent,
  hasSleeves,
  isSleeve,
  sleevesOf,
} from "./accountTree";

function account(patch: Partial<PortfolioAccount> & { id: string }): PortfolioAccount {
  return {
    name: patch.id,
    institution: "",
    type: "taxable",
    forecastAccountId: null,
    syncToForecast: true,
    ownerId: null,
    openingCashBalance: 0,
    parentAccountId: null,
    schwabAccountHash: null,
    ...patch,
  };
}

/** A brokerage, then a 401(k) split into its two tax sleeves. */
const accounts: PortfolioAccount[] = [
  account({ id: "brokerage", name: "Brokerage" }),
  account({ id: "k401", name: "Texa$aver 401(k)" }),
  account({ id: "pre", name: "Pre-tax", type: "traditional_401k", parentAccountId: "k401" }),
  account({ id: "roth", name: "Roth", type: "roth_401k", parentAccountId: "k401" }),
];

describe("sleeve basics", () => {
  it("tells a sleeve from a standalone account", () => {
    expect(isSleeve(accounts[0])).toBe(false);
    expect(isSleeve(accounts[2])).toBe(true);
  });

  it("lists the sleeves under a parent, in list order", () => {
    expect(sleevesOf(accounts, "k401").map((a) => a.id)).toEqual(["pre", "roth"]);
    expect(sleevesOf(accounts, "brokerage")).toEqual([]);
  });

  it("knows which accounts hold sleeves", () => {
    expect(hasSleeves(accounts, "k401")).toBe(true);
    expect(hasSleeves(accounts, "brokerage")).toBe(false);
  });
});

describe("accountFamilyIds", () => {
  it("covers a parent and everything under it", () => {
    expect(accountFamilyIds(accounts, "k401")).toEqual(["k401", "pre", "roth"]);
  });

  it("resolves a standalone account to just itself", () => {
    expect(accountFamilyIds(accounts, "brokerage")).toEqual(["brokerage"]);
  });

  it("resolves one sleeve to just that sleeve", () => {
    expect(accountFamilyIds(accounts, "roth")).toEqual(["roth"]);
  });
});

describe("accountPath", () => {
  it("qualifies a sleeve with its parent's name", () => {
    expect(accountPath(accounts, accounts[3])).toBe("Texa$aver 401(k) / Roth");
  });

  it("leaves a standalone account's name alone", () => {
    expect(accountPath(accounts, accounts[0])).toBe("Brokerage");
  });

  it("falls back to the bare name when the parent is gone", () => {
    const orphan = account({ id: "roth", name: "Roth", parentAccountId: "vanished" });
    expect(accountPath([orphan], orphan)).toBe("Roth");
  });
});

describe("accountTreeRows", () => {
  it("puts each parent's sleeves directly beneath it", () => {
    expect(accountTreeRows(accounts).map((r) => [r.account.id, r.depth, r.isParent])).toEqual([
      ["brokerage", 0, false],
      ["k401", 0, true],
      ["pre", 1, false],
      ["roth", 1, false],
    ]);
  });

  it("shows an orphaned sleeve at top level rather than dropping it", () => {
    const orphaned = [account({ id: "brokerage" }), account({ id: "lost", parentAccountId: "gone" })];
    expect(accountTreeRows(orphaned).map((r) => r.account.id)).toEqual(["brokerage", "lost"]);
  });

  it("emits every account exactly once", () => {
    expect(accountTreeRows(accounts)).toHaveLength(accounts.length);
  });
});

describe("assertAssignableParent", () => {
  it("allows a plain account to become a sleeve of a plain account", () => {
    expect(assertAssignableParent(accounts, "brokerage", "k401")).toBeNull();
  });

  it("allows detaching a sleeve", () => {
    expect(assertAssignableParent(accounts, "roth", null)).toBeNull();
  });

  it("refuses to make an account its own parent", () => {
    expect(assertAssignableParent(accounts, "k401", "k401")).toMatch(/itself/);
  });

  it("refuses to nest a sleeve under a sleeve", () => {
    expect(assertAssignableParent(accounts, "brokerage", "roth")).toMatch(/cannot be nested/);
  });

  it("refuses to demote an account that has sleeves of its own", () => {
    expect(assertAssignableParent(accounts, "k401", "brokerage")).toMatch(/sleeves of its own/);
  });

  it("refuses a parent that no longer exists", () => {
    expect(assertAssignableParent(accounts, "brokerage", "ghost")).toMatch(/no longer exists/);
  });
});

describe("account groups", () => {
  it("files a sleeve under its parent, keeping its own name as the subdivision", () => {
    const groups = accountGroups(accounts);
    expect(groups.get("roth")).toEqual({
      key: "k401",
      label: "Texa$aver 401(k)",
      subKey: "roth",
      subLabel: "Roth",
    });
    expect(groups.get("pre")?.key).toBe("k401");
  });

  it("leaves a standalone account undivided", () => {
    expect(accountGroups(accounts).get("brokerage")).toEqual({
      key: "brokerage",
      label: "Brokerage",
      subKey: null,
      subLabel: null,
    });
  });

  it("gives a split parent's own rows a subdivision of their own", () => {
    // Otherwise they would sit under a header whose subtotal already counts
    // the sleeves listed below them.
    expect(accountGroups(accounts).get("k401")).toEqual({
      key: "k401",
      label: "Texa$aver 401(k)",
      subKey: "k401:own",
      subLabel: "Unassigned",
    });
  });

  it("keeps two people's Roth sleeves apart", () => {
    const two = [
      ...accounts,
      account({ id: "k401b", name: "Hirva 401(k)" }),
      account({ id: "rothb", name: "Roth", type: "roth_401k", parentAccountId: "k401b" }),
    ];
    const groups = accountGroups(two);
    expect(groups.get("roth")?.key).not.toBe(groups.get("rothb")?.key);
  });
});
