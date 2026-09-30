import { importer, midi, Settings, type model } from "@coderline/alphatab";

import { adoptLyrics } from "@/lib/score/lyrics";
import { refinish } from "@/lib/score/model";
import { adoptTrack } from "@/lib/score/score";

/** A score written in alphaTex, prepared like an opened file. */
export function texScore(tex: string): model.Score {
  const score = importer.ScoreLoader.loadAlphaTex(tex, new Settings());
  for (const track of score.tracks) {
    adoptTrack(track);
    adoptLyrics(track);
  }
  refinish(score);
  return score;
}

/** The MIDI alphaTab's player would play, and its tick lookup (bars in playing order). */
export function generateMidi(score: model.Score) {
  const file = new midi.MidiFile();
  const handler = new midi.AlphaSynthMidiFileHandler(file);
  const generator = new midi.MidiFileGenerator(score, new Settings(), handler);
  generator.generate();
  return { file, lookup: generator.tickLookup };
}

/** Bars (0-based) in the order the player plays them: repeats, endings and jumps applied. */
export const playedBars = (score: model.Score) =>
  generateMidi(score).lookup.masterBars.map((bar) => bar.masterBar.index);

/** The note-on events of the generated MIDI. */
export const noteOns = (file: midi.MidiFile) =>
  file.tracks.flatMap((track) =>
    track.events.filter((event): event is midi.NoteOnEvent => event instanceof midi.NoteOnEvent),
  );
