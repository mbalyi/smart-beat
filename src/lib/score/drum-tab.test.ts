import { midi } from "@coderline/alphatab";

import {
  buildMirror,
  drumTabString,
  isMirrorStaff,
  mirrorBeatOf,
  mirrorNoteOf,
  mirrorOf,
  realBeatOf,
  realNoteOf,
  realStaves,
  removeMirrorNotes,
  setDrumTab,
  withoutDrumTabs,
} from "@/lib/score/drum-tab";
import { drumKey } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { generateMidi, noteOns } from "@/test/playback";
import { fixtureBytes } from "@/test/score";

function drums() {
  const { score } = parseScore(fixtureBytes("practice-song.gp"));
  const track = score.tracks.find((t) => t.staves[0]!.isPercussion)!;
  return { score, track };
}

const key = (e: midi.NoteOnEvent | midi.NoteOffEvent) =>
  `${e instanceof midi.NoteOnEvent ? "on" : "off"} ${e.tick} ${e.channel} ${e.noteKey} ${e instanceof midi.NoteOnEvent ? e.noteVelocity : ""}`;
const noteEvents = (file: midi.MidiFile) =>
  file.events.filter(
    (e): e is midi.NoteOnEvent | midi.NoteOffEvent =>
      e instanceof midi.NoteOnEvent || e instanceof midi.NoteOffEvent,
  );

describe("drumTabString", () => {
  it("puts cymbals on top, then toms, snare, low toms, kick and the rest", () => {
    expect([42, 49, 51].map(drumTabString)).toEqual([6, 6, 6]);
    expect(drumTabString(48)).toBe(5);
    expect(drumTabString(38)).toBe(4);
    expect(drumTabString(41)).toBe(3);
    expect([35, 36].map(drumTabString)).toEqual([2, 2]);
    expect([44, 56].map(drumTabString)).toEqual([1, 1]);
  });
});

describe("the mirror staff", () => {
  it("writes every hit as its drum number, ghost notes kept, one note per line", () => {
    const { track } = drums();
    const mirror = buildMirror(track.staves[0]!);
    expect(isMirrorStaff(mirror)).toBe(true);
    expect(mirror.stringTuning.tunings).toEqual([0, 0, 0, 0, 0, 0]);
    expect(mirror.bars).toHaveLength(track.staves[0]!.bars.length);
    const source = track.staves[0]!.bars.flatMap((b) => b.voices.flatMap((v) => v.beats));
    const copies = mirror.bars.flatMap((b) => b.voices.flatMap((v) => v.beats));
    expect(copies).toHaveLength(source.length);
    source.forEach((beat, i) => {
      const copy = copies[i]!;
      expect(copy.duration).toBe(beat.duration);
      expect(copy.notes.map((n) => n.fret).sort()).toEqual(beat.notes.map(drumKey).sort());
      expect(new Set(copy.notes.map((n) => n.string)).size).toBe(copy.notes.length);
    });
  });

  it("is added to the shown drum track only, and removed again", () => {
    const { score, track } = drums();
    setDrumTab(score, track, true);
    expect(track.staves).toHaveLength(2);
    expect(realStaves(track)).toHaveLength(1);
    expect(mirrorOf(track)!.index).toBe(1);
    setDrumTab(score, score.tracks[0]!, true); // a guitar: no mirror anywhere
    expect(score.tracks.every((t) => mirrorOf(t) === null)).toBe(true);
    setDrumTab(score, track, true);
    setDrumTab(score, track, false);
    expect(track.staves).toHaveLength(1);
  });

  it("maps beats and notes both ways", () => {
    const { score, track } = drums();
    setDrumTab(score, track, true);
    const beat = track.staves[0]!.bars[0]!.voices[0]!.beats.find((b) => b.notes.length > 0)!;
    const mirrored = mirrorBeatOf(beat)!;
    expect(isMirrorStaff(mirrored.voice.bar.staff)).toBe(true);
    expect(realBeatOf(mirrored)).toBe(beat);
    expect(realBeatOf(beat)).toBe(beat);
    const note = beat.notes[0]!;
    expect(realNoteOf(mirrorNoteOf(note)!)).toBe(note);
  });

  it("is left out of saves and snapshots, then put back", () => {
    const { score, track } = drums();
    setDrumTab(score, track, true);
    const inside = withoutDrumTabs(score, () => track.staves.length);
    expect(inside).toBe(1);
    expect(track.staves).toHaveLength(2);
    expect(() =>
      withoutDrumTabs(score, () => {
        throw new Error("save failed");
      }),
    ).toThrow("save failed");
    expect(track.staves).toHaveLength(2);
  });
});

describe("removeMirrorNotes", () => {
  it("makes the mirror silent: the MIDI is the same as without it", () => {
    const { score, track } = drums();
    const before = noteEvents(generateMidi(score).file).map(key).sort();
    setDrumTab(score, track, true);
    const { file } = generateMidi(score);
    const removed = removeMirrorNotes(file);
    expect(removed).toBeGreaterThan(0);
    expect(noteEvents(file).map(key).sort()).toEqual(before);
    expect(noteOns(file).length).toBe(before.filter((k) => k.startsWith("on")).length);
  });
});
