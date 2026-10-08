# File formats

What Smart Beat opens, saves and exports, and what each format cannot hold.

| Format              | Extensions                | Open                                     | Save / export                                                  |
| ------------------- | ------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Guitar Pro 7/8      | `.gp`                     | Yes                                      | **Native format**: File › Save, Save As                        |
| Guitar Pro 5        | `.gp5`                    | Yes                                      | File › Save, Save As (limits below)                            |
| Guitar Pro 4        | `.gp4`                    | Yes                                      | File › Save As (limits below)                                  |
| Guitar Pro 3        | `.gp3`                    | Yes                                      | File › Save As (limits below)                                  |
| Guitar Pro 6        | `.gpx`                    | Yes                                      | No (see [below](#guitar-pro-6-gpx-open-only))                  |
| MuseScore 3 / 4     | `.mscz` `.mscx`           | Yes (own importer)                       | File › Save As (limits below)                                  |
| MusicXML (partwise) | `.musicxml` `.xml` `.mxl` | Yes (via alphaTab)                       | File › Export › MusicXML (type `.mxl` for the compressed form) |
| Standard MIDI       | `.mid` `.midi`            | Yes (own importer)                       | File › Export › MIDI                                           |
| alphaTex            | `.atex`                   | Yes (via alphaTab)                       | File › Export › alphaTex                                       |
| ASCII tab           | `.txt`                    | Yes (own importer)                       | File › Export › ASCII tab                                      |
| Audio               | `.wav` `.m4a`             | (audio track: mp3, wav, flac, ogg, aiff) | File › Export › Audio (WAV), Audio (M4A, macOS only)           |

**Save** writes back into the file the song came from only for `.gp` and `.gp5`. A `.gp3`, `.gp4`, `.mscz` or `.mscx` file opened from disk is never overwritten by Save: it asks for a new file, and Save As offers every format above. The writers for these are checked by reading the files back with alphaTab and with Smart Beat's own importer, not in Guitar Pro 3/4 or MuseScore themselves (see [manual-checks.md](manual-checks.md)), so they should not replace an original unasked.

Songs opened from MIDI, MusicXML, MuseScore or text are _converted_: Save never overwrites the original file, it asks for a new `.gp` file.

## Native format: Guitar Pro 7 (`.gp`)

The native format is a Guitar Pro 7 file. It is an open container (a ZIP archive holding an XML score and small configuration files), it is written by alphaTab's exporter (MPL-2.0, the library Smart Beat already uses to read and render scores), and Guitar Pro 7 and 8 open it. Choosing it over a format of our own means files are not locked to Smart Beat, and everything alphaTab can write (techniques, chords, sections, repeats, tempo changes, lyrics) survives.

The mixer (volume, pan, mute, solo of each track) is written into the file, where Guitar Pro reads it.

Everything Guitar Pro has no place for goes into a `SmartBeat/settings.json` entry in the file's ZIP archive (`src-tauri/src/project.rs`):

- master volume and pan;
- effect chains, sounds and sound switches;
- channel EQ, automation, focus and the drum mixer;
- the audio track and chain presets saved with the song.

It is the same JSON as the app's own mixer settings (`MixerSettings`, version 2; version 1 files still load). When the user asks for it, the audio track's recording is stored too, as `SmartBeat/audio/<file name>`, uncompressed.

Guitar Pro and alphaTab ignore entries they do not know, so the file opens everywhere. On open, these settings take priority over the app's settings for the file. For other formats, the app's settings (keyed by the file's content hash) are used.

## Guitar Pro 5 (`.gp5`)

The writer (`src/lib/export/gp/writer.ts`) produces version 5.00 files. Everything Guitar Pro 5 has is saved: notes, rests, dots, tuplets, ties, bends, slides, harmonics, trills, tremolo picking, grace notes, vibrato, palm mute, let ring, hammer-ons and pull-offs, dynamics, accents, brushes, pick strokes, text, chords, lyrics (one track), repeats, alternate endings, sections, jumps (Coda, Segno, D.C., D.S.), key and time signatures, tempo changes, tunings, capos and each track's sound and mix.

What Guitar Pro 5 cannot hold is reported after saving ("saved with limits"):

- tracks without strings (piano, other instruments): saved as a seven-string track without tablature;
- more than seven strings (the notes on the lowest strings are left out), frets above 24, more than two voices, more than six simultaneous drum notes;
- double-dotted notes (saved with one dot), tuplets other than 3 in the time of 2, 5 to 7 in the time of 4 and 9 to 13 in the time of 8 (a nested tuplet such as 9:4 is saved as plain notes: Guitar Pro 5 stores only the note count), notes shorter than a 64th;
- lyrics of more than one track, dotted and Scottish triplet feels, feedback harmonics.

Text is written in a Windows code page, as Guitar Pro 5 expects: the one the song was read with (see below), else the user's (Windows-1250 for Central European languages, otherwise Windows-1252). If the text does not fit that code page but fits the other one, the other is used; characters that fit neither become "?" and the save warns about them.

Drum notes are written on the string of the drum tab they sit on in Smart Beat, so the placement a Guitar Pro 5 user chose survives a round trip (#53).

### Text encoding when reading (#53)

Guitar Pro 3–5 files store text in the code page of the computer that wrote them and do not say which. Smart Beat reads such a file with Windows-1252 first (which keeps every byte), then picks the encoding from the file's own strings: valid UTF-8 (older Smart Beat versions) stays UTF-8; otherwise Windows-1250 and Windows-1252 are scored by the letters each would produce (ő, ű, č, ł … versus õ, û …), with the user's language breaking ties. File › Reopen with encoding overrides the choice, and the choice is remembered per file. Guitar Pro 7+ files are UTF-8 XML and are not affected.

### Drum strings (#53)

alphaTab's Guitar Pro 3–5 reader drops the string a drum note was written on. Smart Beat wraps that reader at run time (alphaTab's files are not changed) to keep the string, stores it in the note's otherwise unused `fret`, draws the drum tab with it and writes it back to GP5. Guitar Pro 7+ files have no place for it, so `.gp` files carry it in `SmartBeat/settings.json` (`drumLines`).

### How the writer was made (clean-room notes)

The rules in [licensing.md](licensing.md) apply: nothing was copied or ported from TuxGuitar (LGPL-2.1) or PyGuitarPro (LGPL-3.0), and their source code was not read for this feature. The layout of the file was written down from community format descriptions and then checked against alphaTab's GP3–GP5 importer (MPL-2.0, a dependency we are allowed to use), whose field order was used to confirm details such as the bar and track headers. No code was taken from it; the writer is original code in TypeScript.

Verification is by round trip (`writer.test.ts`): songs are saved and read back with alphaTab, and the music (notes, strings and frets, durations, tuplets, tempo, repeats, endings, sections, lyrics, chords, techniques) must be identical. **Still to do by hand:** open files written by Smart Beat in Guitar Pro 5 (Windows or macOS) and TuxGuitar, as the licensing doc requires. Only alphaTab was available for the automated tests.

## Guitar Pro 4 and 3 (`.gp4`, `.gp3`)

The same writer as for GP5 (`src/lib/export/gp/writer.ts`) writes version 4.06 and 3.00 files. Most of the layout is shared; what differs from GP5 is written per version:

- the credits have one field for the words and the music (GP3 and GP4);
- the triplet feel is one setting for the whole song, and there are no page setup, tempo names, jumps (Coda, Segno, D.C., D.S.), realistic-sound-engine data or beaming groups;
- lyrics exist from GP4 on (GP3 has none);
- a repeat stores how many times the bars are repeated (one less than GP5's count of plays), and the alternate endings are stored as a number: "ending N" stands for the endings 1 to N that no earlier bar of the repeat has;
- one voice per bar (GP5 has two);
- a track ends after its colour: both staves are always shown;
- chord diagrams, beat effects, note effects, the mix table change and grace notes have their older forms. GP3 has the fewest effects: no rasgueado, pick strokes, whammy bar, palm mute, staccato, note vibrato, tremolo picking or trills, and its harmonics are one natural or artificial harmonic for the whole beat.

What a version cannot hold is listed after saving ("saved with limits"): everything the GP5 section lists, plus tempo names, jumps, the notes of other voices, grace notes that GP5 plays on the beat (GP4 and GP3 play them before it), per-bar triplet feels, alternate endings that skip a number, artificial harmonics other than 5, 7 and 12 frets (GP4), and for GP3 also lyrics, slides other than "to the next note", and the effects above.

Clean-room notes are as for GP5 (below): the field order comes from community descriptions and was confirmed against alphaTab's GP3–GP5 importer (MPL-2.0); nothing was taken from TuxGuitar or PyGuitarPro. Tests (`writer.test.ts`) read the files back with alphaTab. **Still to do by hand:** open them in Guitar Pro 3 and 4 and in TuxGuitar.

## MuseScore (`.mscz`, `.mscx`)

Export (`src/lib/export/musescore.ts`) is the mirror of the importer. It writes the MuseScore 3 XML format (MuseScore 3 and 4 read it), as `.mscx`, or zipped with its container description as `.mscz`. It was written from the file format only, with no MuseScore code or assets (GPL-3.0, see [licensing.md](licensing.md)).

Saved: parts with their name, instrument sound and mix (volume, pan, mute), up to four voices, notes, chords, rests, dots, tuplets, ties, dynamics, the first verse of lyrics, repeats with their counts, time and key signatures, and tempo (also inside a bar). Guitar parts keep their strings in the instrument; drum parts use MuseScore's standard drum set (the notes are the General MIDI drum numbers).

Left out, and listed after saving: bends, slides, hammer-ons and pull-offs, palm mute, let ring, harmonics, vibrato, staccato, accents, ghost and dead notes, trills, tremolo picking, brushes, tap, slap, pop and whammy bar; grace notes; volta endings; jumps; text, chord diagrams and section names; every voice after the fourth; and notes shorter than a 64th (saved as 64ths). Staves are standard notation, not tablature (the strings stay in the instrument, so a tablature staff can be added in MuseScore). The repeat count and the tempo come back when the file is opened again.

## alphaTex and compressed MusicXML

alphaTex export uses alphaTab's own exporter (`src/lib/export/alphatex.ts`). Compressed MusicXML (`.mxl`, `src/lib/export/mxl.ts`) is the MusicXML below inside a ZIP archive with `META-INF/container.xml`, as MusicXML readers expect; its ZIP writer (`src/lib/export/zip.ts`) stores the entries uncompressed. Pick it by typing the `.mxl` extension in the MusicXML export dialog. Smart Beat opens both again.

## Audio export (WAV, M4A)

WAV is 16-bit PCM of the song rendered with the current mix. **M4A** is AAC in an MP4 file (192 kbit/s stereo, 128 kbit/s mono), made by the **operating system's own encoder**: on macOS the AVFoundation `AVAudioFile` (`src-tauri/src/m4a.rs`); the UI renders the same WAV and hands it over. The menu item only exists on macOS. A Windows version through Windows Media Foundation (and Linux) is future work; until then the other platforms answer with a clear error.

**No MP3.** Every usable MP3 encoder is LGPL (LAME, shine, lamejs), and Smart Beat is closed-source freeware that links statically, so none can be bundled ([licensing.md](licensing.md)). The system encoders are the way to get a compressed file without a licence problem (the operating system vendor holds the codec licence); the other option, asking the user to install an encoder, was not taken.

## Guitar Pro 6 (`.gpx`, open only)

Guitar Pro 6 files are opened (alphaTab reads them) but not written. A `.gpx` file is a small file system around Guitar Pro's XML score (`score.gpif`). The only writer in alphaTab makes the Guitar Pro 8 flavour of that XML (`GPVersion` 8.1.3) and keeps it in a ZIP for `.gp` files; Guitar Pro 6 needs its own flavour, and nothing here can open a file in Guitar Pro 6 to check one. A `.gpx` menu item that probably produces files Guitar Pro 6 cannot read would be misleading, so it was left out. It can come back when someone with Guitar Pro 6 can test a GP6-flavoured writer (the container, `BCFZ`, is simple: a 4096-byte sector file system, stored without compression, as alphaTab's reader shows).

## MusicXML

Export (`src/lib/export/musicxml.ts`) writes score-partwise 3.1 with one part per track: pitches (as they sound; guitars get a treble clef an octave down), rhythms, dots, tuplets, ties, rests, tab positions (`<string>` counted from the highest string, `<fret>`), tunings and capo, key and time signatures, tempo, repeats and endings, rehearsal marks, drum notes and lyrics. Bends, slides, palm mute and similar techniques have no standard element and are not exported (Guitar Pro files keep them).

Import goes through alphaTab's MusicXML reader (also handles compressed `.mxl` content). alphaTab reads an "x" note head as a normal note, so dead notes come back as normal notes.

## MIDI

Export (`src/lib/export/midi.ts`) uses alphaTab's generator: a type 1 file with one track per track of the song, tempo and time signature changes, with repeats and jumps played out as in playback.

Import (`src/lib/import/midi.ts`) is Smart Beat's own. A MIDI file has sounds, not notation, so it makes choices:

- every MIDI channel with notes becomes a track (channel 10 is drums); the track name, sound (program change), volume and pan are taken over;
- time signature changes become bars; tempo changes start at the beginning of the bar they fall in;
- many files made from a recording or an audio conversion say one tempo (often 120 BPM) while the music runs at another. When a file has one tempo and one time signature and its notes do not fit its own sixteenth grid, the real sixteenth is measured from the note onsets (within 15% of the file's tempo), small drift is followed, and the bar lines are placed where the music has its downbeats (kick on 1, snare on 2 and 4, chords on the beats). The measured tempo goes into the song and the import says so (`src/lib/import/midi-grid.ts`);
- notes are snapped to sixteenth notes (a note played just before a bar line goes on the next bar's first beat); a note that lasts past the next note is cut (no ties are made) and triplets are not detected;
- guitar (programs 25-32) and bass (33-40) sounds are written as tablature in standard tuning, with notes moved by an octave when they do not fit; other sounds as a staff.
- SMPTE time division is not supported.

## ASCII tab

Export writes each stringed track as lines of text: a line per string named from the tuning (lowercase for the top string), frets, `x` for dead notes and `(5)` for ghost notes, wrapped at 80 characters. Tracks without strings are listed as left out.

Import guesses the rhythm from the spacing of each bar's own notes (snapped to 2, 3, 4, 6, 8, 12, 16, 24 or 32 steps, and doubled when two notes of a string would share a step) and takes over the usual technique marks: `h` and `p` (hammer-on, pull-off), `/`, `\` and `s` (slides), `b` (bend), `~` and `v` (vibrato), `(5)` (ghost note) and `<12>` (natural harmonic). Releases, taps and other marks are listed as left out.

## Opening MuseScore files

The importer (`src/lib/import/musescore.ts`) reads parts, staves, up to four voices, notes, chords, rests, dots, tuplets, ties, dynamics, the first verse of lyrics, repeats, time and key signatures and tempo. Not yet: grace notes, voltas, slurs, text, layout. Saving back to MuseScore is described above.

## Import only

| Format  | Extension | What is read                                                                                                                                                                                                                                                                                              |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capella | `.capx`   | Read by alphaTab. alphaTab 1.8.4 failed on every file with a note (it measures a chord before adding it to its voice); `src/lib/score/alphatab-fixes.ts` works around it. Repeat counts are only read from Capella's draw objects. There is no writer: no specification, and nothing to check one against |

## Not supported yet (needs a format specification)

These are binary formats with no public specification. Smart Beat's code is closed source, so their readers must be written clean-room ([ADR 0001](adr/0001-project-license.md)); the open-source programs that read them are GPL or LGPL and cannot be ported.

| Format    | Extension | What is needed                                                                                                                                                                     |
| --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power Tab | `.ptb`    | A written description of the format. The only reader is Power Tab Editor 2 (GPL-3), which cannot be used as a source                                                               |
| TuxGuitar | `.tg`     | A written description of the format. TuxGuitar (LGPL-2.1) is its only documentation; reading its code to port it is not allowed                                                    |
| TablEdit  | `.tef`    | The TablEdit format specification, which its author (Matthieu Leschemelle) shares on request (MuseScore's importer was written that way). Ask for it with commercial use permitted |
