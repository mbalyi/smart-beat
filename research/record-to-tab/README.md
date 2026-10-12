# Record to tab: comparison harness

This folder holds the research harness for issue #108. It scores two engines on GuitarSet player 00, the player held out from the FretNet fold-0 weights.

- `fretnet`: FretNet predicts string and fret directly from audio.
- `ours`: Basic Pitch notes from Rust, then our TypeScript string and fret placement.

Nothing here ships in the app. Do not commit data, weights or ONNX files. `data/`, `models/` and most of `results/` are git-ignored. Only `results/summary.json` is tracked.

## Setup

Python 3.11 and `uv`. The versions in `pyproject.toml` are pinned because the 2023 FretNet stack needs `numpy<2`, `librosa==0.9.2` and `setuptools<81`. The upstream repos are pinned by commit.

```sh
cd research/record-to-tab
uv sync
uv run fetch.py            # GuitarSet player 00 + FretNet fold-0 weights, prints sha256
uv run export_fretnet.py   # .pt -> models/fretnet.onnx, checks ONNX Runtime against PyTorch
```

`models/model-2000.pt` is a full pickled PyTorch model. Loading it runs code from the pickle. The globals inside it were checked first: only amt-tools, FretNet, inhibition-layer, torch and numpy classes. `export_fretnet.py` loads it once, in this project's venv. It also saves a plain state dict (`models/fretnet_state.pt`, loaded with `weights_only=True`) for the GPU timing. After export, only the ONNX file and the state dict are used. The weights have no stated licence.

## Run

```sh
uv run run_fretnet.py data/audio_mono-mic/00_BN1-129-Eb_comp_mic.wav            # ONNX Runtime, CPU
uv run run_fretnet.py data/audio_mono-mic/00_BN1-129-Eb_comp_mic.wav --backend mps
uv run evaluate.py --engine fretnet
uv run evaluate.py --engine ours      # needs the two commands below
uv run render_table.py                # Markdown table from results/summary.json
uv run python tests/test_harness.py
```

`run_fretnet.py` prints `{ "notes": [{ "start", "end", "pitch", "string", "fret" }] }`. HCQT features and note post-processing are the upstream Python code. The network runs in ONNX Runtime. Post-processing uses a random-weight FretNet shell, because upstream `post_proc` only needs the profile and the output layers. `export_fretnet.py` checks that this gives the same notes as the pickled model run through upstream `run_offline`.

## The `ours` engine

`evaluate.py --engine ours` runs two commands from the repo root. Both can be replaced with the `OURS_STEP1` and `OURS_STEP2` environment variables.

1. `cargo run --release --manifest-path src-tauri/Cargo.toml --example transcribe_wav -- <wav>` prints `{ "notes": [{ "start", "end", "pitch", "velocity" }] }` in seconds.
2. `node --import ./scripts/record-to-tab/register.mjs scripts/record-to-tab/notes-to-tab.ts --tuning standard` reads that JSON on stdin and prints `{ "bpm", "notes": [{ "start", "end", "pitch", "string", "fret" }], "warnings" }`. Node 24 prints an ExperimentalWarning on stderr. Ignore it.

Step 2 moves note times onto a tempo grid, so its times do not match the ground truth. The harness scores like this:

- Note F1 uses step 1 directly (original times and pitches).
- Tab F1 takes string and fret from step 2. Each step 2 note is matched back to a step 1 note with the same pitch, nearest start time first, each step 1 note used once. Step 2 notes with no partner are dropped. Step 1 notes with no partner have no tab position and count as misses.

## String numbering

- GuitarSet/JAMS: 0 = low E, 5 = high E. The harness uses this internally.
- Smart Beat (alphaTab): for a tuning array ordered highest first, `string = tuning.length - index`. The high E is 6 and the low E is 1.
- On a 6-string guitar, `jams_string = alphatab_string - 1`. `tests/test_harness.py` covers this.

## Metrics

- Note F1: pitch within 50 cents and onset within 50 ms (`mir_eval.transcription.match_notes`), with and without the offset rule (offset within 20 percent of the note length, at least 50 ms). Micro-averaged over all notes of all 60 player 00 clips. Per-clip means are in `results/summary.json`.
- Tab F1: a note counts only if pitch, onset, string and fret all match. Offsets are ignored.
- Real-time factor: processing time divided by audio time, for a 60 s clip made from concatenated comp clips. Median of three warm runs, model load excluded. FretNet is timed on ONNX Runtime CPU and PyTorch on MPS.
- Peak RAM: `/usr/bin/time -l` on the whole `run_fretnet.py` process, so it includes Python, torch and librosa.
- Sizes: ONNX file and the Python `onnxruntime` package. A Rust build would be smaller, but would also need an HCQT port.

## Licence notes

- Harness code in this folder is part of the Smart Beat repo. The upstream FretNet, amt-tools and inhibition code is MIT and is installed as dependencies, not copied.
- GuitarSet is CC BY 4.0.
- The FretNet weights have no stated licence. Do not redistribute them or any file derived from them.
