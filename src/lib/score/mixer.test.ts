import { defaultEffect } from "@/lib/audio/effects";
import {
  allTrackEffects,
  describePan,
  describeVolume,
  initialMix,
  isAudible,
  mixerReducer,
  mixFromScore,
  trackEffects,
  trackInterpretation,
} from "@/lib/score/mixer";
import { DEFAULT_INTERPRETATION } from "@/lib/score/interpretation";
import { MIXER_SETTINGS_VERSION, type MixerSettings } from "@/lib/tauri";
import { SUMMARY } from "@/test/score";

const mix = (tracks: Partial<MixerSettings["tracks"][number]>[]): MixerSettings => ({
  version: MIXER_SETTINGS_VERSION,
  master: 1,
  tracks: tracks.map((t) => ({ volume: 1, pan: 0, mute: false, solo: false, ...t })),
});

const GATE = defaultEffect("gate");

describe("mixFromScore", () => {
  it("uses the values from the file at full master volume", () => {
    expect(mixFromScore(SUMMARY)).toEqual({
      version: MIXER_SETTINGS_VERSION,
      master: 1,
      tracks: SUMMARY.tracks.map((t) => t.mix),
    });
  });
});

describe("initialMix", () => {
  it("prefers the saved mix", () => {
    const saved = { ...mixFromScore(SUMMARY), master: 0.3 };
    expect(initialMix(SUMMARY, saved)).toBe(saved);
  });

  it("falls back to the file when nothing is saved or it does not fit", () => {
    expect(initialMix(SUMMARY, null)).toEqual(mixFromScore(SUMMARY));
    expect(initialMix(SUMMARY, mix([{}]))).toEqual(mixFromScore(SUMMARY));
    const outdated = { ...mixFromScore(SUMMARY), version: 2 } as unknown as MixerSettings;
    expect(initialMix(SUMMARY, outdated)).toEqual(mixFromScore(SUMMARY));
  });
});

describe("mixerReducer", () => {
  const start = mix([{}, {}]);

  it("updates one track at a time", () => {
    let next = mixerReducer(start, { type: "volume", track: 1, value: 0.25 });
    next = mixerReducer(next, { type: "pan", track: 1, value: -0.5 });
    next = mixerReducer(next, { type: "mute", track: 0, value: true });
    next = mixerReducer(next, { type: "solo", track: 1, value: true });

    expect(next.tracks).toEqual([
      { volume: 1, pan: 0, mute: true, solo: false },
      { volume: 0.25, pan: -0.5, mute: false, solo: true },
    ]);
    expect(start.tracks[1]!.volume).toBe(1); // immutable
  });

  it("clamps values to their range", () => {
    expect(mixerReducer(start, { type: "master", value: 1.5 }).master).toBe(1);
    expect(mixerReducer(start, { type: "volume", track: 0, value: -1 }).tracks[0]!.volume).toBe(0);
    expect(mixerReducer(start, { type: "pan", track: 0, value: 3 }).tracks[0]!.pan).toBe(1);
  });

  it("ignores unknown tracks", () => {
    expect(mixerReducer(start, { type: "mute", track: 7, value: true })).toBe(start);
  });

  it("resets to a given mix but keeps the effects", () => {
    const other = mix([{ volume: 0.1 }]);
    const withEffects = { ...start, effects: [[GATE]], masterEffects: [GATE] };
    expect(mixerReducer(withEffects, { type: "reset", mix: other })).toEqual({
      ...other,
      effects: [[GATE]],
      masterEffects: [GATE],
    });
  });

  it("sets a track's effects (other tracks keep theirs) and the master's", () => {
    const two = mix([{}, {}]);
    const first = mixerReducer(two, { type: "effects", track: 1, slots: [GATE] });
    expect(allTrackEffects(first)).toEqual([[], [GATE]]);
    expect(trackEffects(first, 0)).toEqual([]);
    expect(mixerReducer(first, { type: "effects", track: 5, slots: [GATE] })).toBe(first);
    expect(mixerReducer(first, { type: "master-effects", slots: [GATE] }).masterEffects).toEqual([
      GATE,
    ]);
  });
});

describe("isAudible", () => {
  it("silences muted tracks", () => {
    const state = mix([{ mute: true }, {}]);
    expect([isAudible(state, 0), isAudible(state, 1)]).toEqual([false, true]);
  });

  it("only plays soloed tracks when any track is soloed", () => {
    const state = mix([{ solo: true }, {}, { solo: true, mute: true }]);
    expect([isAudible(state, 0), isAudible(state, 1), isAudible(state, 2)]).toEqual([
      true,
      false,
      false,
    ]);
    expect(isAudible(state, 9)).toBe(false);
  });
});

describe("describing values", () => {
  it.each([
    [0, "Centre"],
    [0.004, "Centre"],
    [-0.4, "40% left"],
    [1, "100% right"],
  ])("pan %f reads as %s", (pan, text) => {
    expect(describePan(pan)).toBe(text);
  });

  it("reads volume as a percentage", () => {
    expect(describeVolume(0.755)).toBe("76%");
  });
});

describe("interpretation", () => {
  it("is set per track (cleaned up) and kept on reset", () => {
    const two = mix([{}, {}]);
    const next = mixerReducer(two, {
      type: "interpretation",
      track: 1,
      value: { style: "slap", palmMute: 3, accent: 0.5, letRing: false, brush: true },
    });
    expect(trackInterpretation(next, 1)).toEqual({
      style: "slap",
      palmMute: 1,
      accent: 0.5,
      letRing: false,
      brush: true,
    });
    expect(trackInterpretation(next, 0)).toEqual(DEFAULT_INTERPRETATION);
    expect(mixerReducer(next, { type: "reset", mix: two }).interpretation).toBe(
      next.interpretation,
    );
  });
});
