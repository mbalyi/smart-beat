# Guitar Pro 5 to Smart Beat mapping

Feature-by-feature reference: where each GP5 capability lives in Smart Beat, what state it is in, and which GitHub issue covers it. GP8 additions are listed at the end. Details: [guitar-pro-5-reference.md](guitar-pro-5-reference.md), [guitar-pro-8-features.md](guitar-pro-8-features.md), [tab-formats-and-sound-research.md](tab-formats-and-sound-research.md).

Status: **Done** shipped on `main`, **Partial** some of it exists, **Open** planned issue, **Later** not scheduled, **Skip** deliberately not planned.

## Interface areas

| GP5 area (screenshot) | GP5 behaviour | Smart Beat today | Status | Issue |
|---|---|---|---|---|
| Menu bar (File, Edit, Bar, Track, Note, Effects, Markers, Tools, Sound, View, Options, Help) | Native menus | Native Tauri menu (`src-tauri/src/menu.rs`) with state sync | Partial | #35 (GP8-style UI), #11-#14 for missing menus |
| Toolbars (file, transport, tempo, speed, voice, durations, effects) | Stacked icon rows | Score toolbar, transport bar, edit toolbar (`src/components/score`) | Partial | #35 |
| Score area, tab + staff, red bar numbers | Page view | alphaTab render via `score-view.tsx` | Done | #4 |
| Track pane: S/M, port/channel, name, instrument, volume, pan, chorus, reverb, phaser | Per-track strip | `tracks-panel.tsx`, `mixer-panel.tsx`: volume, pan, mute, solo | Partial | #6 done; #37 (mixing), #35 (layout) |
| Coloured bar grid | Track timeline and navigator | Not present | Open | #35 |
| Status bar (page, bar:beat, fill, warnings) | Info strip | `app-footer.tsx` (limited) | Partial | #35 |
| Track properties dialog | Name, colour, strings, tuning library, capo, frets, notation checkboxes | `track-dialog.tsx` | Done | #10; 7-9 strings in #43 |
| Instrument dialog (MIDI/RSE, bank, effect, 3-band EQ, human playing, auto accent, auto let ring/brush) | Per-track sound | `instrument-panel.tsx` (SoundFont/MIDI program) | Partial | #36 (effect chain), #37 (EQ) |
| Scale dialog | Hundreds of scales | Not present | Open | #13 |
| Percussion dialog (MIDI 27-87 list) | Flat list | Basic drum lane input | Partial | #45 (GP8 element picker) |
| Virtual fretboard and keyboard | Tool windows | Fretboard and piano view | Done | #8 |

## Notation and editing

| Capability | Status | Issue |
|---|---|---|
| Open GP3/4/5/GPX/GP7 and render | Done | #4 |
| Note entry, undo/redo | Done | #9 |
| Tracks, tunings, capo, drums, MIDI instruments | Done | #10 |
| Time/key signatures, repeats, endings, Coda/Segno, sections | Open | #11 |
| Guitar techniques (bends, slides, harmonics, ...) | Open | #12 |
| Lyrics, text, chord diagrams, chord/scale tools | Open | #13 |
| Transpose, bar-duration check, tab/staff conversion | Open | #14 |
| 7-9 string guitars, extended-range tunings, odd meters and polyrhythm display | Open | #43 |

## Playback and sound

| Capability | Status | Issue |
|---|---|---|
| Playback with SoundFont, following cursor | Done | #5 |
| Per-track volume, pan, mute, solo | Done | #6 |
| Loop, speed trainer, metronome, count-in | Done | #7 |
| Per-track EQ, automation toggles, Master strip, drum element mixer, focus track | Open | #37 |
| Effect chain per track (RSE-style amp and effects) and pedalboard UI | Open | #36 (needs #34 spike) |
| Compressor, mastering chain, 10-band EQ | Open | #39 |
| Audio track (backing track) with sync points | Open | #38 |
| Importable drum kits (SFZ, SF2) | Open | #40 |
| Import own amp models, cab IRs and effects | Open | #41 |
| Heavy-genre presets (nu-metal, metalcore, hardcore, deathcore, djent) | Open | #42 |
| Sound automations, volume/pan/tempo automation | Later | #37 (partly) |
| Microphone tuner, MIDI step input | Later | - |

## Files

| Format | Status | Issue |
|---|---|---|
| Read GP3/4/5, GPX, GP | Done | #4 |
| Write GP5 and native format | Open | #15 |
| MusicXML and MIDI | Open | #16 |
| Power Tab, TuxGuitar, TablEdit, ASCII tab, MuseScore, GP7 write | Open | #44 |
| Print, PDF, WAV export | Open | #17 |

## GP8-only features

| GP8 feature | Smart Beat plan | Issue |
|---|---|---|
| Dark three-column UI with inspector, audio-track strip, mixer and bar grid | Adopt (original implementation) | #35 |
| Pedalboard with 6 track effects and 3 mastering effects | Adopt with own DSP | #36, #39 |
| Drum mixer (17 elements, volume/pan/mute/solo, mono/stereo) | Adopt | #37 |
| Drum element picker with articulation names | Adopt | #45 |
| Audio track: sync points, time-stretch, semitones/cents, filter | Adopt | #38 |
| Focus / unfocus track | Adopt | #37 |
| Command palette | Later | - |
| Nested tuplets, per-note duration/offset/velocity | Later | #12 |
| Design mode and stylesheets | Later | - |
| mySongBook, mobile apps | Skip | - |
