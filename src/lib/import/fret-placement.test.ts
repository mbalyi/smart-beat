import { describe, expect, it } from "vitest";

import { placeFrets, type PlacementGroup } from "@/lib/import/fret-placement";
import { STANDARD_GUITAR } from "@/lib/score/music";

const single = (pitches: number[]): PlacementGroup[] => pitches.map((p) => ({ pitches: [p] }));

/** The pitch a placed note sounds, from the tuning (highest string first). */
const sounds = (tuning: readonly number[], string: number, fret: number, capo = 0) =>
  tuning[tuning.length - string]! + capo + fret;

describe("placeFrets", () => {
  it("keeps a C major scale run in one position", () => {
    // C3 to C5, up and down.
    const up = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72];
    const placed = placeFrets(STANDARD_GUITAR, single([...up, ...up.slice(0, -1).reverse()]));
    for (let i = 1; i < placed.length; i++) {
      const a = placed[i - 1]!.notes[0]!;
      const b = placed[i]!.notes[0]!;
      if (a.fret > 0 && b.fret > 0) expect(Math.abs(a.fret - b.fret)).toBeLessThanOrEqual(4);
    }
    for (const g of placed) {
      for (const n of g.notes) expect(sounds(STANDARD_GUITAR, n.string, n.fret)).toBe(n.pitch);
    }
  });

  it("plays an open E major chord in the open shape", () => {
    const [group] = placeFrets(STANDARD_GUITAR, [{ pitches: [40, 47, 52, 56, 59, 64] }]);
    const byString = Object.fromEntries(group!.notes.map((n) => [n.string, n.fret]));
    expect(byString).toEqual({ 1: 0, 2: 2, 3: 2, 4: 1, 5: 0, 6: 0 });
  });

  it("handles an octave jump", () => {
    const placed = placeFrets(STANDARD_GUITAR, single([52, 76, 52]));
    expect(placed.map((g) => g.notes.length)).toEqual([1, 1, 1]);
    for (const g of placed) {
      const n = g.notes[0]!;
      expect(sounds(STANDARD_GUITAR, n.string, n.fret)).toBe(n.pitch);
    }
    expect(placed[1]!.notes[0]!.fret).toBeLessThanOrEqual(17);
  });

  it("moves or drops notes below the tuning and reports them", () => {
    // D2 is two semitones below the low E: one octave up fits (D3).
    const [shifted] = placeFrets(STANDARD_GUITAR, [{ pitches: [38] }]);
    expect(shifted!.shifted).toEqual([38]);
    expect(shifted!.dropped).toEqual([]);
    expect(shifted!.notes[0]!.pitch).toBe(50);
    // With no frets to use, no octave move helps either.
    const [lost] = placeFrets(STANDARD_GUITAR, [{ pitches: [30] }], { maxFret: 0 });
    expect(lost!.notes).toEqual([]);
    expect(lost!.dropped).toEqual([30]);
  });

  it("uses the low B of a seven string guitar", () => {
    const seven = [...STANDARD_GUITAR, 35];
    const [group] = placeFrets(seven, [{ pitches: [35] }]);
    expect(group!.notes).toEqual([{ pitch: 35, string: 1, fret: 0 }]);
    expect(group!.shifted).toEqual([]);
  });

  it("keeps chords within the hand span", () => {
    const chords = [
      [43, 47, 50, 55, 59, 67],
      [45, 52, 57, 61, 64],
      [41, 48, 53, 57, 60, 65],
    ];
    for (const group of placeFrets(
      STANDARD_GUITAR,
      chords.map((pitches) => ({ pitches })),
    )) {
      const fretted = group.notes.map((n) => n.fret).filter((f) => f > 0);
      expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(4);
      expect(new Set(group.notes.map((n) => n.string)).size).toBe(group.notes.length);
    }
  });

  it("drops the fewest notes when a chord has more notes than strings", () => {
    const [group] = placeFrets(STANDARD_GUITAR, [{ pitches: [40, 47, 52, 56, 59, 64, 71] }]);
    expect(group!.notes.length + group!.dropped.length).toBe(7);
    expect(group!.dropped.length).toBe(1);
  });

  it("counts frets from the capo", () => {
    const [group] = placeFrets(STANDARD_GUITAR, [{ pitches: [42] }], { capo: 2 });
    // Capo on 2: the low E sounds F#2, which is fret 0.
    expect(group!.notes).toEqual([{ pitch: 42, string: 1, fret: 0 }]);
    const [below] = placeFrets(STANDARD_GUITAR, [{ pitches: [41] }], { capo: 2 });
    expect(below!.shifted).toEqual([41]);
  });

  it("is fast on long takes", () => {
    const groups: PlacementGroup[] = [];
    for (let i = 0; i < 20_000; i++) {
      groups.push({
        pitches: i % 5 === 0 ? [40 + (i % 7), 52, 59 + (i % 3)] : [45 + ((i * 7) % 30)],
      });
    }
    const started = performance.now();
    const placed = placeFrets(STANDARD_GUITAR, groups);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(placed).toHaveLength(20_000);
  });
});
