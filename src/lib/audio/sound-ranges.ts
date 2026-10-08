/**
 * How low a sound can go before it stops sounding like itself. The bundled
 * SoundFonts are sampled: a guitar sound has recordings from some lowest
 * pitch up, and a note below that is the lowest recording played back slower,
 * which sounds thin and dull. An 8, 9 or 10 string guitar or a very low
 * tuning goes well below the recordings, so the track settings warn.
 *
 * The lowest recorded pitch of every program is in `sound-ranges.json`,
 * written by `pnpm ranges:report` from the SoundFonts.
 */
import { pitchName } from "@/lib/score/music";
import { SOUNDFONTS, type SoundFontId } from "@/lib/score/soundfonts";
import ranges from "@/lib/audio/sound-ranges.json";

/** How far below the lowest recording a note may be before it is called thin (an octave). */
export const SEMITONES_BELOW_RECORDING = 12;

/**
 * Only pitches below this (B1, the low string of a standard seven string) are
 * warned about. Some sounds are a single recording stretched over the whole
 * keyboard; the usual guitar range is that sound set's limit, not a choice of
 * the tuning, so it is not reported on every track.
 */
export const USUAL_GUITAR_FLOOR = 35;

const table = ranges as Partial<Record<SoundFontId, Record<string, number>>>;

/** The lowest pitch (MIDI) a sound was recorded at, or null when unknown. */
export function lowestRecording(soundFont: SoundFontId, program: number): number | null {
  return table[soundFont]?.[String(program)] ?? null;
}

/** Whether `lowest` is below the usual guitar range and more than an octave below the sound's lowest recording. */
const isThin = (soundFont: SoundFontId, program: number, lowest: number) => {
  const root = lowestRecording(soundFont, program);
  return root !== null && lowest < USUAL_GUITAR_FLOOR && lowest < root - SEMITONES_BELOW_RECORDING;
};

export interface LowSoundWarning {
  /** What is wrong, in a sentence. */
  message: string;
  /** The lowest string, as a note name ("F#1"). */
  lowest: string;
  /** The lowest pitch the sound was recorded at ("B2"). */
  recorded: string;
  /** A sound set that covers the pitch better, if the other one does. */
  betterSoundFont: SoundFontId | null;
}

/**
 * A warning when `lowestPitch` (MIDI) is below the usual guitar range and more
 * than an octave below the lowest recording of `program` in the chosen sound
 * set, otherwise null. Says which other sound set does better, when there is
 * one.
 */
export function lowSoundWarning(
  soundFont: SoundFontId,
  program: number,
  lowestPitch: number,
): LowSoundWarning | null {
  if (!isThin(soundFont, program, lowestPitch)) return null;
  const root = lowestRecording(soundFont, program)!;
  const better =
    SOUNDFONTS.find((f) => f.id !== soundFont && !isThin(f.id, program, lowestPitch))?.id ?? null;
  const lowest = pitchName(lowestPitch);
  const recorded = pitchName(root);
  const advice = better
    ? ` The “${SOUNDFONTS.find((f) => f.id === better)!.label}” sound set covers it better.`
    : " It may help to use a bass sound for this track.";
  return {
    message: `The lowest string (${lowest}) is more than an octave below the lowest recording of this sound (${recorded}). It will sound thin.${advice}`,
    lowest,
    recorded,
    betterSoundFont: better,
  };
}
