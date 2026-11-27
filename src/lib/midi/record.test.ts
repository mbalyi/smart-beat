import { describe, expect, it } from "vitest";

import { activeMidiTake } from "@/lib/audio-lanes/midi";
import { EMPTY_AUDIO, newMidiClip, newMidiLane } from "@/lib/audio-lanes/model";
import { applyRecording, eventsToPasses, punch, type RecordedEvent } from "@/lib/midi/record";
import type { AudioLanesSettings, MidiNote } from "@/lib/tauri";

const on = (ms: number, key: number, vel = 100, chan = 9): RecordedEvent => ({
  ms,
  status: 0x90 | chan,
  d1: key,
  d2: vel,
});
const off = (ms: number, key: number, chan = 9): RecordedEvent => ({
  ms,
  status: 0x80 | chan,
  d1: key,
  d2: 0,
});
const note = (id: string, startMs: number, pitch: number, lenMs = 100): MidiNote => ({
  id,
  startMs,
  lenMs,
  pitch,
  vel: 80,
  chan: 9,
});

function lane(notes: MidiNote[] = []): AudioLanesSettings {
  const l = newMidiLane("Drums", { type: "drums" }, "lane");
  return {
    ...EMPTY_AUDIO,
    lanes: [
      { ...l, clips: notes.length ? [newMidiClip("Beat", 1000, 2000, { notes }, "clip")] : [] },
    ],
  };
}

const shape = (notes: readonly MidiNote[]) => notes.map((n) => [n.startMs, n.pitch, n.lenMs]);

describe("eventsToPasses", () => {
  it("pairs note on and off, keeps velocity, and reads controllers", () => {
    const [pass] = eventsToPasses([
      on(1000, 36, 90),
      { ms: 1010, status: 0xb9, d1: 4, d2: 127 },
      off(1100, 36),
      on(1200, 38),
      { ms: 1250, status: 0x99, d1: 38, d2: 0 },
    ]);
    expect(pass!.notes.map((n) => [n.startMs, n.lenMs, n.pitch, n.vel, n.chan])).toEqual([
      [1000, 100, 36, 90, 9],
      [1200, 50, 38, 100, 9],
    ]);
    expect(pass!.cc).toEqual([{ atMs: 1010, kind: "cc", cc: 4, value: 127, chan: 9 }]);
  });

  it("closes notes still held at Stop and splits loop passes where the timeline wraps", () => {
    const passes = eventsToPasses(
      [on(1000, 36), on(1500, 42), off(1600, 42), on(1050, 38), off(1100, 38)],
      2000,
    );
    expect(passes).toHaveLength(2);
    expect(shape(passes[0]!.notes)).toEqual([
      [1000, 36, 600],
      [1500, 42, 100],
    ]);
    expect(shape(passes[1]!.notes)).toEqual([[1050, 38, 50]]);
    expect(passes[1]!.endMs).toBe(2000);
  });

  it("keeps only what starts inside a punch", () => {
    const [pass] = eventsToPasses([on(900, 36), off(950, 36), on(1000, 38), off(1500, 38)]);
    expect(shape(punch(pass!, { startMs: 1000, endMs: 1200 }).notes)).toEqual([[1000, 38, 200]]);
  });
});

describe("applyRecording", () => {
  const played = eventsToPasses([on(1500, 42), off(1600, 42)], 1700);

  it("puts a new take on a new clip when the lane is empty", () => {
    const { audio, clipId } = applyRecording(lane(), "lane", played, "take");
    const clip = audio.lanes[0]!.clips[0]!;
    expect(clip.id).toBe(clipId);
    expect(clip.startMs).toBe(1500);
    expect(shape(activeMidiTake(clip).notes)).toEqual([[0, 42, 100]]);
  });

  it("adds a take to the clip under the recording, and one take per loop pass", () => {
    const { audio } = applyRecording(lane([note("k", 0, 36)]), "lane", played, "take");
    const clip = audio.lanes[0]!.clips[0]!;
    expect(clip.takes).toHaveLength(2);
    expect(shape(activeMidiTake(clip).notes)).toEqual([[500, 42, 100]]);
    const loops = eventsToPasses([on(1000, 36), off(1100, 36), on(1000, 38), off(1100, 38)]);
    expect(loops).toHaveLength(1); // no wrap: the same time twice
    const wrapped = eventsToPasses([on(1000, 36), off(1900, 36), on(1000, 38), off(1100, 38)]);
    const { audio: looped } = applyRecording(lane(), "lane", wrapped, "take");
    expect(looped.lanes[0]!.clips[0]!.takes.map((t) => t.name)).toEqual([
      "Recording 1",
      "Recording 2",
    ]);
  });

  it("overdubs onto the clip under the recording", () => {
    const { audio } = applyRecording(lane([note("k", 0, 36)]), "lane", played, "overdub");
    expect(shape(activeMidiTake(audio.lanes[0]!.clips[0]!).notes)).toEqual([
      [0, 36, 100],
      [500, 42, 100],
    ]);
  });

  it("replaces the recorded span, only the touched notes, or from the first note", () => {
    const start = lane([note("a", 400, 36), note("b", 520, 38), note("c", 1500, 36)]);
    // The span is 1500 to 1700 on the timeline: 500 to 700 in the clip, so "b" goes, "a" stays.
    const replaced = applyRecording(start, "lane", played, "replace").audio;
    expect(shape(activeMidiTake(replaced.lanes[0]!.clips[0]!).notes)).toEqual([
      [400, 36, 100],
      [500, 42, 100],
      [1500, 36, 100],
    ]);
    const touched = applyRecording(start, "lane", played, "touch").audio;
    expect(shape(activeMidiTake(touched.lanes[0]!.clips[0]!).notes)).toEqual([
      [400, 36, 100],
      [500, 42, 100],
      [1500, 36, 100],
    ]);
    const late = eventsToPasses([on(1600, 42), off(1700, 42)], 3000);
    const latched = applyRecording(start, "lane", late, "latch").audio;
    expect(shape(activeMidiTake(latched.lanes[0]!.clips[0]!).notes)).toEqual([
      [400, 36, 100],
      [520, 38, 100],
      [600, 42, 100],
    ]);
  });

  it("grows the clip to hold a recording past its end", () => {
    const later = eventsToPasses([on(3500, 36), off(3600, 36)], 3700);
    const { audio } = applyRecording(lane([note("k", 0, 36)]), "lane", later, "overdub");
    const clips = audio.lanes[0]!.clips;
    expect(clips).toHaveLength(2);
    expect(applyRecording(lane(), "lane", [], "overdub").clipId).toBeNull();
  });
});
