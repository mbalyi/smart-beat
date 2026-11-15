import { describe, expect, it } from "vitest";

import { writeMusicXml } from "@/lib/export/musicxml";
import { drumLine, drumLineAtY, setDrumLine, tabLineAtY } from "@/lib/score/drum-lines";
import { notesOf } from "@/lib/score/instrument-view";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";

describe("drumLineAtY (#228)", () => {
  // Six lines from y = 100 (top line, 6) to y = 150 (bottom line, 1): 10 px apart.
  const bar = { y: 100, h: 50 };

  it("finds the line nearest to a click, top line first", () => {
    expect(drumLineAtY(bar, 100)).toBe(6);
    expect(drumLineAtY(bar, 104)).toBe(6);
    expect(drumLineAtY(bar, 126)).toBe(3);
    expect(drumLineAtY(bar, 150)).toBe(1);
  });

  it("takes a click just above or below the staff as the outer line", () => {
    expect(drumLineAtY(bar, 96)).toBe(6);
    expect(drumLineAtY(bar, 154)).toBe(1);
  });

  it("is null for a click well away from the drum tab", () => {
    expect(drumLineAtY(bar, 80)).toBeNull();
    expect(drumLineAtY(bar, 170)).toBeNull();
  });
});

describe("tabLineAtY (#228)", () => {
  // Four lines (a bass) from y = 100 (top line, 4) to y = 130 (bottom line, 1): 10 px apart.
  const bar = { y: 100, h: 30 };

  it("finds the line nearest to a click on a tab of any number of lines", () => {
    expect(tabLineAtY(bar, 100, 4)).toBe(4);
    expect(tabLineAtY(bar, 116, 4)).toBe(2);
    expect(tabLineAtY(bar, 130, 4)).toBe(1);
    expect(tabLineAtY({ y: 100, h: 70 }, 150, 8)).toBe(3);
  });

  it("is null away from the staff, and for a tab without a staff to click", () => {
    expect(tabLineAtY(bar, 90, 4)).toBeNull();
    expect(tabLineAtY(bar, 140, 4)).toBeNull();
    expect(tabLineAtY(bar, 100, 1)).toBeNull();
  });
});

describe("drum notes on a line, with alphaTab 1.9's no value (NaN)", () => {
  const drums = () => parseScore(fixtureBytes("drum-lines.gp5")).score.tracks[0]!;
  const firstBeat = () => drums().staves[0]!.bars[1]!.voices[0]!.beats[0]!;

  it("never counts a drum note as a guitar note, with or without a line", () => {
    for (const note of firstBeat().notes) {
      expect(drumLine(note)).not.toBeNull();
      // alphaTab says "stringed" for a note with a string and a fret: the line is in the fret.
      expect(note.isStringed).toBe(false);
      setDrumLine(note, null);
      expect(note.isStringed).toBe(false);
    }
    expect(notesOf([firstBeat()]).map((n) => [n.string, n.fret])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("has no <string> or <fret> for a drum in MusicXML", () => {
    const score = parseScore(fixtureBytes("drum-lines.gp5")).score;
    const xml = writeMusicXml(score);
    expect(xml).toContain("<instrument");
    expect(xml).not.toMatch(/<fret>/);
  });

  it("takes the line away with the no value, so the drum goes back to its usual line", () => {
    const note = firstBeat().notes[0]!;
    expect(drumLine(note)).not.toBeNull();
    setDrumLine(note, null);
    expect(drumLine(note)).toBeNull();
    expect(Number.isNaN(note.fret)).toBe(true);
    setDrumLine(note, 9);
    expect(Number.isNaN(note.fret)).toBe(true);
  });
});
