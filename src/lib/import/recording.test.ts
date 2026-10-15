import { model } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import {
  alignOffset,
  recordingTargets,
  recordingToSong,
  tabNotes,
  writeRecording,
  type RecordedNote,
} from "@/lib/import/recording";
import { appendMasterBar, refinish, type Score } from "@/lib/score/model";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { History } from "@/lib/score/history";
import { createTrack, createSong, insertTrack } from "@/lib/score/tracks";
import { tempoAt } from "@/lib/score/structure";

const note = (start: number, pitch: number, length = 0.1): RecordedNote => ({
  start,
  end: start + length,
  pitch,
  velocity: 90,
});

/** A riff of eighths and sixteenths at `bpm` for `bars` bars of 4/4, with a little timing jitter. */
function riff(bpm: number, bars: number, offset = 0) {
  const sixteenth = 60 / bpm / 4;
  const steps = [0, 2, 3, 4, 6, 8, 10, 11, 12, 14];
  const pitches = [40, 40, 43, 45, 47, 45, 43, 40];
  let seed = 11;
  const jitter = () => {
    seed = (seed * 16807) % 2147483647;
    return ((seed % 1000) / 1000 - 0.5) * 0.02; // plus or minus 10 ms
  };
  const notes: RecordedNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (const step of steps) {
      const at = offset + (bar * 16 + step) * sixteenth + jitter();
      notes.push(note(at, pitches[notes.length % 8]!, sixteenth * 1.6));
    }
  }
  return notes;
}

/** A song of `bars` empty bars with a second guitar track, ready for takes. */
function song(bars: number): Score {
  const score = createSong();
  while (score.masterBars.length < bars) appendMasterBar(score);
  const other = createTrack(score, {
    kind: "stringed",
    name: "Other",
    program: 25,
    tuning: [...STANDARD_GUITAR],
  });
  insertTrack(score, other);
  refinish(score);
  return score;
}

const countIn = (score: Score, track: number, from: number, to: number) =>
  score.tracks[track]!.staves[0]!.bars.slice(from, to).flatMap((bar) =>
    bar.voices.flatMap((voice) => voice.beats.filter((beat) => beat.notes.length > 0)),
  ).length;

describe("alignOffset", () => {
  const beat = 0.5; // 120 BPM, sixteenth = 125 ms
  const onGrid = (late = 0) =>
    [0, 1, 2, 3, 5, 6, 8, 9, 10, 12, 13, 15].map((k) => note(k * 0.125 + late, 40));

  it("finds the shift of a late take", () => {
    expect(alignOffset(onGrid(0.035), beat)).toBeCloseTo(-0.035, 3);
    expect(alignOffset(onGrid(-0.02), beat)).toBeCloseTo(0.02, 3);
  });

  it("returns 0 for a take on the grid, and for no notes", () => {
    expect(alignOffset(onGrid(), beat)).toBe(0);
    expect(alignOffset([], beat)).toBe(0);
  });

  it("stays within the maximum shift", () => {
    expect(Math.abs(alignOffset(onGrid(0.05), beat, 0.03))).toBeLessThanOrEqual(0.03);
    expect(alignOffset(onGrid(0.05), beat, 0.03)).toBeCloseTo(-0.03, 3);
  });
});

describe("recordingToSong", () => {
  const options = { tuning: [...STANDARD_GUITAR], trackName: "Riff", program: 25 };

  it("measures the tempo of a take and writes the frets", () => {
    const { score, warnings } = recordingToSong(riff(100, 4), options);
    expect(score.tracks).toHaveLength(1);
    expect(score.tracks[0]!.name).toBe("Riff");
    expect(tempoAt(score, 0)).toBeGreaterThanOrEqual(98);
    expect(tempoAt(score, 0)).toBeLessThanOrEqual(102);
    expect(warnings.join(" ")).toMatch(/tempo was measured/);
    const played = tabNotes(score, 0);
    expect(played.map((n) => n.pitch)).toEqual(riff(100, 4).map((n) => n.pitch));
    // Open low E, then G, A, B on the low strings: low frets, no big jumps.
    expect(played.slice(0, 8).map((n) => [n.string, n.fret])).toEqual([
      [1, 0],
      [1, 0],
      [1, 3],
      [2, 0],
      [2, 2],
      [2, 0],
      [1, 3],
      [1, 0],
    ]);
    expect(score.masterBars.length).toBeGreaterThanOrEqual(4);
  });

  it("measures slow and fast takes too", () => {
    for (const bpm of [85, 150]) {
      const { score } = recordingToSong(riff(bpm, 4), options);
      expect(Math.abs(tempoAt(score, 0) - bpm)).toBeLessThanOrEqual(3);
    }
  });

  it("stays at 120 BPM with a warning when a short take has no measurable grid", () => {
    const { score, warnings } = recordingToSong([note(0, 40), note(0.5, 45), note(1, 47)], options);
    expect(tempoAt(score, 0)).toBe(120);
    expect(warnings[0]).toMatch(/could not be measured.*120 BPM/);
  });

  it("warns about notes below the strings, in words for a recording", () => {
    const low = [note(0, 38), note(0.5, 38), note(1, 40), note(1.5, 38)];
    const { warnings } = recordingToSong(low, options);
    expect(warnings.join(" ")).toMatch(
      /3 notes below the low E of “Riff” were moved up an octave\./,
    );
    expect(warnings.join(" ")).toMatch(/tuned down to D\?/);
    expect(warnings.join(" ")).not.toMatch(/MIDI/);
  });

  it("refuses a take without notes", () => {
    expect(() => recordingToSong([], options)).toThrow(/no notes/);
  });
});

describe("writeRecording", () => {
  // 120 BPM: a bar is 2 s, a quarter 0.5 s.
  const quarters = (count: number, pitch: number, from = 0) =>
    Array.from({ length: count }, (_, i) => note(from + i * 0.5, pitch, 0.4));

  it("writes into bars 3 and 4 and leaves the rest alone", () => {
    const score = song(6);
    const before = score.tracks[1]!.staves[0]!.bars.map((bar) => bar.voices[0]!.beats.length);
    const { warnings } = writeRecording(score, quarters(8, 45), { trackIndex: 0, startBar: 2 });
    expect(warnings).toEqual([]);
    refinish(score);
    expect(countIn(score, 0, 0, 2)).toBe(0);
    expect(countIn(score, 0, 2, 4)).toBe(8);
    expect(countIn(score, 0, 4, 6)).toBe(0);
    expect(score.masterBars).toHaveLength(6);
    const written = tabNotes(score, 0);
    expect(written.map((n) => n.start)).toEqual([4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5]);
    expect(written.every((n) => n.pitch === 45 && n.string === 2 && n.fret === 0)).toBe(true);
    // The other track is untouched.
    expect(score.tracks[1]!.staves[0]!.bars.map((bar) => bar.voices[0]!.beats.length)).toEqual(
      before,
    );
    expect(countIn(score, 1, 0, 6)).toBe(0);
  });

  it("replaces the bars a take covers, rests included", () => {
    const score = song(6);
    writeRecording(score, quarters(24, 45), { trackIndex: 0, startBar: 0 });
    expect(countIn(score, 0, 0, 6)).toBe(24);
    // A one-bar take over bar 2 replaces its notes. The other bars keep theirs.
    writeRecording(score, quarters(4, 52), { trackIndex: 0, startBar: 1 });
    refinish(score);
    expect(countIn(score, 0, 0, 6)).toBe(24);
    const pitches = tabNotes(score, 0).map((n) => n.pitch);
    expect(pitches.slice(4, 8)).toEqual([52, 52, 52, 52]);
    expect(pitches.filter((p) => p === 45)).toHaveLength(20);
  });

  it("clears old notes in a bar the take covers but plays nothing in", () => {
    const score = song(4);
    writeRecording(score, quarters(16, 45), { trackIndex: 0, startBar: 0 });
    // Notes in bar 1 and bar 3 of the take, nothing in bar 2.
    writeRecording(score, [...quarters(4, 52), ...quarters(4, 52, 4)], {
      trackIndex: 0,
      startBar: 0,
    });
    refinish(score);
    expect(countIn(score, 0, 0, 1)).toBe(4);
    expect(countIn(score, 0, 1, 2)).toBe(0);
    expect(countIn(score, 0, 2, 3)).toBe(4);
    // Bar 4 is after the take: it keeps what it had.
    expect(countIn(score, 0, 3, 4)).toBe(4);
  });

  it("appends bars to every track when the take runs past the end", () => {
    const score = song(4);
    writeRecording(score, quarters(16, 45), { trackIndex: 0, startBar: 2 });
    refinish(score);
    expect(score.masterBars).toHaveLength(6);
    expect(score.tracks.map((track) => track.staves[0]!.bars.length)).toEqual([6, 6]);
    expect(countIn(score, 0, 2, 6)).toBe(16);
    expect(countIn(score, 1, 0, 6)).toBe(0);
  });

  it("follows a tempo change inside the song", () => {
    const score = song(6);
    // From bar 4 the song runs at 240 BPM: a bar is 1 s.
    score.masterBars[3]!.tempoAutomations = [
      model.Automation.buildTempoAutomation(false, 0, 240, 2),
    ];
    refinish(score);
    // Bar 3 (2 s) holds four quarters, then bar 4 (1 s) four quarters of 0.25 s.
    const take = [...quarters(4, 45), ...[0, 1, 2, 3].map((i) => note(2 + i * 0.25, 47, 0.2))];
    writeRecording(score, take, { trackIndex: 0, startBar: 2 });
    refinish(score);
    expect(countIn(score, 0, 2, 3)).toBe(4);
    expect(countIn(score, 0, 3, 4)).toBe(4);
    const written = tabNotes(score, 0);
    expect(written.map((n) => Math.round(n.start * 1000) / 1000)).toEqual([
      4, 4.5, 5, 5.5, 6, 6.25, 6.5, 6.75,
    ]);
  });

  it("warns about notes before the first bar and about a take without notes", () => {
    const score = song(4);
    const early = writeRecording(score, [note(-0.5, 45), ...quarters(2, 45)], {
      trackIndex: 0,
      startBar: 0,
    });
    expect(early.warnings.join(" ")).toMatch(/1 note played before the first bar was left out/);
    const none = writeRecording(score, [], { trackIndex: 0, startBar: 1 });
    expect(none.warnings[0]).toMatch(/No notes/);
  });

  it("is one undo step when run through the history with the targets", () => {
    const score = song(4);
    const history = new History<null>();
    const snapshot = () => tabNotes(score, 0).length;
    history.record(
      "Record to tab",
      () => recordingTargets(score, 0, 2),
      () => {
        writeRecording(score, quarters(16, 45), { trackIndex: 0, startBar: 2 });
      },
      { before: null, after: () => null },
    );
    refinish(score);
    expect(score.masterBars).toHaveLength(6);
    expect(snapshot()).toBe(16);
    history.undo();
    refinish(score);
    expect(score.masterBars).toHaveLength(4);
    expect(score.tracks.map((track) => track.staves[0]!.bars.length)).toEqual([4, 4]);
    expect(snapshot()).toBe(0);
    history.redo();
    refinish(score);
    expect(score.masterBars).toHaveLength(6);
    expect(snapshot()).toBe(16);
    expect(history.depth).toBe(1);
  });
});

describe("piano takes", () => {
  const piano = { trackName: "Piano", program: 0 };
  const written = (score: Score, track: number) =>
    score.tracks[track]!.staves[0]!.bars.flatMap((bar) =>
      bar.voices[0]!.beats.flatMap((beat) => beat.notes.map((n) => n.octave * 12 + n.tone)),
    );

  /** Quarter notes at 100 BPM: a melody above middle C and a bass line below it. */
  function twoHands(bars: number) {
    const quarter = 60 / 100;
    const notes: RecordedNote[] = [];
    for (let i = 0; i < bars * 4; i++) {
      notes.push(note(i * quarter, [72, 76, 74, 71][i % 4]!, quarter * 0.9));
      if (i % 2 === 0) notes.push(note(i * quarter, [48, 43][(i / 2) % 2]!, quarter * 1.8));
    }
    return notes;
  }

  it("free mode writes the right hand and the left hand as two tracks, no frets", () => {
    const { score } = recordingToSong(twoHands(4), piano);
    expect(score.tracks.map((t) => t.name)).toEqual(["Piano", "Piano (left hand)"]);
    const [right, left] = score.tracks.map((t) => t.staves[0]!);
    expect(right!.showTablature).toBe(false);
    expect(left!.showTablature).toBe(false);
    expect(right!.bars[0]!.clef).toBe(model.Clef.G2);
    expect(left!.bars[0]!.clef).toBe(model.Clef.F4);
    expect(new Set(written(score, 0))).toEqual(new Set([71, 72, 74, 76]));
    expect(new Set(written(score, 1))).toEqual(new Set([43, 48]));
  });

  it("a one-handed take makes one track", () => {
    const { score } = recordingToSong(
      twoHands(4).filter((n) => n.pitch > 60),
      piano,
    );
    expect(score.tracks.map((t) => t.name)).toEqual(["Piano"]);
  });

  it("does not move or drop piano notes the way strings would", () => {
    const wide = [note(0, 24), note(0.6, 100), note(1.2, 36), note(1.8, 96)];
    const { score, warnings } = recordingToSong(wide, piano);
    expect(warnings.join(" ")).not.toMatch(/octave|outside/);
    expect(new Set([...written(score, 0), ...written(score, 1)])).toEqual(
      new Set([24, 100, 36, 96]),
    );
  });

  it("click mode writes a take into a piano track", () => {
    const score = createSong();
    while (score.masterBars.length < 4) appendMasterBar(score);
    const track = createTrack(score, { kind: "pitched", name: "Keys", program: 0 });
    insertTrack(score, track);
    refinish(score);
    const index = score.tracks.length - 1;
    const { warnings } = writeRecording(score, twoHands(2).slice(0, 4), {
      trackIndex: index,
      startBar: 1,
    });
    expect(warnings).toEqual([]);
    expect(written(score, index)).toEqual([72, 48, 76, 74]);
  });

  it("click mode writes the sounding pitch on a transposing piano track", () => {
    for (const transposition of [12, -12, 2]) {
      const score = createSong();
      while (score.masterBars.length < 2) appendMasterBar(score);
      const track = createTrack(score, { kind: "pitched", name: "Keys", program: 0 });
      track.staves[0]!.transpositionPitch = transposition;
      insertTrack(score, track);
      refinish(score);
      const index = score.tracks.length - 1;
      writeRecording(score, [note(0, 72), note(0.5, 41, 0.4)], { trackIndex: index, startBar: 0 });
      const sounded = score.tracks[index]!.staves[0]!.bars.flatMap((bar) =>
        bar.voices[0]!.beats.flatMap((beat) => beat.notes.map((n) => n.realValue)),
      );
      expect(sounded, `transposition ${transposition}`).toEqual([72, 41]);
    }
  });
});

/** The drum numbers written on a track, one list per beat that has notes. */
function drumsOf(track: model.Track): number[][] {
  return track.staves[0]!.bars.flatMap((bar) =>
    bar.voices[0]!.beats.filter((b) => b.notes.length > 0).map((b) =>
      b.notes.map((n) => n.percussionArticulation),
    ),
  );
}

describe("drum takes", () => {
  /** Kick on 1 and 3, snare on 2 and 4, closed hat on every eighth, at 120 BPM for `bars` bars. */
  function groove(bars: number): RecordedNote[] {
    const hits: RecordedNote[] = [];
    for (let bar = 0; bar < bars; bar++) {
      for (let eighth = 0; eighth < 8; eighth++) {
        const at = bar * 2 + eighth / 4;
        hits.push(note(at, 42, 0.12));
        if (eighth === 0 || eighth === 4) hits.push(note(at, 36, 0.12));
        if (eighth === 2 || eighth === 6) hits.push(note(at, 38, 0.12));
      }
    }
    return hits;
  }

  it("free mode opens one percussion track with the drum numbers", () => {
    const { score } = recordingToSong(groove(4), { trackName: "Drums", program: 0, drums: true });
    expect(score.tracks).toHaveLength(1);
    const track = score.tracks[0]!;
    expect(track.name).toBe("Drums");
    expect(track.staves[0]!.isPercussion).toBe(true);
    const beats = drumsOf(track);
    expect(beats.slice(0, 4).map((numbers) => [...numbers].sort())).toEqual([
      [36, 42],
      [42],
      [38, 42],
      [42],
    ]);
    expect(beats.flat().every((n) => [36, 38, 42].includes(n))).toBe(true);
  });

  it("click mode writes the hits on the beat grid of a drum track, from the start bar", () => {
    const score = createSong();
    while (score.masterBars.length < 4) appendMasterBar(score);
    const drums = createTrack(score, { kind: "drums", name: "Kit", program: 0 });
    insertTrack(score, drums);
    refinish(score);
    const index = score.tracks.length - 1;
    // Played a little loose: up to 15 ms early or late.
    const loose = groove(2).map((n, i) => ({
      ...n,
      start: Math.max(0, n.start + ((i % 3) - 1) * 0.015),
    }));
    const { warnings } = writeRecording(score, loose, { trackIndex: index, startBar: 1 });
    expect(warnings).toEqual([]);
    const staff = score.tracks[index]!.staves[0]!;
    expect(staff.bars[0]!.voices[0]!.beats.every((b) => b.notes.length === 0)).toBe(true);
    const hits = drumsOf(score.tracks[index]!).map((numbers) => [...numbers].sort());
    expect(hits.slice(0, 8)).toEqual([
      [36, 42],
      [42],
      [38, 42],
      [42],
      [36, 42],
      [42],
      [38, 42],
      [42],
    ]);
  });

  it("click mode writes the index of the drum in a track's own articulation table", () => {
    // Regression (review of #146): a Guitar Pro 6+ drum track refers to its drums by index, so
    // the kick (36) must go in as the index of the entry that plays 36, not as 36.
    const score = createSong();
    while (score.masterBars.length < 2) appendMasterBar(score);
    const kit = createTrack(score, { kind: "drums", name: "Kit", program: 0 });
    for (const key of [42, 38, 49, 36]) {
      const articulation = new model.InstrumentArticulation();
      articulation.outputMidiNumber = key;
      kit.percussionArticulations.push(articulation);
    }
    insertTrack(score, kit);
    refinish(score);
    const index = score.tracks.length - 1;
    // Kick, snare, hat, and a snare-ish key the table does not have (45, a tom) on the beat.
    const hits = [note(0, 36, 0.1), note(0.5, 38, 0.1), note(1, 42, 0.1), note(1.5, 45, 0.1)];
    writeRecording(score, hits, { trackIndex: index, startBar: 0 });
    expect(drumsOf(score.tracks[index]!).flat()).toEqual([3, 1, 0, 45]);
  });

  it("click mode still refuses a track that is not there", () => {
    expect(() =>
      writeRecording(createSong(), [note(0, 38)], { trackIndex: 9, startBar: 0 }),
    ).toThrow(/string, piano or drum/);
  });
});
