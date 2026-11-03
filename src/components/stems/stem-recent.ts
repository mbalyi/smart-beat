import type { StemSong } from "@/lib/tauri";

/** How many cards the Recent grid shows in all (the same as File › Open Recent remembers). */
export const RECENT_CARDS = 10;
/** Separated songs always have room for this many cards; more only where songs leave space. */
const MIN_STEM_CARDS = 5;

/** One card of the Recent grid: a song to open by its path, or a separated song. */
export type RecentEntry = { kind: "song"; path: string } | { kind: "stem"; song: StemSong };

/** When a separated song was last used: opened, or else made. */
export const lastUsed = (song: StemSong): number => song.lastOpened ?? song.createdAtMs;

/**
 * The cards of the Recent grid. The recent songs are a list of paths in the order they were
 * opened, with no times, so they cannot be sorted against the separated songs. The rule is:
 * separated songs first, most recently used first (`lastOpened`, else `createdAtMs`), then the
 * recent songs in their own order. To keep the songs from being pushed out, the separated songs
 * get at most five cards, or more only where fewer than five songs leave room; the whole grid
 * stops at {@link RECENT_CARDS}.
 */
export function recentEntries(paths: readonly string[], stems: readonly StemSong[]): RecentEntry[] {
  const stemCards = Math.max(MIN_STEM_CARDS, RECENT_CARDS - paths.length);
  const shown = [...stems]
    .sort((a, b) => lastUsed(b) - lastUsed(a))
    .slice(0, stemCards)
    .map((song): RecentEntry => ({ kind: "stem", song }));
  const songs = paths
    .slice(0, Math.max(0, RECENT_CARDS - shown.length))
    .map((path): RecentEntry => ({ kind: "song", path }));
  return [...shown, ...songs];
}
