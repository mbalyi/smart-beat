#!/bin/zsh
# Renders the pieces, transcribes them and prints note F1. Run from this folder, after fetch.sh.
# Needs: python with mir_eval and pretty_midi; a Rust toolchain.
# Usage: ./run.sh [VAR=value ...]   (note options as in src-tauri/examples/transcribe_wav.rs)
set -e
mkdir -p clips out
(cd render && cargo build --release -q)
for f in data/*.mid; do
  b=$(basename $f .mid)
  [ -f clips/$b.wav ] || {
    python3 humanize.py $f clips/$b.mid clips/$b.gt.json
    ./render/target/release/render data/YDP*/YDP-GrandPiano-20160804.sf2 clips/$b.mid clips/$b.wav
  }
done
BIN=../../../src-tauri/target/release/examples/transcribe_wav
for f in clips/*.wav; do env "$@" $BIN $f > out/$(basename $f .wav).json 2>/dev/null & done; wait
python3 score.py out
