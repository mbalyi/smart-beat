#!/bin/sh
# run inside the same image as run.sh, with -v $WORK:/work ; installs into /work/pylib (no torch re-install)
set -e
pip install --no-cache-dir --target /work/pylib onnx onnxruntime
pip install --no-cache-dir --no-deps --target /work/pylib julius demucs openunmix
