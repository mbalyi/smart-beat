#!/bin/sh
# usage: WORK=<dir with the .th checkpoint> IMAGE=<image with torch, einops, numpy> ./run.sh parity|export [htdemucs|htdemucs_6s]
# htdemucs (default) needs 955717e8-8726e21a.th and writes htdemucs_core.onnx; htdemucs_6s needs
# 5c90dfd2-34c22ccb.th and writes htdemucs_6s_core.onnx (both from dl.fbaipublicfiles.com/demucs/hybrid_transformer/).
# Runs the HTDemucs core export in a throwaway container (see setup_pylib.sh for the pip step).
set -e
: "${WORK:?set WORK to the folder holding the HTDemucs .th checkpoint}"
: "${IMAGE:?set IMAGE to a docker image with torch, einops and numpy}"
HERE=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$WORK":/work -v "$HERE":/src:ro "$IMAGE" python -I /src/export_htdemucs.py "$@"
