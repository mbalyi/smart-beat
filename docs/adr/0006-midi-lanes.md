# ADR 0006: MIDI lanes, MIDI clips and pad banks

- **Status:** Accepted
- **Date:** 2026-11-27
- **Issue:** [#250](https://github.com/mbalyi/smart-beat/issues/250)
- **Amends:** [ADR 0005](0005-audio-lanes-and-clips.md). Lanes, clips, the audio timeline, buses and the lane band stay as they are; this record adds a second kind of lane.

## Context

Players want to record what they play on a pad controller, an electronic drum kit, a MIDI keyboard or the app's own on-screen drums, fix it afterwards and hear it with a sound and effects of their choice. Audio lanes only hold audio files, tab tracks are score tracks, and there was no MIDI input at all. A MIDI recording needs somewhere to live that the lane editor, the lane band under the tabs, the mixer, the effects and the WAV export already understand.

## Decision

**A MIDI lane is a lane with `kind: "midi"`.**

- `AudioLane` gets an optional `kind` (absent: audio) and, for a MIDI lane, an `instrument`. Everything else a lane has (name, colour, volume, pan, mute, solo, EQ, effects, automation, sends, folders, groups, the band under the tabs) is shared by both kinds, so a MIDI lane goes through the same lane bus, effect chain (built-in blocks, VST3 and CLAP effects) and sends as an audio lane.
- A lane holds clips of its own kind only: an audio clip never lands on a MIDI lane and a MIDI clip never on an audio lane. Normalizing drops a clip of the wrong kind.

**A MIDI clip is a clip with `midi` events.**

- A MIDI clip keeps every clip field, so move, nudge, copy, paste, ripple, snapping, markers, selection, groups, lock and mute work unchanged. Position and length stay in **ms on the audio timeline**.
- Its `takes` keep only their names (an empty `sourceId`); `midi.takes[i]` holds the events of `takes[i]`, so take lanes and choosing a take work as for audio. Loop recording adds one take per pass.
- **Event times are ms from the clip start.** We chose ms over musical ticks because clips already live on the audio timeline: the engine maps that timeline with the song's `SyncMap` for the speed trainer and tempo, exactly as for audio, and split, trim and glue only have to cut and shift numbers. The editor grid converts with the song's bar grid (`src/lib/audio-lanes/sync.ts`).
- A note has pitch, velocity (1 to 127), channel, start and length, an optional mute, and the **played timing** (`rawStartMs`, `rawLenMs`) once it has been quantized. Un-quantize and every later quantize start from the played timing, so no grid is ever baked in until the user freezes it.
- Controller events (`cc`): a controller change, pitch bend, channel pressure or program change, each with a time and channel.
- Fades, gain envelope, stretch, reverse and playrate don't apply to MIDI clips and are kept at their neutral values. The clip's semitones transpose its notes.
- **No effects per clip.** A part that needs its own effects is split onto its own lane, or rendered to audio ("Render to audio lane").

**The instrument belongs to the lane.**

- `soundfont` (a General MIDI program and bank of the song's SoundFont), `drums` (the General MIDI kit), `kit` (an imported SFZ or SoundFont kit), `pads` (a pad bank of samples) or `plugin` (a VST3 or CLAP instrument, run out of process like effects).
- **Pad bank:** up to 128 pads. A pad answers one MIDI key and plays a sample from the sample browser (or a drum of the General MIDI kit), with playback mode (one-shot, gate, loop), trim, tune, volume, pan, velocity depth, a choke group (1 to 16, so a closed hi-hat stops an open one), a voice limit, and send levels to the song's first two buses. Every pad goes through the lane's effect chain.
- A pad's sample is copied into the song's pool when it is chosen (`sourceId`, the SHA-256 like any source), so a song plays the same on another computer and in Practice together. A save keeps a source that a clip **or a pad** plays.
- Which pad of a controller sends which key is a **device setting**, kept in the app data folder with the device's name, never in the song: the same song works with another controller.

**Tab tracks stay score tracks.** A MIDI lane is not a tab track. A recording can be written into a tab track afterwards (the same converter as "Convert audio to sheet").

**Settings version 4.** Version 4 adds the MIDI fields; version 3 files load unchanged (every new field is optional). A song is written as version 4 only when it has a MIDI lane (`MixerSettings::for_writing`), so songs without one still open in earlier releases. Earlier releases refuse a version 4 file, which the release note says.

**Practice together.** `kind` and `instrument` are shared lane fields. A MIDI clip travels in one `a-clip-set` when it fits a message; a bigger one is sent as the clip with empty takes followed by `a-midi-notes` parts (the first part of a take replaces its events, later parts add to them). Every part is checked like any other operation.

## Consequences

- Every place that reads a clip's audio (waveforms, zero crossings, stretch, transcription, silence detection) checks the clip's kind; MIDI clips draw notes instead.
- The engine builds an instrument per MIDI lane and schedules the clips' events against the audio timeline, then runs the lane's normal bus. A MIDI lane that is armed or monitored also renders while the song is stopped, so live playing is heard.
- Limits: 20,000 notes and 50,000 controller events per take, 200,000 MIDI events per song.
