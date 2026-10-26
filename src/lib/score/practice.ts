/**
 * Practice tools, as in Guitar Pro 5: loop a range of bars, slow the song
 * down or speed it up, let the Speed Trainer raise the speed a step after
 * each loop, and play a metronome and a count-in.
 */

export const MIN_SPEED = 25;
export const MAX_SPEED = 200;
/** Speeds offered in the menu, in percent. */
export const SPEED_PRESETS = [25, 50, 60, 70, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

/** Bars to loop, 0-based and inclusive. */
export interface LoopRange {
  start: number;
  end: number;
}

export interface SpeedTrainer {
  /** Percent to start from. */
  from: number;
  /** Percent to reach. */
  to: number;
  /** Percent added each step. */
  step: number;
  /** Loops played at each speed before the next step. */
  loopsPerStep: number;
  /** A bar counted in before every loop, not only the first (#83; native engine). */
  countInBetween?: boolean;
}

/** Beats a count-in can last (#182). */
export const COUNT_IN_BEATS = [1, 2, 4, 6, 8, 12] as const;
export const DEFAULT_COUNT_IN_BEATS = 4;

/** The metronome sounds of the native engine (`ClickSound` in `src-tauri/src/audio/engine.rs`). */
export const CLICK_SOUNDS = [
  { id: "classic", label: "Classic beep" },
  { id: "woodblock", label: "Woodblock" },
  { id: "cowbell", label: "Cowbell" },
  { id: "bell", label: "Bell" },
] as const;
export type ClickSoundId = (typeof CLICK_SOUNDS)[number]["id"];
export const DEFAULT_CLICK_SOUND: ClickSoundId = "classic";

/** The metronome volume, 1 = as loud as the master volume (alphaTab and the engine allow 3). */
export const MAX_METRONOME_VOLUME = 3;

const isCountInBeats = (value: unknown): value is number =>
  COUNT_IN_BEATS.some((beats) => beats === value);
const isClickSound = (value: unknown): value is ClickSoundId =>
  CLICK_SOUNDS.some((sound) => sound.id === value);
const metronomeVolumeOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_METRONOME_VOLUME, Math.max(0, value))
    : 1;

export interface PracticeState {
  loop: boolean;
  range: LoopRange;
  /** Playback speed in percent (100 = as written). */
  speed: number;
  /**
   * Set while the Speed Trainer runs. `holding`: it stays at this speed and keeps looping
   * ("Stay at this speed", #83) until it is resumed.
   */
  trainer: (SpeedTrainer & { loopsAtSpeed: number; holding: boolean }) | null;
  metronome: boolean;
  countIn: boolean;
  /** Beats of the count-in (#182). */
  countInBeats: number;
  metronomeSound: ClickSoundId;
  /** 1 = as loud as the master volume, up to {@link MAX_METRONOME_VOLUME}. */
  metronomeVolume: number;
  /** Stop inside a loop makes the next Play start at the loop start; Pause still resumes (#93). */
  restartOnStop: boolean;
}

export const DEFAULT_TRAINER: SpeedTrainer = { from: 60, to: 100, step: 10, loopsPerStep: 1 };

export const initialPractice = (prefs: Partial<PracticePrefs> = {}): PracticeState => ({
  loop: false,
  range: { start: 0, end: 0 },
  speed: 100,
  trainer: null,
  metronome: prefs.metronome ?? false,
  countIn: prefs.countIn ?? false,
  countInBeats: prefs.countInBeats ?? DEFAULT_COUNT_IN_BEATS,
  metronomeSound: prefs.metronomeSound ?? DEFAULT_CLICK_SOUND,
  metronomeVolume: prefs.metronomeVolume ?? 1,
  restartOnStop: prefs.restartOnStop ?? true,
});

export type PracticeAction =
  | { type: "loop"; value: boolean; range?: LoopRange }
  | { type: "range"; range: LoopRange }
  | { type: "speed"; value: number }
  | { type: "start-trainer"; trainer: SpeedTrainer; range: LoopRange }
  | { type: "stop-trainer" }
  /** Stay at the current speed (true) or go on speeding up (false). */
  | { type: "hold-trainer"; value: boolean }
  /** Playback reached the end of the loop and starts it again. */
  | { type: "loop-completed" }
  | { type: "metronome"; value: boolean }
  | { type: "count-in-beats"; value: number }
  | { type: "metronome-sound"; value: ClickSoundId }
  | { type: "metronome-volume"; value: number }
  | { type: "count-in"; value: boolean }
  | { type: "restart-on-stop"; value: boolean }
  /** The song's bars changed (edits): keep the range inside it. */
  | { type: "bar-count"; count: number };

export const clampSpeed = (percent: number) =>
  Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(percent) ? percent : 100)));

/** A valid range inside a song of `barCount` bars, start ≤ end. */
export function normalizeRange(range: LoopRange, barCount: number): LoopRange {
  const last = Math.max(0, barCount - 1);
  const clamp = (bar: number) =>
    Number.isFinite(bar) ? Math.min(last, Math.max(0, Math.round(bar))) : 0;
  const a = clamp(range.start);
  const b = clamp(range.end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** Keeps the trainer's numbers sensible (from ≤ to, positive step). */
export function normalizeTrainer(trainer: SpeedTrainer): SpeedTrainer {
  const from = clampSpeed(trainer.from);
  const to = Math.max(from, clampSpeed(trainer.to));
  return {
    from,
    to,
    step: Math.min(MAX_SPEED, Math.max(1, Math.round(trainer.step) || 1)),
    loopsPerStep: Math.min(20, Math.max(1, Math.round(trainer.loopsPerStep) || 1)),
    countInBetween: trainer.countInBetween === true,
  };
}

export function practiceReducer(state: PracticeState, action: PracticeAction): PracticeState {
  switch (action.type) {
    case "loop":
      return {
        ...state,
        loop: action.value,
        range: action.range ?? state.range,
        trainer: action.value ? state.trainer : null,
      };
    case "range":
      return { ...state, range: action.range };
    case "speed":
      return { ...state, speed: clampSpeed(action.value), trainer: null };
    case "start-trainer": {
      const trainer = normalizeTrainer(action.trainer);
      return {
        ...state,
        loop: true,
        range: action.range,
        speed: trainer.from,
        trainer: { ...trainer, loopsAtSpeed: 0, holding: false },
      };
    }
    case "hold-trainer":
      if (!state.trainer) return state;
      // Resuming counts the loops at this speed afresh.
      return { ...state, trainer: { ...state.trainer, holding: action.value, loopsAtSpeed: 0 } };
    // Stopping ends the practice run: no loop and the normal tempo again.
    case "stop-trainer":
      return { ...state, trainer: null, loop: false, speed: 100 };
    case "loop-completed": {
      const trainer = state.trainer;
      if (!trainer || !state.loop || trainer.holding) return state;
      const loopsAtSpeed = trainer.loopsAtSpeed + 1;
      if (loopsAtSpeed < trainer.loopsPerStep || state.speed >= trainer.to) {
        return { ...state, trainer: { ...trainer, loopsAtSpeed } };
      }
      return {
        ...state,
        speed: Math.min(trainer.to, state.speed + trainer.step),
        trainer: { ...trainer, loopsAtSpeed: 0 },
      };
    }
    case "metronome":
      return { ...state, metronome: action.value };
    case "count-in":
      return { ...state, countIn: action.value };
    case "count-in-beats":
      return isCountInBeats(action.value) ? { ...state, countInBeats: action.value } : state;
    case "metronome-sound":
      return isClickSound(action.value) ? { ...state, metronomeSound: action.value } : state;
    case "metronome-volume":
      return { ...state, metronomeVolume: metronomeVolumeOf(action.value) };
    case "restart-on-stop":
      return { ...state, restartOnStop: action.value };
    case "bar-count":
      return { ...state, range: normalizeRange(state.range, action.count) };
  }
}

/** "Bars 3–4", "Bar 2". */
export function describeRange({ start, end }: LoopRange): string {
  return start === end ? `Bar ${start + 1}` : `Bars ${start + 1}–${end + 1}`;
}

const STORAGE_KEY = "smart-beat:practice";

/** Metronome and count-in are remembered, like in Guitar Pro. */
export interface PracticePrefs {
  metronome: boolean;
  countIn: boolean;
  countInBeats: number;
  metronomeSound: ClickSoundId;
  metronomeVolume: number;
  restartOnStop: boolean;
}

export function readPracticePrefs(): PracticePrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return {
      metronome: stored.metronome === true,
      countIn: stored.countIn === true,
      countInBeats: isCountInBeats(stored.countInBeats)
        ? stored.countInBeats
        : DEFAULT_COUNT_IN_BEATS,
      metronomeSound: isClickSound(stored.metronomeSound)
        ? stored.metronomeSound
        : DEFAULT_CLICK_SOUND,
      metronomeVolume: metronomeVolumeOf(stored.metronomeVolume),
      restartOnStop: stored.restartOnStop !== false,
    };
  } catch {
    return {
      metronome: false,
      countIn: false,
      countInBeats: DEFAULT_COUNT_IN_BEATS,
      metronomeSound: DEFAULT_CLICK_SOUND,
      metronomeVolume: 1,
      restartOnStop: true,
    };
  }
}

export function storePracticePrefs(prefs: PracticePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable (private mode): the defaults apply next time.
  }
}
