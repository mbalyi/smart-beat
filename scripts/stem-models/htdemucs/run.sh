#!/bin/sh
# usage: WORK=<dir with 955717e8-8726e21a.th> IMAGE=<image with torch, einops, numpy> ./run.sh parity|export
# Runs the HTDemucs core export in a throwaway container (see setup_pylib.sh for the pip step).
set -e
: "${WORK:?set WORK to the folder holding the HTDemucs .th checkpoint}"
: "${IMAGE:?set IMAGE to a docker image with torch, einops and numpy}"
HERE=$(cd "$(dirname "$0")" && pwd)
docker run --rm -v "$WORK":/work -v "$HERE":/src:ro "$IMAGE" python -I /src/export_htdemucs.py "$@"
