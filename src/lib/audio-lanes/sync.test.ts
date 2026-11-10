import { describe, expect, it } from "vitest";

import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import {
  barAtTimelineMs,
  barsToFitAudio,
  clearSync,
  moveSyncPoint,
  resetPadding,
  segmentBpms,
  setZone,
  shiftPadding,
  snapMs,
  songMsAt,
  syncFromDetectedBeats,
  tempoChangesFromSync,
  timelineMsAt,
  timelineMsAtBar,
  toggleSyncPoint,
  type SongGrid,
} from "@/lib/audio-lanes/sync";

/** Eight bars of 4/4 at 120 bpm: 2 s a bar. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 8 }, (_, i) => i * 2000),
  beats: Array(8).fill(4),
};
const bpm = () => 120;

describe("grid mapping", () => {
  it("finds beats inside a bar", () => {
    expect(songMsAt(grid, 2, 0)).toBe(4000);
    expect(songMsAt(grid, 2, 2)).toBe(5000);
  });

  it("maps the score onto the audio straight when there are no sync points", () => {
    expect(timelineMsAt(EMPTY_AUDIO, grid, 3)).toBe(6000);
    expect(barAtTimelineMs(EMPTY_AUDIO, grid, 7000)).toBeCloseTo(3.5);
  });

  it("follows sync points", () => {
    const audio = { ...EMPTY_AUDIO, sync: [{ bar: 0, ms: 500 }] };
    expect(timelineMsAt(audio, grid, 0)).toBe(500);
    expect(timelineMsAt(audio, grid, 1)).toBe(2500);
  });

  it("snaps to the nearest bar or beat", () => {
    expect(snapMs(EMPTY_AUDIO, grid, 2900, "bar")).toBe(2000);
    expect(snapMs(EMPTY_AUDIO, grid, 2600, "beat")).toBe(2500);
  });
});

describe("sync points", () => {
  it("adds a point on a beat and removes it again", () => {
    const added = toggleSyncPoint(EMPTY_AUDIO, grid, 2, 1);
    expect(added.sync).toEqual([{ bar: 2, beat: 1, ms: 4500 }]);
    expect(toggleSyncPoint(added, grid, 2, 1).sync).toEqual([]);
  });

  it("keeps points inside the play zone", () => {
    const zoned = setZone(EMPTY_AUDIO, "end", 3);
    expect(toggleSyncPoint(zoned, grid, 5).sync).toEqual([]);
  });

  it("moves a point between its neighbours only", () => {
    const audio = {
      ...EMPTY_AUDIO,
      sync: [
        { bar: 0, ms: 0 },
        { bar: 1, ms: 2000 },
        { bar: 2, ms: 4000 },
      ],
    };
    expect(moveSyncPoint(audio, 1, 0, 9000).sync[1]!.ms).toBe(3999);
    expect(moveSyncPoint(audio, 1, 0, 2100).sync[1]!.ms).toBe(2100);
  });

  it("clears every point", () => {
    expect(clearSync({ ...EMPTY_AUDIO, sync: [{ bar: 1, ms: 1 }] }).sync).toEqual([]);
  });

  it("drops points outside a narrowed zone", () => {
    const audio = {
      ...EMPTY_AUDIO,
      sync: [
        { bar: 1, ms: 2000 },
        { bar: 6, ms: 12000 },
      ],
    };
    expect(setZone(audio, "end", 4).sync).toEqual([{ bar: 1, ms: 2000 }]);
  });
});

describe("padding", () => {
  it("slides the audio against the grid and resets it", () => {
    const padded = shiftPadding(EMPTY_AUDIO, grid, 750);
    expect(timelineMsAt(padded, grid, 0)).toBe(750);
    expect(timelineMsAt(resetPadding(padded, grid), grid, 0)).toBe(0);
  });
});

describe("tempo from sync", () => {
  it("labels each segment with the tempo the audio plays it at", () => {
    const audio = {
      ...EMPTY_AUDIO,
      sync: [
        { bar: 0, ms: 0 },
        { bar: 2, ms: 3000 },
        { bar: 4, ms: 7000 },
      ],
    };
    const bpms = segmentBpms(audio, grid, bpm);
    expect(bpms[0]).toMatchObject({ bar: 0, bpm: 160 });
    expect(bpms[1]).toMatchObject({ bar: 2, bpm: 120 });
    expect(tempoChangesFromSync(audio, grid, bpm)).toEqual([
      { bar: 0, bpm: 160 },
      { bar: 2, bpm: 120 },
    ]);
  });
});

describe("timelineMsAtBar", () => {
  it("is the inverse of barAtTimelineMs inside the song", () => {
    for (const ms of [0, 1500, 7300, 13000]) {
      expect(
        timelineMsAtBar(EMPTY_AUDIO, grid, barAtTimelineMs(EMPTY_AUDIO, grid, ms)),
      ).toBeCloseTo(ms);
    }
  });
});

describe("syncFromDetectedBeats", () => {
  it("puts a sync point on every bar at the detected downbeats", () => {
    // Beats every 600 ms from 1 s into the file; the clip starts at 2 s on the timeline.
    const beats = Array.from({ length: 40 }, (_, i) => 1000 + i * 600);
    const clip = { startMs: 2000, playrate: 1, takes: [{ offsetMs: 0 }], take: 0 };
    const points = syncFromDetectedBeats(beats, grid, clip);
    expect(points[0]).toEqual({ bar: 0, ms: 3000 });
    expect(points[1]).toEqual({ bar: 1, ms: 3000 + 4 * 600 });
    expect(points).toHaveLength(8);
  });
});

describe("review regressions (sync)", () => {
  it("does not snap a point before the first bar to a made-up grid", () => {
    const padded = { ...EMPTY_AUDIO, sync: [{ bar: 0, ms: 1200 }] };
    expect(snapMs(padded, grid, 500, "beat")).toBe(500);
    expect(snapMs(padded, grid, 500, "bar")).toBe(500);
  });

  it("slides every sync point together and keeps their gaps at the start", () => {
    const audio = {
      ...EMPTY_AUDIO,
      sync: [
        { bar: 0, ms: 300 },
        { bar: 2, ms: 4300 },
      ],
    };
    expect(shiftPadding(audio, grid, -1000).sync).toEqual([
      { bar: 0, ms: 0 },
      { bar: 2, ms: 4000 },
    ]);
  });
});

describe("audio longer than the score", () => {
  // The app's grid: four bars of 2 s and the song's end at 8 s.
  const scored: SongGrid = { barTimes: [0, 2000, 4000, 6000, 8000], beats: [4, 4, 4, 4] };
  const withClip = (lengthMs: number) => ({
    ...EMPTY_AUDIO,
    sources: [{ id: "s", name: "a.wav", ext: "wav", embedded: true }],
    lanes: [{ ...newLane("A", "a"), clips: [newClip("s", "a.wav", 0, lengthMs, "c")] }],
  });

  it("places a point past the last bar on bars as long as the last one", () => {
    expect(barAtTimelineMs(EMPTY_AUDIO, scored, 12_000)).toBeCloseTo(6);
    expect(timelineMsAtBar(EMPTY_AUDIO, scored, 6.5)).toBeCloseTo(13_000);
    expect(songMsAt(scored, 7, 2)).toBe(15_000);
  });

  it("counts the bars the score lacks for its audio", () => {
    expect(barsToFitAudio(withClip(7000), scored, 4)).toBe(0);
    expect(barsToFitAudio(withClip(8000), scored, 4)).toBe(0);
    expect(barsToFitAudio(withClip(12_500), scored, 4)).toBe(3);
    expect(barsToFitAudio(EMPTY_AUDIO, scored, 4)).toBe(0);
  });
});
