import { drumLine } from "@/lib/score/drum-lines";
import {
  DRUM_LANES,
  laneOf,
  normalizeDrumNotation,
  canNormalizeDrums,
} from "@/lib/score/drum-normalize";
import { drumKey, drumNumber, trackContent, type Note } from "@/lib/score/model";
import { ScoreEditor } from "@/lib/score/editor";
import { parseScore } from "@/lib/score/score";
import { placeDrums } from "@/lib/score/drum-tab";
import { generateMidi, noteOns } from "@/test/playback";
import { fixtureBytes } from "@/test/score";

function drums() {
  const { score } = parseScore(fixtureBytes("practice-song.gp"));
  const track = score.tracks.find((t) => t.staves[0]!.isPercussion)!;
  return { score, track };
}

const notesOf = (track: ReturnType<typeof drums>["track"]): Note[] =>
  track.staves[0]!.bars.flatMap((bar) =>
    bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes)),
  );

describe("the lane table", () => {
  it.each([
    [49, 1],
    [57, 1],
    [55, 1],
    [52, 1],
    [42, 2],
    [44, 2],
    [46, 2],
    [51, 2],
    [50, 3],
    [48, 3],
    [38, 4],
    [40, 4],
    [47, 4],
    [45, 4],
    [43, 5],
    [41, 5],
    [36, 6],
    [35, 6],
  ])("writes drum %i on lane %i from the top", (drum, lane) => {
    expect(laneOf(drum)).toBe(lane);
  });

  it("lists each drum once", () => {
    const all = DRUM_LANES.flatMap((row) => row.drums);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("normalizeDrumNotation", () => {
  it("puts every drum note on its lane (lane 1 is the top, tab line 6)", () => {
    const { track } = drums();
    const count = normalizeDrumNotation(track);
    const notes = notesOf(track);
    expect(count).toBe(notes.length);
    expect(count).toBeGreaterThan(0);
    for (const note of notes) expect(drumLine(note)).toBe(7 - laneOf(drumNumber(note)));
  });

  it("changes only where notes are written, not what plays", () => {
    const { score, track } = drums();
    const before = noteOns(generateMidi(score).file);
    const keys = notesOf(track).map(drumKey);
    normalizeDrumNotation(track);
    expect(notesOf(track).map(drumKey)).toEqual(keys);
    expect(noteOns(generateMidi(score).file)).toEqual(before);
  });

  it("keeps a snare and a mid tom at the same moment as two notes", () => {
    const { track } = drums();
    const beat = track.staves[0]!.bars.flatMap((b) => b.voices.flatMap((v) => v.beats)).find(
      (b) => b.notes.length > 0,
    )!;
    const before = beat.notes.length;
    normalizeDrumNotation(track);
    expect(beat.notes).toHaveLength(before);
    expect(placeDrums(beat.notes).size).toBe(before);
  });

  it("leaves other tracks alone", () => {
    const { score } = drums();
    const guitar = score.tracks.find((t) => !t.staves[0]!.isPercussion)!;
    expect(canNormalizeDrums(guitar)).toBe(false);
    expect(normalizeDrumNotation(guitar)).toBe(0);
  });

  it("is one undo step", () => {
    const { score, track } = drums();
    const editor = new ScoreEditor(score);
    const before = notesOf(track).map(drumLine);
    editor.run(
      "Normalize drum notation",
      () => [...trackContent(track)],
      () => normalizeDrumNotation(track),
    );
    expect(notesOf(track).map(drumLine)).not.toEqual(before);
    editor.undo();
    expect(notesOf(track).map(drumLine)).toEqual(before);
  });
});
