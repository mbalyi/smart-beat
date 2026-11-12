import { describe, expect, it } from "vitest";

import {
  EMPTY_AUDIO,
  MAX_LANES,
  legacySourceId,
  migrateAudioTrack,
  newClip,
  newLane,
  normalizeAudio,
  normalizeClip,
  normalizeLane,
  normalizeSync,
  readAudio,
  usedSources,
} from "@/lib/audio-lanes/model";
import { FLAT_EQ } from "@/lib/score/mixer";
import type { AudioLane, AudioTrackSettings, MixerSettings } from "@/lib/tauri";

const oldTrack: AudioTrackSettings = {
  name: "Backing.mp3",
  path: "/music/Backing.mp3",
  embedded: true,
  enabled: true,
  volume: 0.6,
  pan: -0.25,
  mute: false,
  solo: true,
  eq: { ...FLAT_EQ, lowDb: 3 },
  semitones: -2,
  cents: 15,
  filter: "centreCut",
  sync: [
    { bar: 4, ms: 9000 },
    { bar: 0, ms: 1200 },
  ],
};

const source = { id: "abc", name: "a.wav", ext: "wav", embedded: true };

describe("migrateAudioTrack", () => {
  it("turns the old audio track into one lane with one clip", () => {
    const audio = migrateAudioTrack(oldTrack, "lane-1");
    expect(audio.lanes).toHaveLength(1);
    const [lane] = audio.lanes;
    expect(lane).toMatchObject({
      id: "lane-1",
      name: "Backing.mp3",
      volume: 0.6,
      pan: -0.25,
      solo: true,
      enabled: true,
      semitones: -2,
      cents: 15,
      filter: "centreCut",
    });
    expect(lane!.eq.lowDb).toBe(3);
    expect(lane!.clips).toHaveLength(1);
    expect(lane!.clips[0]!.startMs).toBe(0);
  });

  it("keeps the sync points as the song's, in bar order", () => {
    expect(migrateAudioTrack(oldTrack).sync).toEqual([
      { bar: 0, ms: 1200 },
      { bar: 4, ms: 9000 },
    ]);
  });

  it("points the source at the old embedded entry", () => {
    const [src] = migrateAudioTrack(oldTrack).sources;
    expect(src).toMatchObject({
      id: legacySourceId("Backing.mp3"),
      ext: "mp3",
      embedded: true,
      legacyEntry: "Backing.mp3",
    });
  });

  it("keeps a file path for a track that was not embedded", () => {
    const [src] = migrateAudioTrack({ ...oldTrack, embedded: false }).sources;
    expect(src).toMatchObject({
      path: "/music/Backing.mp3",
      embedded: false,
      legacyEntry: undefined,
    });
  });
});

describe("readAudio", () => {
  const base: MixerSettings = { version: 2, master: 1, tracks: [] };

  it("migrates an old file once and drops the old field", () => {
    const { audio, rest } = readAudio({ ...base, audioTrack: oldTrack });
    expect(audio.lanes).toHaveLength(1);
    expect("audioTrack" in rest).toBe(false);
  });

  it("adds nothing to a song with no audio", () => {
    expect(readAudio(base).audio).toEqual(EMPTY_AUDIO);
  });

  it("prefers version 3 lanes over a stale old field", () => {
    const audio = { ...EMPTY_AUDIO, sources: [source], lanes: [newLane("A", "a")] };
    expect(
      readAudio({ ...base, audio, audioTrack: oldTrack }).audio.lanes.map((l) => l.id),
    ).toEqual(["a"]);
  });
});

describe("legacySourceId", () => {
  it("is stable for one name and differs between names", () => {
    expect(legacySourceId("x.wav")).toBe(legacySourceId("x.wav"));
    expect(legacySourceId("x.wav")).not.toBe(legacySourceId("y.wav"));
  });
});

describe("normalize", () => {
  it("clamps clip values and keeps fades inside the clip", () => {
    const clip = normalizeClip({
      ...newClip("abc", "a", -5, 100, "c"),
      semitones: 40,
      cents: -300,
      playrate: 9,
      gainDb: 99,
      fadeIn: { ms: 80, shape: "sCurve" },
      fadeOut: { ms: 80, shape: "linear" },
    });
    expect(clip).toMatchObject({ startMs: 0, semitones: 24, cents: -100, playrate: 4, gainDb: 24 });
    expect(clip.fadeIn.ms + clip.fadeOut.ms).toBeLessThanOrEqual(100);
  });

  it("caps the number of lanes and drops clips without a source", () => {
    const lanes = Array.from({ length: MAX_LANES + 3 }, (_, i) => ({
      ...newLane(`L${i}`, `l${i}`),
      clips: [newClip(i === 0 ? "missing" : "abc", "a", 0, 100, `c${i}`)],
    }));
    const audio = normalizeAudio({ ...EMPTY_AUDIO, sources: [source], lanes });
    expect(audio.lanes).toHaveLength(MAX_LANES);
    expect(audio.lanes[0]!.clips).toHaveLength(0);
    expect(audio.lanes[1]!.clips).toHaveLength(1);
  });

  it("keeps shownInScore only when it is true", () => {
    const sources = new Set<string>();
    const shown = normalizeLane({ ...newLane("A", "a"), shownInScore: true }, sources);
    expect(shown.shownInScore).toBe(true);
    for (const value of [false, undefined, "true", 1, null]) {
      const lane = normalizeLane(
        { ...newLane("A", "a"), shownInScore: value } as AudioLane,
        sources,
      );
      expect(JSON.parse(JSON.stringify(lane))).not.toHaveProperty("shownInScore");
    }
    expect(normalizeLane(newLane("A", "a"), sources)).not.toHaveProperty("shownInScore");
  });

  it("keeps the lanes shown under the tabs of a whole song through normalizeAudio", () => {
    const lanes = [{ ...newLane("A", "a"), shownInScore: true }, newLane("B", "b")];
    const audio = normalizeAudio({ ...EMPTY_AUDIO, lanes });
    expect(audio.lanes.map((l) => l.shownInScore)).toEqual([true, undefined]);
  });

  it("drops a parent that is not a folder and sends to unknown buses", () => {
    const lane = { ...newLane("A", "a"), parent: "b", sends: [{ bus: "nope", level: 2 }] };
    const audio = normalizeAudio({ ...EMPTY_AUDIO, lanes: [lane, newLane("B", "b")] });
    expect(audio.lanes[0]!.parent).toBeUndefined();
    expect(audio.lanes[0]!.sends).toEqual([]);
  });

  it("keeps one sync point per beat, in order", () => {
    expect(
      normalizeSync([
        { bar: 2, ms: 10 },
        { bar: 1, beat: 2, ms: 5 },
        { bar: 1, beat: 2, ms: 6 },
        { bar: -1, ms: 1 },
      ]),
    ).toEqual([
      { bar: 1, beat: 2, ms: 6 },
      { bar: 2, ms: 10 },
    ]);
  });

  it("lists only the sources a clip plays", () => {
    const audio = {
      ...EMPTY_AUDIO,
      sources: [source, { ...source, id: "unused" }],
      lanes: [{ ...newLane("A", "a"), clips: [newClip("abc", "a", 0, 100, "c")] }],
    };
    expect(usedSources(audio).map((s) => s.id)).toEqual(["abc"]);
  });
});
