"""Evaluate a transcription engine on GuitarSet player 00 (mono mic audio).

Engines:
  fretnet  FretNet via run_fretnet.py code (ONNX Runtime CPU, PyTorch on MPS for timing)
  ours     two external commands built elsewhere in this repo (see README)

Metrics: note F1 (pitch + onset, 50 ms, with and without offsets), tab F1 (note
match AND string+fret match), real-time factor on a 60 s clip, peak RAM, sizes.

Usage:
  uv run evaluate.py --engine fretnet
  uv run evaluate.py --engine ours
  uv run evaluate.py --engine fretnet --limit 5 --skip-perf
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import statistics
import subprocess
import sys
import time
from pathlib import Path

import evalcore as ec

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
AUDIO = HERE / "data" / "audio_mono-mic"
ANN = HERE / "data" / "annotation"
RESULTS = HERE / "results"
RTF_CLIP = HERE / "data" / "rtf_60s.wav"
RTF_SECONDS = 60.0

DEFAULT_STEP1 = "cargo run --release --manifest-path src-tauri/Cargo.toml --example transcribe_wav --"
DEFAULT_STEP2 = (
    "node --import ./scripts/record-to-tab/register.mjs "
    "scripts/record-to-tab/notes-to-tab.ts --tuning standard"
)


def ours_env() -> dict:
    env = dict(os.environ)
    env["PATH"] = f"{Path.home()}/.cargo/bin:" + env.get("PATH", "")
    return env


class FretNetEngine:
    name = "fretnet"

    def __init__(self, backend: str = "onnx"):
        from run_fretnet import FretNetRunner

        self.runner = FretNetRunner(backend)

    def predict(self, wav: Path) -> dict:
        notes, _ = self.runner.transcribe(str(wav))
        return {"raw": notes, "tab": notes, "dropped": 0}


class OursEngine:
    """Step 1: audio -> notes (seconds). Step 2: notes -> tab (regridded times).

    For scoring we keep step-1 times and pitches and copy string/fret from step 2,
    matching notes back by pitch and nearest start (evalcore.attach_tab_to_raw).
    """

    name = "ours"

    def __init__(self):
        self.step1 = shlex.split(os.environ.get("OURS_STEP1", DEFAULT_STEP1))
        self.step2 = shlex.split(os.environ.get("OURS_STEP2", DEFAULT_STEP2))

    def run_step1(self, wav: Path) -> str:
        p = subprocess.run(
            [*self.step1, str(wav)], cwd=REPO_ROOT, env=ours_env(), capture_output=True, text=True
        )
        if p.returncode != 0:
            raise RuntimeError(f"step 1 failed ({p.returncode}): {p.stderr[-500:]}")
        return p.stdout

    def run_step2(self, notes_json: str) -> str:
        p = subprocess.run(
            self.step2, cwd=REPO_ROOT, env=ours_env(), input=notes_json, capture_output=True, text=True
        )
        if p.returncode != 0:
            raise RuntimeError(f"step 2 failed ({p.returncode}): {p.stderr[-500:]}")
        return p.stdout

    def predict(self, wav: Path) -> dict:
        out1 = self.run_step1(wav)
        raw = json.loads(out1)["notes"]
        tab = json.loads(self.run_step2(out1))["notes"]
        with_tab, dropped = ec.attach_tab_to_raw(raw, tab)
        return {"raw": raw, "tab": with_tab, "dropped": dropped}


def clip_pairs(limit: int | None) -> list[tuple[Path, Path]]:
    pairs = []
    for wav in sorted(AUDIO.glob("00_*.wav")):
        jams_path = ANN / (wav.stem.removesuffix("_mic") + ".jams")
        if jams_path.exists():
            pairs.append((wav, jams_path))
    return pairs[:limit] if limit else pairs


def score_clip(ref: list[dict], pred: dict) -> dict:
    raw, tab = pred["raw"], pred["tab"]
    tab_est = [n for n in tab if n.get("string") is not None]
    return {
        "n_ref": len(ref),
        "n_est": len(raw),
        "n_tab_est": len(tab_est),
        "tp_note": ec.count_matches(ref, raw, with_offset=False),
        "tp_note_off": ec.count_matches(ref, raw, with_offset=True),
        "tp_tab": ec.count_tab_matches(ref, tab_est),
        "dropped_step2_notes": pred["dropped"],
    }


def aggregate(clips: list[dict]) -> dict:
    n_ref = sum(c["n_ref"] for c in clips)
    n_est = sum(c["n_est"] for c in clips)
    n_tab = sum(c["n_tab_est"] for c in clips)
    micro = {
        "note_f1": ec.prf(sum(c["tp_note"] for c in clips), n_est, n_ref),
        "note_f1_with_offset": ec.prf(sum(c["tp_note_off"] for c in clips), n_est, n_ref),
        "tab_f1": ec.prf(sum(c["tp_tab"] for c in clips), n_tab, n_ref),
    }
    # Mean of per-clip F1, as a second view.
    macro = {
        "note_f1": statistics.fmean(ec.prf(c["tp_note"], c["n_est"], c["n_ref"])["f1"] for c in clips),
        "note_f1_with_offset": statistics.fmean(
            ec.prf(c["tp_note_off"], c["n_est"], c["n_ref"])["f1"] for c in clips
        ),
        "tab_f1": statistics.fmean(ec.prf(c["tp_tab"], c["n_tab_est"], c["n_ref"])["f1"] for c in clips),
    }
    return {"clips": len(clips), "micro": micro, "mean_per_clip": macro}


# ---------------------------------------------------------------- performance


def make_rtf_clip() -> float:
    """Concatenate player 00 clips to 60 s (mono, native rate). Returns duration."""
    import numpy as np
    import soundfile as sf

    if RTF_CLIP.exists():
        info = sf.info(str(RTF_CLIP))
        return info.frames / info.samplerate
    parts, sr, total = [], None, 0.0
    for wav in sorted(AUDIO.glob("00_*comp*.wav")):
        data, rate = sf.read(str(wav), dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        sr = sr or rate
        parts.append(data)
        total += len(data) / sr
        if total >= RTF_SECONDS:
            break
    audio = np.concatenate(parts)[: int(RTF_SECONDS * sr)]
    sf.write(str(RTF_CLIP), audio, sr)
    return len(audio) / sr


def timed(cmd: list[str], cwd: Path, stdin: str | None = None, env=None) -> tuple[float, int, str]:
    """Run a command under /usr/bin/time -l. Returns (seconds, peak RSS bytes, stdout)."""
    t0 = time.perf_counter()
    p = subprocess.run(
        ["/usr/bin/time", "-l", *cmd], cwd=cwd, input=stdin, capture_output=True, text=True, env=env
    )
    dt = time.perf_counter() - t0
    if p.returncode != 0:
        raise RuntimeError(f"command failed: {cmd}\n{p.stderr[-500:]}")
    m = re.search(r"(\d+)\s+maximum resident set size", p.stderr)
    return dt, int(m.group(1)) if m else 0, p.stdout


def perf_fretnet(duration: float) -> dict:
    from run_fretnet import FretNetRunner

    out: dict = {"clip_seconds": duration}
    for backend in ("onnx", "mps"):
        try:
            runner = FretNetRunner(backend)
            runner.transcribe(str(RTF_CLIP))  # warm-up
            runs = [runner.transcribe(str(RTF_CLIP))[1] for _ in range(3)]
            med = {k: statistics.median(r[k] for r in runs) for k in runs[0]}
            _, rss, _ = timed(
                [sys.executable, str(HERE / "run_fretnet.py"), str(RTF_CLIP), "--backend", backend], HERE
            )
            out[backend] = {
                "rtf": med["total"] / duration,
                "rtf_network_only": med["network"] / duration,
                "seconds": med,
                "peak_ram_mb_cli": rss / 1e6,
            }
        except Exception as err:  # MPS may be missing
            out[backend] = {"error": str(err)}
    return out


def perf_ours(engine: OursEngine, duration: float) -> dict:
    env = ours_env()
    cmd1 = [*engine.step1, str(RTF_CLIP)]
    timed(cmd1, REPO_ROOT, env=env)  # warm-up, also builds
    t1, rss1, out1 = timed(cmd1, REPO_ROOT, env=env)
    t2, rss2, _ = timed(engine.step2, REPO_ROOT, stdin=out1, env=env)
    return {
        "clip_seconds": duration,
        "cpu": {
            "rtf": (t1 + t2) / duration,
            "rtf_step1_only": t1 / duration,
            "seconds": {"step1": t1, "step2": t2},
            "peak_ram_mb_step1": rss1 / 1e6,
            "peak_ram_mb_step2": rss2 / 1e6,
        },
    }


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def sizes_fretnet() -> dict:
    import onnxruntime

    import fretnet_common as fc

    ort_dir = Path(onnxruntime.__file__).parent
    return {
        "onnx_model_bytes": fc.ONNX_PATH.stat().st_size,
        "onnxruntime_python_package_bytes": dir_size(ort_dir),
        "note": "Python onnxruntime wheel. A Rust ort build would be smaller. HCQT would need a Rust port.",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", choices=["fretnet", "ours"], required=True)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--skip-perf", action="store_true")
    args = ap.parse_args()

    RESULTS.mkdir(exist_ok=True)
    engine = FretNetEngine("onnx") if args.engine == "fretnet" else OursEngine()

    clips = []
    for wav, jams_path in clip_pairs(args.limit):
        ref = ec.load_ground_truth(jams_path)
        t0 = time.perf_counter()
        pred = engine.predict(wav)
        row = {"clip": wav.stem, "seconds": time.perf_counter() - t0, **score_clip(ref, pred)}
        clips.append(row)
        print(
            f"{wav.stem}: ref {row['n_ref']} est {row['n_est']} tp note {row['tp_note']} "
            f"tab {row['tp_tab']}",
            flush=True,
        )
    (RESULTS / f"{args.engine}_clips.json").write_text(json.dumps(clips, indent=1))

    summary = {"engine": args.engine, "player": "00", "accuracy": aggregate(clips)}
    if args.engine == "ours":
        summary["accuracy"]["tab_note"] = (
            "Times and pitches from step 1; string/fret from step 2 matched back by pitch and nearest start."
        )
    if not args.skip_perf:
        duration = make_rtf_clip()
        if args.engine == "fretnet":
            summary["performance"] = perf_fretnet(duration)
            summary["sizes"] = sizes_fretnet()
        else:
            summary["performance"] = perf_ours(engine, duration)
            summary["sizes"] = {"note": "Measure the built app binary and ONNX file separately."}

    path = RESULTS / "summary.json"
    all_summary = json.loads(path.read_text()) if path.exists() else {}
    all_summary[args.engine] = summary
    path.write_text(json.dumps(all_summary, indent=1))
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
