import { describe, expect, it } from "vitest";

import { findClip } from "@/lib/audio-lanes/edits";
import {
  EMPTY_AUDIO,
  MAX_CENTS,
  MAX_GAIN_DB,
  MAX_SEMITONES,
  MIN_GAIN_DB,
  MIN_PLAYRATE,
  newClip,
  newLane,
} from "@/lib/audio-lanes/model";
import {
  clampField,
  editClips,
  numberPatch,
  selectedClips,
  setFadeLength,
  setFadeShape,
  setFlag,
  setNumber,
  shared,
  summarizeClips,
} from "@/lib/audio-lanes/multi-edit";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

const SOURCE = { id: "s".repeat(64), name: "take.wav", ext: "wav", embedded: true };

function clip(id: string, patch: Partial<AudioClip> = {}): AudioClip {
  return { ...newClip(SOURCE.id, `${id}.wav`, 0, 4000, id), ...patch };
}

function song(...clips: AudioClip[]): AudioLanesSettings {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [
      { ...newLane("A", "lane-a"), clips: clips.slice(0, 2) },
      { ...newLane("B", "lane-b"), clips: clips.slice(2) },
    ],
  };
}

const get = (audio: AudioLanesSettings, id: string) => findClip(audio, id)!.clip;

describe("shared", () => {
  it("returns the value every item has", () => {
    expect(shared([2, 2, 2])).toEqual({ mixed: false, value: 2 });
    expect(shared(["linear", "linear"])).toEqual({ mixed: false, value: "linear" });
  });

  it("is mixed when the values differ or there are none", () => {
    expect(shared([1, 2])).toEqual({ mixed: true });
    expect(shared([true, false])).toEqual({ mixed: true });
    expect(shared([])).toEqual({ mixed: true });
  });

  it("treats numbers that differ by a rounding error as the same", () => {
    expect(shared([0.1 + 0.2, 0.3])).toEqual({ mixed: false, value: 0.1 + 0.2 });
  });
});

describe("selectedClips", () => {
  it("returns the selected clips in timeline lane order and skips unknown ids", () => {
    const audio = song(clip("a"), clip("b"), clip("c"));
    expect(selectedClips(audio, ["c", "gone", "a"]).map((c) => c.id)).toEqual(["a", "c"]);
  });
});

describe("summarizeClips", () => {
  it("marks each field that differs between the clips as mixed", () => {
    const summary = summarizeClips([
      clip("a", { gainDb: -3, mute: true, fadeIn: { ms: 50, shape: "sCurve" } }),
      clip("b", { gainDb: 2, mute: true, fadeIn: { ms: 50, shape: "linear" } }),
    ]);
    expect(summary.gainDb).toEqual({ mixed: true });
    expect(summary.mute).toEqual({ mixed: false, value: true });
    expect(summary.fadeInMs).toEqual({ mixed: false, value: 50 });
    expect(summary.fadeInShape).toEqual({ mixed: true });
    expect(summary.semitones).toEqual({ mixed: false, value: 0 });
    expect(summary.playrate).toEqual({ mixed: false, value: 1 });
    expect(summary.preservePitch).toEqual({ mixed: false, value: true });
  });
});

describe("clampField", () => {
  it("keeps each field inside the model limits and rounds pitch to whole steps", () => {
    expect(clampField("gainDb", 99)).toBe(MAX_GAIN_DB);
    expect(clampField("gainDb", -99)).toBe(MIN_GAIN_DB);
    expect(clampField("semitones", 30.4)).toBe(MAX_SEMITONES);
    expect(clampField("semitones", 2.6)).toBe(3);
    expect(clampField("cents", -250)).toBe(-MAX_CENTS);
    expect(clampField("playrate", 0)).toBe(MIN_PLAYRATE);
    expect(clampField("gainDb", Number.NaN)).toBe(0);
  });
});

describe("numberPatch", () => {
  it("sets the value in absolute mode", () => {
    expect(numberPatch(clip("a", { gainDb: -6 }), "gainDb", "absolute", 3)).toEqual({ gainDb: 3 });
  });

  it("adds the change to the clip's own value in relative mode, clamped", () => {
    expect(numberPatch(clip("a", { gainDb: -6 }), "gainDb", "relative", 3)).toEqual({
      gainDb: -3,
    });
    expect(numberPatch(clip("a", { gainDb: 20 }), "gainDb", "relative", 10)).toEqual({
      gainDb: MAX_GAIN_DB,
    });
    expect(numberPatch(clip("a", { semitones: -20 }), "semitones", "relative", -12)).toEqual({
      semitones: -MAX_SEMITONES,
    });
  });

  it("always sets the playrate (relative applies to gain and pitch only)", () => {
    expect(numberPatch(clip("a", { playrate: 2 }), "playrate", "relative", 0.5)).toEqual({
      playrate: 0.5,
    });
  });
});

describe("setNumber", () => {
  it("sets a value on every selected clip and leaves the others", () => {
    const audio = song(clip("a", { gainDb: -6 }), clip("b", { gainDb: 1 }), clip("c"));
    const next = setNumber(audio, ["a", "b"], "gainDb", "absolute", -2);
    expect(get(next, "a").gainDb).toBe(-2);
    expect(get(next, "b").gainDb).toBe(-2);
    expect(get(next, "c").gainDb).toBe(0);
  });

  it("offsets each clip by the change in relative mode, clamped per clip", () => {
    const audio = song(clip("a", { cents: 40 }), clip("b", { cents: 90 }), clip("c"));
    const next = setNumber(audio, ["a", "b", "c"], "cents", "relative", 20);
    expect(get(next, "a").cents).toBe(60);
    expect(get(next, "b").cents).toBe(MAX_CENTS);
    expect(get(next, "c").cents).toBe(20);
  });

  it("does not change the input settings", () => {
    const audio = song(clip("a"), clip("b"));
    const before = structuredClone(audio);
    setNumber(audio, ["a", "b"], "gainDb", "absolute", 6);
    expect(audio).toEqual(before);
  });
});

describe("editClips", () => {
  it("returns the same settings when no selected clip exists", () => {
    const audio = song(clip("a"));
    expect(editClips(audio, ["gone"], () => ({ mute: true }))).toBe(audio);
    expect(editClips(audio, [], () => ({ mute: true }))).toBe(audio);
  });

  it("returns the same settings when the edit changes nothing", () => {
    const audio = song(clip("a", { gainDb: 3 }), clip("b", { gainDb: 3 }));
    expect(setNumber(audio, ["a", "b"], "gainDb", "absolute", 3)).toBe(audio);
    expect(setNumber(audio, ["a", "b"], "gainDb", "relative", 0)).toBe(audio);
    expect(setFadeShape(audio, ["a", "b"], "fadeIn", "linear")).toBe(audio);
  });
});

describe("setFlag", () => {
  it("turns a switch on or off on every selected clip", () => {
    const audio = song(clip("a", { mute: true }), clip("b"));
    const next = setFlag(audio, ["a", "b"], "mute", false);
    expect(get(next, "a").mute).toBe(false);
    expect(get(next, "b").mute).toBe(false);
    const locked = setFlag(next, ["a", "b"], "locked", true);
    expect([get(locked, "a").locked, get(locked, "b").locked]).toEqual([true, true]);
  });
});

describe("fades", () => {
  it("sets the fade length on every clip, kept within each clip", () => {
    const audio = song(clip("a"), clip("b", { lengthMs: 100 }));
    const next = setFadeLength(audio, ["a", "b"], "fadeIn", 500);
    expect(get(next, "a").fadeIn.ms).toBe(500);
    expect(get(next, "b").fadeIn.ms).toBe(100);
  });

  it("sets the curve and keeps each clip's own length", () => {
    const audio = song(
      clip("a", { fadeOut: { ms: 30, shape: "linear" } }),
      clip("b", { fadeOut: { ms: 80, shape: "linear" } }),
    );
    const next = setFadeShape(audio, ["a", "b"], "fadeOut", "equalPower");
    expect(get(next, "a").fadeOut).toEqual({ ms: 30, shape: "equalPower" });
    expect(get(next, "b").fadeOut).toEqual({ ms: 80, shape: "equalPower" });
  });
});
