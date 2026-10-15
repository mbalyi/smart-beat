# Record to tab: drum accuracy

Measures how well the Record to tab hit finder (`src-tauri/src/recording/drums.rs`) hears a drum kit, for issue #121.
Results and conclusions: [docs/record-to-tab-drums.md](../../../docs/record-to-tab-drums.md).

Nothing here ships in the app. `clips/`, `out/`, `iso/` and `render/target/` are git-ignored.

1. `gen.py` writes the patterns (a MIDI file and the ground-truth hits per clip) with timing noise. Python standard library only.
2. `render/` plays them through the Sonivox drum kit (`sonivox.sf2`, Apache-2.0, ships in the `@coderline/alphatab` package) into WAV files.
3. `run.sh` runs `transcribe_wav` with `INSTRUMENT=drums` on every WAV and `score.py` prints per-class onset F1 (50 ms).

```sh
cargo build --release --manifest-path ../../../src-tauri/Cargo.toml --example transcribe_wav
./run.sh                 # the shipped settings
./run.sh TOMS=0 CRASH=0  # the options are listed in src-tauri/examples/transcribe_wav.rs
```

`SF2=/path/to/sonivox.sf2 ./run.sh` uses another file (it must be SF2, not SF3).
