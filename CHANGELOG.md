# Changelog

Release notes for every version. The release workflow publishes the section that matches the tag (`v1.0.0-beta.1` uses `## [1.0.0-beta.1]`) as the GitHub Release text, and the in-app update dialog shows it. Keep the headings exactly in this form.

## [Unreleased]

### New

- **Record on an audio lane.** Every audio lane has a record icon next to mute and solo. Press it to arm the lane: you hear your input through that lane's own effects (amp, pedals, plugins) while the song plays, and the bar at the bottom shows the input, its delay and a **Hear myself** switch (off at first for the computer's own microphone or the system default input, with a headphones warning when you turn it on). Press the icon again to record a take straight onto the lane with the last choices of Record audio, and once more to keep it. The lane's own clips stay quiet under the take, the other lanes follow mute and solo, **Space** keeps the take and **Escape** throws it away. One undo takes a kept take away again. Your own Monitor track comes back when you let go of the lane.

### Changed

- **Crash reports are now on by default.** When Smart Beat fails with an unexpected error or crashes, it sends one small report so the problem can be fixed: the kind of error, the program's own stack trace, the app version and your operating system family. Never your songs, file names, folders, user name, IP address, messages or addresses, and never a screen recording, replay or screenshot. Switch it off any time in Help › Settings › Send crash reports; your choice is kept for every later version, and if you had already switched it off, it stays off. Details in `docs/crash-reports.md`.

- **Audio lanes under the tabs work like the lane editor.** Each lane has the editor's header in a slim strip above its clips, at the left of the view (name, mute, solo, add audio file and effects) instead of a small label, with the same mute and solo colours. A marker ruler on the bars shows and edits markers and regions, a handle under each lane resizes it (like in the studio), and an empty lane says so. The positions still follow the score's bars.

### Updated libraries

- Routine updates to the app's libraries (Tauri, Sentry, the sign-in keychain library and others). If you were signed in to cloud storage, you may be asked to sign in once more.

### New: audio lanes to sheet music

- **Convert audio to sheet…** Split an audio lane so a small chunk (a clip) is left, right-click that clip and choose **Convert audio to sheet…**. The dialog opens on the same tab, and the notes are written at the bar where the clip starts. Pick the instrument (guitar, bass, piano or drums), the track to write into (or a new track in this tab, or a new tab) and the start bar, see the new notes as tab or notation before you add them, and Undo takes the whole thing back in one step.
- **Also for a whole lane, a time selection and the studio.** The same dialog opens from the lane's "…" menu, from the lane editor's Tasks menu, from a time selection's right-click menu and from the studio's range bar, and as the new **Audio lane** source in Record to tab.
- **Same engines as Record to tab.** The transcription runs on your computer with the engine you picked there; no audio leaves it. It uses the clips as placed (offset, trim, speed, reverse and pitch), not the lane's volume, effects or mute, and a span can be up to ten minutes.
- **Best on one instrument.** A clip of a whole band or a full mix gives a rough result at best, as in Record to tab. Use a stem or a lane with one instrument for the best notes; the dialog warns you when a lane looks like a full mix.
- The **Audio lanes tour** (Help › Tours) has a new step for it, and What's new tells you about it.

## [1.3.1]

New in 1.3.1: crash reports you can switch on, and updated libraries. What's new still shows the 1.3.0 list.

### New: crash reports, only if you want them

- **Send crash reports** in Help › Settings is **off** until you turn it on. When it is on, an unexpected error or crash sends one small report so it can be fixed: the kind of error, the program's own stack trace, the app version and your operating system. Never your songs, file names, folders, user name, IP address, messages or addresses, and never a screen recording, replay or screenshot. Turn it off and nothing more is sent. It is separate from "Share anonymous usage counts". Details in `docs/crash-reports.md`.

### Changed

- **Bar numbers show only at the start of each line.** The score engine update (alphaTab 1.9) no longer prints a number above every bar, only above the first bar of each line.
- **Piano and other keyboard staves survive a save and reopen of a `.gp` file.** They come back as the keyboard staves you saved, not as guitar tab. A build older than this one opens those staves as guitar tab.
- Drum staves in Guitar Pro 5 files show the app's drum tab alone, and drum lines read and copy correctly after the engine update.
- Dependency updates: Playwright, Tailwind, Vitest, Tauri and other libraries moved to their latest minor versions.

## [1.3.0]

New in 1.3.0: put audio next to your tab, take your stems out as audio files, and edit the same tab with your band.

### New: audio tracks next to your tab

- **Audio tracks (lanes).** Put recordings, backing tracks and stems on lanes under your tab. Add as many as you like: each has its own colour, volume, pan, effects and EQ, and they play in time with the notes. Open an mp3, m4a, wav, flac, ogg or aiff file from the Tracks panel, or drag files onto the window.
- **Edit the audio like a clip in a recorder.** Drag a clip along its lane or to another lane, trim its edges, split it (S), glue the pieces back (G), duplicate it, fade it in and out, and give each clip its own pitch. Double-click a lane for the lane editor, or open the studio to see every lane at once.
- **Line the audio up with the score.** Set sync points so a recording follows the bars of your tab, even when the player was not playing to a click.
- **Record audio.** Record your playing as a plain take on a lane (no tab is written): from where the playhead is, punched into the bars you selected, or looped with a new take on every pass.
- **See the audio on the same bars as the notes.** The eye on a lane shows it under the tab in the continuous view. It shows alone at first; turn on a track to put its tab above the lanes.
- **Audio and notes always play together.** The notes keep playing with the SoundFonts and your audio tracks play next to them, in time, with nothing to switch. The sound engine switch is only for what needs it: effects, amps, drum kits and the monitor track.
- **Old songs keep their backing file.** A song that had one audio file opens with it on a lane. The audio is saved inside the tab's file.
- **Pick any tracks for the continuous view.** Add or take out any track in the continuous layout, the first one too. The tracks stack in the order you added them.
- A short **Audio lanes tour** (Help › Tours) walks through all of this.

### New: take your stems out of Smart Beat

- Every stem row has an **Export** button after Mute and Solo that opens Export stems with only that stem chosen.
- **Export stems** (the download button next to Save on a stem page) saves the stems you choose as audio files: **one mixed file**, or **one file per stem** in a new folder called "<song> stems". Files are WAV or FLAC, both lossless, and it works with every separation model. It shows its progress, you can cancel it (nothing is left behind), and it tells you if the loudest peaks had to be limited.
- **Add to a tab** puts each chosen stem on a lane of its own, in an open tab or a new one, in one step that Undo takes back. Each lane has the stem's colour and is named after the stem and the model ("Vocals · SCNet XL"). Your notes and the other tracks are not touched.

### New: edit the tab together (Practice together)

- Everyone in a Practice together session can edit the same tab at the same time, and each change shows up on the other computers within a moment. Two people can work in the same bar.
- You see where the others are: the note they are on, in their colour, with their name above it.
- Undo and Redo only take back your own edits.
- Playback is not disturbed by edits: the shared clock, the metronome, the count-in and the speed stay as they are.
- The host can turn editing off for guests with "Guests can edit the tab" in the session dialog. A guest who drops and comes back gets the edits it missed.
- **Audio tracks are shared too.** Add, move, cut or remove audio tracks and clips and the others get the same tracks, including stems you add from the stem page. Each player keeps their own mix of a track (volume, pan, mute, solo, effects).
- The audio files are sent once each, directly between the computers, and checked on arrival. Progress shows in the session dialog, and nobody starts until everyone has every file, so nobody plays a track in silence.
- An older Smart Beat as a guest still follows the host's tab, read-only.

### New: a tidier way to write music

- **A compact edit palette.** The palette is now a grid of small icons. Point at one to see its name and shortcut. An icon with several choices (key, time signature, tempo, jumps, tuplet, slide, harmonic and more) opens a small box of them and remembers your pick.
- **A quiet highlight.** The note you edit has a thin outline instead of a big box, and a selection of beats is one light rectangle per line of music.
- **Rests on demand.** Insert a rest before or after a note with I and Shift+I, or from the right-click menu, as long as the note value in the palette.
- **Repeats that play 2 to 8 times.** Choose how often a repeat plays from the Repeat end box, and change it later from the right-click menu.
- **Edit and listen.** Play starts at the note you are on, and plays only your selection when you have selected some beats.
- **Copy and paste between tabs.** Copy in one open tab and paste in another. Pasting over a selection replaces it, and a longer part flows into new bars, so nothing after it is overwritten.

### Improvements and fixes

- Edit mode: a bar that is too short or too long no longer stops you from editing it. Type a run of rests first and fill them in later; the bar lengths are checked when you play or save.
- Edit mode: only the purple selection is shown, without the blue highlight on top of it.
- Drum tab: click any line to put the cursor there and write the drum you type on it.
- Drum tab: put the cursor on a drum (with the Up and Down arrows or a click) and type another number to replace it on the same line. Every number you type replaces it again; to add a second drum to the beat, such as a kick under a crash, put the cursor on an empty line first.
- Drum tab: a click on any line of the tab, also under the drum staff in Score + tab and where there is no note yet, puts the cursor on that line.
- Tracks panel: clicking a bar in another track's lane opens that track at the bar (in Edit mode with the cursor on it).
- Edit mode: Delete removes every selected beat, also rests, in one step.
- Guitar tab: a click on any string line puts the cursor on that string, also where there is no note yet.
- Two tracks shown together in the continuous view: a click lands on the track you clicked, not on the other one.
- Edit mode: the score stays where it is while you delete or change notes. It only scrolls when the note you are on would leave the view, and then just far enough to show it.
- Switching between open tabs in Edit mode puts the keyboard back where you were editing.
- Sound: a new installation plays with SoundFonts. The effects engine is remembered only when you switch it on yourself.
- Fixed: a drum track shown as Tab drew no numbers in the Continuous view.
- Fixed: drums changed to other instruments after a tab was saved and opened again (a kick came back as a bongo, a crash as a tambourine). Files saved this way by older versions still open with the wrong drums.

## [1.2.0]

New in 1.2.0: split a song into its instruments, practice the same tab with up to ten players, and keep your tabs in the cloud.

### New: Stem separation (beta)

- Split a song into drums, bass, vocals and the rest, on your own computer. Nothing is uploaded. Start it with the Stem separation button on the start screen.
- Mute, solo, loop, change the volume of and slow down each part to play along. The page works like an open song, with the same play control, loop, speed, metronome and count-in.
- Guitar and piano: the new HTDemucs 6-part engine splits a song into drums, bass, vocals, guitar, piano and the rest.
- Smart Beat finds the song's tempo for you, also on your computer, and shows how sure it is, where the first beat is and other likely tempos.
- Save a separation as a .sbstems file, with or without the original song, and open it again later without separating again: Open saved stems on the start screen, or double-click the file. Separated songs show up under Recent with a Stems badge.
- Save your stems in your cloud folder, or straight to Google Drive, OneDrive or Dropbox when you are connected. Big files of 100 MB or more are fine.
- A quick engine is built in. Better engines are optional downloads, each showing its terms first. Install or delete them in AI › Stem Separation Models, which tells you what each one is best at and how long it takes (for example SCNet XL for vocals, HTDemucs as the best all-round choice).
- This is a beta. Guitar is weaker than the other parts and piano is the weakest, and distorted guitar can end up in Other; the page says so under each part. The tempo can be off by half, double or a 4:3 ratio, which is why the other likely tempos are shown too.

### New: Practice together

- Play the same tab with up to ten players (you and nine guests), in time, on the same network or over the internet. Start it from Playback › Practice Together, the button beside Record to Tab, or the start screen.
- Anyone can press Play, Pause or Stop, and everyone starts at the same moment. The speed, loops, metronome and count-in are shared. Each of you keeps your own tracks, mute and solo.
- Guests don't need the tab: the host sends it, and the host's edits follow while playback is stopped. Sync tab sends it to everyone again.
- Bring more tabs into the same session with Add this tab to the session. Switching tabs takes everyone to the new tab and stops the playback for all.
- The host lets each guest in, sees how well each one is in sync, and can remove a guest (who may come back) or ban one. If your connection drops or your battery dies, rejoin with the same code: your place is kept for ten minutes.
- A badge in the toolbar shows how well the computers are in sync. The audio quality setting (Auto, Tight, Balanced, Safe) trades a quicker start for a steadier one.
- No router? On the same network, "Need a direct connection?" shows how to connect with a cable, a phone hotspot or a network made on the host's computer.
- In a session, playback always uses the SoundFonts, and clicking another bar while playing is blocked so everyone stays together.

### Cloud

- Cloud folder: link a folder that Google Drive, OneDrive, Dropbox, iCloud Drive or Nextcloud keeps in sync (Settings › Cloud folder). The start screen gets a Cloud tab with your tabs, online-only files download when you open them, and Smart Beat asks before saving over a file that changed since you opened it.
- Open and save in Google Drive, OneDrive and Dropbox directly: File › Open offers your connected drives next to this computer, and File › Open from Cloud… takes you straight there.
- Share with a link: every tab and saved stems file has a share icon. Smart Beat copies a link to it; for a file on this computer it first puts a copy on the drive you pick. You choose whether people with the link can view or edit. Links open in the drive's own page. Stems get their own link, without the original song.
- File › Cloud Library lists the tabs and stems in each connected drive.
- Dropbox has to be connected again once, so that it can make links.

### AI menu

- Two new windows to manage the optional models: Stem Separation Models and Record to Tab Models (the old AI Models item). Each says which features use the models, and installs or deletes them. A model can't be deleted while it is downloading or separating a song.

### Improvements and fixes

- Edit mode: set the time signature (beats per bar and the beat's note value) in the edit sidebar. It applies from the bar at the cursor on, and Undo takes it back.
- A playhead now runs through every track lane and the audio track while the song plays.
- Fixed: an audio track can now also be removed from its row in the track list, and a new audio track plays right away instead of after a restart.
- Screen readers now read the same name you see on more controls: the effect buttons, drum pads, fretboard, track names and the save and open cards.

### Privacy and licensing

- The anonymous usage counters now also count errors and crashes, so we can see what breaks and how often. Only a fixed area (such as audio, cloud or export) and a fixed kind of problem are sent: never the error message, file names or folders, and still nothing that identifies you. Switching off "Share anonymous usage counts" in Settings stops this too.
- Smart Beat is for personal use, learning and research only, and commercial use is not offered. The end user license agreement (now version 1.1) says the same; the source licence is unchanged.
- Under the hood: updated parts of the app to their latest, safer versions.

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
