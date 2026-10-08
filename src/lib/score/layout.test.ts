import {
  CLASSIC_LAYOUT,
  FIRST_RUN_LAYOUT,
  LAYOUT_STORAGE_KEY,
  initLayoutPrefs,
  readLayoutPrefs,
  storeLayoutPrefs,
} from "@/lib/score/layout";

describe("panel layout (#83)", () => {
  beforeEach(() => localStorage.clear());

  it("reads back what was stored, and nothing for damaged values", () => {
    expect(readLayoutPrefs()).toBeNull();
    storeLayoutPrefs({ mixer: false, inspector: true });
    expect(readLayoutPrefs()).toEqual({ mixer: false, inspector: true });
    localStorage.setItem(LAYOUT_STORAGE_KEY, "{not json");
    expect(readLayoutPrefs()).toBeNull();
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ mixer: "yes" }));
    expect(readLayoutPrefs()).toBeNull();
  });

  it("starts a new install with the score and the playback controls only", async () => {
    expect(await initLayoutPrefs(async () => [])).toEqual(FIRST_RUN_LAYOUT);
    expect(readLayoutPrefs()).toEqual(FIRST_RUN_LAYOUT);
  });

  it("keeps both panels for someone who opened songs before", async () => {
    expect(await initLayoutPrefs(async () => ["/songs/a.gp"])).toEqual(CLASSIC_LAYOUT);
    expect(readLayoutPrefs()).toEqual(CLASSIC_LAYOUT);
  });

  it("keeps both panels for someone with saved preferences, even without recent songs", async () => {
    localStorage.setItem("smart-beat:theme", "dark");
    const recent = vi.fn(async () => []);
    expect(await initLayoutPrefs(recent)).toEqual(CLASSIC_LAYOUT);
    expect(recent).not.toHaveBeenCalled();
  });

  it("never overwrites a saved layout", async () => {
    storeLayoutPrefs({ mixer: true, inspector: false });
    expect(await initLayoutPrefs(async () => [])).toEqual({ mixer: true, inspector: false });
    expect(readLayoutPrefs()).toEqual({ mixer: true, inspector: false });
  });

  it("judges by the preferences alone when the recent songs cannot be read", async () => {
    expect(
      await initLayoutPrefs(async () => {
        throw new Error("not the desktop app");
      }),
    ).toEqual(FIRST_RUN_LAYOUT);
  });
});
