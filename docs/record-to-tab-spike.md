# Record to tab: Basic Pitch or FretNet

Issue: [#108](https://github.com/mbalyi/smart-beat/issues/108)

Record to tab turns a recorded guitar part into tab. This spike compared two ways to do it, on the same recordings and the same machine. The result: Smart Beat ships Basic Pitch with its own fret placement. FretNet stays out of the app.

## The two engines

- **Ours.** [Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0) finds the notes. It runs in Rust through `tract` (`src-tauri/src/recording/`). Smart Beat's own placement then picks a playable string and fret for each note (`src/lib/import/fret-placement.ts`). The model is 230 KB and ships in the app.
- **FretNet.** [FretNet](https://github.com/cwitkowitz/guitar-transcription-continuous) (MIT code) predicts the string and fret directly from the audio. The author shared trained weights for fold 0 in [a GitHub issue](https://github.com/cwitkowitz/guitar-transcription-continuous/issues/1). No training was needed.

## Test set

- [GuitarSet](https://zenodo.org/records/3371780) (CC BY 4.0), mono microphone recordings of player 00: 60 clips, 13,223 notes with string and fret.
- The FretNet fold-0 weights were trained without player 00, so both engines see these clips for the first time.
- GuitarSet is clean acoustic guitar. The numbers say nothing about distorted electric guitar.
- Both engines ran with their default settings. Neither was tuned on this set.

## Results

| Measure                                 | Ours                       | FretNet                        |
| --------------------------------------- | -------------------------- | ------------------------------ |
| Note F1 (pitch and onset, 50 ms)        | **72.4%**                  | 51.7%                          |
| Note precision / recall                 | 73.7% / **71.1%**          | **91.8%** / 36.0%              |
| Note F1 with offsets                    | **47.4%**                  | 28.9%                          |
| Tab F1 (pitch, onset, string and fret)  | **46.7%**                  | 44.7%                          |
| Tab F1, mean per clip                   | 42.2%                      | **50.8%**                      |
| Right string, of the notes found        | 64%                        | **87%**                        |
| Time for 60 s of audio, CPU             | **2.3 s** (RTF 0.039)      | 6.1 s (RTF 0.102)              |
| Time for 60 s of audio, GPU (Apple MPS) | not needed                 | 3.1 s (RTF 0.052)              |
| Peak memory                             | **86 MB** + 137 MB         | 886 MB (CPU), 544 MB (GPU)     |
| Added to the app                        | **230 KB** model + `tract` | 19.4 MB model + HCQT + runtime |

RTF is the real-time factor: processing time divided by the length of the audio. Ours ran as two processes, the Rust example for the notes and the Node script for the placement, so its memory has two numbers.

## What the numbers mean

- Ours finds about twice as many notes. FretNet finds few notes, but most of the notes it finds are right.
- FretNet picks the string the player used more often. Our placement picks the most playable position, and GuitarSet players often play higher up the neck than that.
- Across all notes, tab accuracy is about equal.
- Ours is 2.6 times faster on the CPU, needs no GPU and uses about a quarter of the memory.
- A minimum machine for ours is any Mac that runs Smart Beat. FretNet would need about 1 GB of free memory.
- In a hands-on test with a real guitar in the app, ours gave the better tab.

## Licences

- Basic Pitch code and model: Apache-2.0. The licence and `NOTICE` ship in the app.
- `tract`: MIT OR Apache-2.0.
- FretNet code: MIT. FretNet weights: **no stated licence**. Shipping them would need the author's written permission.
- GuitarSet: CC BY 4.0, used only for this measurement.

See [`licensing.md`](licensing.md) for the full tables.

## Decision

Smart Beat ships Basic Pitch with its own fret placement. FretNet does not ship: it does not beat our pipeline, and its weights have no licence.

Two ideas could raise accuracy later:

- A threshold sweep for FretNet, to see how much recall it gains.
- A hybrid: Basic Pitch finds the notes, and FretNet only picks the string.

Both need the FretNet weights licence first.

## Reproduce

The harness is in [`research/record-to-tab/`](../research/record-to-tab/README.md). It downloads GuitarSet and the FretNet weights into git-ignored folders. Results land in `research/record-to-tab/results/summary.json`. The measurements above ran on an Apple M3 with 16 GB of memory.
