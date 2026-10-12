"""Scoring and conversion helpers for evaluate.py. No heavy imports at module level.

String numbering:
  GuitarSet/JAMS: 0 = low E ... 5 = high E (this harness uses it internally).
  Smart Beat (alphaTab): for a tuning array ordered highest string first,
  string = tuning.length - index, so the highest string is 6 and the low E is 1.
  On a 6-string guitar: jams_string = alphatab_string - 1.
"""

from __future__ import annotations

import math

OPEN_MIDI = [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4, index = JAMS string
ONSET_TOL = 0.05  # seconds
PITCH_TOL_CENTS = 50.0


def alphatab_to_jams_string(string: int, num_strings: int = 6) -> int:
    """alphaTab string (1 = lowest) to JAMS string (0 = lowest)."""
    if not 1 <= string <= num_strings:
        raise ValueError(f"alphaTab string {string} outside 1..{num_strings}")
    return string - 1


def jams_to_alphatab_string(string: int, num_strings: int = 6) -> int:
    if not 0 <= string < num_strings:
        raise ValueError(f"JAMS string {string} outside 0..{num_strings - 1}")
    return string + 1


def alphatab_string_from_tuning_index(index: int, num_strings: int = 6) -> int:
    """Tuning array ordered highest first: string = length - index."""
    return num_strings - index


def midi_to_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def load_ground_truth(jams_path) -> list[dict]:
    """JAMS note_midi annotations -> notes with string (0 = low E) and fret."""
    import jams

    j = jams.load(str(jams_path), validate=False)
    notes = []
    for ann in j.search(namespace="note_midi"):
        string = int(ann.annotation_metadata.data_source)
        for obs in ann.data:
            pitch = int(round(float(obs.value)))
            notes.append(
                {
                    "start": float(obs.time),
                    "end": float(obs.time + obs.duration),
                    "pitch": pitch,
                    "pitch_exact": float(obs.value),
                    "string": string,
                    "fret": pitch - OPEN_MIDI[string],
                }
            )
    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes


def _arrays(notes: list[dict]):
    import numpy as np

    if not notes:
        return np.zeros((0, 2)), np.zeros(0)
    iv = np.array([[n["start"], max(n["end"], n["start"] + 1e-3)] for n in notes], dtype=float)
    hz = np.array([midi_to_hz(n.get("pitch_exact", n["pitch"])) for n in notes], dtype=float)
    return iv, hz


def count_matches(ref: list[dict], est: list[dict], with_offset: bool) -> int:
    """Number of matched notes: pitch within 50 cents, onset within 50 ms (and offsets if asked)."""
    import mir_eval

    if not ref or not est:
        return 0
    ref_iv, ref_hz = _arrays(ref)
    est_iv, est_hz = _arrays(est)
    matches = mir_eval.transcription.match_notes(
        ref_iv,
        ref_hz,
        est_iv,
        est_hz,
        onset_tolerance=ONSET_TOL,
        pitch_tolerance=PITCH_TOL_CENTS,
        offset_ratio=0.2 if with_offset else None,
        offset_min_tolerance=0.05,
    )
    return len(matches)


def count_tab_matches(ref: list[dict], est: list[dict]) -> int:
    """Matched notes where pitch, onset, string AND fret all agree (offsets ignored)."""
    total = 0
    for s in range(6):
        total += count_matches(
            [n for n in ref if n["string"] == s],
            [n for n in est if n.get("string") == s and n.get("fret") is not None],
            with_offset=False,
        )
    return total


def prf(tp: int, n_est: int, n_ref: int) -> dict:
    p = tp / n_est if n_est else 0.0
    r = tp / n_ref if n_ref else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": p, "recall": r, "f1": f, "tp": tp, "n_est": n_est, "n_ref": n_ref}


def attach_tab_to_raw(raw: list[dict], tab: list[dict]) -> tuple[list[dict], int]:
    """Give step-1 notes (original seconds) the string/fret from step-2 notes.

    Step 2 regrids times to a detected tempo, so times cannot be compared with the
    ground truth. We match each step-2 note back to a step-1 note with the same
    pitch. Within one pitch, both lists are sorted by start time and each step-2
    note takes the nearest unused step-1 note (by start time). Step-2 notes with no
    unused step-1 partner are dropped. Step-1 notes with no partner get no tab
    position, so they count as misses for tab F1 and as extra notes only in note F1.

    Returns (notes with string 0 = low E and fret, number of step-2 notes dropped).
    """
    by_pitch: dict[int, list[int]] = {}
    for i, n in enumerate(raw):
        by_pitch.setdefault(int(n["pitch"]), []).append(i)
    used: set[int] = set()
    out = [dict(n, string=None, fret=None) for n in raw]
    dropped = 0
    for t in sorted(tab, key=lambda n: (n["start"], n["pitch"])):
        cands = [i for i in by_pitch.get(int(t["pitch"]), []) if i not in used]
        if not cands:
            dropped += 1
            continue
        # Prefer order: the first unused step-1 note of this pitch in time order is
        # the match unless a later one is clearly closer in time.
        best = min(cands, key=lambda i: abs(raw[i]["start"] - t["start"]))
        used.add(best)
        out[best]["string"] = alphatab_to_jams_string(int(t["string"]))
        out[best]["fret"] = int(t["fret"])
    return out, dropped


def tab_consistent(note: dict) -> bool:
    """Check pitch == open string pitch + fret for a JAMS-numbered note."""
    return note["pitch"] == OPEN_MIDI[note["string"]] + note["fret"]


def finite(x) -> bool:
    return isinstance(x, (int, float)) and math.isfinite(x)
