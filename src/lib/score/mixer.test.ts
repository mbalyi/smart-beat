import { defaultEffect } from "@/lib/audio/effects";
import {
  addSound,
  allTrackEffects,
  describeDb,
  describePan,
  describeVolume,
  FLAT_EQ,
  focusTrims,
  FOCUS_BOOST_DB,
  FOCUS_CUT_DB,
  initialMix,
  isAudible,
  mixerReducer,
  mixFromScore,
  removeSound,
  shortPan,
  soundChains,
  soundEffects,
  soundNames,
  trackAutomation,
  trackEffects,
  trackEq,
  trackInterpretation,
  trackSoundsOf,
  trackStates,
  withTrackStates,
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
  it("prefers the saved mix, upgrading older versions", () => {
    const saved = { ...mixFromScore(SUMMARY), master: 0.3 };
    expect(initialMix(SUMMARY, saved)).toEqual(saved);
    const v1 = { ...saved, version: 1 };
    expect(initialMix(SUMMARY, v1)).toEqual({ ...saved, version: MIXER_SETTINGS_VERSION });
  });

  it("falls back to the file when nothing is saved or it does not fit", () => {
    expect(initialMix(SUMMARY, null)).toEqual(mixFromScore(SUMMARY));
    expect(initialMix(SUMMARY, mix([{}]))).toEqual(mixFromScore(SUMMARY));
    const outdated = { ...mixFromScore(SUMMARY), version: 99 } as unknown as MixerSettings;
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

describe("mixer v2 settings", () => {
  const two = mix([{}, {}]);
  const DELAY = defaultEffect("delay");

  it("adds, edits, switches and removes sounds; sound 1 stays the track's chain", () => {
    let m = mixerReducer(two, { type: "effects", track: 0, slots: [GATE] });
    expect(soundNames(m, 0)).toEqual(["Sound 1"]);
    m = mixerReducer(m, { type: "sounds", track: 0, sounds: addSound(m, 0) });
    expect(soundNames(m, 0)).toEqual(["Sound 1", "Sound 2"]);
    expect(soundEffects(m, 0, 1)).toEqual([GATE]);
    m = mixerReducer(m, { type: "sound-effects", track: 0, sound: 1, slots: [DELAY] });
    expect(soundChains(m, 0)).toEqual([[GATE], [DELAY]]);
    m = mixerReducer(m, { type: "sound-effects", track: 0, sound: 0, slots: [] });
    expect(trackEffects(m, 0)).toEqual([]);
    const own = trackSoundsOf(m, 0)!;
    m = mixerReducer(m, {
      type: "sounds",
      track: 0,
      sounds: {
        ...own,
        switches: [
          { bar: 4, sound: 1 },
          { bar: 2, sound: 0 },
          { bar: 4, sound: 0 },
          { bar: 1, sound: 9 },
        ],
      },
    });
    // Sorted, one per bar (the last wins), and only existing sounds.
    expect(trackSoundsOf(m, 0)!.switches).toEqual([
      { bar: 2, sound: 0 },
      { bar: 4, sound: 0 },
    ]);
    m = mixerReducer(m, { type: "sounds", track: 0, sounds: removeSound(m, 0, 1) });
    expect(m.sounds).toBeUndefined();
    expect(soundNames(m, 0)).toEqual(["Sound 1"]);
  });

  it("removing a sound drops its switches and renumbers later ones", () => {
    let m = mixerReducer(two, { type: "sounds", track: 1, sounds: addSound(two, 1) });
    m = mixerReducer(m, { type: "sounds", track: 1, sounds: addSound(m, 1) });
    m = mixerReducer(m, {
      type: "sounds",
      track: 1,
      sounds: {
        ...trackSoundsOf(m, 1)!,
        switches: [
          { bar: 1, sound: 1 },
          { bar: 3, sound: 2 },
        ],
      },
    });
    expect(removeSound(m, 1, 1)!.switches).toEqual([{ bar: 3, sound: 1 }]);
  });

  it("stores EQ, automation, focus, drums, master pan, the audio track and presets", () => {
    let m = mixerReducer(two, {
      type: "eq",
      track: 1,
      eq: { lowDb: 40, midDb: -3, midHz: 50, highDb: Number.NaN },
    });
    expect(trackEq(m, 1)).toEqual({ lowDb: 15, midDb: -3, midHz: 200, highDb: 0 });
    expect(trackEq(m, 0)).toBe(FLAT_EQ);
    m = mixerReducer(m, {
      type: "automation",
      track: 0,
      automation: {
        enabled: true,
        volume: [
          { bar: 2, value: 3 },
          { bar: 0, value: 0.5 },
        ],
        pan: [{ bar: -1, value: -2 }],
        mute: [{ bar: 1, value: 0.7 }],
      },
    });
    expect(trackAutomation(m, 0)).toEqual({
      enabled: true,
      volume: [
        { bar: 0, value: 0.5 },
        { bar: 2, value: 1 },
      ],
      pan: [{ bar: 0, value: -1 }],
      mute: [{ bar: 1, value: 1 }],
    });
    m = mixerReducer(m, { type: "focus", track: 1 });
    expect(focusTrims(m)).toEqual([FOCUS_CUT_DB, FOCUS_BOOST_DB]);
    m = mixerReducer(m, { type: "focus", track: null });
    expect(m.focus).toBeUndefined();
    expect(focusTrims(m)).toEqual([0, 0]);
    m = mixerReducer(m, { type: "master-pan", value: -4 });
    expect(m.masterPan).toBe(-1);
    m = mixerReducer(m, { type: "drums", track: 1, drums: { stereo: false, elements: [] } });
    expect(m.drums).toEqual([null, { stereo: false, elements: [] }]);
    const audio = {
      name: "take.mp3",
      path: "/take.mp3",
      embedded: false,
      enabled: true,
      volume: 2,
      pan: 0,
      mute: false,
      solo: true,
      eq: FLAT_EQ,
      semitones: 40,
      cents: 7.6,
      filter: "off" as const,
      sync: [
        { bar: 4, ms: 9000 },
        { bar: 0, ms: 500 },
        { bar: 2, ms: -1 },
      ],
    };
    m = mixerReducer(m, { type: "audio-track", value: audio });
    expect(m.audioTrack).toMatchObject({
      volume: 1,
      semitones: 24,
      cents: 8,
      sync: [
        { bar: 0, ms: 500 },
        { bar: 4, ms: 9000 },
      ],
    });
    // A soloed audio track silences the score's tracks.
    expect(isAudible(m, 0)).toBe(false);
    m = mixerReducer(m, {
      type: "presets",
      presets: [{ name: "P", target: "guitar", effects: [] }],
    });
    expect(m.presets).toHaveLength(1);
    // Reset keeps all of it apart from focus and master pan.
    const reset = mixerReducer(
      { ...m, focus: 0 },
      { type: "reset", mix: mix([{ volume: 0.2 }, {}]) },
    );
    expect(reset.focus).toBeUndefined();
    expect(reset.masterPan).toBeUndefined();
    expect(reset.audioTrack).toEqual(m.audioTrack);
    expect(reset.tracks[0]!.volume).toBe(0.2);
    m = mixerReducer(m, { type: "audio-track", value: null });
    expect(m.audioTrack).toBeUndefined();
  });

  it("track states follow the tracks when they move", () => {
    let m = mixerReducer(two, { type: "eq", track: 0, eq: { ...FLAT_EQ, lowDb: 6 } });
    m = mixerReducer(m, { type: "focus", track: 0 });
    m = mixerReducer(m, { type: "drums", track: 1, drums: { stereo: true, elements: [] } });
    const [a, b] = trackStates(m);
    const swapped = withTrackStates(m, [b!, a!]);
    expect(trackEq(swapped, 1).lowDb).toBe(6);
    expect(swapped.focus).toBe(1);
    expect(swapped.drums).toEqual([{ stereo: true, elements: [] }, null]);
    // Nothing special: the optional lists stay out of the settings.
    const plain = withTrackStates(two, trackStates(two));
    expect(plain.eq).toBeUndefined();
    expect(plain.automation).toBeUndefined();
    expect(plain.sounds).toBeUndefined();
  });

  it("describes dB and short pans", () => {
    expect(describeDb(1)).toBe("0.0 dB");
    expect(describeDb(0.5)).toBe("-6.0 dB");
    expect(describeDb(0)).toBe("-∞ dB");
    expect(shortPan(0)).toBe("C");
    expect(shortPan(-0.3)).toBe("30L");
    expect(shortPan(1)).toBe("100R");
  });
});

describe("drum kits per track (#40)", () => {
  it("remembers a kit per track and moves it with its track", () => {
    const mix = mixFromScore(SUMMARY);
    const next = mixerReducer(mix, { type: "drum-kit", track: 2, kit: "free-kit" });
    expect(next.drumKits).toEqual([null, null, "free-kit", null]);
    const states = trackStates(next);
    const moved = withTrackStates(next, [states[2]!, states[0]!, states[1]!, states[3]!]);
    expect(moved.drumKits).toEqual(["free-kit", null, null, null]);
    const cleared = mixerReducer(next, { type: "drum-kit", track: 2, kit: null });
    expect(withTrackStates(cleared, trackStates(cleared)).drumKits).toBeUndefined();
    expect(mixerReducer(mix, { type: "drum-kit", track: 9, kit: "x" })).toBe(mix);
  });

  it("does not take drum kits over when the settings are loaded as a mix", () => {
    const saved = { ...mixFromScore(SUMMARY), drumKits: [null, null, "free-kit", null] };
    expect(initialMix(SUMMARY, saved).drumKits).toEqual([null, null, "free-kit", null]);
  });
});
