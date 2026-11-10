import { describe, expect, it } from "vitest";

import { CUT_FADE_MS, EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import {
  quietSpans,
  removeSilence,
  silencePieces,
  silencePreview,
  skippedMessage,
} from "@/lib/audio-lanes/silence";
import type { AudioClip, AudioLanesSettings, SilentRegion } from "@/lib/tauri";

const SOURCE = { id: "s".repeat(64), name: "take.wav", ext: "wav", embedded: true };

function song(clips: AudioClip[], ripple: AudioLanesSettings["ripple"] = "off") {
  return {
    ...EMPTY_AUDIO,
    ripple,
    sources: [SOURCE],
    lanes: [{ ...newLane("Vocals", "lane-a"), clips }],
  } satisfies AudioLanesSettings;
}

/** A clip of 4 s of the file, 2 s into the song. */
const plain = (patch: Partial<AudioClip> = {}): AudioClip => ({
  ...newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a"),
  ...patch,
});

const regions = (...ranges: [number, number][]) =>
  new Map<string, SilentRegion[]>([
    [SOURCE.id, ranges.map(([startMs, endMs]) => ({ startMs, endMs }))],
  ]);

let counter = 0;
const ids = () => `id-${++counter}`;

const clipsOf = (audio: AudioLanesSettings) => audio.lanes[0]!.clips;

describe("quietSpans", () => {
  it("keeps only the part of the file the clip plays", () => {
    const clip = plain({ takes: [{ name: "take.wav", sourceId: SOURCE.id, offsetMs: 500 }] });
    const spans = quietSpans(clip, [
      { startMs: 0, endMs: 800 },
      { startMs: 2000, endMs: 2500 },
      { startMs: 4400, endMs: 9000 },
    ]);
    expect(spans).toEqual([
      { from: 0, to: 300 },
      { from: 1500, to: 2000 },
      { from: 3900, to: 4000 },
    ]);
  });

  it("follows the playrate", () => {
    const spans = quietSpans(plain({ playrate: 2 }), [{ startMs: 1000, endMs: 2000 }]);
    expect(spans).toEqual([{ from: 500, to: 1000 }]);
  });

  it("mirrors a reversed clip, which plays its file backwards", () => {
    const spans = quietSpans(plain({ reversed: true }), [{ startMs: 1000, endMs: 1500 }]);
    expect(spans).toEqual([{ from: 2500, to: 3000 }]);
  });

  it("merges overlapping regions", () => {
    const spans = quietSpans(plain(), [
      { startMs: 1200, endMs: 1800 },
      { startMs: 1000, endMs: 1500 },
    ]);
    expect(spans).toEqual([{ from: 1000, to: 1800 }]);
  });
});

describe("silencePieces", () => {
  it("cuts the clip into sound and quiet pieces", () => {
    expect(silencePieces(plain(), [{ from: 1000, to: 2000 }])).toEqual([
      { from: 0, to: 1000, quiet: false },
      { from: 1000, to: 2000, quiet: true },
      { from: 2000, to: 4000, quiet: false },
    ]);
  });

  it("gives a sliver of sound at an edge or between quiet parts to the quiet part", () => {
    expect(
      silencePieces(plain(), [
        { from: 4, to: 1000 },
        { from: 1005, to: 2000 },
        { from: 3985, to: 3998 },
      ]),
    ).toEqual([
      { from: 0, to: 2000, quiet: true },
      { from: 2000, to: 3985, quiet: false },
      { from: 3985, to: 4000, quiet: true },
    ]);
  });

  it("keeps a quiet part too short to be cut out", () => {
    expect(silencePieces(plain(), [{ from: 1000, to: 1005 }])).toEqual([
      { from: 0, to: 4000, quiet: false },
    ]);
  });
});

describe("removeSilence", () => {
  it("splits a clip at its quiet part, drops it and fades the new edges", () => {
    const result = removeSilence(song([plain()]), ["clip-a"], regions([1000, 2000]), ids);
    expect(result.removed).toBe(1);
    expect(result.clips).toBe(1);
    const [left, right] = clipsOf(result.audio);
    expect(clipsOf(result.audio)).toHaveLength(2);
    expect(left).toMatchObject({ startMs: 2000, lengthMs: 1000 });
    expect(left!.takes[0]!.offsetMs).toBe(0);
    expect(left!.fadeOut.ms).toBe(CUT_FADE_MS);
    expect(left!.fadeIn.ms).toBe(0);
    expect(right).toMatchObject({ startMs: 4000, lengthMs: 2000 });
    expect(right!.takes[0]!.offsetMs).toBe(2000);
    expect(right!.fadeIn.ms).toBe(CUT_FADE_MS);
    expect(right!.fadeOut.ms).toBe(0);
  });

  it("removes several quiet parts, keeping the clip's own outer fades", () => {
    const clip = plain({
      fadeIn: { ms: 50, shape: "linear" },
      fadeOut: { ms: 80, shape: "linear" },
    });
    const result = removeSilence(song([clip]), ["clip-a"], regions([500, 1000], [2000, 3000]), ids);
    expect(result.removed).toBe(2);
    const clips = clipsOf(result.audio);
    expect(clips.map((c) => [c.startMs, c.lengthMs])).toEqual([
      [2000, 500],
      [3000, 1000],
      [5000, 1000],
    ]);
    expect(clips[0]!.fadeIn.ms).toBe(50);
    expect(clips[1]!.fadeIn.ms).toBe(CUT_FADE_MS);
    expect(clips[1]!.fadeOut.ms).toBe(CUT_FADE_MS);
    expect(clips[2]!.fadeOut.ms).toBe(80);
  });

  it("keeps the right part of the file for a reversed clip", () => {
    // The file's first second is quiet: a reversed clip plays it last.
    const result = removeSilence(
      song([plain({ reversed: true })]),
      ["clip-a"],
      regions([0, 1000]),
      ids,
    );
    const [only] = clipsOf(result.audio);
    expect(clipsOf(result.audio)).toHaveLength(1);
    expect(only).toMatchObject({ startMs: 2000, lengthMs: 3000, reversed: true });
    expect(only!.takes[0]!.offsetMs).toBe(1000);
  });

  it("works on the timeline at the clip's playrate", () => {
    const result = removeSilence(
      song([plain({ playrate: 2 })]),
      ["clip-a"],
      regions([1000, 2000]),
      ids,
    );
    const clips = clipsOf(result.audio);
    expect(clips.map((c) => [c.startMs, c.lengthMs, c.takes[0]!.offsetMs])).toEqual([
      [2000, 1000, 0],
      [3000, 2000, 2000],
    ]);
  });

  it("removes a clip that is quiet throughout", () => {
    const result = removeSilence(song([plain()]), ["clip-a"], regions([0, 9000]), ids);
    expect(result.removed).toBe(1);
    expect(clipsOf(result.audio)).toEqual([]);
  });

  it("closes the gaps with ripple on", () => {
    const later = newClip(SOURCE.id, "take.wav", 7000, 1000, "clip-b");
    const result = removeSilence(
      song([plain(), later], "lane"),
      ["clip-a"],
      regions([1000, 2000]),
      ids,
    );
    expect(clipsOf(result.audio).map((c) => [c.id === "clip-b", c.startMs])).toEqual([
      [false, 2000],
      [false, 3000],
      [true, 6000],
    ]);
  });

  it("leaves stretched, locked and unmeasured clips as they are", () => {
    const stretched = plain({ id: "clip-s", stretch: [{ clipMs: 1000, sourceMs: 1500 }] });
    const locked = plain({ id: "clip-l", startMs: 7000, locked: true });
    const other = {
      ...newClip("o".repeat(64), "other.wav", 12_000, 2000, "clip-o"),
    } satisfies AudioClip;
    const audio = song([stretched, locked, other]);
    const result = removeSilence(audio, ["clip-s", "clip-l", "clip-o"], regions([0, 500]), ids);
    expect(result.audio).toBe(audio);
    expect(result.removed).toBe(0);
    expect(result.skipped).toEqual([
      { clipId: "clip-s", reason: "stretched" },
      { clipId: "clip-l", reason: "locked" },
      { clipId: "clip-o", reason: "unknown" },
    ]);
    expect(skippedMessage(result.skipped)).toBe(
      "Left as they are: 1 stretched clip (clear the stretch markers first), 1 locked clip (unlock first), 1 clip whose audio file is not loaded.",
    );
  });

  it("changes nothing when there is no silence", () => {
    const audio = song([plain()]);
    const result = removeSilence(audio, ["clip-a"], regions(), ids);
    expect(result.audio).toBe(audio);
    expect(silencePreview(result)).toBe("No quiet parts found with these settings.");
    expect(skippedMessage(result.skipped)).toBeNull();
  });
});

describe("silencePreview", () => {
  it("counts the pieces and the clips", () => {
    expect(silencePreview({ removed: 1, clips: 1 })).toBe(
      "1 quiet piece will be removed from 1 clip.",
    );
    expect(silencePreview({ removed: 5, clips: 2 })).toBe(
      "5 quiet pieces will be removed from 2 clips.",
    );
  });
});
