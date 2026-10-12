"""Shared FretNet inference code: HCQT features, ONNX session, upstream post-processing.

The network runs in ONNX Runtime (or PyTorch on MPS for the GPU timing). Features
and post-processing use the upstream amt-tools and guitar-transcription-continuous
code, as in upstream examples/inference.py. The pickled model is never loaded here.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
ONNX_PATH = MODELS / "fretnet.onnx"
CONFIG_PATH = MODELS / "fretnet_config.json"
STATE_PATH = MODELS / "fretnet_state.pt"

SAMPLE_RATE = 22050
HOP_LENGTH = 512
FRAME_WIDTH = 9  # frames of context per network input window
CHUNK = 256  # frames per network call, to bound RAM


def make_hcqt():
    import librosa
    from amt_tools.features import HCQT

    return HCQT(
        sample_rate=SAMPLE_RATE,
        hop_length=HOP_LENGTH,
        fmin=librosa.note_to_hz("E2"),
        harmonics=[0.5, 1, 2, 3, 4, 5],
        n_bins=144,
        bins_per_octave=36,
    )


def compute_features(wav_path: str | Path, hcqt=None) -> dict:
    """Load, normalise and resample audio, then compute HCQT features (C x F x T)."""
    import amt_tools.tools as tools

    hcqt = hcqt or make_hcqt()
    audio, _ = tools.load_normalize_audio(str(wav_path), SAMPLE_RATE)
    return {
        tools.KEY_FEATS: hcqt.process_audio(audio),
        tools.KEY_TIMES: hcqt.get_times(audio),
    }


def window_features(feats: np.ndarray) -> np.ndarray:
    """Replicate TabCNN.pre_proc: (C x F x T) -> (1 x T x C x F x W) float32, zero padded."""
    import amt_tools.tools as tools

    batched = feats.astype(np.float32)[None]  # B x C x F x T
    framed = tools.framify_activations(batched, FRAME_WIDTH, pad=True)  # B x C x F x T x W
    framed = np.swapaxes(framed, -2, -3)  # B x C x T x F x W
    framed = np.swapaxes(framed, -3, -4)  # B x T x C x F x W
    return np.ascontiguousarray(framed, dtype=np.float32)


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def make_session(onnx_path: Path = ONNX_PATH):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    return ort.InferenceSession(str(onnx_path), opts, providers=["CPUExecutionProvider"])


def run_onnx(session, windows: np.ndarray) -> dict[str, np.ndarray]:
    """Run the network on windowed features in chunks. Returns raw logits, each 1 x T x O."""
    names = [o.name for o in session.get_outputs()]
    parts: dict[str, list[np.ndarray]] = {n: [] for n in names}
    for start in range(0, windows.shape[1], CHUNK):
        out = session.run(names, {"feats": windows[:, start : start + CHUNK]})
        for n, o in zip(names, out):
            parts[n].append(o)
    return {n: np.concatenate(v, axis=1) for n, v in parts.items()}


def make_torch_runner(cfg: dict, device: str):
    """Run the network in PyTorch (for the MPS timing). Weights come from the state dict."""
    import torch
    import amt_tools.tools as tools
    import guitar_transcription_continuous.utils as utils

    net = make_post_model(cfg)
    net.load_state_dict(torch.load(STATE_PATH, map_location="cpu", weights_only=True))
    net.to(device).eval()

    def run(windows: np.ndarray) -> dict[str, np.ndarray]:
        parts: dict[str, list[np.ndarray]] = {"tablature": [], "relative": [], "onsets": []}
        with torch.no_grad():
            for start in range(0, windows.shape[1], CHUNK):
                x = torch.from_numpy(windows[:, start : start + CHUNK]).to(device)
                out = net(x)
                parts["tablature"].append(out[tools.KEY_TABLATURE].float().cpu().numpy())
                parts["relative"].append(out[utils.KEY_TABLATURE_REL].float().cpu().numpy())
                parts["onsets"].append(out[tools.KEY_ONSETS].float().cpu().numpy())
        return {k: np.concatenate(v, axis=1) for k, v in parts.items()}

    return run


def make_post_model(cfg: dict):
    """A FretNet shell with random weights, used only for upstream post_proc.

    post_proc touches only the profile and stateless output layers, so no trained
    weights and no pickle are needed.
    """
    from amt_tools.tools.instrument import GuitarProfile
    from guitar_transcription_continuous.models import FretNet

    profile = GuitarProfile(tuning=cfg["tuning"], num_frets=cfg["num_frets"])
    return FretNet(
        dim_in=cfg["dim_in"],
        profile=profile,
        in_channels=cfg["in_channels"],
        model_complexity=cfg["model_complexity"],
        semitone_radius=cfg["semitone_radius"],
        gamma=cfg["gamma"],
        cont_layer=cfg["cont_layer"],
        silence_activations=cfg["silence_activations"],
        estimate_onsets=cfg["estimate_onsets"],
        device="cpu",
    ).eval()


def make_estimator(profile):
    import amt_tools.tools as tools
    from amt_tools.transcribe import (
        ComboEstimator,
        StackedNoteTranscriber,
        StackedOffsetsWrapper,
        TablatureWrapper,
    )
    import guitar_transcription_continuous.utils as utils
    from guitar_transcription_continuous.estimators import StackedPitchListTablatureWrapper

    return ComboEstimator(
        [
            TablatureWrapper(profile=profile),
            StackedOffsetsWrapper(profile=profile),
            StackedNoteTranscriber(profile=profile),
            StackedPitchListTablatureWrapper(
                profile=profile,
                multi_pitch_key=tools.KEY_TABLATURE,
                multi_pitch_rel_key=utils.KEY_TABLATURE_REL,
            ),
        ]
    )


def postprocess(raw: dict[str, np.ndarray], times: np.ndarray, post_model, estimator) -> list[dict]:
    """Raw logits -> notes, using upstream post_proc and the upstream estimators.

    Returns a list of {"start", "end", "pitch", "string", "fret"}. `string` follows
    GuitarSet/JAMS: 0 is the low E string.
    """
    import torch
    import amt_tools.tools as tools
    import guitar_transcription_continuous.utils as utils

    key_map = {
        "tablature": tools.KEY_TABLATURE,
        "relative": utils.KEY_TABLATURE_REL,
        "onsets": tools.KEY_ONSETS,
    }
    output = {key_map[k]: torch.from_numpy(v) for k, v in raw.items()}
    batch = {tools.KEY_OUTPUT: output}
    with torch.no_grad():
        post = post_model.post_proc(batch)
    post = tools.dict_squeeze(tools.dict_to_array(post), dim=0)
    post[tools.KEY_TIMES] = times
    predictions = estimator.process_track(post, None)
    stacked_notes = predictions[tools.KEY_NOTES]

    tuning_midi = [int(m) for m in post_model.profile.get_midi_tuning()]
    notes = []
    for string_idx, slc in enumerate(sorted(stacked_notes.keys())):
        pitches, intervals = stacked_notes[slc]
        for p, (s, e) in zip(pitches, intervals):
            pitch = int(round(float(p)))
            notes.append(
                {
                    "start": float(s),
                    "end": float(e),
                    "pitch": pitch,
                    "string": string_idx,
                    "fret": pitch - tuning_midi[string_idx],
                }
            )
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes
