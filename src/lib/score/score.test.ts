import { readFileSync } from "node:fs";
import path from "node:path";

import { applyTrackView, gpFromPan, panFromGp, parseScore, volumeFromGp } from "@/lib/score/score";
import { ScoreLoadError } from "@/lib/score/errors";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(path.join(import.meta.dirname, "../../../e2e/fixtures", name)));

describe("parseScore", () => {
  it("summarizes a Guitar Pro file for the UI", () => {
    const { summary } = parseScore(fixture("practice-song.gp"));

    expect(summary.title).toBe("Practice Song");
    expect(summary.artist).toBe("Smart Beat");
    expect(summary.tracks.map((t) => t.name)).toEqual(["Guitar", "Bass", "Drums", "Piano"]);
  });

  it("describes which views each track supports", () => {
    const [guitar, bass, drums, piano] = parseScore(fixture("practice-song.gp")).summary.tracks;

    expect(guitar).toMatchObject({ hasTablature: true, defaultView: { notation: "score-tab" } });
    expect(bass).toMatchObject({ hasTablature: true, defaultView: { notation: "tab" } });
    expect(drums).toMatchObject({
      isPercussion: true,
      hasTablature: false,
      defaultView: { notation: "score" },
    });
    expect(piano).toMatchObject({ hasTablature: false, defaultView: { notation: "score" } });
  });

  it("starts the mixer from the values saved in the file", () => {
    const { summary } = parseScore(fixture("practice-song.gp"));

    expect(summary.tracks[0]!.mix).toEqual({ volume: 15 / 16, pan: 0, mute: false, solo: false });
    expect(summary.tracks[1]!.mix).toEqual({
      volume: 12 / 16,
      pan: -0.5,
      mute: false,
      solo: false,
    });
    expect(summary.tracks[3]!.mix.mute).toBe(true);
  });

  it("sets every track to full volume so the mixer controls the level", () => {
    const { score } = parseScore(fixture("practice-song.gp"));

    expect(score.tracks.map((t) => t.playbackInfo.volume)).toEqual([16, 16, 16, 16]);
  });

  it("reports damaged files", () => {
    expect(() => parseScore(fixture("corrupt.gp5"))).toThrow(ScoreLoadError);
    expect(() => parseScore(fixture("corrupt.gp5"))).toThrow(/damaged or in an unsupported format/);
  });

  it("reports content that is not a score at all", () => {
    expect(() => parseScore(new TextEncoder().encode("hello"))).toThrow(ScoreLoadError);
  });
});

describe("applyTrackView", () => {
  it("toggles standard notation and tablature on stringed tracks", () => {
    const { score } = parseScore(fixture("practice-song.gp"));
    const guitar = score.tracks[0]!;
    const staff = guitar.staves[0]!;

    applyTrackView(guitar, { notation: "tab", rhythm: false });
    expect([staff.showStandardNotation, staff.showTablature]).toEqual([false, true]);

    applyTrackView(guitar, { notation: "score", rhythm: false });
    expect([staff.showStandardNotation, staff.showTablature]).toEqual([true, false]);

    applyTrackView(guitar, { notation: "score-tab", rhythm: true });
    expect([staff.showStandardNotation, staff.showTablature]).toEqual([true, true]);
  });

  it("shows drums as a score, a drum tab (mirror staff) or both", () => {
    const { score } = parseScore(fixture("practice-song.gp"));
    const drums = score.tracks[2]!;

    applyTrackView(drums, { notation: "tab", rhythm: false });
    expect(drums.staves).toHaveLength(2);
    expect(drums.staves[0]!.showStandardNotation).toBe(false);
    expect(drums.staves[1]!.showTablature).toBe(true);

    applyTrackView(drums, { notation: "score-tab", rhythm: false });
    expect(drums.staves[0]!.showStandardNotation).toBe(true);
    expect(drums.staves).toHaveLength(2);

    applyTrackView(drums, { notation: "score", rhythm: false });
    expect(drums.staves).toHaveLength(1);
    expect(drums.staves[0]!.showTablature).toBe(false);
  });

  it("removes the drum tab when another track is shown", () => {
    const { score } = parseScore(fixture("practice-song.gp"));
    applyTrackView(score.tracks[2]!, { notation: "tab", rhythm: false });
    applyTrackView(score.tracks[0]!, { notation: "tab", rhythm: false });
    expect(score.tracks[2]!.staves).toHaveLength(1);
  });

  it("keeps keyboards in standard notation", () => {
    const { score } = parseScore(fixture("practice-song.gp"));
    const keys = score.tracks.find((t) => !t.isPercussion && t.staves[0]!.tuning.length === 0);
    if (!keys) return;
    applyTrackView(keys, { notation: "tab", rhythm: false });
    expect(keys.staves[0]!.showStandardNotation).toBe(true);
  });
});

describe("Guitar Pro value conversion", () => {
  it.each([
    [0, 0],
    [8, 0.5],
    [16, 1],
    [20, 1],
  ])("volume %i/16 is %f", (gp, volume) => {
    expect(volumeFromGp(gp)).toBe(volume);
  });

  it.each([
    [0, -1],
    [4, -0.5],
    [8, 0],
    [16, 1],
  ])("balance %i is pan %f and back", (balance, pan) => {
    expect(panFromGp(balance)).toBe(pan);
    expect(gpFromPan(pan)).toBe(balance);
  });

  it("rounds and clamps pan values", () => {
    expect(gpFromPan(0.3)).toBe(10);
    expect(gpFromPan(-5)).toBe(0);
  });
});
