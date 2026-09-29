import { model, Settings } from "@coderline/alphatab";

import {
  appendMasterBar,
  barContent,
  cloneBeat,
  cloneTrack,
  ensureVoices,
  freeChannels,
  isPlaceholderVoice,
  newBar,
  placeholderBeats,
  refinish,
  setProgram,
  trackContent,
} from "@/lib/score/model";
import { parseScore } from "@/lib/score/score";
import { Snapshot } from "@/lib/score/snapshot";
import { fixtureBytes } from "@/test/score";

const { Duration, AutomationType } = model;

const load = (name = "practice-song.gp") => parseScore(fixtureBytes(name)).score;
const json = (score: model.Score) => model.JsonConverter.scoreToJson(score);

describe("refinish", () => {
  it("leaves an unchanged score exactly as it was", () => {
    const score = load();
    const before = json(score);

    refinish(score);
    refinish(score);

    expect(json(score)).toBe(before);
  });

  it("re-links everything after beats, bars and tracks move around", () => {
    const score = load();
    const guitar = score.tracks[0]!.staves[0]!;
    const voice = guitar.bars[0]!.voices[0]!;
    voice.beats.reverse();
    score.tracks.reverse();

    refinish(score);

    expect(score.tracks.map((t) => t.index)).toEqual([0, 1, 2, 3]);
    expect(voice.beats.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    expect(voice.beats[1]!.previousBeat).toBe(voice.beats[0]);
    expect(voice.beats[3]!.nextBeat).toBe(guitar.bars[1]!.voices[0]!.beats[0]);
    expect(voice.beats.map((b) => b.playbackStart)).toEqual([0, 960, 1920, 2880]);
  });

  it("finds ties again and forgets links to removed notes", () => {
    const score = load();
    const bar = score.tracks[0]!.staves[0]!.bars[0]!;
    const [first, second] = bar.voices[0]!.beats;
    const tied = second!.notes[0]!;
    tied.string = first!.notes[0]!.string;
    tied.isTieDestination = true;
    refinish(score);
    expect(tied.tieOrigin).toBe(first!.notes[0]);
    expect(tied.fret).toBe(first!.notes[0]!.fret);

    first!.removeNote(first!.notes[0]!);
    refinish(score);

    expect(tied.tieOrigin).toBeNull();
    expect(tied.isTieDestination).toBe(false);
  });
});

describe("building the model", () => {
  it("fills new bars with a rest that lasts the whole bar", () => {
    const score = load();
    const masterBar = score.masterBars[0]!;

    expect(placeholderBeats(masterBar, 0).map((b) => [b.duration, b.dots])).toEqual([
      [Duration.Whole, 0],
    ]);
    const second = placeholderBeats(masterBar, 1);
    expect(second).toHaveLength(1);
    expect(second[0]!.isEmpty).toBe(true);
  });

  it("appends a bar to every track, shaped like the last one", () => {
    const score = load();

    const masterBar = appendMasterBar(score);
    refinish(score);

    expect(score.masterBars).toHaveLength(5);
    expect(masterBar.timeSignatureNumerator).toBe(4);
    expect(masterBar.start).toBe(score.masterBars[3]!.start + 3840);
    for (const track of score.tracks) {
      const bar = track.staves[0]!.bars[4]!;
      expect(bar.clef).toBe(track.staves[0]!.bars[3]!.clef);
      expect(isPlaceholderVoice(bar.voices[0]!)).toBe(true);
    }
  });

  it("keeps the same number of voices in every bar of a staff", () => {
    const score = load();
    const staff = score.tracks[0]!.staves[0]!;

    ensureVoices(staff, 2);
    refinish(score);

    expect(staff.bars.every((bar) => bar.voices.length === 2)).toBe(true);
    expect(staff.bars[0]!.voices[1]!.beats[0]!.isEmpty).toBe(true);
    expect(() => refinish(score)).not.toThrow();
  });

  it("builds bars from a template", () => {
    const score = load();
    const template = score.tracks[1]!.staves[0]!.bars[0]!;

    const bar = newBar(template, score.masterBars[0]!);

    expect(bar.clef).toBe(template.clef);
    expect(bar.voices).toHaveLength(template.voices.length);
  });
});

describe("cloning", () => {
  it("copies a beat and its notes with new ids", () => {
    const score = load();
    const beat = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[1]!;

    const copy = cloneBeat(beat);

    expect(copy).not.toBe(beat);
    expect(copy.id).not.toBe(beat.id);
    expect(copy.duration).toBe(beat.duration);
    expect(copy.notes.map((n) => [n.string, n.fret])).toEqual(
      beat.notes.map((n) => [n.string, n.fret]),
    );
    expect(copy.notes[0]!.beat).toBe(copy);
    expect(copy.notes[0]!.id).not.toBe(beat.notes[0]!.id);
  });

  it("copies a whole track that plays and renders like the original", () => {
    const score = load();
    const original = score.tracks[1]!;

    const copy = cloneTrack(original);
    score.addTrack(copy);
    refinish(score);

    expect(copy.name).toBe(original.name);
    expect(copy.staves[0]!.tuning).toEqual(original.staves[0]!.tuning);
    expect(copy.staves[0]!.tuning).not.toBe(original.staves[0]!.tuning);
    expect(copy.staves[0]!.bars).toHaveLength(4);
    expect(copy.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.realValue).toBe(
      original.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.realValue,
    );
    expect(copy.staves[0]!.bars[0]!.masterBar).toBe(score.masterBars[0]);
    // The copy survives a round trip through alphaTab's serializer (used by the render worker).
    expect(() => model.JsonConverter.jsonToScore(json(score), new Settings())).not.toThrow();
  });
});

describe("snapshots", () => {
  it("restores what an edit changed, any number of times", () => {
    const score = load();
    const bar = score.tracks[0]!.staves[0]!.bars[0]!;
    const before = Snapshot.of(barContent(bar));
    const beats = [...bar.voices[0]!.beats];
    const fret = beats[0]!.notes[0]!.fret;

    beats[0]!.notes[0]!.fret = 12;
    bar.voices[0]!.beats.splice(1, 2);
    before.restore();
    before.restore();
    refinish(score);

    expect(bar.voices[0]!.beats).toEqual(beats);
    expect(beats[0]!.notes[0]!.fret).toBe(fret);
    expect(before.size).toBeGreaterThan(5);
  });

  it("records each object once", () => {
    const score = load();
    const track = score.tracks[0]!;
    expect(Snapshot.of([track, track, track.playbackInfo]).size).toBe(2);
    expect(Snapshot.of(trackContent(track)).size).toBeGreaterThan(20);
  });
});

describe("instruments and channels", () => {
  it("changes the program the MIDI starts with", () => {
    const score = load();
    const track = score.tracks[0]!;

    setProgram(track, 30);
    refinish(score);

    const first = track.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
    expect(track.playbackInfo.program).toBe(30);
    expect(first.getAutomation(AutomationType.Instrument)?.value).toBe(30);
  });

  it("picks unused channels, never the drum channel, and shares when full", () => {
    const score = load(); // uses 0–3, 6, 7 and 9
    expect(freeChannels(score, 2)).toEqual([4, 5]);
    expect(freeChannels(score, 9)).toEqual([4, 5, 8, 10, 11, 12, 13, 14, 15]);
    const full = freeChannels(score, 12);
    expect(full).toHaveLength(12);
    expect(full).not.toContain(9);
  });
});
