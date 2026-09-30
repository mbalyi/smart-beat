import {
  autoFirstFret,
  chordOf,
  diagramFromNotes,
  diagramPitches,
  recognizeChord,
  setChord,
} from "@/lib/score/chords";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { texScore } from "@/test/playback";

const names = (pitches: number[], preferFlats = false) =>
  recognizeChord(pitches, { preferFlats }).map((c) => c.name);

describe("recognizeChord", () => {
  it.each([
    [[48, 52, 55], "C"],
    [[57, 60, 64], "Am"],
    [[40, 47, 52], "E5"],
    [[43, 47, 50, 53], "G7"],
    [[48, 52, 55, 59], "Cmaj7"],
    [[45, 52, 55, 60], "Am7"],
    [[50, 55, 57], "Dsus4"],
    [[50, 52, 57], "Dsus2"],
    [[48, 52, 55, 57], "C6"],
    [[48, 50, 52, 55], "Cadd9"],
    [[47, 50, 53], "Bdim"],
    [[47, 50, 53, 57], "Bm7b5"],
    [[48, 52, 56], "Caug"],
    [[43, 47, 50, 53, 57], "G9"],
    [[45, 48, 52, 56], "Am(maj7)"],
  ])("names %j as %s", (pitches, name) => {
    expect(names(pitches)[0]).toBe(name);
  });

  it("writes inversions as slash chords", () => {
    expect(names([52, 55, 60])[0]).toBe("C/E");
    expect(recognizeChord([52, 55, 60])[0]!.spoken).toBe("C major over E");
  });

  it("prefers the bass as the root when notes fit several chords", () => {
    // C E G A: C6 over C, Am7 over A.
    expect(names([48, 52, 55, 57])[0]).toBe("C6");
    expect(names([45, 48, 52, 55])[0]).toBe("Am7");
    expect(names([45, 48, 52, 55])).toContain("C6/A");
  });

  it("accepts four-note chords without their fifth", () => {
    expect(names([43, 47, 53])[0]).toBe("G7");
  });

  it("spells roots with flats in flat keys", () => {
    expect(names([46, 50, 53], true)[0]).toBe("Bb");
    expect(names([46, 50, 53])[0]).toBe("A#");
    expect(recognizeChord([46, 50, 53], { preferFlats: true })[0]!.spoken).toBe("B flat major");
  });

  it("names nothing for single notes, octaves or unknown clusters", () => {
    expect(recognizeChord([])).toEqual([]);
    expect(recognizeChord([60, 72])).toEqual([]);
    expect(recognizeChord([60, 61, 62])).toEqual([]);
  });
});

describe("chord diagrams", () => {
  it("builds a diagram from tab notes, highest string first", () => {
    // Open C major: x 3 2 0 1 0 (alphaTab numbers strings from the lowest).
    const diagram = diagramFromNotes(
      [
        { string: 2, fret: 3 },
        { string: 3, fret: 2 },
        { string: 4, fret: 0 },
        { string: 5, fret: 1 },
        { string: 6, fret: 0 },
      ],
      6,
    );
    expect(diagram).toEqual({ strings: [0, 1, 0, 2, 3, -1], firstFret: 1 });
    expect(names(diagramPitches(diagram, STANDARD_GUITAR))[0]).toBe("C");
  });

  it("starts high-up diagrams at their lowest fret", () => {
    expect(autoFirstFret([5, 5, 6, 7, 7, 5])).toBe(5);
    expect(autoFirstFret([0, 1, 0, 2, 3, -1])).toBe(1);
    expect(autoFirstFret([-1, -1, -1, -1, -1, -1])).toBe(1);
  });

  it("adds the capo to the pitches", () => {
    const pitches = diagramPitches({ strings: [0, -1, -1, -1, -1, -1], firstFret: 1 }, [64], 2);
    expect(pitches).toEqual([66]);
  });
});

describe("setChord", () => {
  const song = () =>
    texScore(String.raw`\track "G" \staff {tabs} :4 0.6 0.6 0.6 0.6 | 0.6 0.6 0.6 0.6`);
  const beats = (score: ReturnType<typeof song>) =>
    score.tracks[0]!.staves[0]!.bars.flatMap((bar) => bar.voices[0]!.beats);

  it("writes a chord with a diagram on a beat and reads it back", () => {
    const score = song();
    const beat = beats(score)[0]!;
    const spec = {
      name: "Em",
      diagram: { strings: [0, 0, 0, 2, 2, 0], firstFret: 1 },
      showDiagram: true,
    };
    setChord(beat, spec);
    expect(chordOf(beat)).toEqual(spec);
    expect(beat.chord!.showName).toBe(true);
  });

  it("shares one chord between beats with the same chord and drops unused ones", () => {
    const score = song();
    const staff = score.tracks[0]!.staves[0]!;
    const [first, second] = beats(score);
    const spec = { name: "Am", diagram: null, showDiagram: false };
    setChord(first!, spec);
    setChord(second!, spec);
    expect(staff.chords!.size).toBe(1);
    expect(first!.chordId).toBe(second!.chordId);

    setChord(first!, { ...spec, name: "C" });
    expect(staff.chords!.size).toBe(2);
    setChord(second!, null);
    expect(staff.chords!.size).toBe(1);
    expect(chordOf(second!)).toBeNull();
    expect(chordOf(first!)!.name).toBe("C");
  });

  it("never changes a chord object other beats may share", () => {
    const score = song();
    const [first, second] = beats(score);
    setChord(first!, { name: "D", diagram: null, showDiagram: false });
    const original = first!.chord!;
    setChord(second!, { name: "D", diagram: null, showDiagram: false });
    setChord(second!, { name: "D7", diagram: null, showDiagram: false });
    expect(original.name).toBe("D");
    expect(first!.chord).toBe(original);
  });
});
