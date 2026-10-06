/** Helpers for the user's sound library (see src-tauri/src/audio/library.rs). */
import type { LibraryItem } from "@/lib/tauri";

/** Tags typed as "metal, djent" → ["metal", "djent"] (no blanks or repeats, at most 20). */
export const parseTags = (text: string): string[] =>
  [
    ...new Set(
      text
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

/** Every tag used in the library, sorted, without repeats (compared ignoring case). */
export function tagsOf(items: readonly LibraryItem[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    for (const tag of item.tags) {
      if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The items whose name, tags or file name contain the search text, and carry the tag (if any). */
export function filterLibrary(
  items: readonly LibraryItem[],
  { search, tag }: { search: string; tag: string | null },
): LibraryItem[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (tag && !item.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    const haystack = [item.name, item.source, ...item.tags].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
