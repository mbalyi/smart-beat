import { importer, Settings } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import { writeGp7 } from "@/lib/export/gp7";
import { loadSong } from "@/lib/import";
import { listZip } from "@/lib/import/zip";
import { KEYBOARD_ENTRY } from "@/lib/score/keyboard-staves";
import { drumNumber, isStringed, type Score } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";

const keyboardOf = (score: Score) => score.tracks.find((t) => t.name === "Piano")!;
const firstNote = (score: Score, name: string) =>
  score.tracks.find((t) => t.name === name)!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;

describe("keyboard tracks in a Guitar Pro 7 file", () => {
  it("come back as a keyboard, not as a guitar tab staff", async () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    const before = firstNote(score, "Piano");
    const pitch = [before.octave, before.tone];
    expect(before.isStringed).toBe(false);

    const bytes = writeGp7(score);
    // alphaTab wrote the keyboard as guitar notes: nothing about the song itself changed.
    expect(firstNote(score, "Piano").isStringed).toBe(false);

    const again = (await loadSong(bytes, "song.gp")).score;
    const staff = keyboardOf(again).staves[0]!;
    expect(isStringed(staff)).toBe(false);
    expect(staff.tuning).toEqual([]);
    const note = firstNote(again, "Piano");
    expect([note.octave, note.tone]).toEqual(pitch);
    expect(Number.isNaN(note.string)).toBe(true);
    expect(Number.isNaN(note.fret)).toBe(true);
    expect(note.isPiano).toBe(true);
    // The guitar keeps its strings.
    expect(firstNote(again, "Guitar").isStringed).toBe(true);
  });

  it("show as keyboards in the summary of the opened file", async () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    const song = await loadSong(writeGp7(score), "song.gp");
    const piano = song.summary.tracks.find((t) => t.name === "Piano")!;
    expect([piano.kind, piano.tuning]).toEqual(["pitched", []]);
  });

  it("are listed in an entry Guitar Pro and alphaTab ignore", () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    const bytes = writeGp7(score);
    expect(listZip(bytes).map((e) => e.name)).toContain(KEYBOARD_ENTRY);
    // Still a file alphaTab reads on its own.
    const plain = importer.ScoreLoader.loadScoreFromBytes(bytes, new Settings());
    expect(plain.tracks.map((t) => t.name)).toEqual(score.tracks.map((t) => t.name));
  });

  it("add no entry to a song without one", () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    score.tracks = score.tracks.filter((t) => t.name !== "Piano");
    expect(listZip(writeGp7(score)).map((e) => e.name)).not.toContain(KEYBOARD_ENTRY);
  });

  it("and drums survive parseScore(writeGp7(song)) unchanged", () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    const all = (s: Score) =>
      s.tracks.map((t) =>
        t.staves[0]!.bars.flatMap((bar) =>
          bar.voices.flatMap((v) =>
            v.beats.map((b) =>
              b.notes.map((n) =>
                n.isPercussion
                  ? `drum ${drumNumber(n)}`
                  : n.isStringed
                    ? `${n.string}:${n.fret}`
                    : `${n.octave}/${n.tone}`,
              ),
            ),
          ),
        ),
      );
    const before = all(score);
    expect(all(parseScore(writeGp7(score)).score)).toEqual(before);
  });
});
