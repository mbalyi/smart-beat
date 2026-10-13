import sys, json, glob, os, numpy as np, mir_eval
d = sys.argv[1]; tot = np.zeros(6)
def arr(ns): 
    a = np.array([[n["start"], n["end"]] for n in ns]).reshape(-1,2); p = np.array([440*2**((n["pitch"]-69)/12) for n in ns]); return a,p
for g in sorted(glob.glob("clips/*.gt.json")):
    b = os.path.basename(g)[:-8]
    ref = json.load(open(g)); est = json.load(open(f"{d}/{b}.json"))["notes"]
    ri,rp = arr(ref); ei,ep = arr(est)
    p,r,f,_ = mir_eval.transcription.precision_recall_f1_overlap(ri,rp,ei,ep,offset_ratio=None)
    po,ro,fo,_ = mir_eval.transcription.precision_recall_f1_overlap(ri,rp,ei,ep)
    print(f"{b:28s} ref {len(ref):5d} est {len(est):5d}  onset P {p:.2f} R {r:.2f} F1 {f:.2f} | +offset F1 {fo:.2f}")
    tot += [f, fo, p, r, 1, 0]
n = tot[4]; print(f"MEAN onset F1 {tot[0]/n:.3f}  +offset F1 {tot[1]/n:.3f}  P {tot[2]/n:.3f}  R {tot[3]/n:.3f}")
