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

  it("a scope naming nothing real resolves empty rather than everything", () => {
    expect(accountIdsInScope(accounts, ownerScope("ghost"))).toEqual([]);
    expect(accountIdsInScope(accounts, accountScope("ghost"))).toEqual([]);
    expect(accountIdsInScope(accounts, "ghost")).toEqual([]);
  });
});
