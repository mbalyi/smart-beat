/**
 * Drum tracks keep every drum through save and reopen (#229), in every format
 * Smart Beat can write and open again.
 */
import { exporter, Settings } from "@coderline/alphatab";
import { describe, expect, it } from "vitest";

import { exportScore, type ExportFormat } from "@/lib/export";
import { loadSong } from "@/lib/import";
import { articulationForDrum, defaultDrumKit } from "@/lib/score/drum-kit";
import { withoutDrumTabs } from "@/lib/score/drum-tab";
import { ScoreEditor } from "@/lib/score/editor";
import { drumKey, drumNumber, type Note, type Score } from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { createSong, createTrack, insertTrack } from "@/lib/score/tracks";
import { fixtureBytes } from "@/test/score";

const KICK = 36;
const SNARE = 38;
const HAT_CLOSED = 42;
const HAT_PEDAL = 44;
const HAT_OPEN = 46;
const CRASH = 49;
const CRASH_2 = 57;
const RIDE = 51;
const FLOOR_TOM = 41;
const LOW_TOM = 45;
const HIGH_TOM = 48;

/** Hits per beat of the first voice, a bar per row. */
const VOICE_1: number[][][] = [
  [[KICK, HAT_CLOSED], [HAT_CLOSED], [SNARE, HAT_CLOSED], [HAT_OPEN]],
  [[CRASH, KICK], [RIDE], [CRASH_2, SNARE], [HIGH_TOM, LOW_TOM, FLOOR_TOM]],
];

/** Hits per beat of the second voice (the feet), in the first bar. */
const VOICE_2: number[][] = [[KICK], [KICK], [HAT_PEDAL], [KICK]];

/** Types `beats` into a voice from the start of a bar, as the app does. */
function typeBeats(editor: ScoreEditor, voice: number, bar: number, beats: number[][]) {
  editor.setCursorTo({ bar, voice, beat: 0 });
  beats.forEach((hits, index) => {
    if (index > 0) editor.moveBeat(1);
    for (const hit of hits) editor.enterDrum(hit);
  });
}

/** A new song with a drum track (no kit of its own), typed in through the editor. */
function editedDrumSong(): Score {
  const score = createSong();
  insertTrack(score, createTrack(score, { kind: "drums", name: "Drums", program: 0 }));
  const editor = new ScoreEditor(score, 1);
  VOICE_1.forEach((beats, bar) => typeBeats(editor, 0, bar, beats));
  editor.switchVoice(1);
  typeBeats(editor, 1, 0, VOICE_2);
  return editor.score;
}

/** The articulation a drum note is drawn with. */
function articulationOf(note: Note) {
  const kit = note.beat.voice.bar.staff.track.percussionArticulations;
  return kit[note.percussionArticulation] ?? articulationForDrum(note.percussionArticulation);
}

interface Hit {
  bar: number;
  voice: number;
  beat: number;
  /** The drum number the drum tab shows. */
  drum: number;
  /** The MIDI key it plays. */
  key: number;
  /** How the standard staff draws it. */
  line: number;
  head: number;
}

/** Every hit of the song's drum tracks, in order. */
function hitsOf(score: Score): Hit[] {
  const hits: Hit[] = [];
  for (const track of score.tracks) {
    const staff = track.staves[0];
    if (!staff?.isPercussion) continue;
    staff.bars.forEach((bar, b) =>
      bar.voices.forEach((voice, v) =>
        voice.beats.forEach((beat, i) => {
          const notes = beat.notes.map((note) => ({
            bar: b,
            voice: v,
            beat: i,
            drum: drumNumber(note),
            key: drumKey(note),
            line: articulationOf(note).staffLine,
            head: articulationOf(note).noteHeadDefault,
          }));
          hits.push(...notes.sort((x, y) => x.drum - y.drum));
        }),
      ),
    );
  }
  return hits;
}

/** The drums of each bar, voices and beats merged (for formats that do not keep voices). */
function drumsPerBar(score: Score, { unique = false, byKey = false } = {}): number[][] {
  const bars: number[][] = [];
  for (const hit of hitsOf(score)) (bars[hit.bar] ??= []).push(byKey ? hit.key : hit.drum);
  return bars.map((drums) => [...(unique ? new Set(drums) : drums)].sort((a, b) => a - b));
}

const FILE_NAME: Record<Exclude<ExportFormat, "ascii-tab">, string> = {
  gp: "song.gp",
  gp5: "song.gp5",
  gp4: "song.gp4",
  gp3: "song.gp3",
  mscz: "song.mscz",
  mscx: "song.mscx",
  musicxml: "song.musicxml",
  mxl: "song.mxl",
  midi: "song.mid",
  atex: "song.atex",
};

async function reopen(score: Score, format: keyof typeof FILE_NAME) {
  const { bytes, warnings } = exportScore(score, format);
  return { score: (await loadSong(bytes, FILE_NAME[format])).score, warnings };
}

describe("drum tracks after save and reopen (#229)", () => {
  it("types the drums the tests expect", () => {
    const hits = hitsOf(editedDrumSong());
    const sorted = (beat: number[]) => [...beat].sort((a, b) => a - b);
    expect(hits.filter((h) => h.voice === 0).map((h) => h.drum)).toEqual(
      VOICE_1.flatMap((bar) => bar.flatMap(sorted)),
    );
    expect(hits.filter((h) => h.voice === 1).map((h) => h.drum)).toEqual(VOICE_2.flat());
  });

  it("writes Guitar Pro 7 drum notes as indexes into the track's own kit", () => {
    const score = editedDrumSong();
    const again = parseScore(exportScore(score, "gp").bytes).score;
    const kit = again.tracks[1]!.percussionArticulations;
    expect(kit.map((a) => a.id).sort((a, b) => a - b)).toEqual(
      [...new Set([...VOICE_1.flat(2), ...VOICE_2.flat()])].sort((a, b) => a - b),
    );
    // The song itself is left as it was: no kit of its own, notes by drum number.
    expect(score.tracks[1]!.percussionArticulations).toEqual([]);
    expect(hitsOf(score)[0]!.drum).toBe(KICK);
  });

  it.each(["gp", "gp5", "atex"] as const)(
    "keeps every drum, voice, beat and notehead in %s",
    async (format) => {
      const score = editedDrumSong();
      const { score: again } = await reopen(score, format);
      expect(hitsOf(again)).toEqual(hitsOf(score));
    },
  );

  it.each(["gp4", "gp3"] as const)(
    "keeps every drum of the first voice in %s (one voice per bar)",
    async (format) => {
      const score = editedDrumSong();
      const { score: again, warnings } = await reopen(score, format);
      const firstVoice = (hits: Hit[]) => hits.filter((h) => h.voice === 0);
      expect(firstVoice(hitsOf(again))).toEqual(firstVoice(hitsOf(score)));
      expect(warnings.join(" ")).toMatch(/one voice per bar/);
    },
  );

  it.each(["mscz", "mscx"] as const)("keeps every drum of each bar in %s", async (format) => {
    const score = editedDrumSong();
    const { score: again } = await reopen(score, format);
    expect(drumsPerBar(again).slice(0, 2)).toEqual(drumsPerBar(score));
  });

  it.each(["musicxml", "mxl"] as const)(
    "keeps the sound of every drum of each bar in %s",
    async (format) => {
      // MusicXML names a drum by the key it plays, so the open hi-hat (46) can come back as the
      // half-open one (92), which plays the same key.
      const score = editedDrumSong();
      const { score: again } = await reopen(score, format);
      expect(drumsPerBar(again, { byKey: true }).slice(0, 2)).toEqual(
        drumsPerBar(score, { byKey: true }),
      );
    },
  );

  it("keeps every drum of each bar in MIDI (a hit in two voices at once sounds once)", async () => {
    const score = editedDrumSong();
    const { score: again } = await reopen(score, "midi");
    expect(drumsPerBar(again, { unique: true }).slice(0, 2)).toEqual(
      drumsPerBar(score, { unique: true }),
    );
  });

  it("keeps the drums of a Guitar Pro 7 file saved, reopened and saved again", async () => {
    const score = editedDrumSong();
    const { score: once } = await reopen(score, "gp");
    const { score: twice } = await reopen(once, "gp");
    expect(hitsOf(twice)).toEqual(hitsOf(score));
  });

  it("keeps drums added to the own kit of a Guitar Pro 7 file", async () => {
    const score = parseScore(fixtureBytes("practice-song.gp")).score;
    const track = score.tracks.findIndex((t) => t.staves[0]?.isPercussion);
    const editor = new ScoreEditor(score, track);
    for (const drum of [CRASH_2, FLOOR_TOM, HAT_OPEN, 92, 99]) editor.enterDrum(drum);
    const { score: again } = await reopen(editor.score, "gp");
    expect(hitsOf(again)).toEqual(hitsOf(editor.score));
    // Every note refers to an articulation of the kit, as Guitar Pro expects.
    const drums = again.tracks[track]!;
    for (const hit of drums.staves[0]!.bars.flatMap((b) => b.voices[0]!.beats[0]!.notes)) {
      expect(hit.percussionArticulation).toBeLessThan(drums.percussionArticulations.length);
    }
  });

  it("can read a file the old writer damaged: its notes still hold the drum numbers", () => {
    // What Smart Beat wrote before the fix: alphaTab's writer without the kit conversion.
    const score = editedDrumSong();
    const damaged = parseScore(
      withoutDrumTabs(score, () => new exporter.Gp7Exporter().export(score, new Settings())),
    ).score;
    const kit = damaged.tracks[1]!.percussionArticulations;
    // The whole default kit, and the drums read as indexes into it: 36 → 60, 38 → 61, 49 → 62...
    expect(kit.map((a) => a.id)).toEqual(defaultDrumKit().map((a) => a.id));
    const notes = (song: Score) =>
      song.tracks[1]!.staves[0]!.bars.flatMap((bar) =>
        bar.voices.flatMap((voice) => voice.beats.flatMap((beat) => beat.notes)),
      );
    const wrong = new Map(
      notes(score).map((note, i) => [drumNumber(note), drumKey(notes(damaged)[i]!)]),
    );
    expect([KICK, SNARE, CRASH, CRASH_2].map((d) => wrong.get(d))).toEqual([60, 61, 62, 54]);
    // Dropping the kit reads them as drum numbers again: nothing was lost.
    damaged.tracks[1]!.percussionArticulations = [];
    expect(hitsOf(damaged)).toEqual(hitsOf(score));
  });

  it("knows alphaTab's whole default kit, in its order", () => {
    const kit = defaultDrumKit();
    expect(kit.length).toBeGreaterThan(80);
    expect(kit.slice(0, 3).map((a) => a.id)).toEqual([SNARE, 37, 91]);
    expect(kit.find((a) => a.id === 92)?.outputMidiNumber).toBe(HAT_OPEN);
  });
});
