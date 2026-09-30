import { model } from "@coderline/alphatab";

import {
  adoptLyrics,
  hasLyrics,
  lyricsFromBeats,
  lyricsOf,
  MAX_LYRIC_LINES,
  reflowLyrics,
  setLyrics,
  storedLyrics,
  syllableCount,
  syllablesAround,
} from "@/lib/score/lyrics";
import { refinish, type Track } from "@/lib/score/model";
import { texScore } from "@/test/playback";

/** Two bars of four quarter notes, a rest on beat 2 of bar 1. */
const song = () =>
  texScore(
    String.raw`\track "G" \staff {tabs} :4 0.6 r 0.6 0.6 | 1.6 1.6 1.6 1.6 | 2.6 2.6 2.6 2.6`,
  );

/** Syllables of line `line` per beat of voice 1 ("·" for none). */
const sung = (track: Track, line = 0) =>
  track.staves[0]!.bars.map((bar) =>
    bar.voices[0]!.beats.map((beat) => beat.lyrics?.[line] || "·").join(" "),
  );

describe("lyrics", () => {
  it("puts syllables on the notes, skipping rests", () => {
    const score = song();
    const track = score.tracks[0]!;
    setLyrics(track, [{ startBar: 0, text: "Hel-lo my dear+friend  la" }]);
    refinish(score);
    expect(sung(track)).toEqual(["Hel- · lo my", "dear friend · la ·", "· · · ·"]);
    expect(hasLyrics(track)).toBe(true);
  });

  it("starts each line at its bar", () => {
    const score = song();
    const track = score.tracks[0]!;
    setLyrics(track, [
      { startBar: 0, text: "one two" },
      { startBar: 2, text: "three four" },
    ]);
    refinish(score);
    expect(sung(track, 1)).toEqual(["· · · ·", "· · · ·", "three four · ·"]);
  });

  it("flows the syllables again when notes change", () => {
    const score = song();
    const track = score.tracks[0]!;
    setLyrics(track, [{ startBar: 0, text: "a b c d" }]);
    refinish(score);
    expect(sung(track)[0]).toBe("a · b c");

    // Beat 2 becomes a note: the syllables move along.
    const rest = track.staves[0]!.bars[0]!.voices[0]!.beats[1]!;
    const note = new model.Note();
    note.string = 6;
    note.fret = 3;
    rest.addNote(note);
    refinish(score);
    expect(sung(track)[0]).toBe("a b c d");
  });

  it("keeps at most five lines and drops empty ones at the end", () => {
    const score = song();
    const track = score.tracks[0]!;
    const lines = Array.from({ length: 7 }, (_, i) => ({ startBar: 0, text: `line${i}` }));
    setLyrics(track, lines);
    expect(storedLyrics(track)).toHaveLength(MAX_LYRIC_LINES);
    setLyrics(track, [
      { startBar: 1.7, text: "x" },
      { startBar: 0, text: "  " },
    ]);
    expect(storedLyrics(track)).toEqual([{ startBar: 1, text: "x" }]);
    setLyrics(track, []);
    refinish(score);
    expect(hasLyrics(track)).toBe(false);
    expect(sung(track)[0]).toBe("· · · ·");
  });

  it("counts syllables as they will be placed", () => {
    expect(syllableCount("Hel-lo world")).toBe(3);
    expect(syllableCount("of+the [comment] end")).toBe(3);
    expect(syllableCount("")).toBe(0);
  });

  it("reads a file's lyrics back as lines that place the same way", () => {
    // Like the Guitar Pro importer: lines placed by alphaTab, nothing stored.
    const score = song();
    const track = score.tracks[0]!;
    const line = (startBar: number, text: string) =>
      Object.assign(new model.Lyrics(), { startBar, text });
    track.applyLyrics([line(0, "Hel-lo my dear+friend  la"), line(2, "end")]);
    const placed = [sung(track, 0), sung(track, 1)];

    expect(lyricsFromBeats(track)).toEqual([
      { startBar: 0, text: "Hel-lo my dear+friend  la" },
      { startBar: 2, text: "end" },
    ]);
    // Taken over, and placed again: the same syllables on the same notes.
    delete (track as unknown as Record<string, unknown>).smartBeatLyrics;
    adoptLyrics(track);
    reflowLyrics(track);
    expect([sung(track, 0), sung(track, 1)]).toEqual(placed);
    expect(lyricsOf(track)).toEqual(storedLyrics(track));
  });

  it("marks tracks without lyrics explicitly, and adopts only once", () => {
    const score = song();
    const track = score.tracks[0]!;
    expect(storedLyrics(track)).toBeNull();
    expect("smartBeatLyrics" in track).toBe(true);
    setLyrics(track, [{ startBar: 0, text: "kept" }]);
    adoptLyrics(track);
    expect(storedLyrics(track)).toEqual([{ startBar: 0, text: "kept" }]);
  });

  it("gives the syllables around a beat, for the lyrics strip", () => {
    const score = song();
    const track = score.tracks[0]!;
    setLyrics(track, [
      { startBar: 0, text: "Hel-lo my dear friend la la la" },
      { startBar: 1, text: "second" },
    ]);
    refinish(score);
    const beat = track.staves[0]!.bars[0]!.voices[0]!.beats[2]!;
    const lines = syllablesAround(track, beat);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map((s) => s.text)).toEqual(["Hel", "lo", "my", "dear", "friend", "la", "la"]);
    expect(lines[0]![0]!.joined).toBe(true);
    expect(lines[0]![1]!.beat).toBe(beat);
    expect(lines[1]!.map((s) => s.text)).toEqual(["second"]);
  });
});
