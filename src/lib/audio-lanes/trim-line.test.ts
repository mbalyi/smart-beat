import { describe, expect, it } from "vitest";

import { findClip, updateClip } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
import { clipsUnderLine, lineCrosses, trimToLine } from "@/lib/audio-lanes/trim-line";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

const src = { id: "s", name: "a.wav", ext: "wav", embedded: true };

/** Lane A holds `a` (1–5 s) and `b` (6–9 s); lane B holds `c` (2–8 s). */
function song(): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [src],
    lanes: [
      {
        ...newLane("A", "la"),
        clips: [newClip("s", "a", 1000, 4000, "a"), newClip("s", "b", 6000, 3000, "b")],
      },
      { ...newLane("B", "lb"), clips: [newClip("s", "c", 2000, 6000, "c")] },
    ],
  };
}
const clip = (audio: AudioLanesSettings, id: string): AudioClip => findClip(audio, id)!.clip;

describe("lineCrosses", () => {
  it("is true inside a clip and false on or past its edges", () => {
    const a = clip(song(), "a");
    expect(lineCrosses(a, 3000)).toBe(true);
    expect(lineCrosses(a, 1000)).toBe(false);
    expect(lineCrosses(a, 5000)).toBe(false);
    expect(lineCrosses(a, 7000)).toBe(false);
  });
});

describe("clipsUnderLine", () => {
  it("takes every clip under the line when no ids are given", () => {
    expect(clipsUnderLine(song(), [], 3000).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("keeps to the ids given and skips locked clips", () => {
    expect(clipsUnderLine(song(), ["c"], 3000).map((c) => c.id)).toEqual(["c"]);
    const locked = updateClip(song(), "a", { locked: true });
    expect(clipsUnderLine(locked, [], 3000).map((c) => c.id)).toEqual(["c"]);
  });
});

describe("trimToLine", () => {
  it("trims the start of every clip under the line to it", () => {
    const audio = trimToLine(song(), [], "start", 3000);
    expect(clip(audio, "a")).toMatchObject({ startMs: 3000, lengthMs: 2000 });
    expect(clip(audio, "a").takes[0]!.offsetMs).toBe(2000);
    expect(clip(audio, "c")).toMatchObject({ startMs: 3000, lengthMs: 5000 });
    expect(clip(audio, "c").takes[0]!.offsetMs).toBe(1000);
    // The line is not in `b`: it stays.
    expect(clip(audio, "b")).toEqual(clip(song(), "b"));
  });

  it("trims the end of every clip under the line to it, the start staying put", () => {
    const audio = trimToLine(song(), [], "end", 4000);
    expect(clip(audio, "a")).toMatchObject({ startMs: 1000, lengthMs: 3000 });
    expect(clipEndMs(clip(audio, "c"))).toBe(4000);
    expect(clip(audio, "c").takes[0]!.offsetMs).toBe(0);
  });

  it("trims only the ids given", () => {
    const audio = trimToLine(song(), ["a", "b"], "end", 4000);
    expect(clipEndMs(clip(audio, "a"))).toBe(4000);
    expect(clip(audio, "c")).toEqual(clip(song(), "c"));
  });

  it("leaves locked clips as they are", () => {
    const locked = updateClip(song(), "c", { locked: true });
    const audio = trimToLine(locked, [], "start", 3000);
    expect(clip(audio, "a").startMs).toBe(3000);
    expect(clip(audio, "c")).toEqual(clip(locked, "c"));
  });

  it("returns the same audio when the line crosses no clip (no undo step)", () => {
    const audio = song();
    expect(trimToLine(audio, [], "start", 9500)).toBe(audio);
    expect(trimToLine(audio, ["b"], "end", 3000)).toBe(audio);
  });

  it("does not change the audio it was given", () => {
    const audio = song();
    const before = structuredClone(audio);
    trimToLine(audio, [], "start", 3000);
    expect(audio).toEqual(before);
  });

  it("keeps the audio a reversed clip plays from the line on", () => {
    const reversed = updateClip(song(), "a", { reversed: true });
    // Playing file 4 s → 0 s backwards over 1–5 s: at 3 s it has played file 4 s → 2 s.
    const start = trimToLine(reversed, ["a"], "start", 3000);
    expect(clip(start, "a")).toMatchObject({ startMs: 3000, lengthMs: 2000 });
    expect(clip(start, "a").takes[0]!.offsetMs).toBe(0);
    const end = trimToLine(reversed, ["a"], "end", 3000);
    expect(clip(end, "a")).toMatchObject({ startMs: 1000, lengthMs: 2000 });
    expect(clip(end, "a").takes[0]!.offsetMs).toBe(2000);
  });

  it("maps the line into the file of a faster clip", () => {
    // Twice as fast: 4 s of file over 1–3 s.
    const fast = updateClip(song(), "a", { playrate: 2 });
    const audio = trimToLine(fast, ["a"], "start", 2000);
    expect(clip(audio, "a")).toMatchObject({ startMs: 2000, lengthMs: 2000, playrate: 2 });
    expect(clip(audio, "a").takes[0]!.offsetMs).toBe(2000);
  });
});
