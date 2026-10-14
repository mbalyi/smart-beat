/** What Record to Tab remembers between takes: the last choices in its dialog. */
import { STANDARD_GUITAR, tuningPresets } from "@/lib/score/music";

const PLAY_OTHERS_KEY = "smart-beat:record-play-others";
const TUNING_KEY = "smart-beat:record-tuning";
const BASS_TUNING_KEY = "smart-beat:record-tuning-bass";
const ALIGN_KEY = "smart-beat:record-align";
const INSTRUMENT_KEY = "smart-beat:record-instrument";
const ENGINE_KEY = "smart-beat:record-piano-engine";

/** The piano note finder: the built-in one, or the downloaded high-accuracy model (Transkun). */
export type PianoEngine = "standard" | "accurate";

/** What Record to Tab listens to: a guitar or a bass (tab), or a piano (two-hand staves). */
export type RecordInstrument = "guitar" | "bass" | "piano";

/** The strings of a take, in the note finder: a bass is heard like a guitar. */
export const stringsOnly = (instrument: RecordInstrument): boolean => instrument !== "piano";

/** Guitars the tuning picker offers; 7 and 8 strings are the extended-range guitars. */
export const RECORD_STRING_COUNTS = [6, 7, 8] as const;

/** Basses the tuning picker offers. */
export const RECORD_BASS_STRING_COUNTS = [4, 5, 6] as const;

/** A tuning picked by its string count and its preset's name. */
export interface TuningChoice {
  strings: number;
  name: string;
}

/** Play the song's other tracks along with the click (default: yes). */
export function readPlayOthers(): boolean {
  try {
    return localStorage.getItem(PLAY_OTHERS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function storePlayOthers(value: boolean) {
  try {
    localStorage.setItem(PLAY_OTHERS_KEY, value ? "1" : "0");
  } catch {
    // Not remembered: the default is used next time.
  }
}

/**
 * Click mode: shift the take by up to 80 ms so its notes line up with the beat (default: yes).
 * Off for a player who plays behind or ahead of the beat on purpose.
 */
export function readAlignToBeat(): boolean {
  try {
    return localStorage.getItem(ALIGN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function storeAlignToBeat(value: boolean) {
  try {
    localStorage.setItem(ALIGN_KEY, value ? "1" : "0");
  } catch {
    // Not remembered: the default is used next time.
  }
}

const standard = (strings: number): TuningChoice => ({
  strings,
  name: tuningPresets(strings)[0]?.name ?? "",
});

/** The tuning of a choice; the standard tuning of that many strings if the name is unknown. */
export function tuningOf({ strings, name }: TuningChoice): number[] {
  const presets = tuningPresets(strings);
  const found = presets.find((preset) => preset.name === name) ?? presets[0];
  return found ? [...found.tuning] : STANDARD_GUITAR.slice(0, strings);
}

/** The last tuning picked for a guitar or a bass, or the standard six or four strings. */
export function readTuningChoice(family: "guitar" | "bass" = "guitar"): TuningChoice {
  const counts: readonly number[] =
    family === "bass" ? RECORD_BASS_STRING_COUNTS : RECORD_STRING_COUNTS;
  try {
    const value = JSON.parse(
      localStorage.getItem(family === "bass" ? BASS_TUNING_KEY : TUNING_KEY) ?? "null",
    ) as Partial<TuningChoice>;
    if (
      value &&
      counts.includes(value.strings as number) &&
      typeof value.name === "string" &&
      tuningPresets(value.strings!).some((preset) => preset.name === value.name)
    ) {
      return { strings: value.strings!, name: value.name };
    }
  } catch {
    // Unreadable or no storage: standard.
  }
  return standard(family === "bass" ? 4 : 6);
}

export function storeTuningChoice(choice: TuningChoice, family: "guitar" | "bass" = "guitar") {
  try {
    localStorage.setItem(family === "bass" ? BASS_TUNING_KEY : TUNING_KEY, JSON.stringify(choice));
  } catch {
    // Not remembered: standard next time.
  }
}

/** The standard tuning's choice for a string count. */
export const standardTuningChoice = standard;

/** The last instrument picked (guitar by default). */
export function readInstrument(): RecordInstrument {
  try {
    const value = localStorage.getItem(INSTRUMENT_KEY);
    return value === "piano" || value === "bass" ? value : "guitar";
  } catch {
    return "guitar";
  }
}

export function storeInstrument(value: RecordInstrument) {
  try {
    localStorage.setItem(INSTRUMENT_KEY, value);
  } catch {
    // Not remembered: guitar next time.
  }
}

/** The last piano model picked (the built-in one by default). */
export function readPianoEngine(): PianoEngine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "accurate" ? "accurate" : "standard";
  } catch {
    return "standard";
  }
}

export function storePianoEngine(value: PianoEngine) {
  try {
    localStorage.setItem(ENGINE_KEY, value);
  } catch {
    // Not remembered: the built-in model next time.
  }
}
