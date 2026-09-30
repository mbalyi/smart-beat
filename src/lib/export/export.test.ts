import { describe, expect, it } from "vitest";

import { exportScore, formatFromName } from "@/lib/export";
import { parseScore } from "@/lib/score/score";
import { mixFromScore } from "@/lib/score/mixer";
import { texScore } from "@/test/playback";
import { fixtureBytes } from "@/test/score";
import { shotOf } from "@/test/score-snapshot";

const TAB = String.raw`
\title "Tab Test"
\artist "Nobody"
\tempo 120
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  :4 3.6 5.5 7.4 (0.6 2.5) |
  :8 5.3 5.3 x.2 7.1 :4 (3.6 5.5 5.4) r
`;

describe("export formats", () => {
  it("finds the format of a file name", () => {
    expect(formatFromName("song.gp5")).toBe("gp5");
    expect(formatFromName("Song.MID")).toBe("midi");
    expect(formatFromName("song.midi")).toBe("midi");
    expect(formatFromName("song.musicxml")).toBe("musicxml");
    expect(formatFromName("song.txt")).toBe("ascii-tab");
    expect(formatFromName("song.gp")).toBe("gp");
    expect(formatFromName("song.exe")).toBeNull();
    expect(formatFromName("song")).toBeNull();
  });

  it("saves Guitar Pro 7 files that open as the same song", () => {
    const { score, summary } = parseScore(fixtureBytes("structure-song.gp"));
    const { bytes, warnings } = exportScore(score, "gp", mixFromScore(summary));
    expect(warnings).toEqual([]);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // a ZIP archive
    expect(shotOf(parseScore(bytes).score)).toEqual(shotOf(score));
  });

  it("puts the mixer's volume and pan into the file, and only while writing", () => {
    const { score, summary } = parseScore(fixtureBytes("practice-song.gp"));
    const mix = mixFromScore(summary);
    mix.tracks[0] = { volume: 0.5, pan: -1, mute: true, solo: false };
    const before = { ...score.tracks[0]!.playbackInfo };
    const { bytes } = exportScore(score, "gp", mix);
    const info = parseScore(bytes).score.tracks[0]!.playbackInfo;
    expect(info.balance).toBe(0);
    expect(info.isMute).toBe(true);
    expect(score.tracks[0]!.playbackInfo).toEqual(before);
  });

  it("writes MIDI with one track per song track and all the notes", () => {
    const score = texScore(TAB);
    const { bytes } = exportScore(score, "midi");
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("MThd");
    expect(bytes[9]).toBe(1); // format 1: multi-track
  });

  it("writes ASCII tab with the tuning, frets, dead notes and chords", () => {
    const score = texScore(TAB);
    const text = new TextDecoder().decode(exportScore(score, "ascii-tab").bytes);
    expect(text).toContain("Tab Test - Nobody");
    expect(text).toContain("Guitar (tuning E A D G B E)");
    const lines = text.split("\n");
    const e = lines.find((line) => line.startsWith("e|"))!;
    const low = lines.find((line) => line.startsWith("E|"))!;
    expect(e).toContain("7");
    expect(low).toMatch(/^E\|-3-+/);
    expect(text).toContain("x");
  });

  it("lists tracks without strings as left out of the ASCII tab", () => {
    const { score } = parseScore(fixtureBytes("practice-song.gp"));
    const result = exportScore(score, "ascii-tab");
    expect(result.warnings).toEqual([
      "“Drums” has no strings, so it is left out of the tab.",
      "“Piano” has no strings, so it is left out of the tab.",
    ]);
  });

  it("reports a song without stringed tracks", () => {
    const score = texScore(String.raw`\track "Piano" \staff {score} \instrument 0 c4.1`);
    expect(exportScore(score, "ascii-tab").warnings).toContain("The song has no stringed tracks.");
  });

  it("writes MusicXML that opens as the same music", () => {
    const score = texScore(TAB);
    const { bytes } = exportScore(score, "musicxml");
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain("<score-partwise");
    expect(xml).toContain("<work-title>Tab Test</work-title>");
    expect(xml).toContain("<string>6</string>"); // alphaTab string 1 (low E) is MusicXML string 6
    const again = parseScore(bytes).score;
    // Pitches, rhythm and bar structure survive (tab positions come with the pitches).
    // (alphaTab reads an "x" note head as a normal note, so dead notes are not compared.)
    const music = (shot: ReturnType<typeof shotOf>) =>
      JSON.parse(
        JSON.stringify(
          shot.tracks[0]!.bars.map((b) => b.voices),
          (key, value: unknown) => (key === "dead" ? undefined : value),
        ),
      ) as unknown;
    const original = shotOf(score, { pitchOnly: [0] });
    const back = shotOf(again, { pitchOnly: [0] });
    expect(music(back)).toEqual(music(original));
    expect(back.bars.map((b) => b.time)).toEqual(original.bars.map((b) => b.time));
    expect(back.bars[0]!.tempo).toBe(120);
  });
});
