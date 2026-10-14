"""Run FretNet on a WAV file and print notes as JSON.

Output: {"notes": [{"start", "end", "pitch", "string", "fret"}]}
Times are seconds. `string` follows GuitarSet/JAMS: 0 is the low E string.
`pitch` is a MIDI number. `fret` is pitch minus the open string pitch.

Backends:
  onnx  ONNX Runtime on CPU (default)
  mps   PyTorch on Apple GPU (MPS), weights from models/fretnet_state.pt

HCQT features and note post-processing are the upstream Python code. Run
export_fretnet.py first.

Usage: uv run run_fretnet.py <wav> [--backend onnx|mps]
"""

from __future__ import annotations

import argparse
import json
import sys
import time

import fretnet_common as fc


class FretNetRunner:
    def __init__(self, backend: str = "onnx"):
        self.backend = backend
        self.cfg = fc.load_config()
        self.cfg["tuning"] = [str(t) for t in self.cfg["tuning"]]
        self.hcqt = fc.make_hcqt()
        self.post_model = fc.make_post_model(self.cfg)
        self.estimator = fc.make_estimator(self.post_model.profile)
        if backend == "onnx":
            session = fc.make_session()
            self._run = lambda w: fc.run_onnx(session, w)
        elif backend == "mps":
            self._run = fc.make_torch_runner(self.cfg, "mps")
        else:
            raise ValueError(f"unknown backend {backend}")

    def transcribe(self, wav_path: str) -> tuple[list[dict], dict]:
        """Return (notes, timings). Timings are seconds for features, network, post."""
        import amt_tools.tools as tools

        t0 = time.perf_counter()
        data = fc.compute_features(wav_path, self.hcqt)
        windows = fc.window_features(data[tools.KEY_FEATS])
        t1 = time.perf_counter()
        raw = self._run(windows)
        t2 = time.perf_counter()
        notes = fc.postprocess(raw, data[tools.KEY_TIMES], self.post_model, self.estimator)
        t3 = time.perf_counter()
        return notes, {"features": t1 - t0, "network": t2 - t1, "post": t3 - t2, "total": t3 - t0}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--backend", choices=["onnx", "mps"], default="onnx")
    args = ap.parse_args()
    notes, timings = FretNetRunner(args.backend).transcribe(args.wav)
    json.dump({"notes": notes}, sys.stdout)
    sys.stdout.write("\n")
    print(json.dumps({"timings_s": timings}), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
