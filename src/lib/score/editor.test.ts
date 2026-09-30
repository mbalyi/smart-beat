import { model } from "@coderline/alphatab";

import { comparePositions, ScoreEditor, selectionRange, TWO_DIGIT_MS } from "@/lib/score/editor";
import { parseScore } from "@/lib/score/score";
import { createSong } from "@/lib/score/tracks";
import { fixtureBytes } from "@/test/score";

const { Duration } = model;

/** A new song (one guitar, four empty 4/4 bars) with an editor on its guitar. */
function newSong() {
  const editor = new ScoreEditor(createSong());
  const changes: string[] = [];
  editor.subscribe((change) => changes.push(change));
  return { editor, score: editor.score, changes };
}

function practiceSong(track = 0) {
  return new ScoreEditor(parseScore(fixtureBytes("practice-song.gp")).score, track);
}

const voice = (editor: ScoreEditor, bar = 0, v = 0) =>
  editor.score.tracks[editor.cursor.track]!.staves[0]!.bars[bar]!.voices[v]!;

/** Frets per beat of a bar, e.g. `[["6:3"], ["5:5"]]` (string:fret), or "r" for rests. */
const frets = (editor: ScoreEditor, bar = 0, v = 0) =>
  voice(editor, bar, v).beats.map((beat) =>
    beat.isEmpty
      ? "-"
      : beat.notes.length === 0
        ? "r"
        : beat.notes.map((n) => `${n.string}:${n.fret}`).join(" "),
  );

describe("ScoreEditor: cursor", () => {
  it("starts on the first beat, top string", () => {
    const { editor } = newSong();
    expect(editor.cursor).toMatchObject({ track: 0, voice: 0, bar: 0, beat: 0, string: 6 });
    expect(editor.kind).toBe("stringed");
    expect(editor.describeCursor()).toBe(
      "Bar 1, beat 1 of 1, string 1 (E), empty, next note Quarter",
    );
  });

  it("moves between strings, beats and bars", () => {
    const editor = practiceSong();
    editor.moveString(-1);
    editor.moveString(-1);
    expect(editor.cursor.string).toBe(4);
    editor.moveString(1);
    expect(editor.cursor.string).toBe(5);

    editor.moveBeat(1);
    editor.moveBeat(1);
    editor.moveBeat(1);
    editor.moveBeat(1); // past the last beat of a full bar: next bar
    expect(editor.cursor).toMatchObject({ bar: 1, beat: 0 });
    editor.moveBeat(-1);
    expect(editor.cursor).toMatchObject({ bar: 0, beat: 3 });
    editor.moveBar(1);
    editor.moveBar(1);
    expect(editor.cursor).toMatchObject({ bar: 2, beat: 0 });
    editor.moveBar(-1);
    expect(editor.cursor).toMatchObject({ bar: 1, beat: 0 });
  });

  it("stays inside the song at the start", () => {
    const editor = practiceSong();
    editor.moveBeat(-1);
    editor.moveBar(-1);
    editor.moveString(1);
    expect(editor.cursor).toMatchObject({ bar: 0, beat: 0, string: 6 });
  });

  it("selects beats with shift and across bars", () => {
    const editor = practiceSong();
    editor.moveBeat(1, true);
    editor.moveBeat(1, true);
    expect(editor.selection).toEqual({ anchor: { bar: 0, beat: 0 }, head: { bar: 0, beat: 2 } });
    editor.moveBar(1, true);
    expect(selectionRange(editor.selection!)).toEqual([
      { bar: 0, beat: 0 },
      { bar: 1, beat: 3 },
    ]);
    editor.moveBeat(1); // without shift: the selection ends
    expect(editor.selection).toBeNull();

    editor.selectAll();
    expect(selectionRange(editor.selection!)).toEqual([
      { bar: 0, beat: 0 },
      { bar: 3, beat: 3 },
    ]);
    editor.clearSelection();
    expect(editor.selection).toBeNull();
  });

  it("orders positions", () => {
    expect(comparePositions({ bar: 1, beat: 0 }, { bar: 0, beat: 5 })).toBeGreaterThan(0);
    expect(comparePositions({ bar: 1, beat: 2 }, { bar: 1, beat: 3 })).toBeLessThan(0);
  });

  it("places the cursor on a clicked beat and note", () => {
    const editor = practiceSong();
    const beat = voice(editor, 2).beats[1]!;
    editor.setCursorTo({ bar: 2, beat: 1, note: beat.notes[0] });
    expect(editor.cursor).toMatchObject({ bar: 2, beat: 1, string: beat.notes[0]!.string });

    editor.setCursorTo({ bar: 3, beat: 2 }, true);
    expect(editor.selection).toEqual({ anchor: { bar: 2, beat: 1 }, head: { bar: 3, beat: 2 } });
  });

  it("follows the shown track", () => {
    const editor = practiceSong();
    editor.setTrack(1);
    expect(editor.kind).toBe("stringed");
    expect(editor.cursor.string).toBe(4); // a 4-string bass, top line
    editor.setTrack(3);
    expect(editor.kind).toBe("pitched");
    editor.setTrack(2);
    expect(editor.kind).toBe("drums");
  });
});

describe("ScoreEditor: note entry", () => {
  it("types frets into an empty bar with the current note value", () => {
    const { editor, changes } = newSong();

    editor.typeDigit(3);
    expect(frets(editor)).toEqual(["6:3"]);
    expect(voice(editor).beats[0]!.duration).toBe(Duration.Quarter);
    expect(editor.message).toBe("Fret 3 on string 1");
    expect(changes).toContain("model");

    editor.moveBeat(1); // the bar has room: adds a beat of the same length
    editor.moveString(-1);
    editor.typeDigit(5);
    expect(frets(editor)).toEqual(["6:3", "5:5"]);
    expect(editor.canUndo).toBe(true);
    expect(editor.edited).toBe(true);
  });

  it("combines two quick digits into one fret and one undo step", () => {
    const { editor } = newSong();

    editor.typeDigit(1, 1_000);
    editor.typeDigit(2, 1_500);
    expect(frets(editor)).toEqual(["6:12"]);

    editor.typeDigit(3, 1_500 + TWO_DIGIT_MS + 1); // too late: a new fret
    expect(frets(editor)).toEqual(["6:3"]);

    editor.undo();
    expect(frets(editor)).toEqual(["6:12"]);
    editor.undo();
    expect(frets(editor)).toEqual(["r"]);
  });

  it("never combines digits into a fret above 29", () => {
    const { editor } = newSong();
    editor.typeDigit(3, 0);
    editor.typeDigit(5, 10);
    expect(frets(editor)).toEqual(["6:5"]);
  });

  it("enters pitches by letter on the nearest playable string", () => {
    const { editor } = newSong();
    editor.enterLetter("A"); // near the high E string: A4, fret 5
    expect(frets(editor)).toEqual(["6:5"]);

    editor.enterPitch(40); // low E: only the lowest string can play it
    expect(editor.cursor.string).toBe(1);
    expect(frets(editor)).toEqual(["6:5 1:0"]);

    editor.enterPitch(10); // below the guitar
    expect(editor.message).toMatch(/can't be played/);
    expect(frets(editor)).toEqual(["6:5 1:0"]);
  });

  it("enters pitches on a staff-only track", () => {
    const editor = practiceSong(3);
    editor.moveBar(1);
    editor.enterPitch(62);
    const notes = voice(editor, 1).beats[0]!.notes.map((n) => n.realValue);
    expect(notes).toContain(62);
    expect(editor.cursor.pitch).toBe(62);

    editor.transpose(1);
    expect(voice(editor, 1).beats[0]!.notes.map((n) => n.realValue)).toContain(63);
    editor.enterLetter("C");
    expect(editor.cursor.pitch).toBe(60);
  });

  it("enters drum sounds", () => {
    const editor = practiceSong(2);
    editor.enterDrum(49);
    const hits = voice(editor).beats[0]!.notes.map((n) => n.percussionArticulation);
    expect(hits).toContain(49);
    editor.enterDrum(49); // already there: just selects it
    expect(
      voice(editor).beats[0]!.notes.filter((n) => n.percussionArticulation === 49),
    ).toHaveLength(1);
  });

  it("changes and deletes the note under the cursor", () => {
    const { editor } = newSong();
    editor.typeDigit(7);
    editor.transpose(1);
    expect(frets(editor)).toEqual(["6:8"]);
    editor.transpose(-1);
    editor.transpose(-1);
    expect(frets(editor)).toEqual(["6:6"]);

    editor.deleteAtCursor();
    expect(frets(editor)).toEqual(["r"]);
  });

  it("makes rests, inserts and deletes beats", () => {
    const editor = practiceSong();
    editor.clearNotes();
    expect(frets(editor)[0]).toBe("r");

    editor.insertBeat();
    expect(voice(editor).beats).toHaveLength(5);
    expect(frets(editor)[0]).toBe("r");

    editor.deleteBeats();
    editor.deleteBeats();
    expect(voice(editor).beats).toHaveLength(3);

    editor.deleteAtCursor(); // a note on this string: deletes it
    editor.moveString(-1);
    editor.moveString(-1);
    editor.moveString(-1);
    editor.moveString(-1);
    editor.moveString(-1); // lowest string, no note: deletes the beat
    editor.deleteAtCursor();
    expect(voice(editor).beats.length).toBeLessThanOrEqual(3);
  });

  it("gives a bar its rest back when all its beats are deleted", () => {
    const editor = practiceSong();
    editor.moveBeat(1, true);
    editor.moveBeat(1, true);
    editor.moveBeat(1, true);
    editor.deleteBeats();
    expect(frets(editor)).toEqual(["r"]);
    expect(voice(editor).beats[0]!.duration).toBe(Duration.Whole);
  });

  it("adds a bar when moving past the end of the song", () => {
    const { editor, score } = newSong();
    editor.moveBar(1);
    editor.moveBar(1);
    editor.moveBar(1);
    editor.typeDigit(0);
    editor.setDuration(Duration.Whole);
    editor.moveBeat(1);
    expect(score.masterBars).toHaveLength(5);
    expect(editor.cursor).toMatchObject({ bar: 4, beat: 0 });
    expect(score.tracks[0]!.staves[0]!.bars).toHaveLength(5);

    editor.undo();
    expect(score.masterBars).toHaveLength(4);
    expect(editor.cursor.bar).toBe(3);
  });

  it("doesn't add bars after an empty last bar", () => {
    const { editor, score } = newSong();
    editor.moveBar(1);
    editor.moveBar(1);
    editor.moveBar(1);
    editor.moveBeat(1);
    expect(score.masterBars).toHaveLength(4);
  });
});

describe("ScoreEditor: rhythm", () => {
  it("changes durations, dots and tuplets", () => {
    const { editor } = newSong();
    editor.typeDigit(0);

    editor.stepDuration(1);
    expect(editor.beatInfo.duration).toBe(Duration.Eighth);
    editor.stepDuration(-1);
    editor.stepDuration(-1);
    expect(editor.beatInfo.duration).toBe(Duration.Half);
    editor.toggleDots(1);
    expect(editor.beatInfo.dots).toBe(1);
    editor.toggleDots(2);
    expect(editor.beatInfo.dots).toBe(2);
    editor.toggleDots(2);
    expect(editor.beatInfo.dots).toBe(0);

    editor.setTuplet({ numerator: 3, denominator: 2 });
    expect(editor.beatInfo.tuplet).toEqual({ numerator: 3, denominator: 2 });
    expect(voice(editor).beats[0]!.tupletGroup).not.toBeNull();
    editor.setTuplet({ numerator: 1, denominator: 1 });
    expect(voice(editor).beats[0]!.tupletGroup).toBeNull();
  });

  it("uses the chosen note value for the next notes typed in an empty bar", () => {
    const { editor } = newSong();
    editor.setDuration(Duration.Eighth);
    expect(editor.canUndo).toBe(false); // nothing written yet
    editor.typeDigit(2);
    expect(editor.beatInfo.duration).toBe(Duration.Eighth);
  });

  it("changes the rhythm of a selection at once", () => {
    const editor = practiceSong();
    editor.moveBeat(1, true);
    editor.setDuration(Duration.Eighth);
    expect(
      voice(editor)
        .beats.slice(0, 3)
        .map((b) => b.duration),
    ).toEqual([Duration.Eighth, Duration.Eighth, Duration.Quarter]);
  });

  it("ties notes to the note before", () => {
    const editor = practiceSong(); // bar 1: frets 0, 2, 3, 0 on the low E string
    const second = voice(editor).beats[1]!.notes[0]!;
    editor.setCursorTo({ bar: 0, beat: 1, note: second });

    editor.toggleTie();
    expect(second.isTieDestination).toBe(true);
    expect(second.tieOrigin).toBe(voice(editor).beats[0]!.notes[0]);
    expect(second.fret).toBe(0); // a tied note repeats the note it is tied to
    expect(editor.undoLabel).toBe("Tie note");

    editor.toggleTie();
    expect(second.isTieDestination).toBe(false);
    expect(editor.undoLabel).toBe("Untie note");
  });

  it("can't tie the first note of the song", () => {
    const editor = practiceSong();
    editor.setCursorTo({ bar: 0, beat: 0, note: voice(editor).beats[0]!.notes[0] });
    editor.toggleTie();
    expect(voice(editor).beats[0]!.notes[0]!.isTieDestination).toBe(false);
  });

  it("adds a tied note on an empty string", () => {
    const { editor } = newSong();
    editor.typeDigit(5);
    editor.moveBeat(1);
    editor.toggleTie();
    expect(frets(editor)).toEqual(["6:5", "6:5"]);
    expect(voice(editor).beats[1]!.notes[0]!.isTieDestination).toBe(true);
  });
});

describe("ScoreEditor: voices", () => {
  it("writes a second voice without touching the first", () => {
    const editor = practiceSong();
    const first = frets(editor);

    editor.switchVoice(1);
    expect(editor.cursor.voice).toBe(1);
    editor.typeDigit(9);

    expect(frets(editor, 0, 0)).toEqual(first);
    expect(frets(editor, 0, 1)).toEqual(["6:9"]);
    // Every bar of the staff now has a second voice.
    expect(editor.score.tracks[0]!.staves[0]!.bars.every((b) => b.voices.length === 2)).toBe(true);
    expect(editor.message).toMatch(/string 1/);

    editor.undo();
    expect(editor.score.tracks[0]!.staves[0]!.bars.every((b) => b.voices.length === 1)).toBe(true);
    editor.switchVoice(0);
    expect(editor.cursor.voice).toBe(0);
  });
});

describe("ScoreEditor: clipboard", () => {
  it("copies and pastes over the music at the cursor", () => {
    const editor = practiceSong();
    editor.moveBeat(1, true);
    editor.copy();
    expect(editor.hasClipboard).toBe(true);
    expect(editor.message).toBe("Copied 2 beats");
    const copied = frets(editor).slice(0, 2);

    editor.moveBar(1);
    editor.moveBar(1);
    editor.paste();

    expect(frets(editor, 2).slice(0, 2)).toEqual(copied);
    expect(editor.selection).toEqual({ anchor: { bar: 2, beat: 0 }, head: { bar: 2, beat: 1 } });
  });

  it("pastes several bars, adding bars at the end", () => {
    const editor = practiceSong();
    const original = [0, 1, 2, 3].map((bar) => frets(editor, bar));
    editor.selectAll();
    editor.copy();
    editor.setCursorTo({ bar: 3, beat: 0 });
    editor.paste();

    expect(editor.score.masterBars).toHaveLength(7);
    expect([3, 4, 5, 6].map((bar) => frets(editor, bar))).toEqual(original);
    expect(frets(editor, 2)).toEqual(original[2]);
    editor.undo();
    expect(editor.score.masterBars).toHaveLength(4);
  });

  it("cuts to rests", () => {
    const editor = practiceSong();
    editor.cut();
    expect(frets(editor)[0]).toBe("r");
    editor.moveBeat(1);
    editor.paste();
    expect(frets(editor)[1]).not.toBe("r");
  });

  it("converts between tab and staff by pitch", () => {
    const editor = practiceSong();
    const pitch = voice(editor).beats[0]!.notes[0]!.realValue;
    editor.copy();

    editor.setTrack(3); // piano
    editor.moveBar(1);
    editor.paste();
    expect(voice(editor, 1).beats[0]!.notes.map((n) => n.realValue)).toEqual([pitch]);

    editor.copy();
    editor.setTrack(1); // bass: plays it where it can
    editor.paste();
    const bass = voice(editor, 1).beats[0]!.notes;
    expect(bass.map((n) => n.realValue)).toEqual([pitch]);

    editor.setTrack(2); // drums can't take pitched notes
    editor.paste();
    expect(voice(editor, 1).beats[0]!.notes).toHaveLength(0);
  });

  it("does nothing without a clipboard, or with nothing to copy", () => {
    const { editor } = newSong();
    editor.paste();
    editor.switchVoice(1);
    editor.copy(); // voice 2 is empty
    expect(editor.hasClipboard).toBe(false);
    expect(editor.canUndo).toBe(false);
  });
});

describe("ScoreEditor: undo and redo", () => {
  it("undoes and redoes any number of edits, with the cursor", () => {
    const { editor } = newSong();
    editor.typeDigit(1, 0);
    editor.moveBeat(1);
    editor.typeDigit(2, 5_000);
    editor.moveBeat(1);
    editor.typeDigit(3, 10_000);

    expect(editor.undoLabel).toBe("Add note");
    editor.undo();
    expect(frets(editor)).toEqual(["6:1", "6:2", "r"]);
    expect(editor.message).toBe("Undo Add note");
    expect(editor.undoLabel).toBe("Add beat"); // moving right added the beat
    editor.undo();
    editor.undo();
    expect(frets(editor)).toEqual(["6:1", "r"]);
    expect(editor.cursor.beat).toBe(1);
    expect(editor.redoLabel).toBe("Add note");

    editor.redo();
    editor.redo();
    editor.redo();
    expect(frets(editor)).toEqual(["6:1", "6:2", "6:3"]);

    while (editor.canUndo) editor.undo();
    expect(frets(editor)).toEqual(["r"]);
    expect(editor.edited).toBe(false);
    editor.undo(); // nothing left
    editor.redo();
    expect(frets(editor)).toEqual(["6:1"]);
  });

  it("drops the redo steps after a new edit", () => {
    const { editor } = newSong();
    editor.typeDigit(1);
    editor.undo();
    editor.typeDigit(2, 99_999);
    expect(editor.canRedo).toBe(false);
  });

  it("keeps effects it doesn't edit across undo and redo", () => {
    const editor = practiceSong();
    const note = voice(editor).beats[0]!.notes[0]!;
    note.isPalmMute = true;
    note.vibrato = model.VibratoType.Slight;

    editor.typeDigit(9);
    editor.undo();

    const restored = voice(editor).beats[0]!.getNoteOnString(note.string)!;
    expect(restored).toBe(note);
    expect(restored.isPalmMute).toBe(true);
    expect(restored.vibrato).toBe(model.VibratoType.Slight);
  });
});

describe("ScoreEditor: saved state", () => {
  it("is edited after a change and clean again when saved", () => {
    const { editor, changes } = newSong();
    expect(editor.edited).toBe(false);
    editor.setFret(3);
    expect(editor.edited).toBe(true);
    changes.length = 0;
    editor.markSaved();
    expect(editor.edited).toBe(false);
    // Subscribers (React) hear about it.
    expect(changes).toEqual(["cursor"]);
  });

  it("is edited again by the next change, and by undoing past the save", () => {
    const { editor } = newSong();
    editor.setFret(3);
    editor.markSaved();
    editor.undo();
    expect(editor.edited).toBe(true); // the music differs from the saved file
    editor.redo();
    expect(editor.edited).toBe(false); // back to the saved state
    editor.transpose(1);
    expect(editor.edited).toBe(true);
    editor.undo();
    expect(editor.edited).toBe(false);
  });

  it("treats a song saved before any change as clean until edited", () => {
    const { editor } = newSong();
    editor.markSaved();
    expect(editor.edited).toBe(false);
    editor.setFret(2);
    expect(editor.edited).toBe(true);
    editor.undo();
    expect(editor.edited).toBe(false);
  });
});
