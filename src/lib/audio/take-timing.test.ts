import { describe, expect, it } from "vitest";

import {
  contextToPerformance,
  countInSeconds,
  downbeatInTake,
  offsetNotes,
  shiftNotes,
} from "@/lib/audio/take-timing";
import type { RecordedNote } from "@/lib/import/recording";

const note = (start: number, end: number): RecordedNote => ({
  start,
  end,
  pitch: 40,
  velocity: 0.8,
});

describe("contextToPerformance", () => {
  it("moves a context time to the performance clock", () => {
    const stamp = { contextTime: 10, performanceTime: 5000 };
    expect(contextToPerformance(10, stamp)).toBe(5000);
    expect(contextToPerformance(10.25, stamp)).toBe(5250);
    expect(contextToPerformance(9.5, stamp)).toBe(4500);
  });
});

describe("countInSeconds", () => {
  it("is the beats of the bar at the tempo", () => {
    // 4 beats of 0.5 s (120 BPM).
    expect(countInSeconds(4, 0.5)).toBe(2);
  });

  it("lasts longer at a lower speed", () => {
    expect(countInSeconds(4, 0.5, 0.5)).toBe(4);
  });
});

describe("downbeatInTake", () => {
  const base = {
    playStartedAt: 10_000,
    countIn: 2,
    takeStartedAt: 9_000,
    outputLatency: 0,
    inputLatency: 0,
  };

  it("is when the count-in ends, counted from the take's first sample", () => {
    expect(downbeatInTake(base)).toBeCloseTo(3, 6);
  });

  it("adds the output latency: the click is heard later", () => {
    expect(downbeatInTake({ ...base, outputLatency: 0.04 })).toBeCloseTo(3.04, 6);
  });

  it("adds the input latency: the sample holds older sound", () => {
    expect(downbeatInTake({ ...base, inputLatency: 0.01 })).toBeCloseTo(3.01, 6);
  });

  it("works when the take started after playback", () => {
    expect(downbeatInTake({ ...base, takeStartedAt: 10_500 })).toBeCloseTo(1.5, 6);
  });
});

describe("shiftNotes", () => {
  it("makes the downbeat time 0", () => {
    expect(shiftNotes([note(3, 3.5), note(3.5, 4)], 3)).toEqual([note(0, 0.5), note(0.5, 1)]);
  });

  it("drops what was played in the count-in", () => {
    expect(shiftNotes([note(1, 1.4), note(3, 3.5)], 3)).toEqual([note(0, 0.5)]);
  });

  it("starts a note that began before the downbeat at 0", () => {
    expect(shiftNotes([note(2.9, 3.5)], 3)).toEqual([note(0, 0.5)]);
  });

  it("turns time played at half speed into the music's time", () => {
    expect(shiftNotes([note(5, 6)], 3, 0.5)).toEqual([note(1, 1.5)]);
  });

  it("does not change the notes it was given", () => {
    const input = [note(3, 3.5)];
    shiftNotes(input, 3);
    expect(input).toEqual([note(3, 3.5)]);
  });
});

describe("offsetNotes", () => {
  it("moves every note", () => {
    expect(offsetNotes([note(0.5, 1)], -0.05)).toEqual([note(0.45, 0.95)]);
  });

  it("keeps notes at or after 0", () => {
    expect(offsetNotes([note(0.02, 0.5)], -0.05)).toEqual([note(0, 0.45)]);
  });
});
