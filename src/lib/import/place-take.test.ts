import { describe, expect, it } from "vitest";

import { placeTake, programFor } from "@/lib/import/place-take";
import type { RecordedNote } from "@/lib/import/recording";
import { appendMasterBar, cloneScore, refinish, type Score } from "@/lib/score/model";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { createSong, createTrack, insertTrack } from "@/lib/score/tracks";
import { shotOf } from "@/test/score-snapshot";

const note = (start: number, pitch: number, length = 0.2): RecordedNote => ({
  start,
  end: start + length,
  pitch,
  velocity: 90,
});

function song(bars: number): Score {
  const score = createSong();
  while (score.masterBars.length < bars) appendMasterBar(score);
  insertTrack(
    score,
    createTrack(score, {
      kind: "stringed",
      name: "Guitar 2",
      program: 25,
      tuning: [...STANDARD_GUITAR],
    }),
  );
  refinish(score);
  return score;
}

const NOTES = [note(0, 40), note(0.5, 43), note(1, 45), note(2.5, 47), note(4.1, 52)];

describe("placeTake", () => {
  it("writes on an existing track and reports the bars", () => {
    const score = song(4);
    const placed = placeTake(score, NOTES, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: 1,
    });
    expect(placed).toMatchObject({ track: 0, firstBar: 1, lastBar: 3, appended: 0 });
  });

  it("a preview on a copy equals the real write (guitar, new track)", () => {
    const live = song(4);
    const preview = cloneScore(live);
    const plan = {
      instrument: "guitar" as const,
      tuning: [...STANDARD_GUITAR],
      track: null,
      startBar: 2,
    };
    const a = placeTake(preview, NOTES, plan);
    const b = placeTake(live, NOTES, plan);
    expect(a).toEqual(b);
    expect(shotOf(preview)).toEqual(shotOf(live));
    expect(live.tracks).toHaveLength(3);
  });

  it("a piano gets a track for each hand", () => {
    const score = song(2);
    const notes = [note(0, 72), note(0.5, 76), note(1, 40), note(1.5, 43)];
    const placed = placeTake(score, notes, {
      instrument: "piano",
      tuning: [],
      track: null,
      startBar: 0,
    });
    expect(score.tracks).toHaveLength(4);
    expect(placed.track).toBe(2);
  });

  it("a piano with hands reaching different bars reports all bars written and the growth", () => {
    const score = song(4);
    // Right hand only in bar 1, left hand continues into bar 5 (4/4 at 120 bpm: 2 s a bar),
    // one bar past the four the song starts with.
    const notes = [note(0, 72), note(0.5, 76), note(1, 40), note(9, 43)];
    const placed = placeTake(score, notes, {
      instrument: "piano",
      tuning: [],
      track: null,
      startBar: 0,
    });
    expect(score.masterBars).toHaveLength(5);
    expect(placed).toMatchObject({ firstBar: 0, lastBar: 4, appended: 1 });
  });

  it("a drum take goes on a new drum track, named by the plan", () => {
    const score = song(2);
    placeTake(score, [note(0, 36), note(0.5, 38)], {
      instrument: "drums",
      tuning: [],
      track: null,
      startBar: 0,
      trackName: "From audio",
    });
    expect(score.tracks.at(-1)!.name).toBe("From audio");
    expect(score.tracks.at(-1)!.staves[0]!.isPercussion).toBe(true);
  });

  it("leaves the original alone when a copy is written", () => {
    const live = song(4);
    const before = JSON.stringify(shotOf(live));
    placeTake(cloneScore(live), NOTES, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 1,
      startBar: 0,
    });
    expect(JSON.stringify(shotOf(live))).toBe(before);
    expect(live.masterBars).toHaveLength(4);
  });

  it("programFor gives a bass its own sound", () => {
    expect(programFor("bass")).not.toBe(programFor("piano"));
  });
});

describe("cloneScore", () => {
  it("copies bars, tracks, tempo and notes into new objects", () => {
    const score = song(3);
    placeTake(score, NOTES, {
      instrument: "guitar",
      tuning: [...STANDARD_GUITAR],
      track: 0,
      startBar: 0,
    });
    const copy = cloneScore(score);
    expect(shotOf(copy)).toEqual(shotOf(score));
    expect(copy).not.toBe(score);
    expect(copy.tracks[0]).not.toBe(score.tracks[0]);
    expect(copy.masterBars[0]).not.toBe(score.masterBars[0]);
    const bars = score.masterBars.length;
    appendMasterBar(copy);
    expect(score.masterBars).toHaveLength(bars);
    expect(copy.masterBars).toHaveLength(bars + 1);
  });
});
