import { describe, expect, it } from "vitest";

import { exportScore } from "@/lib/export";
import { loadSong } from "@/lib/import";
import { importMidi } from "@/lib/import/midi";
import { ScoreLoadError } from "@/lib/score/errors";
import type { Score } from "@/lib/score/model";
import { durationTicks } from "@/lib/score/music";
import { tempoAt } from "@/lib/score/structure";
import { texScore } from "@/test/playback";
import { shotOf } from "@/test/score-snapshot";

/** Builds a Standard MIDI file: one track of (delta, bytes) events. */
function smf(events: [number, number[]][], { division = 480, format = 0, tracks = 1 } = {}) {
  const vlq = (value: number) => {
    const out = [value & 0x7f];
    while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
    return out;
  };
  const body = events.flatMap(([delta, bytes]) => [...vlq(delta), ...bytes]);
  body.push(0, 0xff, 0x2f, 0);
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return new Uint8Array([
    ...[0x4d, 0x54, 0x68, 0x64],
    ...u32(6),
    0,
    format,
    0,
    tracks,
    division >> 8,
    division & 255,
    ...[0x4d, 0x54, 0x72, 0x6b],
    ...u32(body.length),
    ...body,
  ]);
}

const name = (text: string): [number, number[]] => [
  0,
  [0xff, 0x03, text.length, ...[...text].map((c) => c.charCodeAt(0))],
];
const tempo = (bpm: number): [number, number[]] => {
  const micros = Math.round(60_000_000 / bpm);
  return [0, [0xff, 0x51, 3, (micros >> 16) & 255, (micros >> 8) & 255, micros & 255]];
};
const timeSignature = (n: number, d: number): [number, number[]] => [
  0,
  [0xff, 0x58, 4, n, Math.log2(d), 24, 8],
];
const on = (delta: number, pitch: number, channel = 0): [number, number[]] => [
  delta,
  [0x90 | channel, pitch, 90],
];
const off = (delta: number, pitch: number, channel = 0): [number, number[]] => [
  delta,
  [0x80 | channel, pitch, 0],
];

/**
 * A recording-like file: the header says 120 BPM but the music is played at `bpm`, with
 * a little timing jitter and `lead` sixteenths of silence. Each bar (16 sixteenths): a
 * kick on 1 and 3, a snare on 2 and 4, eighth-note hi-hats, and a guitar power chord
 * on sixteenths 0, 3, 6 and 10.
 */
function recording(bpm: number, bars: number, lead: number) {
  const sixteenth = (480 * 120) / bpm / 4;
  let seed = 7;
  const jitter = () => {
    seed = (seed * 16807) % 2147483647;
    return Math.round(((seed % 1000) / 1000 - 0.5) * 16); // ±8 ticks
  };
  const hits: [number, number, number][] = []; // [tick, pitch, channel]
  for (let bar = 0; bar < bars; bar++) {
    for (let step = 0; step < 16; step++) {
      const at = (lead + bar * 16 + step) * sixteenth;
      const drums: number[] = [];
      if (step % 8 === 0) drums.push(36);
      if (step % 8 === 4) drums.push(38);
      if (step % 2 === 0) drums.push(42);
      for (const pitch of drums) hits.push([Math.round(at + jitter()), pitch, 9]);
      if ([0, 3, 6, 10].includes(step)) {
        const tick = Math.round(at + jitter());
        hits.push([tick, 40, 0], [tick + 2, 47, 0]);
      }
    }
  }
  const events: [number, number[]][] = [];
  for (const [tick, pitch, channel] of hits) {
    events.push([tick, [0x90 | channel, pitch, 100]]);
    events.push([tick + Math.round(sixteenth * 0.8), [0x80 | channel, pitch, 0]]);
  }
  events.sort((a, b) => a[0] - b[0]);
  let last = 0;
  return smf([
    tempo(120),
    [0, [0xc0, 30]], // distortion guitar
    ...events.map(([tick, bytes]): [number, number[]] => {
      const delta = tick - last;
      last = tick;
      return [delta, bytes];
    }),
  ]);
}

/** The sixteenths of a bar that have notes, as a pattern like "x..x..x...x.....". */
function pattern(score: Score, track: number, bar: number) {
  const cells = Array<string>(16).fill(".");
  let position = 0;
  for (const beat of score.tracks[track]!.staves[0]!.bars[bar]!.voices[0]!.beats) {
    if (beat.notes.length > 0) cells[position / 240] = "x";
    position += durationTicks(beat.duration, beat.dots);
  }
  return cells.join("");
}

describe("MIDI import", () => {
  it("reads the tempo, time signature, name and sound of a file", () => {
    const { score } = importMidi(
      smf([
        name("Lead"),
        tempo(90),
        timeSignature(3, 4),
        [0, [0xc0, 25]], // steel guitar
        on(0, 64),
        off(480, 64),
        on(0, 62),
        off(480, 62),
        on(0, 60),
        off(480, 60),
        on(0, 67),
        off(480, 67),
      ]),
    );
    expect(score.tracks).toHaveLength(1);
    const track = score.tracks[0]!;
    expect(track.name).toBe("Lead");
    expect(track.playbackInfo.program).toBe(25);
    // A guitar sound becomes tablature in standard tuning.
    expect(track.staves[0]!.stringTuning.tunings).toEqual([64, 59, 55, 50, 45, 40]);
    expect(
      score.masterBars.map((m) => `${m.timeSignatureNumerator}/${m.timeSignatureDenominator}`),
    ).toEqual(["3/4", "3/4"]);
    expect(tempoAt(score, 0)).toBe(90);
    const shot = shotOf(score, { pitchOnly: [0] });
    const beats = shot.tracks[0]!.bars.flatMap((bar) => bar.voices[0] ?? []);
    expect(beats.filter((b) => !b.rest).map((b) => b.notes[0]!.at)).toEqual([
      "64",
      "62",
      "60",
      "67",
    ]);
    expect(beats[0]).toMatchObject({ duration: 4, dots: 0 });
  });

  it("reads running status and note-on with velocity 0 as note-off", () => {
    const { score } = importMidi(
      smf([
        [0, [0x90, 60, 80]],
        [240, [60, 0]], // running status: a note-on with velocity 0
        [0, [62, 80]], // running status: a note-on
        [240, [62, 0]],
      ]),
    );
    const shot = shotOf(score, { pitchOnly: [0] });
    const notes = shot.tracks[0]!.bars[0]!.voices[0]!.filter((b) => !b.rest);
    expect(notes.map((b) => [b.notes[0]!.at, b.duration])).toEqual([
      ["60", 8],
      ["62", 8],
    ]);
  });

  it("puts channel 10 on a drum track and each channel on its own track", () => {
    const { score } = importMidi(
      smf([
        [0, [0xc1, 33]], // bass on channel 2
        on(0, 36, 9),
        on(0, 40, 1),
        off(480, 36, 9),
        off(0, 40, 1),
      ]),
    );
    expect(score.tracks.map((t) => [t.isPercussion, t.playbackInfo.program])).toEqual([
      [true, 0],
      [false, 33],
    ]);
    expect(score.tracks[1]!.staves[0]!.stringTuning.tunings).toEqual([43, 38, 33, 28]);
    const drum = shotOf(score).tracks[0]!.bars[0]!.voices[0]![0]!;
    expect(drum.notes[0]!.at).toBe("drum:36");
  });

  it("uses a staff, not tablature, for other sounds", () => {
    const { score } = importMidi(smf([on(0, 72), off(480, 72)]));
    expect(score.tracks[0]!.staves[0]!.stringTuning.tunings).toEqual([]);
    expect(shotOf(score).tracks[0]!.bars[0]!.voices[0]![0]!.notes[0]!.at).toBe("72");
  });

  it("puts a note played just before a bar line on the next bar's first beat", () => {
    // Regression (#55): it stayed in the earlier bar, squeezed onto its last sixteenth.
    const { score } = importMidi(smf([on(1910, 60), off(240, 60)]));
    const bars = shotOf(score, { pitchOnly: [0] }).tracks[0]!.bars;
    expect(bars[0]!.voices).toEqual([]); // only rests
    expect(bars[1]!.voices[0]![0]!.notes[0]!.at).toBe("60");
  });

  it("snaps notes to sixteenths and fills gaps with rests so bars stay complete", () => {
    const { score } = importMidi(
      smf([on(130, 60), off(100, 60), on(200, 62), off(200, 62)]), // slightly off the grid
    );
    const bar = score.tracks[0]!.staves[0]!.bars[0]!;
    const total = bar.voices[0]!.beats.reduce(
      (sum, beat) => sum + ((960 * 4) / beat.duration) * (beat.dots ? 1.5 : 1),
      0,
    );
    expect(total).toBe(3840);
  });

  it("moves notes that do not fit on the strings by an octave, and leaves out impossible ones", () => {
    const { score, warnings } = importMidi(
      smf([[0, [0xc0, 25]], on(0, 100), off(480, 100), on(0, 20), off(480, 20)]),
    );
    expect(warnings.some((w) => w.includes("moved an octave"))).toBe(true);
    const notes = score.tracks[0]!.staves[0]!.bars.flatMap((bar) =>
      bar.voices[0]!.beats.flatMap((b) => b.notes),
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses files that are not MIDI, use SMPTE timing or have no notes", () => {
    expect(() => importMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(ScoreLoadError);
    const smpte = smf([on(0, 60), off(480, 60)], { division: 0xe728 });
    expect(() => importMidi(smpte)).toThrow(/SMPTE/);
    expect(() => importMidi(smf([tempo(100)]))).toThrow(/no notes/);
    expect(() => importMidi(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0]))).toThrow(
      ScoreLoadError,
    );
  });

  it("keeps the notes read before a damaged part of a track", () => {
    const bytes = smf([on(0, 60), off(480, 60), [0, [0xf1]]]);
    const { score } = importMidi(bytes);
    expect(shotOf(score, { pitchOnly: [0] }).tracks[0]!.bars[0]!.voices[0]![0]!.notes[0]!.at).toBe(
      "60",
    );
  });

  it("finds the real tempo and bar lines when the notes do not follow the file's tempo", () => {
    // Regression (#55): snapping to the file's own 120 BPM grid drifted a sixteenth
    // every ~30 sixteenths, so notes moved and bars seemed to start with rests.
    const { score, warnings } = importMidi(recording(122, 24, 37));
    expect(warnings.some((w) => w.includes("measured as 122 BPM"))).toBe(true);
    expect(shotOf(score).bars[0]!.tempo).toBe(122);
    const guitar = score.tracks.findIndex((t) => !t.isPercussion);
    const drums = score.tracks.findIndex((t) => t.isPercussion);
    // 37 sixteenths of silence: the first bar line goes on the music's downbeat.
    const firstBar = score.tracks[drums]!.staves[0]!.bars.findIndex((bar) =>
      bar.voices[0]!.beats.some((b) => b.notes.length > 0),
    );
    for (let bar = firstBar; bar < firstBar + 24; bar++) {
      expect(pattern(score, guitar, bar), `guitar bar ${bar + 1}`).toBe("x..x..x...x.....");
      expect(pattern(score, drums, bar), `drum bar ${bar + 1}`).toBe("x.x.x.x.x.x.x.x.");
      const first = score.tracks[drums]!.staves[0]!.bars[bar]!.voices[0]!.beats[0]!;
      expect(first.notes.map((n) => n.percussionArticulation).sort()).toEqual([36, 42]);
    }
  });

  it("keeps files whose notes follow their tempo on the file's own grid", () => {
    const { score, warnings } = importMidi(recording(120, 8, 16));
    expect(warnings.some((w) => w.includes("measured as"))).toBe(false);
    expect(shotOf(score).bars[0]!.tempo).toBe(120);
    const guitar = score.tracks.findIndex((t) => !t.isPercussion);
    for (let bar = 1; bar <= 8; bar++) expect(pattern(score, guitar, bar)).toBe("x..x..x...x.....");
  });

  it("opens our own MIDI export as the same tracks, pitches and rhythm", async () => {
    const original = texScore(String.raw`
\title "Round"
\tempo 100
\track "Guitar"
  \staff {score tabs}
  \instrument 25
  :4 3.6 5.5 7.4 0.3 | :8 5.3 5.3 7.2 7.2 :4 (3.6 5.5) r
`);
    const { bytes } = exportScore(original, "midi");
    const loaded = await loadSong(bytes);
    expect(loaded.converted).toBe(true);
    expect(loaded.warnings.length).toBeGreaterThan(0);
    const back = shotOf(loaded.score, { pitchOnly: [0] });
    const before = shotOf(original, { pitchOnly: [0] });
    expect(back.tracks[0]!.bars.map((b) => b.voices[0])).toEqual(
      before.tracks[0]!.bars.map((b) => b.voices[0]),
    );
    expect(back.bars[0]!.tempo).toBe(100);
    expect(loaded.score.tracks[0]!.playbackInfo.program).toBe(25);
  });
});

describe("importMidi: a lead line over chords", () => {
  /** Eight bars of power chords, with a high melody note on top of every other beat. */
  function guitar(withLead: boolean) {
    const events: [number, number[]][] = [name("distorted electric guitar"), tempo(120)];
    for (let beat = 0; beat < 32; beat++) {
      const lead = withLead && beat % 2 === 0;
      const pitches = [40, 47, 52, ...(lead ? [76] : [])];
      pitches.forEach((p) => events.push(on(0, p)));
      pitches.forEach((p, i) => events.push(off(i === 0 ? 480 : 0, p)));
    }
    return smf(events);
  }

  it("moves the top notes to a track of their own", () => {
    const { score, warnings } = importMidi(guitar(true));
    expect(score.tracks.map((t) => t.name)).toEqual([
      "distorted electric guitar",
      "distorted electric guitar (lead)",
    ]);
    const notes = (track: number) =>
      score.tracks[track]!.staves[0]!.bars.flatMap((b) =>
        b.voices[0]!.beats.flatMap((beat) => beat.notes),
      );
    expect(notes(1)).toHaveLength(16);
    expect(notes(0)).toHaveLength(96);
    expect(warnings.join(" ")).toContain("lead line");
  });

  it("keeps plain chords in one track", () => {
    const { score } = importMidi(guitar(false));
    expect(score.tracks).toHaveLength(1);
  });
});
