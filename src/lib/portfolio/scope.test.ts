import { describe, expect, it } from "vitest";
import type { PortfolioAccount } from "@/domain/portfolio";
import {
  accountIdsInScope,
  accountScope,
  ALL_ACCOUNTS_SCOPE,
  JOINT_OWNER_SCOPE,
  ownerScope,
} from "./scope";

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
  account({ id: "a1", ownerId: "p1" }),
  account({ id: "a2", ownerId: "p1" }),
  account({ id: "a3", ownerId: "p2" }),
  account({ id: "a4", ownerId: null }),
];

describe("accountIdsInScope", () => {
  it("'all' covers every account", () => {
    expect(accountIdsInScope(accounts, ALL_ACCOUNTS_SCOPE)).toBeNull();
  });

  it("an owner scope narrows to that person's accounts", () => {
    expect(accountIdsInScope(accounts, ownerScope("p1"))?.sort()).toEqual(["a1", "a2"]);
    expect(accountIdsInScope(accounts, ownerScope("p2"))).toEqual(["a3"]);
  });

  it("the joint scope narrows to unowned accounts", () => {
    expect(accountIdsInScope(accounts, JOINT_OWNER_SCOPE)).toEqual(["a4"]);
  });

  it("an account scope narrows to that one account", () => {
    expect(accountIdsInScope(accounts, accountScope("a3"))).toEqual(["a3"]);
  });

  it("a legacy bare account id still resolves to that one account", () => {
    expect(accountIdsInScope(accounts, "a2")).toEqual(["a2"]);
  });

  it("naming a split account covers its sleeves too", () => {
    const split: PortfolioAccount[] = [
      ...accounts,
      account({ id: "k401", ownerId: "p1", name: "401(k)" }),
      account({ id: "k401-pre", ownerId: "p1", parentAccountId: "k401" }),
      account({ id: "k401-roth", ownerId: "p1", parentAccountId: "k401" }),
    ];
    expect(accountIdsInScope(split, accountScope("k401"))).toEqual([
      "k401",
      "k401-pre",
      "k401-roth",
    ]);
  });

  it("naming one sleeve covers only that sleeve", () => {
    const split: PortfolioAccount[] = [
      ...accounts,
      account({ id: "k401" }),
      account({ id: "k401-pre", parentAccountId: "k401" }),
      account({ id: "k401-roth", parentAccountId: "k401" }),
    ];
    expect(accountIdsInScope(split, accountScope("k401-roth"))).toEqual(["k401-roth"]);
  });

  it("a scope naming nothing real resolves empty rather than everything", () => {
    expect(accountIdsInScope(accounts, ownerScope("ghost"))).toEqual([]);
    expect(accountIdsInScope(accounts, accountScope("ghost"))).toEqual([]);
    expect(accountIdsInScope(accounts, "ghost")).toEqual([]);
  });
});
