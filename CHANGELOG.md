# Changelog

Release notes for every version. The release workflow publishes the section that matches the tag (`v1.0.0-beta.1` uses `## [1.0.0-beta.1]`) as the GitHub Release text, and the in-app update dialog shows it. Keep the headings exactly in this form.

## [Unreleased]

- Usage counters now also count failures and crashes, so we can see what breaks and how often. A failed action is counted as one of a fixed list of areas (such as audio, cloud or export) together with a fixed kind (such as not found or network), and a crash of the app core is counted by area only. The error message, file names, paths and the stack are never sent, and there is still no identifier. Errors and crashes are sent right away when you are online and otherwise the next time the app starts or you are online again. Switching off "Share anonymous usage counts" in Settings stops this too.
- Practice together: play the same tab with someone else, in time. Playback › Practice Together, the button beside Record to Tab and the Practice together button on the start screen first ask whether to start a new session or join one, then host (or join with a code) on the same network or over the internet. Either of you can press Play, Pause or Stop and both start at the same moment (the host decides, with a start time a moment ahead), and the speed, loops, metronome and count-in are shared; each of you keeps your own tracks, mute and solo. The guest does not need the tab: the host sends it, and the host's edits follow while playback is stopped. Playback in a session always uses the SoundFonts, and during playback a click on another bar is refused so the two computers stay together. A chip in the toolbar shows how well the two computers are in sync, and the audio quality setting (Auto, Tight, Balanced, Safe) trades a quicker start for a steadier one. Same network has a "Need a direct connection?" help with the steps for your own system (cable, phone hotspot, or a network made on the host computer), no router needed.
- Share with a link, and a Cloud library. Every tab and saved stems file now has a share icon: on the start screen (Recent, Cloud, Stems), in the Open from Google Drive / OneDrive / Dropbox list and in the new **File › Cloud Library**. For a file that is in a connected drive the link is made at once and copied, with a "Link copied" notice; for a file on this computer you pick the drive first and Smart Beat puts a copy there, then copies the link. Stems are shared as their own file, with their own link, and without the original song. You choose whether people with the link can view or edit it. The Cloud library lists the tabs and stems in each connected drive, with empty, not-connected and error states. Dropbox has to be connected again once, because links need two more permissions. Links open in the drive's own page, not in Smart Beat; they are never logged or counted. Not checked against the real services yet: it was tested against mock servers.
- Stem separation: save and open stems through your connected Google Drive, OneDrive and Dropbox accounts. Save stems and Open saved stems now show a card for each connected account next to this computer and the linked cloud folder, with progress, Cancel and a clear message when a sign-in has expired. Large stems files go up in chunks and come down streamed to disk, so a file of 100 MB or more is no problem; stems stay in each service's Smart Beat folder and no longer show up in the tab lists. Not checked against the real services yet: it was tested against mock servers.
- Fixed: after you connected, disconnected or changed the cloud folder in Settings, the Cloud section of the start screen behind it kept showing what it found when it opened (for example "Reconnect Google Drive in Settings") until you restarted the app. It now reads the accounts and the folder again as soon as Settings changes them.
- Fixed: Settings could say Google Drive, OneDrive or Dropbox was connected while the start screen said to reconnect it. The list of connected accounts now drops an account whose sign-in is no longer in the system keychain, so both agree. A build without sign-in keys (a local build without a `.env`) also no longer deletes a sign-in it cannot refresh, which another build can still use.
- Stem separation: the page's header is laid out like an open song's. New, Open and Save come first, then the same play control (its skip buttons step five seconds), then the song's name, length, engine and tempo. The position, loop, speed, metronome and count-in sit in a sub header above the tab bar. The stem logo is gone from the header.
- Stem separation shows the song's tempo. The stem page measures the beats per minute of a separated song on your computer (a few tenths of a second per song, nothing is uploaded), with how sure it is, the first beat, other likely tempos (half and double time) and, only for large lasting changes, the tempo of each section. It can be wrong by a half, a double or a 4:3 ratio, and it says so by offering the alternatives.
- AI menu: two new windows to manage the optional models. **Stem Separation Models** lists every stem engine (what it is best at, how fast it is, how big the download is) and installs it, with its terms first, or deletes it. **Record to Tab Models** (the old AI Models item) shows MuScriptor, the high-accuracy piano model and what is built in, and installs or deletes them. Both say which features use the models. Stem separation also got a Delete button on each downloaded engine, with a second click to confirm, and the choice moves to the next engine you have when you delete the one that was selected. Deleting a model is refused while a download or a separation is running.
- Stem separation: guitar and piano. A new HTDemucs 6-part engine splits a song into drums, bass, vocals, guitar, piano and the rest. Guitar is the weaker of the main parts and piano the weakest (distorted guitar can leak into Other), and the page says so under each part. Like the other models it is an optional download with its terms shown first; its file is hosted with the other models, and saved `.sbstems` files with six parts open like any other.
- Local builds in a git worktree now also read the `.env` of the main checkout, so Google Drive, OneDrive and Dropbox sign-in no longer shows "Not available in this build" there when the main checkout has the keys.
- Stem separation: save your stems in your cloud folder. Save stems offers "Cloud folder" (the default when one is linked) or "Another place", shows about how big the file will be, and the start screen lists the stems in your cloud folder next to your tabs, with online-only files downloaded when you open them. Your drive app does the uploading; Smart Beat does not upload anything, and the original song is in the file only when you tick the box.
- Stem separation: save a separation to a `.sbstems` file (Save stems on the stem page, with or without the original song) and open it again later (Open saved stems on the start screen, or double-click the file) without separating again. Separated songs now sit in the Recent grid with a Stems badge, a Saved mark and the most recently opened first.
- Licensing: Smart Beat is for personal use, learning and research only, and commercial use is not offered. The source licence (PolyForm Noncommercial 1.0.0) is unchanged; the end user license agreement now says the same (version 1.1), and `COMMERCIAL-LICENSE.md` became `NONCOMMERCIAL-USE.md`.
- Open from the cloud: File › Open now offers Google Drive, OneDrive and Dropbox next to this computer when you are connected, and File › Open from Cloud… takes you straight there.
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
