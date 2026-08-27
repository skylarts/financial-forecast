/**
 * Theme tags are free text, so "AI", " ai ", and "Ai" are the same tag typed
 * three ways. Everything that touches tags goes through here, so a symbol
 * tagged from two different screens can't end up with near-duplicate labels
 * that split its exposure across both when grouping.
 */

export function normalizeThemeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Dedupes case-insensitively while keeping the first spelling seen -- so
 * retyping an existing tag in different case reuses the tag instead of
 * minting a look-alike one, but nothing here forces a house style on
 * capitalization.
 */
export function normalizeThemes(raw: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const entry of raw) {
    const tag = normalizeThemeTag(entry);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }
  return [...seen.values()];
}

/** Every distinct tag in use across a set of securities, alphabetical. */
export function allThemes(themesBySymbol: Iterable<readonly string[]>): string[] {
  const seen = new Map<string, string>();
  for (const themes of themesBySymbol) {
    for (const tag of themes) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
