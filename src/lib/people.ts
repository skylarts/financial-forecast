import type { Person } from "@/domain/household";
import type { Account } from "@/domain/account";

/**
 * Resolves an `ownerId` to a display name.
 *
 * `null` means joint/household -- the convention forecast accounts, income
 * sources, and now portfolio accounts all share. An id that doesn't match
 * anyone (a person removed after the fact, a stale link) reads the same way
 * as "joint" rather than as a person, since crediting a specific name to data
 * that no longer has one would be misleading.
 */
export function ownerLabel(people: readonly Person[], ownerId: string | null): string {
  if (ownerId === null) return "Joint";
  return people.find((p) => p.id === ownerId)?.name ?? "Joint";
}

/** `<select>` options for an owner picker: "Joint / none" plus one entry per person. */
export function ownerOptions(people: readonly Person[]): { value: string; label: string }[] {
  return [
    { value: "", label: "Joint / none" },
    ...people.map((p) => ({ value: p.id, label: p.name })),
  ];
}

/** An account's name with its owner appended when it has one, so his and her "Roth IRA" read apart in a picker. */
export function accountLabel(account: Pick<Account, "name" | "ownerId">, people: readonly Person[]): string {
  if (!account.ownerId) return account.name;
  const owner = people.find((p) => p.id === account.ownerId)?.name;
  return owner ? `${account.name} (${owner})` : account.name;
}

/** `<select>` options for an account picker, labelled with owners. */
export function accountOptions(accounts: readonly Account[], people: readonly Person[]): { value: string; label: string }[] {
  return accounts.map((a) => ({ value: a.id, label: accountLabel(a, people) }));
}
