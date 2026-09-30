# File formats

What Smart Beat opens, saves and exports, and what each format cannot hold.

| Format              | Extensions           | Open               | Save / export                           |
| ------------------- | -------------------- | ------------------ | --------------------------------------- |
| Guitar Pro 7/8      | `.gp`                | Yes                | **Native format**: File › Save, Save As |
| Guitar Pro 5        | `.gp5`               | Yes                | File › Save As (limits below)           |
| Guitar Pro 3, 4, 6  | `.gp3` `.gp4` `.gpx` | Yes                | No: Save asks for a new `.gp` file      |
| MusicXML (partwise) | `.musicxml` `.xml`   | Yes (via alphaTab) | File › Export › MusicXML                |
| Standard MIDI       | `.mid` `.midi`       | Yes (own importer) | File › Export › MIDI                    |
| ASCII tab           | `.txt`               | No                 | File › Export › ASCII tab               |

Songs opened from MIDI or MusicXML are _converted_: Save never overwrites the original file, it asks for a new `.gp` file.

## Native format: Guitar Pro 7 (`.gp`)

The native format is a Guitar Pro 7 file. It is an open container (a ZIP archive holding an XML score and small configuration files), it is written by alphaTab's exporter (MPL-2.0, the library Smart Beat already uses to read and render scores), and Guitar Pro 7 and 8 open it. Choosing it over a format of our own means files are not locked to Smart Beat, and everything alphaTab can write (techniques, chords, sections, repeats, tempo changes, lyrics) survives.

The mixer (volume, pan, mute, solo of each track) is written into the file. The master volume is not: a `.gp` file has no place for it.

## Guitar Pro 5 (`.gp5`)

The writer (`src/lib/export/gp5/writer.ts`) produces version 5.00 files. Everything Guitar Pro 5 has is saved: notes, rests, dots, tuplets, ties, bends, slides, harmonics, trills, tremolo picking, grace notes, vibrato, palm mute, let ring, hammer-ons and pull-offs, dynamics, accents, brushes, pick strokes, text, chords, lyrics (one track), repeats, alternate endings, sections, jumps (Coda, Segno, D.C., D.S.), key and time signatures, tempo changes, tunings, capos and each track's sound and mix.

What Guitar Pro 5 cannot hold is reported after saving ("saved with limits"):

- tracks without strings (piano, other instruments): saved as a seven-string track without tablature;
- more than seven strings, frets above 24, more than two voices, more than six simultaneous drum notes;
- double-dotted notes (saved with one dot), tuplets other than 3, 5-7, 9-13, notes shorter than a 64th;
- lyrics of more than one track, dotted and Scottish triplet feels, feedback harmonics.

Text is written as UTF-8. Guitar Pro 5 itself expects Windows-1252, so accented characters in titles may look wrong there.

### How the writer was made (clean-room notes)

The rules in [licensing.md](licensing.md) apply: nothing was copied or ported from TuxGuitar (LGPL-2.1) or PyGuitarPro (LGPL-3.0), and their source code was not read for this feature. The layout of the file was written down from community format descriptions and then checked against alphaTab's GP3–GP5 importer (MPL-2.0, a dependency we are allowed to use), whose field order was used to confirm details such as the bar and track headers. No code was taken from it; the writer is original code in TypeScript.

Verification is by round trip (`writer.test.ts`): songs are saved and read back with alphaTab, and the music (notes, strings and frets, durations, tuplets, tempo, repeats, endings, sections, lyrics, chords, techniques) must be identical. **Still to do by hand:** open files written by Smart Beat in Guitar Pro 5 (Windows or macOS) and TuxGuitar, as the licensing doc requires. Only alphaTab was available for the automated tests.

## MusicXML

Export (`src/lib/export/musicxml.ts`) writes score-partwise 3.1 with one part per track: pitches (as they sound; guitars get a treble clef an octave down), rhythms, dots, tuplets, ties, rests, tab positions (`<string>` counted from the highest string, `<fret>`), tunings and capo, key and time signatures, tempo, repeats and endings, rehearsal marks, drum notes and lyrics. Bends, slides, palm mute and similar techniques have no standard element and are not exported (Guitar Pro files keep them).

Import goes through alphaTab's MusicXML reader (also handles compressed `.mxl` content). alphaTab reads an "x" note head as a normal note, so dead notes come back as normal notes.

## MIDI

Export (`src/lib/export/midi.ts`) uses alphaTab's generator: a type 1 file with one track per track of the song, tempo and time signature changes, with repeats and jumps played out as in playback.

Import (`src/lib/import/midi.ts`) is Smart Beat's own. A MIDI file has sounds, not notation, so it makes choices:

- every MIDI channel with notes becomes a track (channel 10 is drums); the track name, sound (program change), volume and pan are taken over;
- time signature changes become bars; tempo changes start at the beginning of the bar they fall in;
- notes are snapped to sixteenth notes; a note that lasts past the next note is cut (no ties are made) and triplets are not detected;
- guitar (programs 25-32) and bass (33-40) sounds are written as tablature in standard tuning, with notes moved by an octave when they do not fit; other sounds as a staff.
- SMPTE time division is not supported.

## ASCII tab

Export writes each stringed track as lines of text: a line per string named from the tuning (lowercase for the top string), frets, `x` for dead notes and `(5)` for ghost notes, wrapped at 80 characters. Tracks without strings are listed as left out.
