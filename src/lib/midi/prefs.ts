import type { MidiRecordMode } from "@/lib/midi/record";

/** Where a MIDI recording goes when it stops. */
export type MidiDestination = "lane" | "newLane" | "tab";

/** What MIDI recording remembers between takes (ADR 0006). */
export interface MidiRecordPrefs {
  mode: MidiRecordMode;
  /** Where the take starts: at the playhead, punched into the selected bars, or looping them. */
  span: "playhead" | "punch" | "loop";
  countIn: boolean;
  preRollBars: number;
  destination: MidiDestination;
  /** Line the notes up with a 1/16 grid as they are recorded (the played timing is kept). */
  inputQuantize: boolean;
  /** The velocity of the on-screen pads and the computer keyboard (1 … 127). */
  padVelocity: number;
  /** The computer keyboard plays notes while a MIDI lane is armed. */
  computerKeyboard: boolean;
}

const KEY = "smart-beat:midi-record";
const MODES: readonly MidiRecordMode[] = ["take", "overdub", "replace", "touch", "latch"];

export const DEFAULT_MIDI_PREFS: MidiRecordPrefs = {
  mode: "take",
  span: "playhead",
  countIn: true,
  preRollBars: 1,
  destination: "lane",
  inputQuantize: false,
  padVelocity: 100,
  computerKeyboard: false,
};

/** The remembered choices, each checked (a damaged value falls back to its default). */
export function readMidiPrefs(): MidiRecordPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<MidiRecordPrefs> | null;
    if (!v) return DEFAULT_MIDI_PREFS;
    const d = DEFAULT_MIDI_PREFS;
    return {
      mode: MODES.includes(v.mode as MidiRecordMode) ? (v.mode as MidiRecordMode) : d.mode,
      span: v.span === "punch" || v.span === "loop" ? v.span : "playhead",
      countIn: v.countIn !== false,
      preRollBars: [0, 1, 2].includes(v.preRollBars as number) ? v.preRollBars! : d.preRollBars,
      destination: v.destination === "newLane" || v.destination === "tab" ? v.destination : "lane",
      inputQuantize: v.inputQuantize === true,
      padVelocity:
        typeof v.padVelocity === "number" && v.padVelocity >= 1 && v.padVelocity <= 127
          ? Math.round(v.padVelocity)
          : d.padVelocity,
      computerKeyboard: v.computerKeyboard === true,
    };
  } catch {
    return DEFAULT_MIDI_PREFS;
  }
}

export function storeMidiPrefs(prefs: MidiRecordPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered: the defaults are used next time.
  }
}

/**
 * The computer keyboard as a small piano: the middle letter row (A S D F G H J K L) plays the white
 * keys from C, the row above (W E T Y U O P) the black keys; Z and X move an octave down and up.
 * Returns the semitone above the base C, or null for other keys.
 */
const KEYBOARD: Readonly<Record<string, number>> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
};

export function keyboardSemitone(key: string): number | null {
  return KEYBOARD[key.toLowerCase()] ?? null;
}
