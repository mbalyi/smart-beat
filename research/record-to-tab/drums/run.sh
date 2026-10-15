#!/bin/zsh
# Makes the patterns, renders them through the Sonivox drum kit, finds the hits and prints per-class F1.
# Run from this folder. Needs python3 and a Rust toolchain; nothing else.
# Usage: ./run.sh [VAR=value ...]   (drum options as in src-tauri/examples/transcribe_wav.rs)
set -e
SF2=${SF2:-$(ls ../../../public/soundfont/sonivox.sf2 ../../../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2 2>/dev/null | head -1)}
[ -f "$SF2" ] || { echo "Set SF2=/path/to/sonivox.sf2 (Apache-2.0, ships in alphaTab)"; exit 1; }
mkdir -p clips out
(cd render && cargo build --release -q)
[ -f clips/00-rock-72.gt.json ] || python3 gen.py clips 12 60 >/dev/null
for f in clips/*.mid; do
  b=${f%.mid}; [ -f $b.wav ] || ./render/target/release/render $SF2 $f $b.wav
done
BIN=../../../src-tauri/target/release/examples/transcribe_wav
for f in clips/*.wav; do env INSTRUMENT=drums "$@" $BIN $f > out/$(basename $f .wav).json 2>/dev/null & done; wait
python3 score.py out
