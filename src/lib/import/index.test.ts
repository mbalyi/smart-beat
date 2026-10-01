import { describe, expect, it } from "vitest";

import { exportScore } from "@/lib/export";
import { isMidiFile, isXmlFile, loadSong } from "@/lib/import";
import { ScoreLoadError } from "@/lib/score/errors";
import { texScore } from "@/test/playback";
import { makeZip } from "@/test/zip";
import { fixtureBytes } from "@/test/score";

const source = () =>
  texScore(
    String.raw`\title "Riff" \track "G" \staff {score tabs} \instrument 25 :4 3.6 5.6 7.6 5.6`,
  );

describe("loading songs", () => {
  it("tells MIDI and XML from Guitar Pro files", () => {
    expect(isMidiFile(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0]))).toBe(true);
    expect(isMidiFile(new Uint8Array([0x4d, 0x54]))).toBe(false);
    const xml = (text: string) => new TextEncoder().encode(text);
    expect(isXmlFile(xml("<?xml version='1.0'?><score-partwise/>"))).toBe(true);
    expect(isXmlFile(xml("  \n<score-partwise/>"))).toBe(true);
    expect(isXmlFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x61]))).toBe(true);
    expect(isXmlFile(xml("hello"))).toBe(false);
    expect(isXmlFile(new Uint8Array())).toBe(false);
  });

  it("opens Guitar Pro files as they are", async () => {
    const loaded = await loadSong(fixtureBytes("practice-song.gp"));
    expect(loaded.converted).toBe(false);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.summary.title).toBe("Practice Song");
  });

  it("opens MusicXML through alphaTab, as a converted song", async () => {
    const loaded = await loadSong(exportScore(source(), "musicxml").bytes);
    expect(loaded.converted).toBe(true);
    expect(loaded.summary.title).toBe("Riff");
    expect(loaded.summary.tracks[0]!.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(loaded.summary.tracks[0]!.kind).toBe("stringed");
    const fret = loaded.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
    expect([fret.string, fret.fret]).toEqual([1, 3]);
  });

  it("opens MIDI with warnings about what was converted", async () => {
    const loaded = await loadSong(exportScore(source(), "midi").bytes);
    expect(loaded.converted).toBe(true);
    expect(loaded.warnings.join(" ")).toMatch(/sixteenth notes/);
    expect(loaded.summary.tracks.length).toBeGreaterThan(0);
  });

  it("reports damaged files", async () => {
    await expect(loadSong(new Uint8Array([1, 2, 3]))).rejects.toThrow(ScoreLoadError);
    await expect(loadSong(new TextEncoder().encode("<html/>"))).rejects.toThrow(ScoreLoadError);
    await expect(loadSong(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0]))).rejects.toThrow(
      ScoreLoadError,
    );
  });

  it("opens alphaTex, as a converted song (saving asks for a new file)", async () => {
    const tex = new TextEncoder().encode(
      String.raw`\title "Tex" \tempo 100 \track "G" :4 0.6 2.6 3.6 0.6 |`,
    );

    const loaded = await loadSong(tex, "riff.atex");

    expect(loaded.summary.title).toBe("Tex");
    expect(loaded.converted).toBe(true);
    expect(loaded.warnings).toEqual([]);
  });

  it("opens text tab by its .txt name, with the warnings of the guess", async () => {
    const tab = new TextEncoder().encode(
      [
        "e|--0---3--|",
        "B|--1---0--|",
        "G|--0---0--|",
        "D|--2---0--|",
        "A|--3---2--|",
        "E|----------|",
      ].join("\n"),
    );

    const loaded = await loadSong(tab, "song.TXT");

    expect(loaded.summary.tracks).toHaveLength(1);
    expect(loaded.converted).toBe(true);
    expect(loaded.warnings.join(" ")).toMatch(/no rhythm/);
  });

  it("opens MuseScore files, plain or zipped", async () => {
    const mscx = fixtureBytes("practice-song.mscx");

    const plain = await loadSong(mscx, "practice.mscx");
    const zipped = await loadSong(
      makeZip([{ name: "practice.mscx", data: mscx, deflate: true }]),
      "practice.mscz",
    );

    expect(plain.summary.tracks.map((t) => t.name)).toEqual(["Guitar", "Piano"]);
    expect(zipped.summary.tracks.map((t) => t.name)).toEqual(["Guitar", "Piano"]);
    expect(plain.converted && zipped.converted).toBe(true);
  });

  it("does not take a text file for a song when it has no tab", async () => {
    await expect(loadSong(new TextEncoder().encode("shopping list"), "list.txt")).rejects.toThrow(
      ScoreLoadError,
    );
  });

  it("decides by the name only for text and MuseScore: other files by their content", async () => {
    // A Guitar Pro file called .txt would be read as text tab: the name decides for text.
    const gp = fixtureBytes("practice-song.gp");
    await expect(loadSong(gp, "renamed.txt")).rejects.toThrow(ScoreLoadError);
    expect((await loadSong(gp, "renamed.dat")).converted).toBe(false);
  });
});
