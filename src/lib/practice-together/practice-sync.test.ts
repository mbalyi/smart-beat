import { describe, expect, it } from "vitest";

import {
  actionsFor,
  commandOf,
  sameSettings,
  settingsOf,
} from "@/lib/practice-together/practice-sync";
import { initialPractice, practiceReducer, type PracticeState } from "@/lib/score/practice";

const base = (): PracticeState => initialPractice({ metronome: false, countIn: false });

describe("settingsOf / commandOf", () => {
  it("reads the shared settings, with no loop when none is set", () => {
    const state = { ...base(), speed: 80, metronome: true, countInBeats: 4 };
    expect(settingsOf(state)).toEqual({
      speed: 80,
      loop: null,
      metronome: true,
      countIn: false,
      countInBeats: 4,
    });
  });

  it("reads the loop as bars", () => {
    const state: PracticeState = { ...base(), loop: true, range: { start: 2, end: 5 } };
    expect(commandOf("play", 960, state)).toMatchObject({
      action: "play",
      tick: 960,
      loop: { from: 2, to: 5 },
    });
  });
});

describe("actionsFor", () => {
  const command = (over = {}) => ({
    id: 1,
    at: 0,
    ...commandOf("play", 0, base()),
    ...over,
  });

  it("needs nothing when the guest already matches", () => {
    expect(actionsFor(base(), command())).toEqual([]);
  });

  it("brings the guest to the host's settings", () => {
    const cmd = command({
      speed: 70,
      loop: { from: 1, to: 3 },
      metronome: true,
      countIn: true,
      countInBeats: 2,
    });
    const actions = actionsFor(base(), cmd);
    const result = actions.reduce(practiceReducer, base());
    expect(settingsOf(result)).toEqual({
      speed: 70,
      loop: { from: 1, to: 3 },
      metronome: true,
      countIn: true,
      countInBeats: 2,
    });
  });

  it("clears a loop the host does not have", () => {
    const guest: PracticeState = { ...base(), loop: true, range: { start: 0, end: 1 } };
    const result = actionsFor(guest, command()).reduce(practiceReducer, guest);
    expect(result.loop).toBe(false);
  });

  it("ends the guest's own Speed Trainer, as the host's speeds are sent to it", () => {
    const guest = practiceReducer(base(), {
      type: "start-trainer",
      trainer: { from: 60, to: 100, step: 10, loopsPerStep: 1 },
      range: { start: 0, end: 1 },
    });
    const result = actionsFor(guest, command({ loop: { from: 0, to: 1 }, speed: 60 })).reduce(
      practiceReducer,
      guest,
    );
    expect(result.trainer).toBeNull();
    expect(result.speed).toBe(60);
  });
});

describe("sameSettings", () => {
  it("tells when a settings command is due", () => {
    expect(sameSettings(base(), base())).toBe(true);
    expect(sameSettings(base(), { ...base(), speed: 90 })).toBe(false);
    expect(sameSettings(base(), { ...base(), loop: true, range: { start: 0, end: 2 } })).toBe(
      false,
    );
    const looped: PracticeState = { ...base(), loop: true, range: { start: 1, end: 2 } };
    expect(sameSettings(looped, { ...looped, range: { start: 1, end: 3 } })).toBe(false);
    expect(sameSettings(looped, { ...looped })).toBe(true);
    // A range left over from an earlier loop does not count while looping is off.
    expect(sameSettings(base(), { ...base(), range: { start: 4, end: 9 } })).toBe(true);
  });
});
