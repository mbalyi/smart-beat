# Changelog

Release notes for every version. The release workflow publishes the section that matches the tag (`v1.0.0-beta.1` uses `## [1.0.0-beta.1]`) as the GitHub Release text, and the in-app update dialog shows it. Keep the headings exactly in this form.

## [Unreleased]

- Cloud folder: link a folder that Google Drive, OneDrive, Dropbox, iCloud Drive or Nextcloud keeps in sync (Help › Settings… › Cloud folder). The welcome screen gets a Cloud tab with the tabs in it, online-only files are downloaded when you open them, and saving over a file that changed since you opened it asks what to do first.

## [1.1.0]

New features and fixes since 1.0.1:

- AI that runs on your own computer: **Audio to tab** and **Record to tab** can now use MuScriptor, an optional model you download once with a guided setup. Drop in a recording, or play it live, and get tab you can edit. It never uploads your music, and it is for non-commercial use only. Record to tab keeps its built-in Default mode, and the AI menu and the dialogs were redesigned to match.
- Show several tracks under each other in the continuous layout, lined up bar by bar, and drag them into the order you like.
- A new eye in the Tracks header shows or hides the section names, tempo markers and texts above the bars.
- Practice: the count-in and the metronome have their own small settings windows (how many beats, which sound, how loud), a count-in that has started now plays to the end, and Stop takes you back to the start of the song.
- File › Export › Audio (M4A) now works on Windows too.
- Smart Beat can be the app that opens your tab and MIDI files on macOS, Windows and Linux: double-click a file and it opens here.
- Every SoundFont in the SoundFonts window now links to the page it comes from, so you can read about it and its licence.
- Edit mode: insert, copy, cut, paste and delete whole bars from the right-click menu, and the Right arrow on the last bar adds a new one.
- A redesigned What's new window, and a new slogan on the welcome screen: "Practice, create and break the era".
- Fixed: drum notes play at the right loudness, sections show in the Tracks panel, the score follows playback again after you jump to another bar, and the drum cursor moves freely.
- Fixed: the anonymous usage counters (you can switch them off in Help › Settings…) are sent reliably when the app starts and when it closes.
- Under the hood: updated parts of the app to their latest, safer versions.
- Coming soon, not in this version yet: Cloud sync, Stem separation, Practice together and Audio tracks & editing.

## [1.0.1]

New features and fixes since 1.0.0:

- A guided tour for new users (Help › Take the Tour), a demo song (Help › Open Demo Song), short tours for Editing, Speed Trainer, Effects and Record to tab (Help › Tours), and Help › What's New, which opens once after an update.
- A monitor track that plays your audio input live (for example a guitar in an audio interface) with its own pedalboard, EQ, volume, pan, mute and solo. Switch it on with **Monitor my input** in **Practice mix**. Monitoring fades in, recovers after an output-open failure and no longer blocks the UI while an interface opens.
- Third-party VST3 and CLAP plugins as opt-in pedalboard blocks. Each plugin runs in its own helper process, so a crashing plugin cannot take the app down, and presets are saved in the song.
- Record to tab: Basic Pitch with playable fret placement, piano to staves, and drums to a drum track.
- Importable SoundFonts and new anonymous usage counters (still switchable off in Help › Settings…).
- A pan control with an L/C/R value, centre snap and double-click reset; Copy track to instrument; drum notation is normalised.
- Fixed: the tuner reads a steady pitch from audio interfaces, tunings read low to high in selectors, pedalboard drag and drop adds, reorders and removes, and Guitar Pro is listed in the Export menu.
- Credits for Basic Pitch and Transkun on the start page and in the README.

## [1.0.0]

The first stable release of Smart Beat. It is the first public beta plus updated dependencies:

- Updated the Tauri runtime and plugins (including the updater), Radix UI, shadcn, lucide icons and the test tooling.

## [1.0.0-beta.1]

The first public beta of Smart Beat, a free tablature editor for macOS, Windows and Linux. Please report problems at https://github.com/mbalyi/smart-beat/issues or write to smart-beat@outlook.com.

- Opens, plays and edits Guitar Pro (GP3–GP8), MuseScore, MusicXML and MIDI files, with a mixer, practice tools (loops, Speed Trainer, metronome, count-in) and a fretboard, keyboard and drum-pad view.
- Saves to Guitar Pro 7, 5, 4 and 3 and to MuseScore; exports MusicXML, MIDI, alphaTex, ASCII tab, WAV and (on macOS) M4A.
- A tuner, and the choice of audio input in Settings (for example an audio interface with your guitar plugged in).
- Settings… in the macOS app menu (⌘,); on Windows and Linux it is in the Help menu (Ctrl+,).
- Help › Check for Updates…, plus a quiet automatic check at most once a day. Nothing is downloaded until you click **Download & Install**.
- Anonymous usage counters (which features are used, per day, with the app version, operating system and installer type; no identifier and nothing about your songs). Switch them off in Help › Settings…, which also deletes counts not sent yet.
- Help › About shows the contact address and a link to the source code. A "Built with" section on the start page thanks alphaTab and the other open-source projects behind Smart Beat.
- Licensing: the source code is available under the PolyForm Noncommercial License 1.0.0 (commercial use needs a separate agreement, see `COMMERCIAL-LICENSE.md`); the app is free under the End User License Agreement 1.0 (Dutch law, your local consumer rights kept).
- Fixed: stopping the tuner while macOS was still asking for the microphone left the microphone on.

Coming soon: AI features, starting with audio to tab (turn a recording into MIDI and tab).

This is a beta: back up songs you care about. Beta versions are not offered by the automatic update check, so download the next beta from the releases page.
