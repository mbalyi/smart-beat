import { describe, expect, it } from "vitest";

import {
  analyseSource,
  buildPart,
  countNotes,
  compatibleTracks,
  defaultPlace,
  describeSource,
  firstEmptyBar,
  firstTenMinutes,
  instrumentFromName,
  laneNotesToTake,
  looksLikeFullMix,
  MAX_SPAN_MS,
  startBarFor,
} from "@/lib/audio-lanes/lane-transcribe";
import {
  requestFromSelection,
  resolveClipRequest,
} from "@/lib/audio-lanes/lane-transcribe-request";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { placeTake } from "@/lib/import/place-take";
import { appendMasterBar, type Score } from "@/lib/score/model";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { createSong } from "@/lib/score/tracks";
import type { AudioLanesSettings } from "@/lib/tauri";

/** 60 bpm in 4/4: 4 s a bar, 32 bars. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 32 }, (_, i) => i * 4000),
  beats: Array(32).fill(4),
};

function lanes(
  clips: { id: string; start: number; length: number; mute?: boolean; rate?: number }[],
  name = "Lead guitar",
): AudioLanesSettings {
  const lane = newLane(name, "lane");
  lane.clips = clips.map((c) => ({
    ...newClip("src", "file", c.start, c.length, c.id),
    mute: c.mute ?? false,
    playrate: c.rate ?? 1,
  }));
  return { ...EMPTY_AUDIO, lanes: [lane], sources: [] };
}

describe("resolveClipRequest", () => {
  const audio = lanes([
    { id: "a", start: 1000, length: 2000 },
    { id: "b", start: 5000, length: 4000 },
  ]);
  it("takes the union of several clips on one lane", () => {
    const r = resolveClipRequest(audio.lanes, {
      laneId: "lane",
      clipIds: ["a", "b"],
      range: null,
    });
    expect(r.range).toEqual({ startMs: 1000, endMs: 9000 });
    expect(r.clipIds).toEqual(["a", "b"]);
    expect(r.notice).toBeNull();
  });

  it("uses the placed span of a clip with another playrate", () => {
    const fast = lanes([{ id: "a", start: 0, length: 4000, rate: 2 }]);
    const r = resolveClipRequest(fast.lanes, { laneId: "lane", clipIds: ["a"], range: null });
    expect(r.range).toEqual({ startMs: 0, endMs: 2000 });
  });

  it("keeps the range and says so when the clip was split away", () => {
    const r = resolveClipRequest(audio.lanes, {
      laneId: "lane",
      clipIds: ["gone"],
      range: { startMs: 1000, endMs: 3000 },
    });
    expect(r.clipIds).toEqual([]);
    expect(r.range).toEqual({ startMs: 1000, endMs: 3000 });
    expect(r.notice).toMatch(/time span/);
  });

  it("keeps the lane of the clicked clip across lanes", () => {
    const other = newLane("Bass", "bass");
    other.clips = [newClip("src", "f", 0, 1000, "x")];
    const all = [...audio.lanes, other];
    const picked = requestFromSelection(all, ["a", "x"], "a", "selection");
    expect(picked?.request.laneId).toBe("lane");
    expect(picked?.request.clipIds).toEqual(["a"]);
    expect(picked?.notice).toMatch(/one track at a time/);
  });
});

describe("analyseSource", () => {
  it("reports the span of a clip", () => {
    const audio = lanes([{ id: "a", start: 48_000, length: 42_000 }]);
    const report = analyseSource(audio, { laneId: "lane", clipIds: ["a"], range: null });
    expect(report.problem).toBeNull();
    expect(report.span).toEqual({ startMs: 48_000, endMs: 90_000 });
    expect(describeSource(report, { clipIds: ["a"] })).toBe("Lead guitar, clip 1, 0:48 to 1:30");
  });

  it("clamps a range to the audio", () => {
    const audio = lanes([{ id: "a", start: 1000, length: 4000 }]);
    const report = analyseSource(audio, {
      laneId: "lane",
      clipIds: [],
      range: { startMs: 0, endMs: 100_000 },
    });
    expect(report.span).toEqual({ startMs: 1000, endMs: 5000 });
  });

  it("names the problems", () => {
    const kinds = (a: AudioLanesSettings, ids: string[] = [], range = null) =>
      analyseSource(a, { laneId: "lane", clipIds: ids, range }).problem?.kind;
    expect(kinds({ ...EMPTY_AUDIO })).toBe("no-lane");
    expect(kinds(lanes([]))).toBe("empty");
    expect(kinds(lanes([{ id: "a", start: 0, length: 1000, mute: true }]))).toBe("muted");
    expect(kinds(lanes([{ id: "a", start: 0, length: 1000, mute: true }]), ["a"])).toBe(
      "clip-muted",
    );
    const far = analyseSource(lanes([{ id: "a", start: 0, length: 1000 }]), {
      laneId: "lane",
      clipIds: [],
      range: { startMs: 5000, endMs: 6000 },
    });
    expect(far.problem?.kind).toBe("outside");
    const folder = lanes([]);
    folder.lanes[0]!.folder = true;
    expect(kinds(folder)).toBe("folder");
  });

  it("skips muted clips of a whole lane", () => {
    const audio = lanes([
      { id: "a", start: 0, length: 1000, mute: true },
      { id: "b", start: 2000, length: 1000 },
    ]);
    const report = analyseSource(audio, { laneId: "lane", clipIds: [], range: null });
    expect(report.clips.map((c) => c.id)).toEqual(["b"]);
    expect(report.span).toEqual({ startMs: 2000, endMs: 3000 });
  });

  it("flags a missing file", () => {
    const audio = lanes([{ id: "a", start: 0, length: 1000 }]);
    const report = analyseSource(
      audio,
      { laneId: "lane", clipIds: [], range: null },
      new Set(["src"]),
    );
    expect(report.problem?.kind).toBe("missing-file");
  });

  it("limits a span to ten minutes, exactly", () => {
    const ok = lanes([{ id: "a", start: 0, length: MAX_SPAN_MS }]);
    expect(analyseSource(ok, { laneId: "lane", clipIds: [], range: null }).problem).toBeNull();
    const long = lanes([{ id: "a", start: 0, length: MAX_SPAN_MS + 1 }]);
    const report = analyseSource(long, { laneId: "lane", clipIds: [], range: null });
    expect(report.problem?.kind).toBe("too-long");
    expect(report.problem?.fix).toBe("first-10-minutes");
    expect(firstTenMinutes(report.span!)).toEqual({ startMs: 0, endMs: MAX_SPAN_MS });
  });

  it("advises on a short span and a whole mix", () => {
    const audio = lanes([{ id: "a", start: 0, length: 300 }], "Full mix");
    const report = analyseSource(audio, { laneId: "lane", clipIds: [], range: null });
    expect(report.problem).toBeNull();
    expect(report.advisories).toHaveLength(2);
  });
});

describe("defaults", () => {
  it("guesses the instrument from a lane name", () => {
    expect(instrumentFromName("Drums (stem)")).toBe("drums");
    expect(instrumentFromName("bass")).toBe("bass");
    expect(instrumentFromName("Piano")).toBe("piano");
    expect(instrumentFromName("Lead guitar")).toBe("guitar");
    expect(instrumentFromName("Vocals")).toBeNull();
    expect(looksLikeFullMix({ name: "Full mix" })).toBe(true);
    expect(looksLikeFullMix({ name: "Bass" })).toBe(false);
  });

  it("puts a 60 bpm clip at 0:48 on bar 13 (index 12)", () => {
    const audio = lanes([{ id: "a", start: 48_000, length: 8000 }]);
    expect(startBarFor(audio, grid, 48_000, 32)).toEqual({
      bar: 12,
      midBar: false,
      beforeFirst: false,
      pastEnd: false,
    });
  });

  it("rounds a mid-bar start and says so", () => {
    const start = startBarFor(EMPTY_AUDIO, grid, 50_500, 32);
    expect(start.bar).toBe(13);
    expect(start.midBar).toBe(true);
  });

  it("follows sync points", () => {
    const audio = { ...EMPTY_AUDIO, sync: [{ bar: 0, ms: 2000 }] };
    // The audio is 2 s late: audio 48 s is song 46 s, bar 11.5, rounded to 12 (index).
    expect(startBarFor(audio, grid, 48_000, 32).bar).toBe(12);
    expect(startBarFor(audio, grid, 46_000, 32).bar).toBe(11);
  });

  it("clamps before the first bar and past the last", () => {
    const early = { ...EMPTY_AUDIO, sync: [{ bar: 0, ms: 6000 }] };
    expect(startBarFor(early, grid, 1000, 32)).toMatchObject({ bar: 0, beforeFirst: true });
    expect(startBarFor(EMPTY_AUDIO, grid, 200_000, 32)).toMatchObject({ bar: 32, pastEnd: true });
  });

  it("chooses the track: named like the lane, cursor, first, new", () => {
    const tracks = [
      { index: 0, name: "Rhythm", kind: "stringed" },
      { index: 1, name: "Lead guitar", kind: "stringed" },
      { index: 2, name: "Keys", kind: "pitched" },
    ];
    const pick = (instrument: "guitar" | "piano" | "drums", cursor: number | null, name = "x") =>
      defaultPlace({ laneName: name, instrument, tracks, cursorTrack: cursor });
    expect(pick("guitar", 0, "Lead guitar")).toEqual({ kind: "track", index: 1 });
    expect(pick("guitar", 0)).toEqual({ kind: "track", index: 0 });
    expect(pick("guitar", null)).toEqual({ kind: "track", index: 0 });
    expect(pick("piano", 0)).toEqual({ kind: "track", index: 2 });
    expect(pick("drums", 0)).toEqual({ kind: "new-track" });
    expect(
      defaultPlace({ laneName: "x", instrument: "guitar", tracks: null, cursorTrack: null }),
    ).toEqual({ kind: "new-tab" });
    expect(compatibleTracks(tracks, "guitar")).toHaveLength(2);
  });

  it("finds the first empty bar of a track", () => {
    const score: Score = createSong();
    while (score.masterBars.length < 4) appendMasterBar(score);
    expect(firstEmptyBar(score, 0)).toBe(0);
    placeTake(score, [{ start: 2.1, end: 2.4, pitch: 40, velocity: 90 }], {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: 0,
    });
    expect(firstEmptyBar(score, 0)).toBe(2);
  });
});

describe("laneNotesToTake", () => {
  const notes = [{ start: 48.5, end: 49, pitch: 40, velocity: 90 }];

  it("makes time relative to the start bar", () => {
    const [n] = laneNotesToTake(EMPTY_AUDIO, grid, notes, 12);
    expect(n!.start).toBeCloseTo(0.5, 6);
    expect(n!.end).toBeCloseTo(1, 6);
  });

  it("goes through the sync points", () => {
    const audio = { ...EMPTY_AUDIO, sync: [{ bar: 0, ms: 2000 }] };
    // Audio 48.5 s is song 46.5 s; bar 11 starts at 44 s.
    const [n] = laneNotesToTake(audio, grid, notes, 11);
    expect(n!.start).toBeCloseTo(2.5, 6);
  });
});

describe("buildPart with a clip that starts in the middle of a bar", () => {
  /** 120 bpm in 4/4: 2 s a bar. */
  const fast: SongGrid = {
    barTimes: Array.from({ length: 32 }, (_, i) => i * 2000),
    beats: Array(32).fill(4),
  };
  const found = {
    // The clip starts at 1.25 s, which rounds to bar index 1 (downbeat 2 s).
    span: { startMs: 1250, endMs: 5000 },
    notes: [
      { start: 1.3, end: 1.6, pitch: 40, velocity: 90 },
      { start: 1.6, end: 1.9, pitch: 43, velocity: 90 },
      { start: 2.5, end: 3, pitch: 45, velocity: 90 },
    ],
  };
  const options = {
    instrument: "guitar" as const,
    tuning: [...STANDARD_GUITAR],
    laneName: "Lead guitar",
    barCount: 4,
  };

  const song = (): Score => {
    const score = createSong();
    while (score.masterBars.length < 4) appendMasterBar(score);
    return score;
  };

  it("uses the containing bar as the time origin so no note gets a negative time", () => {
    const part = buildPart(EMPTY_AUDIO, fast, found, options);
    expect(part.originBar).toBe(0);
    expect(part.take.every((n) => n.start >= 0)).toBe(true);
    expect(part.take[0]!.start).toBeCloseTo(1.3, 6);
  });

  it("keeps every note when the part is placed where the clip is", () => {
    const part = buildPart(EMPTY_AUDIO, fast, found, options);
    const score = song();
    const placed = placeTake(score, part.take, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: part.originBar,
    });
    expect(placed.warnings).toEqual([]);
    expect(placed.firstBar).toBe(0);
    expect(countNotes(score, 0, 0, 3)).toBe(3);
  });

  it("keeps every note when the player moves the part to a later bar", () => {
    const part = buildPart(EMPTY_AUDIO, fast, found, options);
    const score = song();
    const placed = placeTake(score, part.take, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: 1,
    });
    expect(placed.warnings).toEqual([]);
    expect(countNotes(score, 0, 0, 3)).toBe(3);
  });

  it("still rounds to the next bar when that loses no note", () => {
    // 1.95 s is just before the downbeat of bar 1: the first note is within the early grace.
    const part = buildPart(
      EMPTY_AUDIO,
      fast,
      {
        span: { startMs: 1950, endMs: 5000 },
        notes: [{ start: 2, end: 2.3, pitch: 40, velocity: 90 }],
      },
      options,
    );
    expect(part.originBar).toBe(1);
    expect(part.take[0]!.start).toBeCloseTo(0, 6);
  });
});

describe("time fields", () => {
  it("formats and parses times", async () => {
    const { formatTime, parseTime } = await import("@/lib/audio-lanes/lane-transcribe");
    expect(formatTime(48_000)).toBe("0:48.0");
    expect(formatTime(62_500)).toBe("1:02.5");
    expect(parseTime("0:48")).toBe(48_000);
    expect(parseTime("48.5")).toBe(48_500);
    expect(parseTime("1:02,5")).toBe(62_500);
    expect(parseTime("1:75")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("")).toBeNull();
  });
});
