import { describe, expect, it } from "vitest";

import { computePreview } from "@/components/audio-lanes/lane-transcribe/use-part-preview";
import type { LanePart } from "@/lib/audio-lanes/lane-transcribe";
import { placeTake } from "@/lib/import/place-take";
import { appendMasterBar, refinish, type Score } from "@/lib/score/model";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { createSong } from "@/lib/score/tracks";
import { shotOf } from "@/test/score-snapshot";

const notes = [40, 45, 50, 55].map((pitch, i) => ({
  pitch,
  start: i * 0.5,
  end: i * 0.5 + 0.5,
  velocity: 90,
}));
const part = (instrument: LanePart["instrument"] = "guitar"): LanePart => ({
  notes,
  take: notes,
  originBar: 0,
  span: { startMs: 0, endMs: 2000 },
  instrument,
  tuning: [...STANDARD_GUITAR],
  laneName: "Lead",
});
function song(): Score {
  const score = createSong();
  while (score.masterBars.length < 4) appendMasterBar(score);
  return score;
}

describe("computePreview", () => {
  it("shows what the write will put in the tab, and leaves the song alone", () => {
    const live = song();
    const before = JSON.stringify(shotOf(live));
    const preview = computePreview(live, part(), { kind: "track", index: 0 }, 1);
    expect(JSON.stringify(shotOf(live))).toBe(before);
    // The real write: placeTake, then what the editor does after every change.
    placeTake(live, notes, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: 1,
    });
    refinish(live);
    expect(shotOf(preview.score)).toEqual(shotOf(live));
    expect([preview.firstBar, preview.lastBar]).toEqual([1, 1]);
    expect(preview.kind).toBe("track");
  });

  it("links the copy up again, so alphaTab can draw it", () => {
    const preview = computePreview(song(), part(), { kind: "track", index: 0 }, 0);
    const beats = preview.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
    expect(beats.map((b) => b.index)).toEqual(beats.map((_, i) => i));
    expect(beats[0]!.nextBeat).toBe(beats[1]);
  });

  it("counts the notes a track loses", () => {
    const live = song();
    placeTake(live, notes, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: 0,
    });
    const preview = computePreview(live, part(), { kind: "track", index: 0 }, 0);
    expect(preview.existingNotes).toBe(4);
    expect(computePreview(live, part(), { kind: "track", index: 0 }, 2).existingNotes).toBe(0);
  });

  it("previews a new track on a copy and a new tab as its own song", () => {
    const live = song();
    const track = computePreview(live, part(), { kind: "new-track" }, 0);
    expect(track.score.tracks).toHaveLength(live.tracks.length + 1);
    expect(live.tracks).toHaveLength(1);
    const tab = computePreview(live, part(), { kind: "new-tab" }, 0);
    expect(tab.kind).toBe("new-tab");
    expect(tab.score).not.toBe(live);
    expect(tab.score.tracks.length).toBeGreaterThan(0);
  });

  it("a part that runs past the end makes the copy grow, not the song", () => {
    const live = song();
    const preview = computePreview(live, part(), { kind: "track", index: 0 }, 3);
    expect(preview.appended).toBe(0);
    const late = {
      ...part(),
      take: notes.map((n) => ({ ...n, start: n.start + 5, end: n.end + 5 })),
    };
    const grown = computePreview(live, late, { kind: "track", index: 0 }, 3);
    expect(grown.appended).toBeGreaterThan(0);
    expect(live.masterBars).toHaveLength(4);
  });
});
