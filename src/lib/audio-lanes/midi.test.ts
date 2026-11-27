import { describe, expect, it } from "vitest";
import {
  addClip,
  addMidiTake,
  glueClips,
  setMidiTake,
  splitClip,
  trimClip,
} from "@/lib/audio-lanes/edits";
import {
  activeMidiTake,
  instrumentSources,
  isAudioClip,
  isMidiClip,
  isMidiLane,
  mergeTakes,
  midiEventCount,
  newPad,
  normalizeInstrument,
  normalizeNote,
  normalizePad,
  normalizeTake,
  sliceTake,
  transposeNotes,
} from "@/lib/audio-lanes/midi";
import {
  EMPTY_AUDIO,
  newClip,
  newLane,
  newMidiClip,
  newMidiLane,
  normalizeAudio,
  usedSources,
} from "@/lib/audio-lanes/model";
import type { AudioLanesSettings, MidiNote } from "@/lib/tauri";

const note = (id: string, startMs: number, lenMs = 100, pitch = 36): MidiNote => ({
  id,
  startMs,
  lenMs,
  pitch,
  vel: 100,
  chan: 9,
});

function song(): AudioLanesSettings {
  const lane = newMidiLane("Drums", { type: "drums" }, "m");
  const clip = newMidiClip(
    "Beat",
    1000,
    2000,
    { notes: [note("a", 0), note("b", 500), note("c", 1500)] },
    "clip",
  );
  return { ...EMPTY_AUDIO, lanes: [{ ...lane, clips: [clip] }] };
}

describe("MIDI lanes and clips", () => {
  it("creates MIDI lanes and clips that tell themselves apart from audio", () => {
    const audio = song();
    const lane = audio.lanes[0]!;
    const clip = lane.clips[0]!;
    expect(isMidiLane(lane)).toBe(true);
    expect(isMidiLane(newLane("A"))).toBe(false);
    expect(isMidiClip(clip)).toBe(true);
    expect(isAudioClip(newClip("s", "x", 0, 10))).toBe(true);
    expect(clip.takes).toEqual([{ name: "Beat", sourceId: "", offsetMs: 0 }]);
    expect(activeMidiTake(clip).notes).toHaveLength(3);
    expect(activeMidiTake(newClip("s", "x", 0, 10))).toEqual({ notes: [], cc: [] });
  });

  it("survives normalizing (no source needed) and drops clips of the wrong kind", () => {
    const audio = song();
    const wrong = {
      ...audio,
      lanes: [
        { ...audio.lanes[0]!, clips: [...audio.lanes[0]!.clips, newClip("missing", "x", 0, 10)] },
        { ...newLane("Audio", "a"), clips: [newMidiClip("x", 0, 10)] },
      ],
    };
    const normalized = normalizeAudio(wrong);
    expect(normalized.lanes[0]!.clips.map((c) => c.id)).toEqual(["clip"]);
    expect(normalized.lanes[0]!.kind).toBe("midi");
    expect(normalized.lanes[1]!.clips).toEqual([]);
    expect(normalized.lanes[1]!.kind).toBeUndefined();
  });

  it("keeps notes in range and in order, and caps a clip's events", () => {
    const take = normalizeTake(
      {
        notes: [
          { ...note("late", 900, 500), pitch: 200, vel: 0, chan: 20 },
          note("early", 10),
          note("outside", 5000),
        ],
        cc: [{ atMs: 3, kind: "bend", value: 99999, chan: 0 }],
      },
      1000,
    );
    expect(take.notes.map((n) => n.id)).toEqual(["early", "late"]);
    expect(take.notes[1]).toMatchObject({ pitch: 127, vel: 1, chan: 15, lenMs: 100 });
    expect(take.cc[0]!.value).toBe(8191);
    expect(normalizeNote({ ...note("x", 0), muted: false }, 100)).not.toHaveProperty("muted");
  });

  it("splits a MIDI clip so each side keeps its own notes", () => {
    const audio = splitClip(song(), "clip", 2000, ["l", "r"]);
    const [left, right] = audio.lanes[0]!.clips;
    expect(left).toMatchObject({ id: "l", startMs: 1000, lengthMs: 1000 });
    expect(right).toMatchObject({ id: "r", startMs: 2000, lengthMs: 1000 });
    expect(activeMidiTake(left!).notes.map((n) => [n.id, n.startMs])).toEqual([
      ["a", 0],
      ["b", 500],
    ]);
    expect(activeMidiTake(right!).notes.map((n) => [n.id, n.startMs])).toEqual([["c", 500]]);
    expect(left!.fadeOut.ms).toBe(0);
  });

  it("trims a MIDI clip at either edge, growing it past its old start", () => {
    const shorter = trimClip(song(), "clip", "end", 2200);
    expect(activeMidiTake(shorter.lanes[0]!.clips[0]!).notes.map((n) => n.id)).toEqual(["a", "b"]);
    const earlier = trimClip(song(), "clip", "start", 400);
    const clip = earlier.lanes[0]!.clips[0]!;
    expect(clip.startMs).toBe(400);
    expect(activeMidiTake(clip).notes[0]!.startMs).toBe(600);
    const clamped = trimClip(song(), "clip", "start", -500);
    expect(clamped.lanes[0]!.clips[0]!.startMs).toBe(0);
  });

  it("glues MIDI clips across a gap into one clip with both clips' notes", () => {
    const split = splitClip(song(), "clip", 2000, ["l", "r"]);
    const glued = glueClips(split, ["l", "r"]);
    const clips = glued.lanes[0]!.clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]!.lengthMs).toBe(2000);
    expect(activeMidiTake(clips[0]!).notes.map((n) => n.startMs)).toEqual([0, 500, 1500]);
  });

  it("only adds clips to lanes of their kind", () => {
    const audio = song();
    expect(addClip(audio, "m", newClip("s", "x", 0, 10))).toEqual(audio);
    const added = addClip(audio, "m", newMidiClip("x", 4000, 100, {}, "x"));
    expect(added.lanes[0]!.clips.map((c) => c.id)).toEqual(["clip", "x"]);
  });

  it("adds record passes as takes and replaces the heard take's notes", () => {
    const withTake = addMidiTake(song(), "clip", "Take 2", { notes: [note("z", 50)], cc: [] });
    const clip = withTake.lanes[0]!.clips[0]!;
    expect(clip.take).toBe(1);
    expect(clip.takes.map((t) => t.name)).toEqual(["Beat", "Take 2"]);
    expect(activeMidiTake(clip).notes.map((n) => n.id)).toEqual(["z"]);
    const edited = setMidiTake(withTake, "clip", { notes: [], cc: [] });
    expect(activeMidiTake(edited.lanes[0]!.clips[0]!).notes).toEqual([]);
    expect(edited.lanes[0]!.clips[0]!.midi!.takes[0]!.notes).toHaveLength(3);
  });

  it("slices, shifts and merges takes", () => {
    const take = { notes: [note("a", 100), note("b", 300, 500)], cc: [] };
    expect(sliceTake(take, 200, 400).notes).toEqual([{ ...note("b", 100, 100) }]);
    expect(mergeTakes(take, take, 50).notes.map((n) => n.startMs)).toEqual([100, 150, 300, 350]);
    expect(transposeNotes(take.notes, new Set(["a"]), 100).map((n) => n.id)).toEqual(["b"]);
  });

  it("counts pad samples as used sources and drops pads' unknown sources", () => {
    const source = { id: "s".repeat(64), name: "kick.wav", ext: "wav", embedded: true };
    const lane = newMidiLane("Pads", {
      type: "pads",
      pads: [newPad(36, "Kick", { sourceId: source.id })],
    });
    const audio = { ...EMPTY_AUDIO, lanes: [lane], sources: [source] };
    expect(usedSources(audio)).toEqual([source]);
    expect(instrumentSources(lane.instrument)).toEqual([source.id]);
    const normalized = normalizeInstrument(lane.instrument, new Set());
    expect(normalized).toEqual({ type: "pads", pads: [newPad(36, "Kick")] });
    expect(normalizePad({ ...newPad(36, "x"), choke: 99, voices: 0 })).toMatchObject({
      choke: 16,
      voices: 1,
    });
    expect(midiEventCount(song().lanes)).toBe(3);
  });
});
