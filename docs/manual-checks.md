# Checks by hand

What the automated tests cannot do: they run in a browser engine without a sound card, and the only program that reads our files back is alphaTab or Smart Beat's own importers. These checks need your ears, your hardware or another program. Tick a box here (or in [issue #50](https://github.com/mbalyi/smart-beat/issues/50)) when you have done it, and write down what you found.

The build to test is the one installed in `/Applications/Smart Beat.app`. Open a song with a clear pulse (a drum or bass part helps) before each check.

## Sound and timing (needs real devices)

### 1. The cursor follows the sound

Headless WebKit reports `baseLatency` 2.7 ms and `outputLatency` 0 ms, so the cursor offset can only be judged in the desktop app.

For **each output**: the built-in speakers, wired headphones and a Bluetooth speaker or headphones. For **each engine**: Inspector › "Native engine with effects" off (alphaTab's synthesizer), then on.

1. Play from the first bar at 100 % speed.
2. Listen to a note that lands on the first beat of a bar and watch the cursor. It should reach the note when you hear it.
3. If the cursor is early (typical for Bluetooth), raise Inspector › Sync offset (ms) until it lines up; if late, lower it. Write the value that works for each output.

Expected: no offset needed on the built-in speakers and wired headphones; a Bluetooth output needs a positive offset, and the value stays after closing and reopening the song.

### 2. The native audio engine

With "Native engine with effects" on:

- start, pause and stop with the Play button and with Space;
- click a bar to seek, also while playing;
- loop a few bars (drag across them in the score, then Loop);
- change the speed (50 %, 75 %, 125 %), check the pitch does not change;
- switch the Metronome and the Count-in on and off (the count-in plays a bar of clicks, then the song and the cursor start together);
- add an effect chain on a guitar track (the pedalboard) and listen to it; mute, solo and change the volume of a track;
- import your own amp capture (`.nam`) and cabinet impulse response (`.wav`) from the sound library (also by dropping the file on the window) and use them in a chain; drag them from "My sounds" onto the board;
- try a capture that was made at 44.1 kHz and one at 48 kHz, whatever your output device runs at: both should sound the same tone, at about the same level; switch "Match loudness" on and off on the amp block;
- import a file that is not a capture (a renamed text file) and a broken `.wav`: the message names the problem and nothing is added.

Expected: no clicks, dropouts or stuck notes; stopping is immediate; the sound after seeking and looping comes from the right place.

### 2b. Extended-range guitars (#43)

- add a 7, 8 and 9 string guitar, pick Drop A, F# standard and Drop B, write a low riff on the lowest strings and play it, on both sound sets;
- listen for the thin, slowed-down sound the warning in the track settings talks about: is it right to warn at that point (below B1, more than an octave under the recording)? Does the other sound set help, as the message says?
- write a 7/8 and an 11/16 bar and a triplet of triplets (Tuplet › Nested…) with the metronome on: does the click and the cursor agree with what you hear?

### 2c. The tuner's microphone (#83)

Install the bundled app (the browser and `pnpm tauri dev` skip the entitlement). Open a guitar track, show the fretboard, click **Tuner…**, then **Input** › **Start listening**.

- macOS asks for the microphone once, with Smart Beat's reason. Saying no shows how to allow it in System Settings.
- Play each open string of a guitar and a bass (a five-string bass's low B too). The note shown is the string's; the needle settles within a few cents of a clip-on tuner's reading, and reacts within about a fifth of a second.
- Stop listening, or close the dialog: the microphone indicator in the menu bar goes off.
- **Reference notes:** each button plays the string's note with the track's instrument, also while the song is stopped.

### 2d. The audio input

Plug an audio interface in (a Focusrite Scarlett or similar) with a guitar in its instrument input. Open Help › Settings….

- Under **Audio**, the **Input** list shows only **System default** at first. **Show all inputs** asks for the microphone, then lists the built-in microphone and the interface by name. The menu bar's microphone indicator goes off again straight away.
- Choose the interface. Open the tuner, **Input** › **Start listening**: the status names the interface, and the needle follows the guitar, not the room.
- **Change input…** in the tuner opens Settings on top of it. Choose **System default** and close Settings: the tuner switches to the built-in microphone without being stopped.
- Quit and start Smart Beat again: the interface is still the input.
- Unplug the interface and listen again: the tuner says it is not connected. Settings lists it as "(not connected)" until it is plugged in again.

### 2e. Third-party plugins (#80)

Plugins are third-party code, so this is about hearing them work and hearing them fail safely.

- Open a song's pedalboard, switch **Third-party plugins** on (it is off on every launch) and press **Scan for plugins…**: your installed VST3 and CLAP plugins appear with their vendor and version, and files that cannot load are counted as skipped instead of failing the scan.
- Add an amp sim or pedal, open its own window, change a setting there and hear it. Then press **Save settings**, close and reopen the song: the setting is back, in its editor too.
- Play with the plugin on the master bus at your usual device buffer, then at the smallest and largest your interface offers (128 through 1024 frames in Audio MIDI Setup): the effect must sound even and continuous at every size, never chopping in and out. The block shows the added latency it reports; a 512-frame buffer should read about 10 ms plus the plugin's own.
- Turn **Third-party plugins** off while playing: the effect disappears immediately and the sound continues dry.
- Open a song whose plugin you do not have installed (or move the plugin file away) and play: the song plays without that block and says the plugin is not installed next to it.
- Pull the plugin's audio: rename the plugin file while it is loaded, then keep playing. The block should pass your dry signal (no silence, no stuck notes) and report the failure.
- Remove the block: the plugin's editor window closes and the helper process is gone in Activity Monitor (one per block).

### 3. The right drum for every drum number

[drum-midi-support.md](drum-midi-support.md) says which numbers sound, not whether the sample is the right instrument. Judge by ear:

1. Open a song with a drum track and the drum kit picker (the virtual drumkit under the tab) or the pads.
2. For every number in the table, play it and ask: is that the instrument the name says (kick, snare, hi-hat open, ride bell…)?
3. Write down the numbers that are wrong or missing under "By ear" in `drum-midi-support.md`, for each bundled SoundFont (Sonivox and FluidR3).

## Printing

### 4. Print and Save as PDF (#83)

WebKit may ignore the `@page` paper size. Check with a song of several tracks and with a larger notation size, in light and dark mode (the PDF is always light).

**macOS (installed app):**

1. File › Print / PDF… › **Export as PDF…** (or File › Export › PDF…): a save dialog asks where, no print panel opens, and a message names the file and its folder when it is done.
2. Open the PDF: paper size and orientation as chosen, margins, no cut-off bars, every chosen track present.
3. **Print…** opens the macOS print panel (it was blocked before #83). Its PDF › Save as PDF still works.

**Windows:** Print… opens the system print dialog; choose "Microsoft Print to PDF" and the file name there. **Linux:** Print… opens the GTK print dialog; choose "Print to File" (PDF). Note on each which version you used.

## Files we write

### 5. Open Smart Beat's files in the real programs

Save a song (try `practice-song.gp` from `e2e/fixtures`, and a song of your own that is not a commercial transcription) with File › Save As in every format below, and open each file in the program named. The "saved with limits" message after saving lists what the format cannot hold: check that exactly that is missing, and that the rest sounds and looks the same.

| File            | Open it in                           | Look for                                                                                                                                    |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.gp5`          | Guitar Pro 5 (also TuxGuitar)        | tempo names, repeats and endings, drums on the right drum lines, lyrics, chords                                                             |
| `.gp4`          | Guitar Pro 4 (also TuxGuitar)        | the same, plus the single triplet feel and the numbered endings                                                                             |
| `.gp3`          | Guitar Pro 3 (also TuxGuitar)        | the same; no lyrics, fewer effects                                                                                                          |
| `.gp`           | Guitar Pro 7 or 8                    | everything; the mix                                                                                                                         |
| `.mscz` `.mscx` | MuseScore 3 and MuseScore 4          | opens without an error; notes, ties, tuplets, dynamics, lyrics, repeats, tempo; the guitar is standard notation; the drums use the drum set |
| `.mxl`          | MuseScore, or any MusicXML reader    | opens; same notes                                                                                                                           |
| `.atex`         | alphaTab's playground (alphatab.net) | renders the same song                                                                                                                       |
| `.m4a`          | QuickTime Player, Music, a phone     | plays; length matches the song; no clipping                                                                                                 |

Write down which version of each program you used.

## Updates (needs two published releases)

### 6. Update from one release to the next (#82)

The automated tests mock the update server. Only two real releases prove the whole path: key, signature, URLs and permissions. Do it on **each OS** (on Linux, with the AppImage).

1. Publish release N from a tag (for example `v0.2.0`; see [release.md](release.md)) and install it from the GitHub Release page.
2. Publish release N+1 (`v0.2.1`) with a distinct line in its `CHANGELOG.md` section.
3. In the installed app, open Help › Check for Updates…. It must offer N+1 with the installed and the available version and N+1's release notes.
4. Click **Later**: nothing is downloaded, and the app keeps working.
5. Check again and click **Download & Install**. The progress bar fills, the app restarts, and About shows N+1.
6. Check once more: "You're up to date".
7. Automatic check: install N again, quit, wait or clear the `smart-beat:last-update-check` entry (or reinstall), and start the app. A few seconds after startup the update dialog must appear by itself, only because there is a newer version. With no newer version, nothing must appear.

Also try a failure: switch off the network and use Help › Check for Updates…; it must show an error with **Try again**, and the automatic check must stay silent.
