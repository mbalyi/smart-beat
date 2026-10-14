"""Makes drum patterns (a standard MIDI file and the ground truth JSON) with timing noise.

Python standard library only. Usage: gen.py OUT_DIR [CLIPS] [SECONDS]
Styles: rock, funk (16th hats), shuffle-ish (triplet hats), halftime; fills on toms every 4th bar
and a crash on the first bar of a phrase. Hits are humanised: timing noise ~8 ms, velocity 60-120.
"""
import json, os, random, struct, sys

out = sys.argv[1]
clips = int(sys.argv[2]) if len(sys.argv) > 2 else 12
seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 60
os.makedirs(out, exist_ok=True)
PPQ = 480


def vlq(n):
    b = [n & 0x7F]
    n >>= 7
    while n:
        b.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(b))


def write_midi(path, bpm, events):
    """events: (tick, note, velocity); channel 10 (index 9), 60-tick hits."""
    track = bytearray(b"\x00\xff\x51\x03" + struct.pack(">I", int(60_000_000 / bpm))[1:])
    items = []
    for tick, note, vel in events:
        items.append((tick, 1, 0x99, note, vel))
        items.append((tick + 60, 0, 0x89, note, 0))
    last = 0
    for tick, _, status, note, vel in sorted(items):
        track += vlq(tick - last) + bytes([status, note, vel])
        last = tick
    track += b"\x00\xff\x2f\x00"
    with open(path, "wb") as f:
        f.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, PPQ) + b"MTrk" + struct.pack(">I", len(track)) + bytes(track))


STYLES = ["rock", "funk", "shuffle", "halftime"]


def bar(style, rng):
    """One 4/4 bar as (sixteenth index 0-15, drum number, base velocity)."""
    hits = []
    if style == "rock":
        for i in range(0, 16, 2): hits.append((i, 46 if i == 14 and rng.random() < .5 else 42, 80 if i % 4 else 100))
        hits += [(0, 36, 110), (8, 36, 105), (4, 38, 110), (12, 38, 110)]
        if rng.random() < .4: hits.append((10, 36, 95))
    elif style == "funk":
        for i in range(16): hits.append((i, 42, 70 if i % 2 else 95))
        hits += [(0, 36, 110), (7, 36, 95), (10, 36, 100), (4, 38, 112), (12, 38, 112)]
    elif style == "shuffle":
        for i in (0, 3, 4, 7, 8, 11, 12, 15): hits.append((i, 42, 85))
        hits += [(0, 36, 108), (8, 36, 100), (4, 38, 110), (12, 38, 110)]
    else:
        for i in range(0, 16, 4): hits.append((i, 42 if i != 12 else 46, 90))
        hits += [(0, 36, 112), (10, 36, 100), (8, 38, 112)]
    return hits


def fill(rng):
    toms = [48, 47, 45, 41]
    hits = [(0, 36, 100), (4, 38, 105)]
    for k, i in enumerate(range(8, 16, 2)): hits.append((i, toms[k], 100 + rng.randint(-8, 8)))
    return hits


for c in range(clips):
    rng = random.Random(100 + c)
    bpm = rng.choice([72, 84, 96, 108, 120, 132, 144, 156])
    style = STYLES[c % len(STYLES)]
    sixteenth = PPQ // 4
    bars = int(seconds * bpm / 60 / 4)
    events, truth = [], []
    for b in range(bars):
        hits = fill(rng) if b % 4 == 3 else bar(style, rng)
        if b % 4 == 0:
            hits.append((0, 49, 112))
        for i, note, vel in hits:
            jitter = rng.gauss(0, 8) / 1000  # seconds
            tick = (b * 16 + i) * sixteenth
            t = tick * 60 / bpm / PPQ + jitter
            if t < 0.5: continue
            v = max(40, min(127, int(vel + rng.gauss(0, 8))))
            tick_j = max(0, int(round(t * PPQ * bpm / 60)))
            events.append((tick_j, note, v))
            truth.append({"start": tick_j * 60 / bpm / PPQ, "pitch": note, "velocity": v})
    name = f"{c:02d}-{style}-{bpm}"
    write_midi(f"{out}/{name}.mid", bpm, events)
    json.dump(truth, open(f"{out}/{name}.gt.json", "w"))
    print(name, len(truth), "hits")
