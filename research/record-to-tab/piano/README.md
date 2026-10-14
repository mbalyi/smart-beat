# Record to tab: piano accuracy

Measures how well the Record to tab note finder (Basic Pitch) hears a piano, for issue #120.
Results and conclusions: [docs/record-to-tab-piano.md](../../../docs/record-to-tab-piano.md).

Nothing here ships in the app. `data/`, `clips/` and `out/` are git-ignored.

## How it works

1. `fetch.sh` downloads six public-domain pieces as MIDI from the Mutopia Project and the CC BY 3.0
   Yamaha grand piano sound set (SF2) from FreePats.
2. `humanize.py` adds timing noise (about 12 ms), slow tempo drift and varied loudness, and writes
   the ground truth notes (`*.gt.json`).
3. `render/` (a small Rust program using `rustysynth`) plays that MIDI through the sound set to a WAV.
4. `run.sh` runs `transcribe_wav` on every WAV and `score.py` compares the notes with the ground
   truth using `mir_eval`: note F1 with the onset within 50 ms, and with the offset rule too.

```sh
cd research/record-to-tab/piano
./fetch.sh
cargo build --release --manifest-path ../../../src-tauri/Cargo.toml --example transcribe_wav
./run.sh                                   # Basic Pitch defaults (the guitar settings)
./run.sh INSTRUMENT=piano                  # the piano settings that ship
./run.sh ONSET=0.7 FRAME=0.4 MELODIA=0     # try your own
```

Transkun in Python: `transkun clip.wav out.mid`, then `mid2json.py out.mid out.json` and `score.py` on that folder.

Transkun in Rust (what the app runs): make the model files with `export_transkun.py OUT_DIR` (a venv with
`transkun`, `torch` 2.2, `onnx`, `onnxruntime` and `numpy<2`), then
`TRANSKUN_DIR=OUT_DIR ./run.sh`.

## Limits

The audio is rendered, not a real room with a real microphone, so every engine scores higher than
it would on a recording. Use the numbers to compare engines and settings, not as the accuracy a
player will see.
