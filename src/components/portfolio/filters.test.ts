import { describe, expect, it } from "vitest";
import type { Person } from "@/domain/household";
import type { PortfolioAccount } from "@/domain/portfolio";
import type { FacetState } from "@/components/ui/facets";
import { accountFacetOptions, accountIdsForFacet } from "./filters";

function account(patch: Partial<PortfolioAccount> & { id: string }): PortfolioAccount {
  return {
    name: "Account",
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

const accounts: PortfolioAccount[] = [
  account({ id: "a1", name: "Her Roth", ownerId: "p1" }),
  account({ id: "a2", name: "Her Brokerage", ownerId: "p1" }),
  account({ id: "a3", name: "His Roth", ownerId: "p2" }),
  account({ id: "a4", name: "Joint Brokerage", ownerId: null }),
];

const people: Person[] = [
  { id: "p1", name: "Ada" },
  { id: "p2", name: "Linus" },
] as Person[];

const split: PortfolioAccount[] = [
  ...accounts,
  account({ id: "k401", name: "401(k)", ownerId: "p1" }),
  account({ id: "k401-pre", name: "Pre-tax", ownerId: "p1", parentAccountId: "k401" }),
  account({ id: "k401-roth", name: "Roth", ownerId: "p1", parentAccountId: "k401" }),
];

function facet(mode: FacetState["mode"], ...ids: string[]): FacetState {
  return { mode, selected: new Set(ids) };
}

describe("accountIdsForFacet", () => {
  it("nothing ticked covers every account", () => {
    expect(accountIdsForFacet(accounts, facet("include"))).toBeNull();
  });

  it("ticked accounts are the ones in play", () => {
    expect(accountIdsForFacet(accounts, facet("include", "a1", "a4"))?.sort()).toEqual(["a1", "a4"]);
  });

  it("hiding leaves everything that wasn't ticked", () => {
    expect(accountIdsForFacet(accounts, facet("exclude", "a1"))).toEqual(["a2", "a3", "a4"]);
  });

  it("ticking a split account covers its sleeves too", () => {
    expect(accountIdsForFacet(split, facet("include", "k401"))?.sort()).toEqual([
      "k401",
      "k401-pre",
      "k401-roth",
    ]);
  });

  it("hiding a split account hides its sleeves too", () => {
    expect(accountIdsForFacet(split, facet("exclude", "k401"))).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("ticking one sleeve covers only that sleeve", () => {
    expect(accountIdsForFacet(split, facet("include", "k401-roth"))).toEqual(["k401-roth"]);
  });

  it("hiding every account shows nothing rather than everything", () => {
    expect(accountIdsForFacet(accounts, facet("exclude", "a1", "a2", "a3", "a4"))).toEqual([]);
  });

  it("an account that no longer exists widens nothing", () => {
    expect(accountIdsForFacet(accounts, facet("include", "ghost"))).toEqual([]);
    expect(accountIdsForFacet(accounts, facet("include", "ghost", "a3"))).toEqual(["a3"]);
  });
});

describe("accountFacetOptions", () => {
  it("groups accounts by whose they are, joint last", () => {
    expect(accountFacetOptions(accounts, people).map((o) => [o.group, o.label])).toEqual([
      ["Ada", "Her Roth"],
      ["Ada", "Her Brokerage"],
      ["Linus", "His Roth"],
      ["Joint", "Joint Brokerage"],
    ]);
  });

  it("names a sleeve after its parent, so the chip reads as an account", () => {
    const labels = accountFacetOptions(split, people).map((o) => o.label);
    expect(labels).toContain("401(k) / Roth");
    expect(labels).not.toContain("Roth");
  });

  it("carries no count -- the account list decides what there is to count", () => {
    expect(accountFacetOptions(accounts, people).every((o) => o.count === undefined)).toBe(true);
  });
});
