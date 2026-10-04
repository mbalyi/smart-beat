import { DRUM_MIDI_MAP } from "@/lib/score/drum-map";
import {
  describeInstrument,
  drumKitOf,
  drumPads,
  fretboardStrings,
  fretPositions,
  instrumentViewName,
  isBlackKey,
  keyboardRange,
  notesOf,
} from "@/lib/score/instrument-view";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes, SUMMARY } from "@/test/score";

const load = () => parseScore(fixtureBytes("practice-song.gp")).score;

describe("fretboard", () => {
  it("lists strings from the highest, as in tab", () => {
    expect(fretboardStrings([64, 59, 55, 50, 45, 40])).toEqual([
      { string: 6, number: 1, open: 64, label: "E" },
      { string: 5, number: 2, open: 59, label: "B" },
      { string: 4, number: 3, open: 55, label: "G" },
      { string: 3, number: 4, open: 50, label: "D" },
      { string: 2, number: 5, open: 45, label: "A" },
      { string: 1, number: 6, open: 40, label: "E" },
    ]);
  });

  it("places notes from the nut, counting the capo", () => {
    const notes = [
      { string: 1, fret: 0, pitch: 42, tied: false },
      { string: 3, fret: 5, pitch: 57, tied: false },
      { string: null, fret: null, pitch: 60, tied: false },
    ];
    expect(fretPositions(notes, 2)).toEqual([
      { string: 1, fret: 2 },
      { string: 3, fret: 7 },
    ]);
  });

  it("reads the notes of beats being played", () => {
    const score = load();
    const guitar = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[1]!;
    const drums = score.tracks[2]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;

    expect(notesOf([guitar])).toEqual([{ string: 1, fret: 2, pitch: 42, tied: false }]);
    // The fixture's drums use their own articulations: the pads show General MIDI keys.
    expect(
      notesOf([drums])
        .map((n) => n.pitch)
        .sort(),
    ).toEqual([35, 42]);
  });
});

describe("keyboard", () => {
  it("knows the black keys", () => {
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlackKey)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ]);
  });

  it("shows C3–C6, widened to fit the notes", () => {
    expect(keyboardRange([])).toEqual({ low: 48, high: 84 });
    expect(keyboardRange([40, 90])).toEqual({ low: 36, high: 96 });
    expect(keyboardRange([10, 120])).toEqual({ low: 21, high: 108 });
  });
});

describe("drums", () => {
  it("offers every articulation once, plus any other sound in use (#53)", () => {
    const groups = drumPads();
    expect(groups.map((g) => g.label)).toEqual(["Drum kit", "Percussion"]);
    const ids = groups.flatMap((g) => g.pads.map((p) => p.id));
    expect(new Set(ids).size).toBe(ids.length); // no duplicate keys
    expect(ids.sort((a, b) => a - b)).toEqual(Object.keys(DRUM_MIDI_MAP).map(Number));
    expect(groups[0]!.pads).toHaveLength(24);
    expect(drumPads([38, 130, 130]).at(-1)).toEqual({
      label: "Other sounds in this track",
      pads: [{ id: 130, name: "Drum sound 130" }],
    });
  });

  it("maps drum sounds to the staff", () => {
    const standard = drumKitOf(null);
    expect(standard[0]).toEqual({ name: "Kick drum", midi: 36, staffLine: 7, notehead: "Normal" });

    const own = drumKitOf(load().tracks[2]!);
    expect(own.map((row) => row.midi).sort()).toEqual([35, 38, 42]);
    expect(own.find((row) => row.midi === 42)?.notehead).toBe("X black");
  });
});

describe("names", () => {
  it("names the instrument view for each kind of track", () => {
    expect(instrumentViewName("stringed")).toBe("Fretboard");
    expect(instrumentViewName("pitched")).toBe("Keyboard");
    expect(instrumentViewName("drums")).toBe("Drum pads");
  });

  it("describes a track's instrument", () => {
    const [guitar, bass, drums, piano] = SUMMARY.tracks;
    expect(describeInstrument(guitar!)).toBe("Overdriven Guitar · Guitar Standard Tuning");
    expect(describeInstrument({ ...bass!, capo: 2 })).toBe(
      "Electric Bass (finger) · Bass Standard Tuning · Capo 2",
    );
    expect(describeInstrument(drums!)).toBe("Drums");
    expect(describeInstrument(piano!)).toBe("Acoustic Grand Piano");
    expect(describeInstrument({ ...guitar!, tuning: [64, 59, 55, 50, 45, 39] })).toBe(
      "Overdriven Guitar · 6 strings: E B G D A D#",
    );
  });
});
