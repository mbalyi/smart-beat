"""Render results/summary.json as a Markdown table.

Usage: uv run render_table.py [results/summary.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def num(x, fmt="{:.3f}") -> str:
    return "n/a" if x is None else fmt.format(x)


def get(d, *keys):
    for k in keys:
        if not isinstance(d, dict) or k not in d:
            return None
        d = d[k]
    return d


def rows(name: str, s: dict) -> list[list[str]]:
    micro = get(s, "accuracy", "micro") or {}
    perf = s.get("performance", {})
    out = []
    if name == "fretnet":
        variants = [("fretnet (ONNX, CPU)", "onnx"), ("fretnet (PyTorch, MPS)", "mps")]
    else:
        variants = [(name + " (CPU)", "cpu")]
    for i, (label, key) in enumerate(variants):
        p = perf.get(key, {})
        out.append(
            [
                label,
                pct(get(micro, "note_f1", "f1")) if i == 0 else "",
                pct(get(micro, "note_f1_with_offset", "f1")) if i == 0 else "",
                pct(get(micro, "tab_f1", "f1")) if i == 0 else "",
                num(p.get("rtf")),
                num(p.get("peak_ram_mb_cli", p.get("peak_ram_mb_step1")), "{:.0f}"),
            ]
        )
    return out


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "results" / "summary.json"
    data = json.loads(path.read_text())
    head = ["Engine", "Note F1", "Note F1 +offset", "Tab F1", "RTF (60 s)", "Peak RAM MB"]
    lines = ["| " + " | ".join(head) + " |", "|" + "|".join(["---"] * len(head)) + "|"]
    for name, s in data.items():
        for r in rows(name, s):
            lines.append("| " + " | ".join(r) + " |")
    print("\n".join(lines))
    print("\nRTF is processing time divided by audio time. Lower is faster. Micro-averaged over player 00 clips.")
    for name, s in data.items():
        sizes = s.get("sizes", {})
        if "onnx_model_bytes" in sizes:
            print(
                f"\n{name}: model {sizes['onnx_model_bytes'] / 1e6:.1f} MB, "
                f"onnxruntime Python package {sizes['onnxruntime_python_package_bytes'] / 1e6:.0f} MB"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
