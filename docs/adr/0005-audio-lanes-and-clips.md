# ADR 0005: Audio lanes with clips (replacing the single audio track)

- **Status:** Accepted
- **Date:** 2026-11-09
- **Issue:** [#185](https://github.com/mbalyi/smart-beat/issues/185)
- **Replaces:** the "audio track" parts of [ADR 0003](0003-audio-engine.md) (its _Consequences_). The rest of ADR 0003 stays.

## Context

Until 1.2 a song had at most one audio track: one file, one set of mix settings and one sync map, stored as `audioTrack` in the mixer settings and played by a single `Backing` in the engine. Practising and arranging needs more:

- several files next to the tab (a backing, separated stems, takes);
- clips that can be moved, trimmed, split and joined;
- pitch per clip, effects per lane, and recording plain audio takes;
- everything the score app's audio track does, kept.

## Decision

**Lanes of clips on one audio timeline.**

- A song has up to 16 lanes. A lane has a name, a colour (the stem colours by default), mix settings (volume, pan, mute, solo, EQ, a filter, pitch), an effect chain with automation and auto-bypass, sends to up to four buses, a folder, and an edit group. A lane can be hidden from under the tabs; the flag `hiddenInScore` is saved with the song.
- A lane holds clips. A clip plays a range of a source file (or of one of its takes) from a point of the timeline, with gain, fades (linear, equal power, S-curve), a gain envelope, stretch markers, playrate (with or without keeping the pitch), pitch, mute, lock and reverse.
- Positions are milliseconds on the **audio timeline**. The song's sync points (per bar, or per beat) map the score onto that timeline. The speed trainer, tempo changes and sync are handled once for every clip, by the same `SyncMap` the old track used.

**Sources are pooled by content.**

- A source is identified by the SHA-256 of its bytes. An embedded source is stored once in the `.gp` file, as `SmartBeat/audio/<sha256>.<ext>`, however many clips play it.
- A save keeps only the files a clip plays, so removed clips do not grow the file.
- Takes are WAV files made by the app; they are always embedded.

**The engine plays lanes, not one backing.**

- `audio/lanes` builds a `ClipVoice` per clip (its own WSOLA stretcher, fades, envelope) and a `LaneBus` per lane (filter, channel EQ, `ChainPlayer`, fader and pan, sends). Buses have their own chains.
- Everything is built off the audio thread and swapped in under the engine lock. A knob turn keeps a lane's running chain (`Chain::update`); effect automation switches between pre-built slot lists.
- Export uses the same path, and playback and export run until the last clip ends, even after the song.
- The stretcher now primes its first grain, so a clip that starts where another ends joins without a dip.

**One-way migration.** Settings move from version 2 to version 3.

- On read, Rust and the frontend both turn an old `audioTrack` into one lane with one clip. They use the same ids: `legacy-<FNV-1a of the name>`.
- The old file stays readable under its old entry name until the first save.
- Saves write version 3 only. Older releases cannot read version 3 files.

**Analysis next to the lanes.** Rust gives:

- zero crossings, for clean splits;
- WAV extraction;
- spectrograms;
- loudness (ITU-R BS.1770 integrated and short-term LUFS);
- onset-based tempo and beat detection, for sync points.

**Lanes are decoded without the audio engine; only playback needs it.**

- Opening a file (`audio_load_source`, `audio_add_take`), its waveform peaks, zero crossings, spectrograms, loudness, beat detection, silent regions, WAV extraction, `audio_forget_sources` and storing the lane settings (`audio_set_lanes`) work on the shared source pool and never touch the engine. `audio_set_lanes` only rebuilds the engine's lanes when an engine runs.
- So waveforms, the lane editor, the studio and every clip edit work with the SoundFont (alphaTab) engine too, and adding a file never switches engines. The UI loads files with the file-level command; while the native engine runs it goes through the engine's loader instead, so the engine also remembers where each file came from.
- Only playback of lanes needs the native engine. With the SoundFonts the lanes are silent, and each lane (and the lane editor) says so, with a button to switch to the native engine (the user's own pick, so it is remembered). Recording still needs the native engine (input monitoring, count-in). This is a bridge until lanes can play next to SoundFont playback.

**Lanes also show under the tabs in the continuous view, mapped through the bars' measured x ranges.**

- The score draws bars of different widths, so the track list's fixed pixels per bar (and the editor's pixels per second) do not line up with the notation. In the continuous layout the player reads each bar's x range from alphaTab's bounds lookup (`ScorePlayer.barBounds()`, read again after every draw through `onLayoutChange`), and `lib/audio-lanes/bar-bounds.ts` turns the audio timeline into pixels and back: `barAtTimelineMs` and `timelineMsAtBar` (so sync points and padding still apply) joined to piecewise linear bars, extrapolating past both ends with the first and last bar's width.
- The band is a block in the score's paper, directly under the notation, so the scroll area grows to make room and no note is covered. It is drawn only in the continuous layout, when the song has lanes and the notation has been drawn. The page layout wraps bars onto lines and shows no band. Clips outside the visible range (plus a margin) are not drawn.
- Everything goes through the shared lanes controller and the shared clip, handle, marquee and menu components, which already take `toX` and `toMs`; a drag, trim, fade or marquee maps through the bars, and snapping stays in time. A lane element there registers its own pixel-to-time function (`registerLaneResolver`) for files dropped from Finder, instead of the `data-px-per-bar` and `data-ms-per-px` attributes the other hosts use. The controls (volume, pan, effects, colour) stay in the track list.

## Consequences

- The old `Backing` single-slot path, its commands (`audio_load_backing`, `audio_set_backing`, `audio_clear_backing`) and the audio track panel are gone.
- `decode`, `SyncMap`, `Stretcher`, `Interpolator` and the filter bank are reused per clip and per lane. The filter bank gained six enhance and attenuate filters (bass, mid, high).
- M4A files open: Symphonia's MP4 container and AAC decoder (MPL-2.0, unmodified, decoding only).
- Pitch stays on WSOLA. A better stretcher (for example Signalsmith Stretch, MIT) can replace it behind `ClipVoice` without changing the settings.
- The CPU cost grows with pitched or stretched clips: each one has a stretcher. Sixteen lanes with a few clips each stay well inside the ADR 0003 budget on Apple Silicon. This is checked by hand (`docs/manual-checks.md`).
