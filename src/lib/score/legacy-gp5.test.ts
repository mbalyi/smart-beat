import { writeGp5 } from "@/lib/export/gp/writer";
import { applyDrumLines, collectDrumLines, drumLine } from "@/lib/score/drum-lines";
import { placeDrums } from "@/lib/score/drum-tab";
import { encodeText, sourceEncoding } from "@/lib/score/encoding";
import { parseScore } from "@/lib/score/score";
import { BAR2_LINES, linesOf } from "@/test/legacy-fixtures";
import { fixtureBytes } from "@/test/score";

describe("Guitar Pro 5 text encoding (#53)", () => {
  it("reads Central European names from a Windows-1250 file", () => {
    const { score, summary, encoding } = parseScore(fixtureBytes("accented-names.gp5"));
    expect(encoding).toBe("windows-1250");
    expect(summary.title).toBe("Őszi dal");
    expect(summary.artist).toBe("Kovács Erzsébet");
    expect(summary.tracks.map((t) => t.name)).toEqual(["Szóló 1", "Ütős hangszer"]);
    expect(sourceEncoding(score)).toBe("windows-1250");
  });

  it("reads the file the user's way when they pick an encoding", () => {
    const { summary } = parseScore(fixtureBytes("accented-names.gp5"), "windows-1252");
    expect(summary.tracks[1]!.name).toBe("Ütõs hangszer");
  });

  it("saves the names back in the encoding they were read with", () => {
    const { score } = parseScore(fixtureBytes("accented-names.gp5"));
    const written = writeGp5(score);
    expect(written.warnings, written.warnings.join()).toEqual([]);
    const again = parseScore(written.bytes);
    expect(again.summary.tracks.map((t) => t.name)).toEqual(["Szóló 1", "Ütős hangszer"]);
    // The name is stored as Windows-1250 bytes, not UTF-8.
    const needle = encodeText("Ütős", "windows-1250").bytes;
    const haystack = Array.from(written.bytes).join(",");
    expect(haystack).toContain(Array.from(needle).join(","));
  });

  it("warns when a character fits no code page", () => {
    const { score } = parseScore(fixtureBytes("accented-names.gp5"));
    score.tracks[0]!.name = "Szóló ♪";
    expect(writeGp5(score).warnings.join(" ")).toMatch(/1 character could not be saved/);
  });
});

describe("drum notes on chosen strings (#53)", () => {
  const bar2 = (score: ReturnType<typeof parseScore>["score"]) =>
    score.tracks[0]!.staves[0]!.bars[1]!.voices[0]!.beats[0]!;

  it("keeps the strings drum notes were written on in a GP5 file", () => {
    const { score } = parseScore(fixtureBytes("drum-lines.gp5"));
    expect(linesOf(bar2(score), drumLine)).toEqual(BAR2_LINES);
    // The drum tab shows them there.
    const placed = placeDrums(bar2(score).notes);
    expect(linesOf(bar2(score), (n) => placed.get(n) ?? null)).toEqual(BAR2_LINES);
  });

  it("saves the placement back to GP5", () => {
    const { score } = parseScore(fixtureBytes("drum-lines.gp5"));
    const again = parseScore(writeGp5(score).bytes).score;
    expect(linesOf(bar2(again), drumLine)).toEqual(BAR2_LINES);
  });

  it("keeps it in the song's settings for Guitar Pro 7+ files", () => {
    const { score } = parseScore(fixtureBytes("drum-lines.gp5"));
    const lines = collectDrumLines(score);
    expect(lines).toContainEqual({
      track: 0,
      bar: 1,
      voice: 0,
      beat: 0,
      note: expect.any(Number),
      line: 5,
    });
    const fresh = parseScore(fixtureBytes("drum-lines.gp5")).score;
    for (const note of bar2(fresh).notes) note.fret = -1;
    applyDrumLines(fresh, lines);
    expect(linesOf(bar2(fresh), drumLine)).toEqual(BAR2_LINES);
  });

  it("puts hits without a chosen line on their usual line", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const drums = score.tracks[2]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect([...placeDrums(drums.notes).values()].sort()).toEqual([2, 6]); // kick, hi-hat
  });
});
