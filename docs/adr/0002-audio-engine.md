# ADR 0002: A native audio engine next to alphaTab (hybrid)

- **Status:** Accepted (the native engine ships as an opt-in, experimental switch)
- **Date:** 2026-10-01
- **Issue:** [#34](https://github.com/mbalyi/smart-beat/issues/34)
- **Unblocks:** effect chains and pedalboard (#36), mixing (#37), audio track (#38), compressor and mastering (#39), drum kits (#40), amp and IR import (#41), genre presets (#42)

## Context

Until now alphaTab did everything: it draws the score and plays it with its own SoundFont synthesizer (alphaSynth) in a web worker, output through an AudioWorklet. alphaSynth mixes all tracks into **one stereo stream**. There is no per-track bus, so nothing can be inserted on a single track: no gate, compressor, amp, cabinet or EQ, and no per-drum-element bus.

The sound issues need:

- an effect chain of up to 6 blocks per track and 3 on the master bus, switchable without clicks;
- amp and pedal captures (Neural Amp Modeler `.nam`) and cabinet impulse responses from the user's library;
- per-track and later per-drum-element buses, meters and automation;
- an audio file mixed with the score, following its tempo;
- the same sound when exporting audio;
- only commercial-friendly licences (ADR 0001).

## Options

|                                   | A. WebAudio only                                                                                                                  | B. Rust engine only                                  | **C. Hybrid (chosen)**                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Synthesis                         | One alphaSynth per track feeding our own `ISynthOutput`                                                                           | `rustysynth` per track, sharing one parsed SoundFont | B in the desktop app, alphaSynth stays as the fallback                                                             |
| Effects                           | WebAudio nodes (`DynamicsCompressorNode`, `BiquadFilterNode`, `ConvolverNode`) plus AudioWorklets (gate) or Rust compiled to WASM | Our own DSP in Rust                                  | Rust                                                                                                               |
| NAM amps                          | WASM build of a NAM runtime in an AudioWorklet, single-threaded                                                                   | `nam-rs` (MIT, pure Rust)                            | Rust                                                                                                               |
| Cursor and transport              | alphaTab as now                                                                                                                   | Must be rebuilt                                      | alphaTab **external media** mode: alphaTab keeps the notation, cursor and transport and follows the engine's clock |
| Works in the browser / Playwright | Yes                                                                                                                               | No                                                   | Yes (fallback)                                                                                                     |
| Plugin hosting later (VST3/CLAP)  | No                                                                                                                                | Yes (out of process)                                 | Yes                                                                                                                |

alphaTab 1.8.4 provides what the hybrid needs:

- `PlayerMode.EnabledExternalMedia` with `IExternalMediaHandler` (play, pause, seek, rate, volume) and `updatePosition`. alphaTab handles looping and the end of the song from the position we report.
- `midiLoad`: the MIDI it generated for the score. We send that to the engine, so the engine plays exactly what alphaSynth would, including our effect approximations (`effect-sound.ts`) and drum remapping.
- `BackingTrackSyncPoint` and `PlayerMode.EnabledBackingTrack` for an audio file with sync points. This is the model for the audio track (#38).

## Measurements (Apple Silicon, M-series, release build, 48 kHz)

Native engine, `cargo run --release --example audio_bench`:

| What                                                                | Cost                         |
| ------------------------------------------------------------------- | ---------------------------- |
| SoundFont load, Sonivox SF3 (1 MB): Vorbis decode + parse           | 230 ms                       |
| SoundFont load, FluidR3 Mono SF3 (14.6 MB)                          | 2.6 s (to be cached on disk) |
| Effect chain only (gate, compressor, 10-band EQ, cab IR), one track | 0.9 % of one core            |
| 1 / 4 / 8 / 16 tracks, synth only, 16 notes per bar per track       | 0.09 / 0.50 / 0.97 / 2.2 %   |
| 1 / 4 / 8 / 16 tracks, synth + chain                                | 0.97 / 4.1 / 8.2 / 16.6 %    |
| Output latency (CoreAudio default device, callback → playback)      | 13.7 ms                      |

WebAudio, the same chain built from native nodes (no gate, no NAM), rendered offline (`node scripts/audio-bench-web.mjs`):

| Tracks | Chromium | WebKit |
| ------ | -------- | ------ |
| 1      | 1.7 %    | 1.5 %  |
| 8      | 13.7 %   | 11.5 % |
| 16     | 27.5 %   | 22.9 % |

Also considered for WebAudio: every per-track alphaSynth instance decodes its own copy of the samples it uses. A Rust `SoundFont` is parsed once and shared by all track synthesizers (`Arc`).

The compressor converts levels to decibels per sample. That conversion is most of the chain's cost and is the first thing to optimise if 32+ tracks become a target.

## Decision

1. **Hybrid (C).** alphaTab keeps notation, cursor, transport, practice tools and MIDI generation. In the desktop app the **native engine** (`src-tauri/src/audio`) can make the sound instead of alphaSynth. It is switched on per user in the inspector ("Native engine with effects") and is off by default while it is experimental. In a plain browser only alphaSynth exists.
2. **Engine structure:**
   - `sf3.rs`: SF3 → SF2 conversion (lewton);
   - `song.rs`: alphaTab's MIDI with times;
   - `engine.rs`: one `rustysynth` synthesizer per track, sharing the SoundFont. Each track has a bus with an effect chain, volume, mute, solo and a peak meter, all mixed into a master bus with its own chain;
   - `chain.rs`: blocks as serde data, built off the audio thread, with a 20 ms crossfade on every change;
   - `dsp/`: gate, compressor, EQ, drive and a partitioned FFT convolver, all written by us, plus NAM through `nam-rs`;
   - `output.rs`: cpal stream on its own thread;
   - `library.rs`: the user's `.nam` and `.wav` imports, plus built-in cabinets that we generate ourselves;
   - IPC commands in `mod.rs`.
3. **Audio export** in native mode renders offline through the same engine and chains (`audio_render`). The export sounds like playback.
4. **Chains are saved with the song's mixer settings** (`MixerSettings.effects` / `masterEffects`). They are not saved in Guitar Pro files, which have no place for them.
5. **Real-time safety:**
   - The audio callback only `try_lock`s the engine. If the UI holds the lock, that buffer is silence and counted as a dropout (shown in `audio_state`).
   - Chains are built outside the lock, and old chains are dropped outside it.
   - Every bus ends with a NaN/∞ guard, and the master is clamped to ±1.

## Licences checked

| Crate / package                  | Licence                                                          | Use                                       |
| -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `cpal` 0.18                      | Apache-2.0                                                       | Audio output (CoreAudio, WASAPI, ALSA)    |
| `rustysynth` 1.3                 | MIT                                                              | SoundFont synthesis                       |
| `lewton` 0.10                    | MIT OR Apache-2.0                                                | Ogg Vorbis (SF3 samples)                  |
| `nam-rs` 0.4                     | MIT (ports MIT code from NAM, NeuralAmpModelerCore, NeuralAudio) | Amp and pedal captures                    |
| `realfft` / `rustfft`            | MIT OR Apache-2.0                                                | Convolution                               |
| `hound` 3.5                      | Apache-2.0                                                       | Reading IR WAV files                      |
| `symphonia` (later, audio track) | MPL-2.0                                                          | Decoding MP3/FLAC/OGG; allowed unmodified |

Not allowed: Guitarix, ChowDSP BYOD, dm-TubeScreamer, AmpForge (GPL-3), LSP (LGPL), lamejs (LGPL). See [`docs/sound-presets-research.md`](../sound-presets-research.md).

## Consequences

- Effects, the pedalboard (#36), the compressor and mastering chain (#39), NAM and IR import (#41) and genre presets (#42) now have a signal path. This PR ships a first version of each.
- **Not yet in the native engine:**
  - count-in;
  - per-drum-element buses (each drum key needs its own synth voice group; planned for #37);
  - an audio track (#38: decode with symphonia, play on its own bus, follow sync points);
  - sound automation;
  - reverb, delay and modulation blocks.
- Two players must stay in step:
  - The engine reports the position of what is heard (its output latency is subtracted), and alphaTab draws the cursor there.
  - The UI polls every 25 ms, so a loop restart can show the cursor up to one poll late, while the audio itself loops sample-accurately in the engine.
- Linux builds need `libasound2-dev` (ALSA) for cpal.
- Browser tests (Playwright) keep testing alphaSynth playback. The native engine is covered by Rust tests (DSP on known signals, every preset, a full song through chains with the real Sonivox SoundFont) and by Vitest tests with the IPC mocked.

## Alternatives considered

- **WebAudio only (A).** Simple and testable in the browser. But WebAudio nodes cost more than the native chain (above), there is no gate node, NAM would need a single-threaded WASM runtime, and per-track alphaSynth instances duplicate sample memory. Rejected for now. A WASM build of the same Rust DSP stays possible if a web version is ever needed.
- **Rust only (B).** Would mean rebuilding alphaTab's cursor, looping, speed trainer and MIDI generation. The hybrid keeps all of it.
- **Hosting third-party plugins in process.** Rejected for stability and sandboxing. Opt-in out-of-process VST3/CLAP hosting stays on #41's list.
