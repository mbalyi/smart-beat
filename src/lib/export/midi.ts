/** Standard MIDI file export, using alphaTab's generator (the same MIDI its player plays). */
import { midi, Settings } from "@coderline/alphatab";

import type { Score } from "@/lib/score/model";

/**
 * A type 1 MIDI file: one MIDI track per Smart Beat track, with tempo and time
 * signature changes. Repeats, endings and jumps are played out, exactly as
 * playback does, so the file sounds like the song.
 */
export function writeMidi(score: Score): Uint8Array {
  const file = new midi.MidiFile();
  file.format = midi.MidiFileFormat.MultiTrack;
  // "SMF1 mode": only standard events, no alphaTab extensions that other programs ignore.
  const handler = new midi.AlphaSynthMidiFileHandler(file, true);
  new midi.MidiFileGenerator(score, new Settings(), handler).generate();
  return file.toBinary();
}
