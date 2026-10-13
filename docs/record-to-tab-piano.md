# Record to tab: piano

Issue: [#120](https://github.com/mbalyi/smart-beat/issues/120)

Record to tab can now listen to a piano. This page records how well it hears one, what was tuned, which open-source piano models were compared, and why none of them ships yet.

## What shipped

- The dialog has an **Instrument** choice: Guitar or bass, or Piano. A piano needs no tuning.
- A piano take is split between the hands by pitch (`src/lib/import/hand-split.ts`: notes near middle C follow the hand that played the nearest note just before them). The right hand goes to a treble-clef track and the left hand to a bass-clef track, named "Recording" and "Recording (left hand)". There are no frets: the notes are written as they are heard, from A0 to C8.
- Two tracks, not one two-staff track. Smart Beat's editor, playback and exports work on one staff per track, so a true grand staff would break editing. Both tracks are ordinary tracks and stay editable.
- Click and free mode and the File mode all work for piano. In click mode, a new take creates both tracks in one undo step. A take written onto an existing piano track goes onto that track as it is.
- The Rust command takes an optional `x-instrument` header. For piano it uses `NoteOptions::piano()` (`src-tauri/src/recording/notes.rs`): only the 88 keys, onset threshold 0.7 (default 0.5), frame threshold 0.4 (default 0.3), shortest note 100 ms, and the frame-only ("melodia") pass off. Guitar is unchanged.
- Everything runs on this computer with the 230 KB Basic Pitch model that was already bundled. No network, no account, no new model, no new dependency.

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

| Engine                                       | Precision | Recall |   Note F1 | With offsets | Speed on this Mac (CPU) |
| -------------------------------------------- | --------: | -----: | --------: | -----------: | ----------------------- |
| Basic Pitch, guitar settings (before)        |     0.683 |  0.883 |     0.762 |        0.410 | 0.04× (guitar spike)    |
| **Basic Pitch, piano settings (shipped)**    |     0.916 |  0.825 | **0.864** |        0.453 | 0.04× (guitar spike)    |
| Transkun 2.0.1 (MIT) in Python, PyTorch, CPU |     0.999 |  0.983 | **0.991** |        0.596 | about 0.5× real time    |

Tuning, one change at a time on the same six pieces (note F1): onset threshold 0.7 gave 0.817; turning the frame-only pass off gave 0.851 alongside it; frame threshold 0.4 gave 0.855; shortest note 100 ms gave 0.864. Higher thresholds raise precision and lower recall, so 0.7/0.4 is where the two meet. The settings were found on these six pieces, so the true gain on other music may be somewhat smaller.

What is still wrong with Basic Pitch on piano: it misses about one note in six, and the note ends are poor (offset F1 0.45 against 0.60 for Transkun). The causes were not analysed further.

## Open-source piano models

| Model                                                                             | Kind                            | Code / weights licence                                                     | Result here                                                           |
| --------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Transkun](https://github.com/Yujia-Yan/Transkun)                                 | Neural semi-CRF (no LLM)        | MIT / MIT (PyPI); published MAESTRO v3 onset F1 0.983                      | **F1 0.991**, 0.5× real time on CPU in PyTorch. Not ported or shipped |
| [Aria-AMT](https://github.com/EleutherAI/aria-amt) (EleutherAI)                   | Transformer (the LLM-like one)  | Apache-2.0 / not stated in the repo ("preliminary" weights); aimed at GPUs | Not run: no CPU or ONNX path, weights licence not stated              |
| [ByteDance piano_transcription](https://github.com/bytedance/piano_transcription) | CRNN                            | Apache-2.0 / not stated; trained on MAESTRO v2                             | Not run: weights licence not stated                                   |
| [MuScriptor](https://github.com/muscriptor/muscriptor)                            | Multi-instrument sequence model | MIT / **CC BY-NC 4.0**                                                     | Not usable: non-commercial weights                                    |

A piano-only neural model is clearly better than a general one: Transkun finds nearly every note and is better at note ends too. The sequence-model ("LLM") route was not better for this job. The one that could be tested reaches its accuracy with a small convolutional and attention network, not a language model.

**Why nothing new ships:** the weights of Transkun, Aria-AMT and ByteDance were trained on MAESTRO, which is CC BY-NC-SA. None of the three says whether that licence passes to the weights. Until that is cleared in writing, `docs/licensing.md` marks them as not shippable. If it is cleared, the path is: export Transkun to ONNX (a third-party export exists), run it with `tract` like Basic Pitch, and download the weights on first use. It is probably tens of megabytes and about half real time on a CPU, so a 4-minute take would take about 2 minutes.

## Next steps

1. Decide whether to ask the Transkun author for a statement on the weights' licence, or to train a model on data that is free to use.
2. Measure on a few real piano recordings with a matching score.
3. Look at the missed notes and the note ends of Basic Pitch on piano; the cheap fixes (for example cutting a note when the same key is struck again) were not tried.
