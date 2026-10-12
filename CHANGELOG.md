# Changelog

Release notes for every version. The release workflow publishes the section that matches the tag (`v0.1.0` uses `## [0.1.0]`) as the GitHub Release text, and the in-app update dialog shows it. Keep the headings exactly in this form.

## [Unreleased]

- Added: choose the audio input in Help › Settings…, for example an audio interface with your guitar plugged in. The tuner listens to it, and Smart Beat remembers it. The tuner shows the input and links to the setting.
- Fixed: stopping the tuner while macOS was still asking for the microphone left the microphone on.
- Added: anonymous usage counters. Smart Beat counts, per day, how often features such as Loop, Metronome, Count-in, Export or Open are used, with the app version, the operating system and the installer type. There is no identifier, and nothing about your songs, files or sounds is sent. Counts are kept while you are offline and sent later. Switch them off in Help › Settings…, which also deletes counts that were not sent yet. See `docs/analytics.md`.
- Added: Smart Beat › Settings… (⌘,) in the macOS menu bar, under About. On Windows and Linux it is in the Help menu (Ctrl+,).
- Added: Help › Check for Updates…, an automatic update check at startup (at most once a day), and an update dialog with release notes and download progress.
- Added: a "Built with" section on the start page that thanks and promotes alphaTab and the other libraries; its links open in the system browser.
- Changed: Smart Beat's source is now available under the PolyForm Noncommercial License 1.0.0. Commercial use needs a separate agreement (see `COMMERCIAL-LICENSE.md`).

## [0.1.0]

- First public preview: opens, plays and edits Guitar Pro, MuseScore, MusicXML and MIDI files, with a mixer, practice tools and a fretboard.
- Saves to Guitar Pro 7, 5, 4 and 3 and to MuseScore; exports MusicXML, MIDI, alphaTex, ASCII tab, WAV and (on macOS) M4A.
