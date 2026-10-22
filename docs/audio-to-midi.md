# Audio-to-MIDI transcription

Import from Audio turns a recording into MIDI **on this computer**. The model is
[MuScriptor](https://github.com/muscriptor/muscriptor) by Kyutai and Mirelo, an optional
download: the weights (GGUF, float16, converted without retraining by DamRsn) never ship with
the app and are never hosted by Smart Beat. The user downloads a size (small, medium or large)
through a guided installer ([`ai-install.md`](ai-install.md)). Nothing is uploaded, and the app
needs no API key, no account and no server. The earlier self-hosted server path was removed
(issue #150).

## How it runs

1. The dialog checks the AI store (`src/lib/ai/ai-store.ts`). Without the model and the accepted
   terms it shows a **Download MuScriptor** button first; that hands over to the installer and
   comes back to this dialog when the installer closes.
2. The page sends the recording to Rust as the request body, with the headers `operation-id`,
   `file-type`, `instruments` and `model-size` (`src-tauri/src/transcription.rs`). Rust refuses to
   run unless the terms are on file (`recording/muscriptor_model.rs`).
3. Rust measures the length (limit 15 minutes, 100 MiB), decodes it with symphonia, mixes it to
   mono, resamples it to 16 kHz and runs MuScriptor through `muscriptor.cpp`
   (`recording/muscriptor.rs`, `muscriptor_ffi.rs`, `native/`). `instruments` limits the model to
   the chosen instrument groups.
4. The notes (`onset`, `offset`, `pitch`, `program`, `is_drum`, no velocity) become a Standard
   MIDI file (one track per program, drums on channel 10, a fixed 120 bpm so the notes keep real
   time) and the preview notes. The page's existing importer lays them on a grid.
5. Cancel stops the model between two steps. Progress comes as `transcription-progress`.

Formats: MP3, WAV, FLAC and OGG (what symphonia decodes). A file dropped on the window reaches
Rust as a path: Rust records the paths of each drop and reads only those, once per drop. The
instrument ids in `src/lib/audio-transcription/instrument-ids.json` are MuScriptor's 35
instrument groups; their position is the group id (drums is 36).

## Entry points

Import from Audio… opens the same dialog from three places: the welcome screen, the native
File menu, and the File menu beside Open while a song is open. It is a menu item there
because the header has no room for another button: at 1280 px, edit mode would wrap the
header onto a second line.

## Preview and import

The dialog shows a piano roll, the generated instruments, show/mute/solo controls and
synthesized-tone playback. This preview keeps note timing but is not a sampled instrument
rendition. Imported MIDI goes through Smart Beat's existing score importer and normal
instrument playback.

Import opens a new score immediately, uses the recording name as the score title, and keeps
existing scores open. A failed import keeps the MIDI in the dialog. Save MIDI As writes the
same bytes the import uses. No temporary MIDI file is needed.

## Privacy

The recording never leaves the computer: decoding, resampling and the model all run locally.
Smart Beat counts completed transcriptions in its anonymous usage counters, without file names or
transcription content: `audio_transcribe`, and `ai_transcribe_file` with whether the rights
confirmation is on file. See [analytics](analytics.md).

## Licensing

- **Code:** instrument aliases and fuzzy matching are adapted from MuScriptor's
  `web/src/instruments.ts`, commit `7f213afecf23bd6a1b8672aa223690ee9807cefb` (MIT, notice in
  `src/lib/audio-transcription/upstream/`). `muscriptor.cpp` and ggml (both MIT) are built into
  the app; their notices are in Help › Open-Source Licenses.
- **Weights:** CC BY-NC 4.0, non-commercial use only. `AGENTS.md` keeps a deliberate,
  time-limited exception for this one model, with the reasons and the revocation triggers (a
  paid tier, no from Kyutai or Mirelo, changed terms). The user accepts the terms on the
  official model card and confirms in the installer that they only use music they have the
  rights to; the app keeps a record and refuses to run without it. The exception is described in
  [`licensing.md`](licensing.md) and `EULA.md` (clauses 2 and 5).
- No provider logos are included.

## Tests

- **Rust:** length measurement, dropped-file reads, the MIDI writer, program-to-instrument
  naming, the terms gate, the model downloader and the network-client guard.
- **Vitest:** the AI store, the installer dialog, the audio dialog's download-first state and
  the provider's headers.
- **e2e:** `e2e/audio-transcription.spec.ts` and `e2e/ai-install.spec.ts` run the whole flow in
  Chromium and WebKit against mocked native commands, with axe scans in light and dark mode.
- **By hand:** `cargo test --lib real_model -- --ignored --nocapture` downloads the small model
  and transcribes a clip (set `SMART_BEAT_MUSCRIPTOR_WAV` to a 16 kHz mono WAV).
