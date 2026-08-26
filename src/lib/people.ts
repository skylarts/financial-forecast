import type { Person } from "@/domain/household";

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
