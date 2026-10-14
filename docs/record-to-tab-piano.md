# Record to tab: piano

Issue: [#120](https://github.com/mbalyi/smart-beat/issues/120)

Record to tab can now listen to a piano. This page records how well it hears one, what was tuned, which open-source piano models were compared, and why none of them ships yet.

## What shipped

- The dialog has an **Instrument** choice: Guitar or bass, or Piano. A piano needs no tuning.
- A piano take is split between the hands by pitch (`src/lib/import/hand-split.ts`: notes near middle C follow the hand that played the nearest note just before them). The right hand goes to a treble-clef track and the left hand to a bass-clef track, named "Recording" and "Recording (left hand)". There are no frets: the notes are written as they are heard, from A0 to C8.
- Two tracks, not one two-staff track. Smart Beat's editor, playback and exports work on one staff per track, so a true grand staff would break editing. Both tracks are ordinary tracks and stay editable.
- Click and free mode and the File mode all work for piano. In click mode, a new take creates both tracks in one undo step. A take written onto an existing piano track goes onto that track as it is.
- The Rust command takes an optional `x-instrument` header. For piano it uses `NoteOptions::piano()` (`src-tauri/src/recording/notes.rs`): only the 88 keys, onset threshold 0.7 (default 0.5), frame threshold 0.4 (default 0.3), shortest note 100 ms, and the frame-only ("melodia") pass off. Guitar is unchanged.
- **Piano model: Standard or High accuracy.** Standard is Basic Pitch with the piano settings above: built in, 230 KB. High accuracy is [Transkun](https://github.com/Yujia-Yan/Transkun) 2.0 (MIT), ported to Rust (`src-tauri/src/recording/transkun.rs`) and run with `tract`. Its three files (55 MB) are not in the installer: the dialog offers a one-time download, which fetches them from the Smart Beat release `piano-model-1`, checks their size and SHA-256 and keeps them in the app's data folder (`src-tauri/src/recording/piano_model.rs`). After that it runs on this computer with no network. The recording is never uploaded. Without the download, the Standard model works as before.
- Everything else runs on this computer with the 230 KB Basic Pitch model that was already bundled: no account, no network.

## Test set

No free, ready-made recording comes with matching note data, so the test audio is rendered:

| Piece                               | Source (public-domain composition) | Notes | Length |
| ----------------------------------- | ---------------------------------- | ----: | -----: |
| Bach, Prelude in C (WTC I)          | Mutopia Project                    |   549 |  140 s |
| Satie, Gymnopédie 1                 | Mutopia Project                    |   282 |  141 s |
| Chopin, Prelude Op. 28 No. 7        | Mutopia Project                    |   168 |   24 s |
| Chopin, Prelude Op. 28 No. 15       | Mutopia Project                    | 1,518 |  267 s |
| Chopin, Nocturne Op. 9 No. 2        | Mutopia Project                    | 1,242 |  202 s |
| Beethoven, Pathétique, 2nd movement | Mutopia Project                    | 1,629 |  243 s |

Each MIDI file got timing noise (about 12 ms), a slow tempo drift and varied loudness, was written as the ground truth, then played through the Yamaha grand piano sound set from FreePats (CC BY 3.0, sampled from a Disklavier) by `rustysynth`. The harness is in [`research/record-to-tab/piano/`](../research/record-to-tab/piano/README.md).

**Limit:** this is a rendered piano, not a real room and microphone. Real recordings will score lower for every engine. Use the numbers to compare engines and settings. A real recording with a matching score was not available for free: the Open Goldberg Variations are CC0, but a human performance does not line up with its score to 50 ms.

## Results

Note F1: pitch within half a semitone and onset within 50 ms. "With offsets" also needs the note end within 20% of the length (at least 50 ms). Mean of the six pieces.

| Engine                                           | Precision | Recall |   Note F1 | With offsets | Speed on this Mac (CPU)              |
| ------------------------------------------------ | --------: | -----: | --------: | -----------: | ------------------------------------ |
| Basic Pitch, guitar settings (before)            |     0.683 |  0.883 |     0.762 |        0.410 | 0.04× (guitar spike)                 |
| **Basic Pitch, piano settings (Standard)**       |     0.916 |  0.825 | **0.864** |        0.453 | 0.04× (guitar spike)                 |
| Transkun 2.0 (MIT) in Python, PyTorch, CPU       |     0.999 |  0.983 |     0.991 |        0.596 | about 0.5× real time                 |
| **Transkun 2.0, Rust + `tract` (High accuracy)** |     0.999 |  0.983 | **0.991** |        0.596 | 0.5–0.6× real time (136 s for 267 s) |

Tuning, one change at a time on the same six pieces (note F1): onset threshold 0.7 gave 0.817; turning the frame-only pass off gave 0.851 alongside it; frame threshold 0.4 gave 0.855; shortest note 100 ms gave 0.864. Higher thresholds raise precision and lower recall, so 0.7/0.4 is where the two meet. The settings were found on these six pieces, so the true gain on other music may be somewhat smaller.

What is still wrong with Basic Pitch on piano: it misses about one note in six, and the note ends are poor (offset F1 0.45 against 0.60 for Transkun). The causes were not analysed further.

## Open-source piano models

| Model                                                                             | Kind                            | Code / weights licence                                                     | Result here                                                           |
| --------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Transkun](https://github.com/Yujia-Yan/Transkun)                                 | Neural semi-CRF (no LLM)        | MIT / MIT (PyPI); published MAESTRO v3 onset F1 0.983                      | **F1 0.991**, 0.5× real time on CPU in PyTorch. Not ported or shipped |
| [Aria-AMT](https://github.com/EleutherAI/aria-amt) (EleutherAI)                   | Transformer (the LLM-like one)  | Apache-2.0 / not stated in the repo ("preliminary" weights); aimed at GPUs | Not run: no CPU or ONNX path, weights licence not stated              |
| [ByteDance piano_transcription](https://github.com/bytedance/piano_transcription) | CRNN                            | Apache-2.0 / not stated; trained on MAESTRO v2                             | Not run: weights licence not stated                                   |
| [MuScriptor](https://github.com/muscriptor/muscriptor)                            | Multi-instrument sequence model | MIT / **CC BY-NC 4.0**                                                     | Not usable: non-commercial weights                                    |

A piano-only neural model is clearly better than a general one: Transkun finds nearly every note and is better at note ends too. Transkun is not a language model: it is a convolutional and attention network with a semi-CRF decoder. Aria-AMT, the Transformer ("LLM-like") one, could not be tested here, so there is no result on whether a sequence model does better.

## The licence decision for Transkun

Transkun's author publishes both the code and the weights under the MIT licence (the repository, the PyPI package and the `LICENSE` file say so). The weights were trained on MAESTRO, which is CC BY-NC-SA 4.0, and the repository does not say whether that licence passes on to the weights. The project owner decided on 2026-10-13 to ship Transkun on the author's MIT statement. The risk is recorded in `docs/licensing.md` and in `src-tauri/models/transkun/NOTICE`. If the author or the MAESTRO owners say otherwise, remove the download (`piano_model.rs`) and delete the release `piano-model-1`: the Standard model needs nothing from it. Aria-AMT and the ByteDance model were not added: their weights have no stated licence.

## How the port works and how it was checked

- `export_transkun.py` writes two ONNX graphs and a constants file from the PyTorch model, and checks each against ONNX Runtime (largest difference on the context 3e-3, on the heads 7e-6).
- The Rust code (`transkun.rs`) does what PyTorch did outside those graphs: 44.1 kHz mono in 16 s segments every 8 s, the Hann and Gaussian windows and the mel filter bank (log mel features), the semi-CRF Viterbi search for each of the 90 events, the velocity and edge heads, the joining of notes cut by a segment edge, and the overlap clean-up.
- On the six test pieces the Rust notes match the Python notes: same counts and same scores per piece (see the table). Unit tests cover the Viterbi search, the overlap clean-up and the download; two tests that need the real model files are marked `#[ignore]` and run with `TRANSKUN_DIR=<folder> cargo test --release --test recording -- --ignored`.
- Cost: about half real time on this Mac (a 267 s piece took 136 s, with all cores), and about 1.5 GB of memory at the peak. The 55 MB model is read once per app run.

## Next steps

1. The three model files are published as the release `piano-model-1`, marked **pre-release**. Keep it that way, and publish any new model release as a pre-release: the updater reads `releases/latest/download/latest.json`, so a normal release without `latest.json` would break the update check for everyone. The sums in `piano_model.rs` must match the files.
2. Ask the Transkun author for a short statement on the weights' licence in view of MAESTRO, or train a model on data that is free to use.
3. Measure on a few real piano recordings with a matching score.
4. Memory: the peak is about 1.5 GB. Dropping the query and key arrays before the heads run, and running the network with 16-bit weights, would cut it.
5. Basic Pitch on piano: look at the missed notes and the note ends; the cheap fixes (for example cutting a note when the same key is struck again) were not tried.
