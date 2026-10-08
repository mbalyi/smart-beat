# Extended-range guitars, odd meters and nested tuplets (#43)

What Smart Beat does for djent, deathcore and other modern heavy writing, and what it does not.

## Strings and tunings

- A stringed track has **3 to 10 strings** (Track settings, or the instrument list when adding a track; 5 and 6 string basses are there too). Guitar Pro 8 offers the same range.
- Tuning presets, by string count (`tuningPresets` in `src/lib/score/music.ts`): alphaTab's own list (standard, tuned down, dropped D and C, open tunings, bass, banjo…) plus ours for guitars of 6 to 10 strings, named after the lowest string:
  - 6 strings: Drop C#, Drop B, Drop A#, Drop A (and alphaTab's Dropped D and C);
  - 7 strings: B standard (alphaTab's "Guitar 7 strings"), A# standard, A standard, Drop A, Drop G#, Drop G;
  - 8 strings: F# standard, F standard, E standard, Drop E, Drop D#, Drop D;
  - 9 strings: C# standard, C standard, B standard, Drop B, Drop A#, Drop A;
  - 10 strings: G# standard, G standard, F# standard, Drop F#, Drop F, Drop E.
  - A "drop" tuning is the same tuning with the lowest string a whole step lower. Anything else is **Custom** (the up and down buttons on every string).
- New strings are added a fourth below the lowest one. Changing the tuning can keep the pitches of the notes (they move to other frets) or keep the fret numbers.
- The editor takes frets 0 to 29. The fretboard view shows 24.

## Very low notes: the sound set warning

The bundled sounds are sampled (Sonivox and FluidR3 General MIDI). A guitar sound has recordings from some lowest pitch up; a note below that is the lowest recording played slower, which sounds thin and dull. Both sound sets claim every key from 0 to 127 for every guitar, so the key ranges say nothing; what matters is the **lowest pitch a sound was recorded at** (its samples' root keys).

- `pnpm ranges:report` reads those root keys from the SoundFonts (`melodicRootKeys` in `src/lib/score/sf2-keys.ts`) and writes `src/lib/audio/sound-ranges.json` (per sound set, per General MIDI program). The table is committed, so the app does not parse a SoundFont for this. A test keeps the table in step with the SoundFonts.
- `lowSoundWarning` (`src/lib/audio/sound-ranges.ts`) warns when the lowest sounding pitch (lowest string plus capo) is **below B1** (the low string of a standard seven string) and **more than an octave below the lowest recording** of the track's sound. B1 is there because some sounds are one recording stretched over the whole keyboard (Sonivox's jazz guitar, for one): the usual guitar range is that sound set's limit, not a choice of tuning.
- Where: under the tuning in the track settings, and as a small warning mark next to the track in the track list. It says which sound set covers the pitch better when the other one does (FluidR3 goes lower than Sonivox: its guitars start at E2, its basses at E1, Sonivox's electric guitar at B2).
- The warning never blocks anything.

## Odd time signatures, polyrhythm and polymeter

- The Bar dialog takes 1 to 32 beats over 1, 2, 4, 8, 16 or 32 (5/8, 7/8, 11/16, 15/16…). Empty bars get one rest per beat of the signature. Bar length checks ("incomplete bars") are based on ticks, so every signature works the same way.
- **Polyrhythm** is written with tuplets (3:2 up to 13:8) and with nested tuplets (below).
- **Polymeter is not supported.** alphaTab keeps one time signature for all tracks (it sits on the master bar), so a 7/8 guitar against 4/4 drums cannot be written as two meters. The usual workaround is to write the pattern across the bar lines with ties, in the common meter. A per-track meter would need our own score renderer and player.

## Nested tuplets

A tuplet inside a tuplet is one flat ratio in alphaTab: the ratios multiply. The tuplet menu has **Nested…**: pick the outer and the inner tuplet and Smart Beat sets the combined ratio on the selected notes (a triplet of triplets is 9 notes in the time of 4, a quintuplet inside a triplet 15 in the time of 8).

- Timing and playback follow the ratio (alphaTab rounds each note to whole ticks, a few ticks over the group).
- The score draws **one bracket** for the whole group, not one inside another.
- Guitar Pro 3–5 files only hold 3:2, 5–7:4 and 9–13:8. Any other ratio is saved as plain notes and the save says so. Guitar Pro 7/8 files, MusicXML and MuseScore carry both numbers.
- Tests: `src/lib/score/extended-range.test.ts` (timing in alphaTab's MIDI, exports), `e2e/extended-range.spec.ts`.
