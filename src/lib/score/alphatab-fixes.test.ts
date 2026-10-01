import { model } from "@coderline/alphatab";

import { applyAlphaTabFixes } from "@/lib/score/alphatab-fixes";
import { loadSong } from "@/lib/import";
import { fixtureBytes } from "@/test/score";

describe("alphaTab workarounds", () => {
  it("lets a beat without a voice answer isFullBarRest (Capella import crashed on it)", () => {
    applyAlphaTabFixes();
    applyAlphaTabFixes(); // idempotent
    const beat = new model.Beat();
    expect(beat.isFullBarRest).toBe(false);
  });

  it("opens Capella files (regression: every file with a note failed)", async () => {
    const loaded = await loadSong(fixtureBytes("practice-song.capx"), "practice-song.capx");
    expect(loaded.score.tracks).toHaveLength(2);
  });
});
