import { lastUsed, recentEntries, RECENT_CARDS } from "@/components/stems/stem-recent";
import { STEM_SONG } from "@/test/tauri";

const stem = (id: string, createdAtMs: number, lastOpened: number | null = null) => ({
  ...STEM_SONG,
  id,
  name: id,
  createdAtMs,
  lastOpened,
});
const paths = (count: number) => Array.from({ length: count }, (_, i) => `/Songs/s${i}.gp5`);
const label = (entry: ReturnType<typeof recentEntries>[number]) =>
  entry.kind === "stem" ? `stem:${entry.song.id}` : entry.path;

describe("recentEntries", () => {
  it("uses the time a song was opened, else the time it was made", () => {
    expect(lastUsed(stem("a", 100))).toBe(100);
    expect(lastUsed(stem("a", 100, 900))).toBe(900);
  });

  it("puts the separated songs first, the most recently used on top, then the songs in order", () => {
    const entries = recentEntries(paths(2), [stem("a", 100), stem("b", 50, 500), stem("c", 300)]);
    expect(entries.map(label)).toEqual([
      "stem:b",
      "stem:c",
      "stem:a",
      "/Songs/s0.gp5",
      "/Songs/s1.gp5",
    ]);
  });

  it("keeps room for five songs and stops at ten cards", () => {
    const many = Array.from({ length: 8 }, (_, i) => stem(`m${i}`, i));
    const entries = recentEntries(paths(10), many);
    expect(entries).toHaveLength(RECENT_CARDS);
    expect(entries.filter((entry) => entry.kind === "stem")).toHaveLength(5);
    expect(entries.filter((entry) => entry.kind === "song")).toHaveLength(5);
  });

  it("lets separated songs fill the room where there are few songs", () => {
    const many = Array.from({ length: 12 }, (_, i) => stem(`m${i}`, i));
    expect(recentEntries(paths(2), many)).toHaveLength(RECENT_CARDS);
    expect(recentEntries(paths(2), many).filter((e) => e.kind === "stem")).toHaveLength(8);
    expect(recentEntries([], many).filter((e) => e.kind === "stem")).toHaveLength(10);
  });

  it("shows only the songs when nothing was separated", () => {
    expect(recentEntries(paths(3), []).map(label)).toEqual(paths(3));
    expect(recentEntries([], [])).toEqual([]);
  });
});
