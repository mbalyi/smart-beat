import { model } from "@coderline/alphatab";

import { ScoreEditor } from "@/lib/score/editor";
import { refinish } from "@/lib/score/model";
import { compatiblePrograms, getPreset, INSTRUMENT_PRESETS } from "@/lib/score/music";
import { parseScore, summarizeScore, trackMix } from "@/lib/score/score";
import {
  convertTrackToInstrument,
  createSong,
  createTrack,
  duplicateTrack,
  insertTrack,
  moveTrack,
  removeTrack,
  renameTrack,
  setCapo,
  setInstrument,
  setTuning,
  trackFromPreset,
  uniqueTrackName,
} from "@/lib/score/tracks";
import { fixtureBytes } from "@/test/score";

const { Clef } = model;

const load = () => parseScore(fixtureBytes("practice-song.gp")).score;

function add(score: model.Score, presetId: string) {
  const track = createTrack(score, trackFromPreset(getPreset(presetId)!));
  insertTrack(score, track);
  refinish(score);
  return track;
}

describe("createSong", () => {
  it("makes an empty song with one guitar", () => {
    const score = createSong();
    const summary = summarizeScore(score);

    expect(summary.title).toBe("");
    expect(score.masterBars).toHaveLength(4);
    expect(score.tempo).toBe(120);
    expect(summary.tracks).toEqual([
      expect.objectContaining({
        name: "Guitar",
        kind: "stringed",
        tuning: [64, 59, 55, 50, 45, 40],
        program: 25,
      }),
    ]);
    expect(score.tracks[0]!.playbackInfo.volume).toBe(16); // the mixer sets the level
    expect(trackMix(score.tracks[0]!).volume).toBeCloseTo(13 / 16);
  });
});

describe("createTrack", () => {
  it.each(INSTRUMENT_PRESETS.map((p) => [p.id, p] as const))("builds a %s track", (_, preset) => {
    const score = load();
    const track = add(score, preset.id);
    const staff = track.staves[0]!;
    const summary = summarizeScore(score).tracks.at(-1)!;

    expect(summary.kind).toBe(preset.kind);
    expect(summary.name).toBe(preset.name);
    expect(staff.bars).toHaveLength(score.masterBars.length);
    expect(staff.bars.every((bar) => bar.voices[0]!.beats.length > 0)).toBe(true);
    if (preset.kind === "stringed") {
      expect(summary.tuning).toEqual(preset.tuning);
      expect(staff.showTablature).toBe(true);
    } else {
      expect(summary.tuning).toEqual([]);
    }
    if (preset.kind === "drums") {
      expect(track.isPercussion).toBe(true);
      expect(track.playbackInfo.primaryChannel).toBe(9);
      expect(staff.bars[0]!.clef).toBe(Clef.Neutral);
    } else {
      expect(track.playbackInfo.program).toBe(preset.program);
      expect(track.playbackInfo.primaryChannel).not.toBe(9);
    }
  });

  it("writes basses in bass clef and guitars in treble clef", () => {
    const score = load();
    expect(add(score, "bass-5").staves[0]!.bars[0]!.clef).toBe(Clef.F4);
    expect(add(score, "guitar-8").staves[0]!.bars[0]!.clef).toBe(Clef.G2);
    const cello = createTrack(score, { kind: "pitched", name: "Cello", program: 42 });
    expect(cello.staves[0]!.bars[0]!.clef).toBe(Clef.F4);
  });

  it("gives each new track its own MIDI channels", () => {
    const score = load();
    const a = add(score, "guitar");
    const b = add(score, "piano");
    const channels = [a, b].flatMap((t) => [
      t.playbackInfo.primaryChannel,
      t.playbackInfo.secondaryChannel,
    ]);
    expect(new Set(channels).size).toBe(4);
  });

  it("can be edited like any other track", () => {
    const score = load();
    add(score, "guitar-7");
    const editor = new ScoreEditor(score, 4);
    expect(editor.stringCount).toBe(7);
    editor.typeDigit(5);
    expect(score.tracks[4]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.realValue).toBe(69);
  });
});

describe("track list", () => {
  it("removes, moves and duplicates tracks", () => {
    const score = load();
    const names = () => score.tracks.map((t) => t.name);

    moveTrack(score, 3, 0);
    refinish(score);
    expect(names()).toEqual(["Piano", "Guitar", "Bass", "Drums"]);
    expect(score.tracks[0]!.index).toBe(0);

    const copy = duplicateTrack(score, 2);
    refinish(score);
    expect(names()).toEqual(["Piano", "Guitar", "Bass", "Bass 2", "Drums"]);
    expect(copy.playbackInfo.primaryChannel).not.toBe(score.tracks[2]!.playbackInfo.primaryChannel);
    expect(trackMix(copy)).toEqual(trackMix(score.tracks[2]!));

    removeTrack(score, 0);
    refinish(score);
    expect(names()).toEqual(["Guitar", "Bass", "Bass 2", "Drums"]);
  });

  it("keeps at least one track", () => {
    const score = createSong();
    expect(() => removeTrack(score, 0)).toThrow(/at least one track/);
  });

  it("duplicates drum tracks on the drum channel", () => {
    const score = load();
    const copy = duplicateTrack(score, 2);
    expect(copy.playbackInfo.primaryChannel).toBe(9);
  });

  it("names tracks uniquely", () => {
    const score = load();
    expect(uniqueTrackName(score, "Guitar")).toBe("Guitar 2");
    expect(uniqueTrackName(score, "Banjo")).toBe("Banjo");
    expect(uniqueTrackName(score, "  ")).toBe("Track");
    renameTrack(score.tracks[0]!, "  Lead  ");
    expect(score.tracks[0]!.name).toBe("Lead");
    renameTrack(score.tracks[0]!, "");
    expect(score.tracks[0]!.name).toBe("Lead");
  });
});

describe("instrument, tuning and capo", () => {
  it("changes the instrument", () => {
    const score = load();
    setInstrument(score.tracks[0]!, 30);
    setInstrument(score.tracks[2]!, 30); // drums keep the drum kit
    refinish(score);
    expect(score.tracks[0]!.playbackInfo.program).toBe(30);
    expect(score.tracks[2]!.playbackInfo.program).toBe(0);
  });

  it("retunes, keeping fret numbers", () => {
    const score = load();
    const staff = score.tracks[0]!.staves[0]!;
    const note = staff.bars[0]!.voices[0]!.beats[1]!.notes[0]!;

    expect(setTuning(staff, [64, 59, 55, 50, 45, 38])).toBe(0); // drop D
    refinish(score);

    expect(note.fret).toBe(2);
    expect(note.realValue).toBe(40);
    expect(summarizeScore(score).tracks[0]!.tuning).toEqual([64, 59, 55, 50, 45, 38]);
  });

  it("adds and removes strings at the low end", () => {
    const score = load();
    const staff = score.tracks[0]!.staves[0]!;
    const note = staff.bars[0]!.voices[0]!.beats[1]!.notes[0]!; // low E string, fret 2

    setTuning(staff, [64, 59, 55, 50, 45, 40, 35]);
    refinish(score);
    expect(note.string).toBe(2);
    expect(note.realValue).toBe(42); // still on the low E string

    const removed = setTuning(staff, [64, 59, 55, 50, 45]);
    refinish(score);
    expect(removed).toBe(4); // bar 1 is played on the low E string
    expect(staff.bars[0]!.voices[0]!.beats[1]!.notes).toHaveLength(0);
  });

  it("ignores tunings for tracks without strings", () => {
    const score = load();
    expect(setTuning(score.tracks[3]!.staves[0]!, [64])).toBe(0);
    expect(score.tracks[3]!.staves[0]!.tuning).toEqual([]);
  });

  it("sets a capo, which raises the pitch", () => {
    const score = load();
    const staff = score.tracks[0]!.staves[0]!;
    setCapo(staff, 3);
    refinish(score);
    expect(staff.bars[0]!.voices[0]!.beats[0]!.notes[0]!.realValue).toBe(43);
    setCapo(staff, 99);
    expect(staff.capo).toBe(24);
    setCapo(staff, -1);
    expect(staff.capo).toBe(0);
  });
});

describe("undoing track changes", () => {
  it("brings removed, moved and added tracks back", () => {
    const score = load();
    const editor = new ScoreEditor(score);
    const original = [...score.tracks];

    editor.run(
      "Remove track",
      () => editor.structureTargets(),
      () => removeTrack(score, 1),
    );
    editor.run(
      "Move track",
      () => editor.structureTargets(),
      () => moveTrack(score, 0, 2),
    );
    editor.run(
      "Add track",
      () => editor.structureTargets(),
      () => insertTrack(score, createTrack(score, trackFromPreset(getPreset("drums")!))),
    );
    expect(score.tracks).toHaveLength(4);

    editor.undo();
    editor.undo();
    editor.undo();
    expect(score.tracks).toEqual(original);
    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3]);

    editor.redo();
    expect(score.tracks.map((t) => t.name)).toEqual(["Guitar", "Drums", "Piano"]);
  });
});

describe("convertTrackToInstrument", () => {
  const withNotes = () => {
    const score = createSong();
    const staff = score.tracks[0]!.staves[0]!;
    const beat = staff.bars[0]!.voices[0]!.beats[0]!;
    beat.isEmpty = false;
    for (const [string, fret] of [
      [6, 3],
      [3, 2],
    ] as const) {
      const note = new model.Note();
      note.string = string;
      note.fret = fret;
      beat.addNote(note);
    }
    refinish(score);
    return { score, beat };
  };

  it("copies a guitar track to piano by pitch as a new track right after it", () => {
    const { score } = withNotes();
    const result = convertTrackToInstrument(score, 0, getPreset("piano")!)!;
    expect(score.tracks).toHaveLength(2);
    expect(score.tracks[1]).toBe(result.track);
    const summary = summarizeScore(score).tracks[1]!;
    expect(summary.kind).toBe("pitched");
    expect(summary.tuning).toEqual([]);
    expect(summary.program).toBe(0);
    const notes = result.track.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes;
    expect(notes.map((n) => n.octave * 12 + n.tone).sort()).toEqual([52, 67]);
    // the original is unchanged
    expect(score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.isStringed).toBe(
      true,
    );
  });

  it("copies piano to a guitar by pitch", () => {
    const { score } = withNotes();
    const piano = convertTrackToInstrument(score, 0, getPreset("piano")!)!;
    const guitar = convertTrackToInstrument(score, 1, getPreset("guitar")!)!;
    expect(piano.dropped + guitar.dropped).toBe(0);
    const notes = guitar.track.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes;
    expect(notes.map((n) => [n.string, n.fret]).sort()).toEqual([
      [3, 2],
      [6, 3],
    ]);
  });

  it("shifts a note outside the range by octaves and reports it", () => {
    const { score, beat } = withNotes();
    const high = new model.Note();
    high.string = 6;
    high.fret = 20; // E4 + 20 = 84, above a bass
    beat.addNote(high);
    refinish(score);
    const { track, shifted, dropped } = convertTrackToInstrument(score, 0, getPreset("bass-4")!)!;
    expect(shifted).toBe(1);
    expect(dropped).toBe(0);
    const staff = track.staves[0]!;
    for (const note of staff.bars[0]!.voices[0]!.beats[0]!.notes) {
      expect(note.string).toBeGreaterThanOrEqual(1);
      expect(note.string).toBeLessThanOrEqual(4);
      expect(note.fret).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not convert drums", () => {
    const score = load();
    const drums = score.tracks.findIndex((t) => t.staves[0]!.isPercussion);
    expect(convertTrackToInstrument(score, drums, getPreset("piano")!)).toBeNull();
    expect(convertTrackToInstrument(score, 0, getPreset("drums")!)).toBeNull();
  });

  it("is one undo step", () => {
    const { score } = withNotes();
    const editor = new ScoreEditor(score);
    editor.run(
      "Copy track to instrument",
      () => editor.structureTargets(),
      () => convertTrackToInstrument(editor.score, 0, getPreset("piano")!),
    );
    expect(editor.score.tracks).toHaveLength(2);
    editor.undo();
    expect(editor.score.tracks).toHaveLength(1);
  });
});

describe("compatiblePrograms", () => {
  it("offers fretted sounds to a tab track and the rest to a staff track", () => {
    const stringed = compatiblePrograms("stringed", 25);
    expect(stringed).toContain(33);
    expect(stringed).not.toContain(0);
    const pitched = compatiblePrograms("pitched", 0);
    expect(pitched).toContain(0);
    expect(pitched).not.toContain(25);
    expect(compatiblePrograms("drums", 0)).toEqual([]);
  });

  it("always includes the track's own sound", () => {
    expect(compatiblePrograms("stringed", 0)).toContain(0);
    expect(compatiblePrograms("pitched", 25)).toContain(25);
  });
});
