"""Per-class onset F1 (hit within 50 ms, same drum class) of detected hits against the truth.

Python standard library only. Usage: score.py OUT_DIR [CLIPS_DIR]
Drum numbers are grouped as the detector sees them: toms 41/43 -> 41, 45/47 -> 47, 48/50 -> 48,
crash 49/57 -> 49. The detector does not claim rides, so none are generated.
"""
import glob, json, os, sys

TOL = 0.05
GROUP = {43: 41, 45: 47, 50: 48, 57: 49, 35: 36, 40: 38}
NAMES = {36: "kick", 38: "snare", 42: "hat closed", 46: "hat open", 41: "tom low", 47: "tom mid", 48: "tom high", 49: "crash"}
out = sys.argv[1]
clips = sys.argv[2] if len(sys.argv) > 2 else "clips"
tp, fp, fn = {}, {}, {}


def match(ref, est):
    ref, est = sorted(ref), sorted(est)
    used, hit = set(), 0
    for r in ref:
        best, bd = None, TOL
        for j, e in enumerate(est):
            if j in used: continue
            d = abs(e - r)
            if d <= bd: best, bd = j, d
        if best is not None:
            used.add(best); hit += 1
    return hit, len(est) - hit, len(ref) - hit


for g in sorted(glob.glob(f"{clips}/*.gt.json")):
    b = os.path.basename(g)[:-8]
    ref = json.load(open(g)); est = json.load(open(f"{out}/{b}.json"))["notes"]
    for cls in NAMES:
        r = [n["start"] for n in ref if GROUP.get(n["pitch"], n["pitch"]) == cls]
        e = [n["start"] for n in est if n["pitch"] == cls]
        h, f, m = match(r, e)
        tp[cls] = tp.get(cls, 0) + h; fp[cls] = fp.get(cls, 0) + f; fn[cls] = fn.get(cls, 0) + m
print(f"{'class':12s} {'ref':>6s} {'found':>6s}  {'P':>5s} {'R':>5s} {'F1':>5s}")
allt = allf = allm = 0
for cls, name in NAMES.items():
    t, f, m = tp.get(cls, 0), fp.get(cls, 0), fn.get(cls, 0)
    if t + m == 0 and f == 0: continue
    p = t / (t + f) if t + f else 0; r = t / (t + m) if t + m else 0
    f1 = 2 * p * r / (p + r) if p + r else 0
    print(f"{name:12s} {t + m:6d} {t + f:6d}  {p:5.2f} {r:5.2f} {f1:5.2f}")
    allt += t; allf += f; allm += m
p = allt / (allt + allf) if allt + allf else 0; r = allt / (allt + allm) if allt + allm else 0
print(f"{'ALL':12s} {allt + allm:6d} {allt + allf:6d}  {p:5.2f} {r:5.2f} {2 * p * r / (p + r) if p + r else 0:5.2f}")
core = [36, 38, 42, 46]
t = sum(tp.get(c, 0) for c in core); f = sum(fp.get(c, 0) for c in core); m = sum(fn.get(c, 0) for c in core)
p = t / (t + f) if t + f else 0; r = t / (t + m) if t + m else 0
print(f"{'KICK/SNARE/HAT':12s} {t + m:6d} {t + f:6d}  {p:5.2f} {r:5.2f} {2 * p * r / (p + r) if p + r else 0:5.2f}")
