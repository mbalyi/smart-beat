"""Export the FretNet fold-0 network to ONNX and check it against PyTorch.

SECURITY: models/model-2000.pt is a full pickled PyTorch model. Loading it runs code
from the pickle. Run this script once, inside this project's own virtual environment
(uv run export_fretnet.py). Afterwards use only models/fretnet.onnx. The weights have
no stated licence, so neither the .pt nor the .onnx may be committed.

The graph holds the network up to the raw logits (tablature, relative pitch, onsets).
Windowing of the features and upstream post-processing stay in Python
(fretnet_common.py), so the output notes match upstream.

Usage: uv run export_fretnet.py [--clip data/audio_mono-mic/<file>.wav] [--opset 17]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import fretnet_common as fc

HERE = Path(__file__).resolve().parent
PT_PATH = fc.MODELS / "model-2000.pt"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", default=None)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    import torch
    import amt_tools.tools as tools
    from amt_tools.inference import run_offline

    clip = args.clip or sorted((HERE / "data" / "audio_mono-mic").glob("00_*.wav"))[0]
    print(f"torch {torch.__version__}, clip {clip}")

    model = torch.load(PT_PATH, map_location="cpu", weights_only=False)
    model.change_device("cpu") if hasattr(model, "change_device") else None
    model.eval()
    profile = model.profile
    cfg = {
        "dim_in": int(model.dim_in),
        "in_channels": int(model.in_channels),
        "frame_width": int(model.frame_width),
        "model_complexity": int(getattr(model, "model_complexity", 1)),
        "cont_layer": model.cont_layer,
        "estimate_onsets": bool(model.estimate_onsets),
        "tuning": list(profile.tuning) if hasattr(profile, "tuning") else None,
        "num_frets": int(profile.get_num_frets()),
        "num_strings": int(profile.get_num_dofs()),
        "online": bool(model.online),
        "semitone_radius": float(model.semitone_radius),
        "gamma": float(model.gamma),
        "silence_activations": bool(model.tablature_layer.silence_activations),
    }
    print("model config:", json.dumps(cfg, default=str))
    assert cfg["frame_width"] == fc.FRAME_WIDTH, "frame width differs from fretnet_common"

    class Net(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, feats):
            out = self.m(feats)
            return (
                out[tools.KEY_TABLATURE],
                out[fc_rel_key],
                out[tools.KEY_ONSETS],
            )

    import guitar_transcription_continuous.utils as utils

    fc_rel_key = utils.KEY_TABLATURE_REL
    net = Net(model).eval()

    # Real features for the example input and the numeric check.
    data = fc.compute_features(clip)
    feats = data[tools.KEY_FEATS]
    windows = fc.window_features(feats)
    print("features", feats.shape, "windows", windows.shape)

    fc.MODELS.mkdir(exist_ok=True)
    example = torch.from_numpy(windows[:, :32])
    torch.onnx.export(
        net,
        (example,),
        str(fc.ONNX_PATH),
        input_names=["feats"],
        output_names=["tablature", "relative", "onsets"],
        dynamic_axes={
            "feats": {1: "frames"},
            "tablature": {1: "frames"},
            "relative": {1: "frames"},
            "onsets": {1: "frames"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )
    # Plain tensors only, so the GPU timing path can load them with weights_only=True
    # and never touch the pickle again.
    torch.save(model.state_dict(), fc.STATE_PATH)
    import onnx

    onnx.checker.check_model(str(fc.ONNX_PATH))
    size = fc.ONNX_PATH.stat().st_size
    print(f"exported {fc.ONNX_PATH.name}: {size} bytes (opset {args.opset})")

    # Numeric check on the whole clip: raw logits.
    with torch.no_grad():
        ref = [t.numpy() for t in net(torch.from_numpy(windows))]
    sess = fc.make_session()
    got = fc.run_onnx(sess, windows)
    diffs = {}
    for name, r in zip(["tablature", "relative", "onsets"], ref):
        diffs[name] = float(np.max(np.abs(r - got[name])))
    print("max abs diff of logits (ONNX Runtime vs PyTorch):", diffs)

    # End to end check: notes from the pickled model through upstream run_offline
    # versus notes from ONNX + the shell post-processing.
    est = fc.make_estimator(profile)
    up = run_offline(
        {tools.KEY_FEATS: feats, tools.KEY_TIMES: data[tools.KEY_TIMES]}, model, est
    )
    up_notes = up[tools.KEY_NOTES]
    cfg["tuning"] = [str(t) for t in cfg["tuning"]]
    shell = fc.make_post_model(cfg)
    notes = fc.postprocess(got, data[tools.KEY_TIMES], shell, fc.make_estimator(shell.profile))
    n_up = sum(len(v[0]) for v in up_notes.values())
    print(f"notes: upstream pickled model {n_up}, ONNX path {len(notes)}")
    up_set = set()
    for i, k in enumerate(sorted(up_notes.keys())):
        for p, (s, e) in zip(*up_notes[k]):
            up_set.add((i, round(float(p)), round(float(s), 4), round(float(e), 4)))
    our_set = {(n["string"], n["pitch"], round(n["start"], 4), round(n["end"], 4)) for n in notes}
    print("identical note sets:", up_set == our_set, f"(only upstream {len(up_set - our_set)}, only ONNX {len(our_set - up_set)})")

    if up_set != our_set:
        print("sample only upstream:", sorted(up_set - our_set)[:4])
        print("sample only ONNX:", sorted(our_set - up_set)[:4])

    cfg["onnx_bytes"] = size
    cfg["opset"] = args.opset
    cfg["max_abs_diff"] = diffs
    cfg["identical_notes"] = up_set == our_set
    fc.CONFIG_PATH.write_text(json.dumps(cfg, indent=2, default=str))
    print(f"wrote {fc.CONFIG_PATH.name}")
    return 0 if up_set == our_set and max(diffs.values()) < 1e-3 else 1


if __name__ == "__main__":
    sys.exit(main())
