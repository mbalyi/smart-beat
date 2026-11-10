import { describe, expect, it } from "vitest";

import {
  articulationForDrum,
  defaultDrumKit,
  drumValueFor,
  kitIndexOf,
  withWritableDrumKits,
} from "@/lib/score/drum-kit";
import { ScoreEditor } from "@/lib/score/editor";
import { drumKey, drumNumber, type Score } from "@/lib/score/model";
import { createSong, createTrack, insertTrack } from "@/lib/score/tracks";

/** A new song whose drum track is the second one; `kit`: give it the whole default kit. */
function drumSong(kit = false): Score {
  const score = createSong();
  insertTrack(score, createTrack(score, { kind: "drums", name: "Drums", program: 0 }));
  if (kit)
    score.tracks[1]!.percussionArticulations = defaultDrumKit()
      .map((a) => a.id)
      .map(articulationForDrum);
  return score;
}

const firstBeat = (score: Score) => score.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;

describe("drum kits (#229)", () => {
  it("finds the articulation that is a drum, else one that plays it", () => {
    const kit = defaultDrumKit();
    expect(kit[kitIndexOf(kit, 46)]!.id).toBe(46); // not 92, which also plays 46
    expect(kit[kitIndexOf(kit, 92)]!.id).toBe(92);
    expect(kitIndexOf(kit, 27)).toBe(-1);
  });

  it("stores drum numbers on tracks without a kit and indexes on tracks with one", () => {
    const score = drumSong();
    expect(drumValueFor(score.tracks[1]!, 57)).toBe(57);

    const own = drumSong(true).tracks[1]!;
    expect(drumValueFor(own, 57)).toBe(kitIndexOf(own.percussionArticulations, 57));
    own.percussionArticulations = own.percussionArticulations.slice(0, 3); // snares only
    expect(drumValueFor(own, 57)).toBe(3);
    expect(own.percussionArticulations[3]!.outputMidiNumber).toBe(57);
  });

  it("enters the drum that was typed on a track with its own kit", () => {
    const score = drumSong(true);
    const editor = new ScoreEditor(score, 1);
    editor.enterDrum(92); // hi-hat half: a number inside the kit's range, but not an index
    editor.enterDrum(92); // already there
    const notes = firstBeat(score).notes;
    expect(notes).toHaveLength(1);
    expect(drumKey(notes[0]!)).toBe(46);
    expect(score.tracks[1]!.percussionArticulations[notes[0]!.percussionArticulation]!.id).toBe(92);
  });

  it("pastes drums between tracks with different kits", () => {
    const score = drumSong(true);
    insertTrack(score, createTrack(score, { kind: "drums", name: "Drums 2", program: 0 }));
    const editor = new ScoreEditor(score, 1);
    editor.enterDrum(92);
    editor.enterDrum(36);
    editor.copy();
    editor.setTrack(2);
    editor.setCursorTo({ bar: 0, beat: 0 });
    editor.paste();
    const pasted = score.tracks[2]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes;
    expect(pasted.map((n) => n.percussionArticulation).sort()).toEqual([36, 92]);

    editor.copy();
    editor.setTrack(1);
    editor.setCursorTo({ bar: 1, beat: 0 });
    editor.paste();
    const back = score.tracks[1]!.staves[0]!.bars[1]!.voices[0]!.beats[0]!.notes;
    const kit = score.tracks[1]!.percussionArticulations;
    expect(back.map((n) => kit[n.percussionArticulation]!.id).sort()).toEqual([36, 92]);
  });

  it("writes drum notes against a kit and puts the song back afterwards", () => {
    const score = drumSong();
    const editor = new ScoreEditor(score, 1);
    editor.enterDrum(36);
    editor.enterDrum(57);
    const track = score.tracks[1]!;
    const seen = withWritableDrumKits(score, () => ({
      kit: track.percussionArticulations.map((a) => a.id),
      values: firstBeat(score).notes.map((n) => n.percussionArticulation),
      drums: firstBeat(score).notes.map(drumNumber),
    }));
    expect(seen.kit).toEqual([36, 57]);
    expect(seen.values).toEqual([0, 1]);
    expect(seen.drums).toEqual([36, 57]);
    expect(track.percussionArticulations).toEqual([]);
    expect(firstBeat(score).notes.map((n) => n.percussionArticulation)).toEqual([36, 57]);
  });

  it("puts the song back when writing fails", () => {
    const score = drumSong();
    new ScoreEditor(score, 1).enterDrum(38);
    expect(() =>
      withWritableDrumKits(score, () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(score.tracks[1]!.percussionArticulations).toEqual([]);
    expect(firstBeat(score).notes[0]!.percussionArticulation).toBe(38);
  });
});
