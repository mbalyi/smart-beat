"""Fake step 1: ignores the WAV and prints three notes (seconds)."""

import json
import sys

notes = [
    {"start": 1.00, "end": 1.50, "pitch": 40, "velocity": 0.9},  # low E open
    {"start": 2.00, "end": 2.50, "pitch": 64, "velocity": 0.8},  # high E open
    {"start": 3.00, "end": 3.50, "pitch": 59, "velocity": 0.7},  # B string open (or fret 4 on G)
]
json.dump({"notes": notes}, sys.stdout)
