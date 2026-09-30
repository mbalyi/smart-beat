import { model } from "@coderline/alphatab";

import { ScoreEditor } from "@/lib/score/editor";
import { BEND_PRESETS, WHAMMY_PRESETS } from "@/lib/score/effects";
import { refinish } from "@/lib/score/model";
import { applyBarSettings, barSettingsOf, barSettingsRange } from "@/lib/score/structure";
import { createSong } from "@/lib/score/tracks";
import { texScore } from "@/test/playback";

const { GraceType, HarmonicType, KeySignatureType, SlideOutType, VibratoType } = model;

/** A guitar with four quarter notes on the G string (frets 5 7 5 7), then a rest bar. */
function tabSong() {
  const score = texScore(String.raw`
\track "Guitar" \staff {tabs}
:4 5.3 7.3 5.3 7.3 | r.1
\track "Piano" \staff {score}
:4 C4 E4 G4 C5 | r.1
\track "Drums" \instrument percussion \articulation defaults
:4 "Kick (hit)" "Snare (hit)" "Kick (hit)" "Snare (hit)" | r.1
`);
  const editor = new ScoreEditor(score);
  editor.setString(4); // the G string
  return editor;
}

const json = (editor: ScoreEditor) => model.JsonConverter.scoreToJson(editor.score);
const beat = (editor: ScoreEditor, index: number, bar = 0) =>
  editor.score.tracks[editor.cursor.track]!.staves[0]!.bars[bar]!.voices[0]!.beats[index]!;

describe("ScoreEditor: note effects", () => {
  it("toggles an effect on the note under the cursor, with one undo step", () => {
    const editor = tabSong();
    const before = json(editor);
    editor.toggleNoteEffect("palmMute");
    expect(beat(editor, 0).notes[0]!.isPalmMute).toBe(true);
    expect(editor.undoLabel).toBe("Add palm mute");
    expect(editor.message).toBe("Palm mute on");
    expect(editor.effects.note!.palmMute).toBe(1);
    expect(editor.describeCursor()).toContain("fret 5, palm mute");

    editor.toggleNoteEffect("palmMute");
    expect(beat(editor, 0).notes[0]!.isPalmMute).toBe(false);
    expect(editor.undoLabel).toBe("Remove palm mute");
    expect(editor.message).toBe("Palm mute off");

    editor.undo();
    editor.undo();
    expect(json(editor)).toBe(before);
    editor.redo();
    expect(beat(editor, 0).notes[0]!.isPalmMute).toBe(true);
  });

  it("changes an effect's kind, and names the note's effects in the status", () => {
    const editor = tabSong();
    editor.setNoteEffect("vibrato", VibratoType.Slight);
    editor.setNoteEffect("vibrato", VibratoType.Wide);
    expect(editor.undoLabel).toBe("Change vibrato");
    expect(editor.message).toBe("Wide vibrato");
    editor.setNoteEffect("harmonic", HarmonicType.Natural);
    expect(editor.describeCursor()).toContain("wide vibrato, natural harmonic");
  });

  it("applies effects to every note of the selection", () => {
    const editor = tabSong();
    editor.moveBeat(1, true);
    editor.moveBeat(1, true);
    editor.toggleNoteEffect("letRing");
    expect([0, 1, 2, 3].map((i) => beat(editor, i).notes[0]!.isLetRing)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // All selected notes have it: toggling again removes it from all.
    editor.toggleNoteEffect("letRing");
    expect([0, 1, 2].map((i) => beat(editor, i).notes[0]!.isLetRing)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("refuses without a note, or on tracks the effect doesn't suit", () => {
    const editor = tabSong();
    editor.setString(1);
    editor.toggleNoteEffect("palmMute");
    expect(editor.message).toBe("No note at the cursor");
    expect(editor.canUndo).toBe(false);

    editor.setTrack(1); // piano
    editor.toggleNoteEffect("palmMute");
    expect(editor.message).toBe("Palm mute is only available on tab tracks");
    editor.setTrack(2); // drums
    editor.toggleNoteEffect("staccato");
    expect(editor.message).toBe("Staccato isn't available on drum tracks");
    expect(editor.canUndo).toBe(false);
  });

  it("needs a next note on the string for hammer-ons and slides to it", () => {
    const editor = tabSong();
    editor.toggleNoteEffect("hammerPull");
    expect(beat(editor, 0).notes[0]!.isHammerPullOrigin).toBe(true);
    editor.setNoteEffect("slideOut", SlideOutType.Legato);
    expect(beat(editor, 0).notes[0]!.slideOutType).toBe(SlideOutType.Legato);

    editor.moveBar(1); // the rest bar: nothing follows
    editor.moveBar(-1);
    editor.moveBeat(1);
    editor.moveBeat(1);
    editor.moveBeat(1); // last note of bar 1, followed by a rest bar
    editor.toggleNoteEffect("hammerPull");
    expect(editor.message).toBe("A hammer-on or pull-off needs a next note on the same string");
    editor.setNoteEffect("slideOut", SlideOutType.Shift);
    expect(editor.message).toBe("A slide to the next note needs a next note on the same string");
    // Sliding out of the note needs nothing after it.
    editor.setNoteEffect("slideOut", SlideOutType.OutDown);
    expect(beat(editor, 3).notes[0]!.slideOutType).toBe(SlideOutType.OutDown);
  });

  it("uses staff effects on piano and drum tracks", () => {
    const editor = tabSong();
    editor.setTrack(1);
    editor.moveString(1); // select the chord's lowest note
    editor.toggleNoteEffect("staccato");
    expect(beat(editor, 0).notes[0]!.isStaccato).toBe(true);
    editor.setTrack(2);
    editor.moveString(1);
    editor.toggleNoteEffect("accent");
    expect(beat(editor, 0).notes[0]!.accentuated).toBe(model.AccentuationType.Normal);
    editor.toggleNoteEffect("ghost");
    expect(beat(editor, 0).notes[0]!.isGhost).toBe(true);
  });
});

describe("ScoreEditor: beat effects, bends and grace notes", () => {
  it("sets beat effects on the cursor's beat", () => {
    const editor = tabSong();
    editor.toggleBeatEffect("slap");
    expect(beat(editor, 0).slap).toBe(true);
    expect(editor.undoLabel).toBe("Add slap");
    editor.setBeatEffect("tremolo", 3);
    expect(beat(editor, 0).tremoloPicking?.marks).toBe(3);
    expect(editor.effects.beat!.tremolo).toBe(3);
    editor.toggleBeatEffect("slap");
    expect(beat(editor, 0).slap).toBe(false);
    editor.moveBar(1); // a rest
    editor.toggleBeatEffect("pop");
    expect(editor.message).toBe("No notes on this beat");
  });

  it("bends notes and puts the whammy bar on beats", () => {
    const editor = tabSong();
    const before = json(editor);
    editor.setBend(BEND_PRESETS[0]!.points(4));
    expect(beat(editor, 0).notes[0]!.hasBend).toBe(true);
    expect(editor.effects.bend).not.toBeNull();
    expect(editor.undoLabel).toBe("Add bend");
    editor.setBend(BEND_PRESETS[1]!.points(2));
    expect(editor.undoLabel).toBe("Change bend");
    editor.setWhammy(WHAMMY_PRESETS[0]!.points(8));
    expect(beat(editor, 0).hasWhammyBar).toBe(true);
    expect(editor.describeCursor()).toContain("bend, whammy bar");
    editor.setWhammy(null);
    editor.setBend(null);
    expect(editor.undoLabel).toBe("Remove bend");
    while (editor.canUndo) editor.undo();
    expect(json(editor)).toBe(before);

    editor.setTrack(1);
    editor.setBend(BEND_PRESETS[0]!.points(4));
    expect(editor.message).toBe("Bends are only available on tab tracks");
    editor.setWhammy(WHAMMY_PRESETS[0]!.points(4));
    expect(editor.message).toBe("The whammy bar is only available on tab tracks");
  });

  it("adds a grace note before the cursor's note without taking time from the bar", () => {
    const editor = tabSong();
    const duration = editor.score.masterBars[0]!.calculateDuration();
    editor.setGrace(GraceType.BeforeBeat);
    const grace = beat(editor, 0);
    expect(grace.graceType).toBe(GraceType.BeforeBeat);
    expect(grace.notes.map((n) => [n.string, n.fret])).toEqual([[4, 5]]);
    expect(beat(editor, 1).graceType).toBe(GraceType.None);
    expect(editor.cursor.beat).toBe(0);
    expect(editor.effects.grace).toBe(GraceType.BeforeBeat);
    expect(editor.message).toBe("Grace note before the beat: type its fret or pitch");

    // Typing a fret changes the grace note; the bar still plays for as long.
    editor.typeDigit(3);
    expect(grace.notes[0]!.fret).toBe(3);
    const voice = editor.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!;
    expect(voice.beats.at(-1)!.playbackStart + voice.beats.at(-1)!.playbackDuration).toBe(duration);

    editor.setGrace(GraceType.OnBeat);
    expect(grace.graceType).toBe(GraceType.OnBeat);
    editor.setGrace(GraceType.None);
    expect(grace.graceType).toBe(GraceType.None);
    expect(editor.undoLabel).toBe("Remove grace note");
  });

  it("adds grace notes on drum and piano tracks too", () => {
    const editor = tabSong();
    editor.setTrack(2);
    editor.moveString(1);
    editor.setGrace(GraceType.BeforeBeat);
    expect(beat(editor, 0).notes[0]!.percussionArticulation).toBe(
      beat(editor, 1).notes[0]!.percussionArticulation,
    );
    editor.setTrack(1);
    editor.setGrace(GraceType.BeforeBeat);
    expect(beat(editor, 0).notes[0]!.realValue).toBe(60);
    editor.moveBar(1);
    editor.setGrace(GraceType.BeforeBeat);
    expect(editor.message).toBe("No note at the cursor");
  });
});

describe("ScoreEditor: text, chords and bars", () => {
  it("writes and removes free text", () => {
    const editor = tabSong();
    editor.setText("  let it ring ");
    expect(beat(editor, 0).text).toBe("let it ring");
    expect(editor.effects.text).toBe("let it ring");
    expect(editor.undoLabel).toBe("Add text");
    editor.setText("louder");
    expect(editor.undoLabel).toBe("Change text");
    editor.setText("louder"); // no change, no undo step
    expect(editor.undoLabel).toBe("Change text");
    editor.setText("");
    expect(beat(editor, 0).text).toBeNull();
    expect(editor.message).toBe("Text removed");
  });

  it("writes chords and undoes them with the staff's chord list", () => {
    const editor = tabSong();
    const staff = editor.score.tracks[0]!.staves[0]!;
    editor.setChord({
      name: "C",
      diagram: { strings: [0, 1, 0, 2, 3, -1], firstFret: 1 },
      showDiagram: true,
    });
    expect(editor.effects.chord!.name).toBe("C");
    expect(staff.chords!.size).toBe(1);
    expect(editor.message).toBe("Chord C");
    editor.setChord(null);
    expect(staff.chords!.size).toBe(0);
    editor.undo();
    expect(staff.chords!.size).toBe(1);
    expect(beat(editor, 0).chord!.name).toBe("C");
    editor.undo();
    expect(staff.chords?.size ?? 0).toBe(0);
    expect(beat(editor, 0).chordId).toBeNull();
  });

  it("gives the pitches of the selection, for naming a chord", () => {
    const editor = tabSong();
    editor.setTrack(1);
    expect(editor.selectedPitches()).toEqual([60]);
    editor.moveBeat(1, true);
    expect(editor.selectedPitches()).toEqual([60, 64]);
  });

  it("edits bars as one undo step", () => {
    const editor = new ScoreEditor(createSong());
    const before = json(editor);
    const next = {
      ...barSettingsOf(editor.score, 1),
      timeSignature: { numerator: 3, denominator: 4 },
    };
    editor.editBars("Change time signature", barSettingsRange(editor.score, 1, next), () =>
      applyBarSettings(editor.score, 1, next),
    );
    expect(editor.score.masterBars.map((b) => b.timeSignatureNumerator)).toEqual([4, 3, 3, 3]);
    expect(editor.undoLabel).toBe("Change time signature");
    editor.undo();
    expect(json(editor)).toBe(before);
    editor.redo();
    expect(editor.score.masterBars[3]!.timeSignatureNumerator).toBe(3);
  });

  it("enters letters in the bar's key", () => {
    const editor = tabSong();
    editor.setTrack(1);
    const score = editor.score;
    const next = { ...barSettingsOf(score, 0), keySignature: 1, keyType: KeySignatureType.Major };
    applyBarSettings(score, 0, next);
    refinish(score);
    editor.moveBar(1);
    editor.enterLetter("f");
    expect(beat(editor, 0, 1).notes[0]!.realValue % 12).toBe(6); // F sharp
    editor.enterLetter("c");
    expect(beat(editor, 0, 1).notes.map((n) => n.realValue % 12)).toContain(0);
  });
});
