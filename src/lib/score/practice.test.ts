import {
  clampSpeed,
  describeRange,
  initialPractice,
  normalizeRange,
  normalizeTrainer,
  practiceReducer,
  readPracticePrefs,
  storePracticePrefs,
  type PracticeState,
} from "@/lib/score/practice";

const start = (overrides: Partial<PracticeState> = {}) => ({ ...initialPractice(), ...overrides });

describe("practice", () => {
  it("starts at normal speed without loop, using the remembered metronome and count-in", () => {
    expect(initialPractice()).toEqual({
      loop: false,
      range: { start: 0, end: 0 },
      speed: 100,
      trainer: null,
      metronome: false,
      countIn: false,
    });
    expect(initialPractice({ metronome: true, countIn: true })).toMatchObject({
      metronome: true,
      countIn: true,
    });
  });

  it("keeps speeds between 25% and 200%", () => {
    expect(clampSpeed(10)).toBe(25);
    expect(clampSpeed(250)).toBe(200);
    expect(clampSpeed(72.6)).toBe(73);
    expect(clampSpeed(Number.NaN)).toBe(100);
    expect(practiceReducer(start(), { type: "speed", value: 300 }).speed).toBe(200);
  });

  it("keeps loop ranges inside the song and in order", () => {
    expect(normalizeRange({ start: 5, end: 2 }, 10)).toEqual({ start: 2, end: 5 });
    expect(normalizeRange({ start: -3, end: 40 }, 10)).toEqual({ start: 0, end: 9 });
    expect(normalizeRange({ start: Number.NaN, end: 2 }, 10)).toEqual({ start: 0, end: 2 });
    expect(
      practiceReducer(start({ range: { start: 3, end: 8 } }), { type: "bar-count", count: 5 }),
    ).toMatchObject({ range: { start: 3, end: 4 } });
  });

  it("turns the loop on with a range, and off", () => {
    let state = practiceReducer(start(), {
      type: "loop",
      value: true,
      range: { start: 2, end: 3 },
    });
    expect(state).toMatchObject({ loop: true, range: { start: 2, end: 3 } });
    state = practiceReducer(state, { type: "range", range: { start: 1, end: 1 } });
    expect(state.range).toEqual({ start: 1, end: 1 });
    state = practiceReducer(state, { type: "loop", value: false });
    expect(state).toMatchObject({ loop: false, range: { start: 1, end: 1 } });
  });

  it("raises the speed a step after each loop until the target", () => {
    let state = practiceReducer(start(), {
      type: "start-trainer",
      trainer: { from: 60, to: 80, step: 15, loopsPerStep: 1 },
      range: { start: 0, end: 1 },
    });
    expect(state).toMatchObject({ loop: true, speed: 60, range: { start: 0, end: 1 } });

    state = practiceReducer(state, { type: "loop-completed" });
    expect(state.speed).toBe(75);
    state = practiceReducer(state, { type: "loop-completed" });
    expect(state.speed).toBe(80); // not past the target
    state = practiceReducer(state, { type: "loop-completed" });
    expect(state.speed).toBe(80);
    expect(state.trainer).not.toBeNull();
  });

  it("can wait several loops at each speed", () => {
    let state = practiceReducer(start(), {
      type: "start-trainer",
      trainer: { from: 50, to: 100, step: 10, loopsPerStep: 2 },
      range: { start: 0, end: 0 },
    });
    state = practiceReducer(state, { type: "loop-completed" });
    expect(state.speed).toBe(50);
    state = practiceReducer(state, { type: "loop-completed" });
    expect(state.speed).toBe(60);
  });

  it("stops the trainer when the speed or loop is changed by hand", () => {
    const training = practiceReducer(start(), {
      type: "start-trainer",
      trainer: { from: 50, to: 100, step: 10, loopsPerStep: 1 },
      range: { start: 0, end: 0 },
    });
    expect(practiceReducer(training, { type: "speed", value: 90 }).trainer).toBeNull();
    expect(practiceReducer(training, { type: "loop", value: false }).trainer).toBeNull();
    expect(practiceReducer(training, { type: "stop-trainer" })).toMatchObject({
      trainer: null,
      loop: false,
      speed: 100,
    });
    // Without a trainer, loops don't change the speed.
    expect(practiceReducer(start({ loop: true }), { type: "loop-completed" }).speed).toBe(100);
  });

  it("fixes trainer settings that make no sense", () => {
    expect(normalizeTrainer({ from: 120, to: 80, step: 0, loopsPerStep: 99 })).toEqual({
      from: 120,
      to: 120,
      step: 1,
      loopsPerStep: 20,
    });
    expect(normalizeTrainer({ from: Number.NaN, to: 90, step: 5.4, loopsPerStep: 0 })).toEqual({
      from: 100,
      to: 100,
      step: 5,
      loopsPerStep: 1,
    });
  });

  it("toggles the metronome and count-in", () => {
    let state = practiceReducer(start(), { type: "metronome", value: true });
    state = practiceReducer(state, { type: "count-in", value: true });
    expect(state).toMatchObject({ metronome: true, countIn: true });
  });

  it("describes ranges", () => {
    expect(describeRange({ start: 2, end: 2 })).toBe("Bar 3");
    expect(describeRange({ start: 0, end: 3 })).toBe("Bars 1–4");
  });

  it("remembers the metronome and count-in", () => {
    expect(readPracticePrefs()).toEqual({ metronome: false, countIn: false });
    storePracticePrefs({ metronome: true, countIn: false });
    expect(readPracticePrefs()).toEqual({ metronome: true, countIn: false });
    localStorage.setItem("smart-beat:practice", "{broken");
    expect(readPracticePrefs()).toEqual({ metronome: false, countIn: false });
  });
});
