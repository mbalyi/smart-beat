import { describe, expect, it } from "vitest";

import { findClip, sliceClip } from "@/lib/audio-lanes/edits";
import { EMPTY_AUDIO, activeTake, clipEndMs, newClip, newLane } from "@/lib/audio-lanes/model";
import { copyClipTo, slipClip, slippedClip } from "@/lib/audio-lanes/slip";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";

const src = { id: "s", name: "a.wav", ext: "wav", embedded: true };
/** The source is 20 s long. */
const durationOf = (id: string) => (id === "s" ? 20_000 : undefined);

/** Lane "a" holds clip "c" (4 s of the file from `offsetMs`, at 2 s) and lane "b" is empty. */
function song(patch: Partial<AudioClip> = {}, offsetMs = 5000): AudioLanesSettings {
  const base = newClip("s", "take", 2000, 4000, "c");
  const c: AudioClip = { ...base, takes: [{ ...base.takes[0]!, offsetMs }], ...patch };
  return {
    ...EMPTY_AUDIO,
    sources: [src],
    lanes: [
      { ...newLane("A", "a"), clips: [c] },
      newLane("B", "b"),
      { ...newLane("Folder", "f"), folder: true },
    ],
  };
}
const clip = (audio: AudioLanesSettings, id: string) => findClip(audio, id)!.clip;
const offset = (audio: AudioLanesSettings, id = "c") => activeTake(clip(audio, id)).offsetMs;

describe("copyClipTo", () => {
  it("leaves the original and puts a copy where it was dropped on the same lane", () => {
    const audio = copyClipTo(song(), "c", 8000, undefined, "copy");
    expect(audio.lanes[0]!.clips.map((c) => [c.id, c.startMs])).toEqual([
      ["c", 2000],
      ["copy", 8000],
    ]);
    expect(activeTake(clip(audio, "copy"))).toEqual(activeTake(clip(audio, "c")));
  });

  it("copies to another lane, and to the clip's own lane when the target is a folder", () => {
    const other = copyClipTo(song(), "c", 3000, "b", "copy");
    expect(findClip(other, "copy")!.lane.id).toBe("b");
    expect(findClip(other, "c")!.lane.id).toBe("a");
    const folder = copyClipTo(song(), "c", 3000, "f", "copy");
    expect(findClip(folder, "copy")!.lane.id).toBe("a");
  });

  it("crossfades a copy that overlaps the original", () => {
    // The original plays 2–6 s; a copy at 5 s overlaps it by 1 s.
    const audio = copyClipTo(song(), "c", 5000, undefined, "copy");
    expect(clip(audio, "c").fadeOut).toEqual({ ms: 1000, shape: "equalPower", auto: true });
    expect(clip(audio, "copy").fadeIn).toEqual({ ms: 1000, shape: "equalPower", auto: true });
  });

  it("does not copy a locked clip, nor before the start of the song", () => {
    const locked = song({ locked: true });
    expect(copyClipTo(locked, "c", 8000)).toBe(locked);
    expect(clip(copyClipTo(song(), "c", -500, undefined, "copy"), "copy").startMs).toBe(0);
  });
});

describe("slipClip", () => {
  it("slides the audio inside the clip and keeps the clip in place", () => {
    // Dragging right by 1 s plays the audio 1 s later: the clip starts 1 s earlier in the file.
    const audio = slipClip(song(), "c", 1000, durationOf);
    expect(offset(audio)).toBe(4000);
    expect(clip(audio, "c").startMs).toBe(2000);
    expect(clipEndMs(clip(audio, "c"))).toBe(6000);
    expect(offset(slipClip(song(), "c", -1000, durationOf))).toBe(6000);
  });

  it("moves a reversed clip's offset the other way", () => {
    const audio = slipClip(song({ reversed: true }), "c", 1000, durationOf);
    expect(offset(audio)).toBe(6000);
    // What was heard at 1 s into the clip is now heard at 2 s into it.
    const before = clip(song({ reversed: true }), "c");
    const after = clip(audio, "c");
    const heard = (c: AudioClip, t: number) => {
      const slice = sliceClip(c, t, t + 1);
      return activeTake(slice).offsetMs;
    };
    expect(heard(after, 2000)).toBeCloseTo(heard(before, 1000));
  });

  it("clamps at the start and the end of the file", () => {
    // 5 s into the file: sliding 9 s later would read before its start.
    expect(offset(slipClip(song(), "c", 9000, durationOf))).toBe(0);
    // A 4 s clip in a 20 s file starts at most 16 s in.
    expect(offset(slipClip(song(), "c", -30_000, durationOf))).toBe(16_000);
    expect(offset(slipClip(song({ reversed: true }), "c", 30_000, durationOf))).toBe(16_000);
    expect(offset(slipClip(song({ reversed: true }), "c", -30_000, durationOf))).toBe(0);
    // With the file's length unknown only its start limits the slip.
    expect(offset(slipClip(song(), "c", -30_000))).toBe(35_000);
  });

  it("returns the same lanes when nothing changes or the clip is locked", () => {
    const atStart = song({}, 0);
    expect(slipClip(atStart, "c", 1000, durationOf)).toBe(atStart);
    const locked = song({ locked: true });
    expect(slipClip(locked, "c", 1000, durationOf)).toBe(locked);
    const audio = song();
    expect(slipClip(audio, "missing", 1000, durationOf)).toBe(audio);
  });

  it("scales the slide by the playrate and keeps the stretch markers", () => {
    const stretch = [{ clipMs: 1000, sourceMs: 3000 }];
    // 4 s of source at playrate 2 lasts 2 s; a 500 ms slide is 1 s of the file.
    const audio = slipClip(song({ playrate: 2, stretch }), "c", 500, durationOf);
    expect(offset(audio)).toBe(4000);
    expect(clip(audio, "c").stretch).toEqual(stretch);
    expect(clip(audio, "c").lengthMs).toBe(4000);
  });

  it("slips only the take the clip plays", () => {
    const base = clip(song(), "c");
    const takes = [base.takes[0]!, { ...base.takes[0]!, name: "two", offsetMs: 8000 }];
    const audio = slipClip(song({ takes, take: 1 }), "c", 1000, durationOf);
    expect(clip(audio, "c").takes.map((t) => t.offsetMs)).toEqual([5000, 7000]);
  });
});

describe("slippedClip", () => {
  it("is the same clip for a slide of nothing or one that is not a number", () => {
    const c = clip(song(), "c");
    expect(slippedClip(c, 0, 20_000)).toBe(c);
    expect(slippedClip(c, Number.NaN, 20_000)).toBe(c);
  });

  it("starts at the file's start when the clip is longer than its file", () => {
    const c = clip(song(), "c");
    expect(activeTake(slippedClip(c, -1000, 3000)).offsetMs).toBe(0);
  });
});
