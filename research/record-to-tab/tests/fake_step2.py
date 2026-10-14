"""Fake step 2: regrids times (shifts by +0.2 s, as a tempo grid would) and assigns
alphaTab strings (1 = low E, 6 = high E), in a different order than the input."""

import json
import sys

notes = json.load(sys.stdin)["notes"]
out = []
for n in reversed(notes):
    string, fret = {40: (1, 0), 64: (6, 0), 59: (5, 0)}[n["pitch"]]
    out.append(
        {"start": n["start"] + 0.2, "end": n["end"] + 0.2, "pitch": n["pitch"], "string": string, "fret": fret}
    )
json.dump({"bpm": 120, "notes": out, "warnings": []}, sys.stdout)
