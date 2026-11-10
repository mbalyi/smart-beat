/**
 * A drum track's kit (#229). alphaTab stores the drum of a note in
 * `note.percussionArticulation` in one of two ways:
 *
 * - the track has no articulations of its own (Guitar Pro 3–5 and MIDI files,
 *   new drum tracks): the value is the drum number itself (36 kick, 38 snare…),
 *   an articulation of alphaTab's default kit;
 * - the track has its own list (Guitar Pro 6+ files, alphaTex): the value is an
 *   index into `track.percussionArticulations`.
 *
 * A Guitar Pro 7 file only has the second form. alphaTab's writer gets the first
 * one wrong: it writes its whole default kit as the track's list but keeps each
 * note's drum number, which the file then reads as an index (36 → the 37th
 * articulation, "Bongo High (slap)", which plays 60). {@link withWritableDrumKits}
 * turns every drum track into the second form while a file is written.
 */
import { exporter, importer, model, Settings } from "@coderline/alphatab";

type Articulation = model.InstrumentArticulation;
type Score = model.Score;
type Track = model.Track;

let defaultKit: readonly Articulation[] | null = null;

/**
 * alphaTab's default drum kit, in its order. alphaTab keeps it internal, but
 * writes all of it for a drum track without a kit of its own, so a tiny file
 * written and read back lists it (once, on first use).
 */
export function defaultDrumKit(): readonly Articulation[] {
  if (defaultKit) return defaultKit;
  const settings = new Settings();
  const probe = importer.ScoreLoader.loadAlphaTex(
    '\\track "Drums" \\instrument percussion \\articulation defaults :1 38',
    settings,
  );
  const track = probe.tracks[0]!;
  track.percussionArticulations = [];
  track.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.percussionArticulation = 38;
  const bytes = new exporter.Gp7Exporter().export(probe, settings);
  const read = importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  defaultKit = [...read.tracks[0]!.percussionArticulations];
  return defaultKit;
}

const copy = (a: Articulation): Articulation =>
  new model.InstrumentArticulation(
    a.elementType,
    a.staffLine,
    a.outputMidiNumber,
    a.noteHeadDefault,
    a.noteHeadHalf,
    a.noteHeadWhole,
    a.techniqueSymbol,
    a.techniqueSymbolPlacement,
    a.id,
  );

/**
 * The articulation of the default kit for a drum number, as a new object (a
 * plain notehead on the middle line, playing the number, if the kit has none).
 */
export function articulationForDrum(drum: number): Articulation {
  const known = defaultDrumKit().find((a) => a.id === drum);
  if (known) return copy(known);
  const { NoteheadBlack, NoteheadHalf, NoteheadWhole, None } = model.MusicFontSymbol;
  return new model.InstrumentArticulation(
    "Percussion",
    3,
    drum,
    NoteheadBlack,
    NoteheadHalf,
    NoteheadWhole,
    None,
    model.TechniqueSymbolPlacement.Outside,
    drum,
  );
}

/**
 * The index of the kit's articulation for a drum number, or -1: the one that
 * is that drum and plays it, else one that plays it, else one that is it (92
 * "Hi-Hat (half)" plays 46).
 */
export function kitIndexOf(kit: readonly Articulation[], drum: number): number {
  const exact = kit.findIndex((a) => a.id === drum && a.outputMidiNumber === drum);
  if (exact >= 0) return exact;
  const sounding = kit.findIndex((a) => a.outputMidiNumber === drum);
  return sounding >= 0 ? sounding : kit.findIndex((a) => a.id === drum);
}

/**
 * The value to store in `note.percussionArticulation` for a drum number on a
 * track: the number itself on a track without its own kit, else the index of
 * the kit's articulation for it, which is added to the kit when missing.
 */
export function drumValueFor(track: Track, drum: number): number {
  const kit = track.percussionArticulations;
  if (kit.length === 0) return drum;
  const own = kitIndexOf(kit, drum);
  if (own >= 0) return own;
  kit.push(articulationForDrum(drum));
  return kit.length - 1;
}

/**
 * The drum number of a drum note whatever its track's kit: the number of the
 * default kit's articulation it is (92 for "Hi-Hat (half)"), else the key it plays.
 */
export function drumIdOf(note: model.Note): number {
  const own = note.beat.voice.bar.staff.track.percussionArticulations[note.percussionArticulation];
  if (!own) return note.percussionArticulation;
  const known = defaultDrumKit().find((a) => a.id === own.id);
  return known?.outputMidiNumber === own.outputMidiNumber ? own.id : own.outputMidiNumber;
}

const isDrumTrack = (track: Track) =>
  track.isPercussion || track.staves.some((staff) => staff.isPercussion);

function drumNotes(track: Track): model.Note[] {
  const notes: model.Note[] = [];
  for (const staff of track.staves) {
    if (!staff.isPercussion) continue;
    for (const bar of staff.bars)
      for (const voice of bar.voices)
        for (const beat of voice.beats)
          for (const note of beat.notes) if (note.isPercussion) notes.push(note);
  }
  return notes;
}

/**
 * Runs `fn` (writing a Guitar Pro 7 file) with every drum note referring to an
 * articulation of its track's own kit: tracks without a kit get one with the
 * drums they use, and kits get the drums they lack. Puts the score back as it
 * was afterwards.
 */
export function withWritableDrumKits<T>(score: Score, fn: () => T): T {
  const undo: (() => void)[] = [];
  for (const track of score.tracks) {
    if (!isDrumTrack(track)) continue;
    const notes = drumNotes(track);
    const kit = track.percussionArticulations;
    const own = kit.length > 0;
    // A value past the end of the kit is a drum number (alphaTab looks it up by id).
    const loose = notes.filter((note) => !own || note.percussionArticulation >= kit.length);
    if (loose.length === 0) continue;
    const written = [...kit];
    const indexOf = new Map<number, number>();
    for (const note of loose) {
      const drum = note.percussionArticulation;
      if (indexOf.has(drum)) continue;
      const existing = own ? kitIndexOf(kit, drum) : -1;
      if (existing >= 0) {
        indexOf.set(drum, existing);
      } else {
        written.push(articulationForDrum(drum));
        indexOf.set(drum, written.length - 1);
      }
    }
    const values = loose.map((note) => note.percussionArticulation);
    track.percussionArticulations = written;
    loose.forEach(
      (note) => (note.percussionArticulation = indexOf.get(note.percussionArticulation)!),
    );
    undo.push(() => {
      track.percussionArticulations = kit;
      loose.forEach((note, i) => (note.percussionArticulation = values[i]!));
    });
  }
  try {
    return fn();
  } finally {
    for (const restore of undo) restore();
  }
}
