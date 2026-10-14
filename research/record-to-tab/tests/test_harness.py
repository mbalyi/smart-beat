"""Tests for string conversion, step matching, scoring and the `ours` engine.

Run: uv run python tests/test_harness.py
"""

import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import evalcore as ec  # noqa: E402


class StringNumbering(unittest.TestCase):
    def test_alphatab_to_jams(self):
        # alphaTab: 1 = low E ... 6 = high E. JAMS: 0 = low E ... 5 = high E.
        self.assertEqual([ec.alphatab_to_jams_string(s) for s in range(1, 7)], [0, 1, 2, 3, 4, 5])

    def test_tuning_index_highest_first(self):
        # tuning = [E4, B3, G3, D3, A2, E2]; string = length - index
        tuning = [64, 59, 55, 50, 45, 40]
        alpha = [ec.alphatab_string_from_tuning_index(i) for i in range(6)]
        self.assertEqual(alpha, [6, 5, 4, 3, 2, 1])
        jams = [ec.alphatab_to_jams_string(a) for a in alpha]
        self.assertEqual([ec.OPEN_MIDI[j] for j in jams], tuning)

    def test_round_trip_and_bounds(self):
        for s in range(6):
            self.assertEqual(ec.alphatab_to_jams_string(ec.jams_to_alphatab_string(s)), s)
        with self.assertRaises(ValueError):
            ec.alphatab_to_jams_string(0)
        with self.assertRaises(ValueError):
            ec.alphatab_to_jams_string(7)


class Matching(unittest.TestCase):
    def test_attach_by_pitch_and_order(self):
        raw = [
            {"start": 1.0, "end": 1.4, "pitch": 40},
            {"start": 1.1, "end": 1.4, "pitch": 64},
            {"start": 2.0, "end": 2.4, "pitch": 40},
        ]
        tab = [  # regridded, reordered, one extra note
            {"start": 2.2, "end": 2.5, "pitch": 40, "string": 1, "fret": 0},
            {"start": 1.2, "end": 1.5, "pitch": 40, "string": 2, "fret": -5},
            {"start": 1.3, "end": 1.5, "pitch": 64, "string": 6, "fret": 0},
            {"start": 5.0, "end": 5.5, "pitch": 70, "string": 6, "fret": 6},
        ]
        out, dropped = ec.attach_tab_to_raw(raw, tab)
        self.assertEqual(dropped, 1)
        self.assertEqual([n["string"] for n in out], [1, 5, 0])  # 1.0 -> tab 1.2, 2.0 -> tab 2.2
        self.assertEqual(out[0]["start"], 1.0)  # keeps step-1 time

    def test_self_score_is_perfect(self):
        ref = [
            {"start": 1.0, "end": 1.5, "pitch": 40, "string": 0, "fret": 0},
            {"start": 2.0, "end": 2.5, "pitch": 64, "string": 5, "fret": 0},
        ]
        self.assertEqual(ec.count_matches(ref, ref, True), 2)
        self.assertEqual(ec.count_tab_matches(ref, ref), 2)

    def test_wrong_string_fails_tab_only(self):
        ref = [{"start": 1.0, "end": 1.5, "pitch": 59, "string": 4, "fret": 0}]
        est = [{"start": 1.01, "end": 1.5, "pitch": 59, "string": 3, "fret": 4}]
        self.assertEqual(ec.count_matches(ref, est, False), 1)
        self.assertEqual(ec.count_tab_matches(ref, est), 0)

    def test_onset_tolerance(self):
        ref = [{"start": 1.0, "end": 1.5, "pitch": 40, "string": 0, "fret": 0}]
        near = [dict(ref[0], start=1.04)]
        far = [dict(ref[0], start=1.08)]
        self.assertEqual(ec.count_matches(ref, near, False), 1)
        self.assertEqual(ec.count_matches(ref, far, False), 0)


class OursEngineWithFakes(unittest.TestCase):
    def test_predict(self):
        os.environ["OURS_STEP1"] = f"{sys.executable} {HERE / 'fake_step1.py'}"
        os.environ["OURS_STEP2"] = f"{sys.executable} {HERE / 'fake_step2.py'}"
        from evaluate import OursEngine

        pred = OursEngine().predict(Path("ignored.wav"))
        self.assertEqual(len(pred["raw"]), 3)
        self.assertEqual(pred["dropped"], 0)
        by_pitch = {n["pitch"]: n for n in pred["tab"]}
        self.assertEqual(by_pitch[40]["string"], 0)  # alphaTab 1 -> JAMS 0 (low E)
        self.assertEqual(by_pitch[64]["string"], 5)  # alphaTab 6 -> JAMS 5 (high E)
        self.assertEqual(by_pitch[59]["string"], 4)  # alphaTab 5 -> JAMS 4 (B)
        self.assertEqual(by_pitch[40]["start"], 1.0)  # original step-1 time, not regridded
        ref = [
            {"start": 1.0, "end": 1.5, "pitch": 40, "string": 0, "fret": 0},
            {"start": 2.0, "end": 2.5, "pitch": 64, "string": 5, "fret": 0},
            {"start": 3.0, "end": 3.5, "pitch": 59, "string": 4, "fret": 0},
        ]
        from evaluate import score_clip

        s = score_clip(ref, pred)
        self.assertEqual((s["tp_note"], s["tp_tab"]), (3, 3))
        for n in pred["tab"]:
            self.assertTrue(ec.tab_consistent(n))


if __name__ == "__main__":
    unittest.main()
