import {
  audioMsAt,
  automationTicks,
  barOccurrences,
  barPositionAtTick,
  barTimeline,
  barTimesMs,
  engineExtras,
  laneTicks,
  laneValueAt,
  soundSwitchTicks,
  syncPointsFromTempo,
  syncTicks,
  tickOfBar,
  type BarOccurrence,
} from "@/lib/audio/engine-config";
import { defaultEffect } from "@/lib/audio/effects";
import type { Score } from "@/lib/score/model";
import { MIXER_SETTINGS_VERSION, type MixerSettings } from "@/lib/tauri";
import { texScore } from "@/test/playback";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";

const BAR = 3840; // 4/4 at 960 ticks per quarter

/** Bars 0-1 repeated once, then bar 2: 0 1 0 1 2. */
const REPEATED: BarOccurrence[] = [0, 1, 0, 1, 2].map((bar, i) => ({
  bar,
  start: i * BAR,
  end: (i + 1) * BAR,
}));

const mix = (over: Partial<MixerSettings> = {}): MixerSettings => ({
  version: MIXER_SETTINGS_VERSION,
  master: 1,
  tracks: [{ volume: 1, pan: 0, mute: false, solo: false }],
  ...over,
});

describe("bar passes", () => {
  it("come from alphaTab's lookup, or straight through the score", () => {
    const lookup = {
      masterBars: REPEATED.map((o) => ({
        start: o.start,
        end: o.end,
        masterBar: { index: o.bar },
      })),
    };
    const score = { masterBars: [] } as unknown as Score;
    expect(barOccurrences(score, lookup)).toEqual(REPEATED);
    const straight = barOccurrences(texScore(":4 c4 c4 c4 c4 | c4 c4 c4 c4"), null);
    expect(straight).toEqual([
      { bar: 0, start: 0, end: BAR, beats: 4 },
      { bar: 1, start: BAR, end: 2 * BAR, beats: 4 },
    ]);
  });

  it("place fractional bar positions on the first pass", () => {
    expect(tickOfBar(REPEATED, 1.5)).toBe(BAR * 1.5);
    expect(tickOfBar(REPEATED, 2)).toBe(4 * BAR);
    expect(tickOfBar(REPEATED, 9)).toBe(5 * BAR);
  });
});

describe("automation", () => {
  const points = [
    { bar: 0, value: 1 },
    { bar: 1.5, value: 0 },
  ];

  it("reads lanes between and beyond their points", () => {
    expect(laneValueAt(points, -1)).toBe(1);
    expect(laneValueAt(points, 0.75)).toBe(0.5);
    expect(laneValueAt(points, 5)).toBe(0);
    expect(laneValueAt([], 1)).toBeNull();
  });

  it("repeats on every pass through the bars", () => {
    const ticks = laneTicks(points, REPEATED);
    // First pass of bar 1 starts two thirds of the way down, then reaches 0 halfway.
    expect(ticks.find((t) => t[0] === BAR)![1]).toBeCloseTo(1 / 3);
    expect(ticks).toContainEqual([BAR * 1.5, 0]);
    // The repeat starts loud again.
    expect(ticks).toContainEqual([2 * BAR, 1]);
    expect(ticks).toContainEqual([3 * BAR + BAR / 2, 0]);
    // Ticks never go backwards.
    expect(ticks.map((t) => t[0])).toEqual([...ticks.map((t) => t[0])].sort((a, b) => a - b));
  });

  it("is off unless enabled, and mute is a step", () => {
    expect(
      automationTicks({ enabled: false, volume: points, pan: [], mute: [] }, REPEATED),
    ).toEqual({
      enabled: false,
      volume: [],
      pan: [],
      mute: [],
    });
    const on = automationTicks(
      { enabled: true, volume: [], pan: [], mute: [{ bar: 1, value: 1 }] },
      REPEATED,
    );
    expect(on.mute.slice(0, 2)).toEqual([
      [0, 1],
      [BAR, 1],
    ]);
  });
});

describe("sound switches", () => {
  it("switch wherever the sound changes on each pass", () => {
    const m = mix({
      sounds: [
        {
          sounds: [
            { name: "Clean", effects: [] },
            { name: "Lead", effects: [defaultEffect("drive")] },
          ],
          switches: [{ bar: 1, sound: 1 }],
        },
      ],
    });
    expect(soundSwitchTicks(m, 0, REPEATED)).toEqual([
      [BAR, 1],
      [2 * BAR, 0],
      [3 * BAR, 1],
    ]);
    expect(soundSwitchTicks(mix(), 0, REPEATED)).toEqual([]);
  });
});

describe("audio track", () => {
  it("syncs on the first pass of each bar", () => {
    expect(
      syncTicks(
        [
          { bar: 1, ms: 2000 },
          { bar: 2, ms: 9000 },
          { bar: 7, ms: 1 },
        ],
        REPEATED,
      ),
    ).toEqual([
      { tick: BAR, ms: 2000 },
      { tick: 4 * BAR, ms: 9000 },
    ]);
  });

  it("puts a point on a beat that many beats into the bar, beside the bar-start point", () => {
    expect(
      syncTicks(
        [
          { bar: 0, ms: 1000 },
          { bar: 0, beat: 2, ms: 1200 },
          { bar: 1, beat: 1, ms: 2500 },
        ],
        REPEATED,
      ),
    ).toEqual([
      { tick: 0, ms: 1000 },
      { tick: 1920, ms: 1200 },
      { tick: BAR + 960, ms: 2500 },
    ]);
  });

  it("counts beats by the time signature's numerator", () => {
    const threeFour: BarOccurrence[] = [{ bar: 0, start: 0, end: 2880, beats: 3 }];
    expect(syncTicks([{ bar: 0, beat: 2, ms: 5 }], threeFour)).toEqual([{ tick: 1920, ms: 5 }]);
    // 6/8 is 6 beats in 2880 ticks: 480 ticks each.
    const sixEight: BarOccurrence[] = [{ bar: 0, start: 2880, end: 5760, beats: 6 }];
    expect(syncTicks([{ bar: 0, beat: 3, ms: 5 }], sixEight)).toEqual([
      { tick: 2880 + 1440, ms: 5 },
    ]);
    // The score's bars carry their numerator.
    const score = texScore("\\ts 6 8 :8 c4 c4 c4 c4 c4 c4 | \\ts 3 4 :4 c4 c4 c4");
    expect(barOccurrences(score, null).map((o) => o.beats)).toEqual([6, 3]);
  });

  it("keeps a point past the bar's last beat inside the bar", () => {
    expect(syncTicks([{ bar: 1, beat: 9, ms: 7 }], REPEATED)).toEqual([
      { tick: 2 * BAR - 1, ms: 7 },
    ]);
    expect(syncTicks([{ bar: 1, beat: 4, ms: 7 }], REPEATED)).toEqual([
      { tick: 2 * BAR - 1, ms: 7 },
    ]);
  });

  it("maps song time to recording time like the engine", () => {
    const points = [
      { songMs: 0, ms: 1000 },
      { songMs: 8000, ms: 10_000 },
    ];
    expect(audioMsAt(points, 0)).toBe(1000);
    expect(audioMsAt(points, 4000)).toBe(5500);
    expect(audioMsAt(points, 9000)).toBe(11_000);
    expect(audioMsAt(points, -1000)).toBe(0);
    expect(audioMsAt([], 1234)).toBe(1234);
    // Out-of-order points are dropped.
    expect(audioMsAt([...points, { songMs: 4000, ms: 200 }], 4000)).toBe(5500);
  });

  it("times bars at the score's tempo and adds sync points at tempo changes", () => {
    const score = texScore("\\tempo 120 :4 c4 c4 c4 c4 | c4 c4 c4 c4 | \\tempo 60 c4 c4 c4 c4");
    const passes = barOccurrences(score, null);
    expect(barTimesMs(score, passes)).toEqual([0, 2000, 4000]);
    expect(barTimeline(score, passes)).toEqual([0, 2000, 4000, 8000]);
    const sync = syncPointsFromTempo(score, [{ bar: 0, ms: 500 }], barTimesMs(score, passes));
    expect(sync).toEqual([
      { bar: 0, ms: 500 },
      { bar: 2, ms: 4500 },
    ]);
  });
});

describe("engineExtras", () => {
  it("collects everything the engine needs per track", () => {
    const m = mix({
      masterEffects: [defaultEffect("reverb")],
      masterPan: 0.25,
      eq: [{ lowDb: 2, midDb: 0, midHz: 1000, highDb: 0 }],
      drums: [{ stereo: false, elements: [] }],
      audio: {
        ...EMPTY_AUDIO,
        sources: [{ id: "s", name: "a.mp3", ext: "mp3", embedded: false }],
        lanes: [{ ...newLane("A", "a"), semitones: 1, clips: [newClip("s", "a", 0, 1000, "c")] }],
        sync: [{ bar: 0, ms: 10 }],
      },
    });
    const extras = engineExtras(m, REPEATED);
    expect(extras.sounds).toEqual([{ chains: [[]], switches: [] }]);
    expect(extras.master).toEqual([defaultEffect("reverb")]);
    expect(extras.masterPan).toBe(0.25);
    expect(extras.eq[0]!.lowDb).toBe(2);
    expect(extras.drums[0]!.stereo).toBe(false);
    expect(extras.drums[0]!.elements.length).toBeGreaterThan(10);
    expect(extras.lanes!.audio.lanes[0]!.semitones).toBe(1);
    expect(extras.lanes!.sync).toEqual([{ tick: 0, ms: 10 }]);
    expect(extras.lanes!.transpose).toBe(0);
    expect(engineExtras(mix(), REPEATED).lanes).toBeNull();
  });

  it("sends beat sync points at their beat's tick", () => {
    const m = mix({
      audio: {
        ...EMPTY_AUDIO,
        sources: [{ id: "s", name: "a.mp3", ext: "mp3", embedded: false }],
        lanes: [{ ...newLane("A", "a"), clips: [newClip("s", "a", 0, 1000, "c")] }],
        sync: [
          { bar: 0, ms: 1000 },
          { bar: 0, beat: 2, ms: 1200 },
          { bar: 2, beat: 1, ms: 9000 },
        ],
      },
    });
    expect(engineExtras(m, REPEATED).lanes!.sync).toEqual([
      { tick: 0, ms: 1000 },
      { tick: 1920, ms: 1200 },
      { tick: 4 * BAR + 960, ms: 9000 },
    ]);
  });

  it("sends the monitor track with the input chosen in Settings", () => {
    const eq = { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 };
    const m = mix({
      monitor: {
        enabled: true,
        volume: 0.7,
        pan: -0.5,
        mute: false,
        solo: true,
        eq,
        effects: [defaultEffect("gate")],
      },
    });
    expect(engineExtras(m, REPEATED, { device: "Scarlett 2i2 USB", channel: 1 }).monitor).toEqual({
      params: { enabled: true, volume: 0.7, pan: -0.5, mute: false, solo: true, eq },
      effects: [defaultEffect("gate")],
      device: "Scarlett 2i2 USB",
      channel: 1,
    });
    // Without a choice: the system's default input, first channel.
    expect(engineExtras(m, REPEATED).monitor).toMatchObject({ device: null, channel: 0 });
    expect(engineExtras(mix(), REPEATED).monitor).toBeNull();
  });
});

describe("playhead position", () => {
  it("is the fractional bar of a tick, following repeated passes", () => {
    expect(barPositionAtTick(REPEATED, 0)).toBe(0);
    expect(barPositionAtTick(REPEATED, BAR / 2)).toBe(0.5);
    // The second pass through bars 0-1 is later in time, but still bars 0-1 on the score.
    expect(barPositionAtTick(REPEATED, 2 * BAR + BAR / 4)).toBe(0.25);
    expect(barPositionAtTick(REPEATED, 3 * BAR + BAR / 2)).toBe(1.5);
    expect(barPositionAtTick(REPEATED, 4 * BAR)).toBe(2);
  });

  it("is the end of the song after the last pass, and the start without passes", () => {
    expect(barPositionAtTick(REPEATED, 5 * BAR)).toBe(3);
    expect(barPositionAtTick(REPEATED, 99 * BAR)).toBe(3);
    expect(barPositionAtTick([], 1234)).toBe(0);
  });
});
