import sys, json, random, math, pretty_midi
src, dst, gt = sys.argv[1:4]
random.seed(7)
pm = pretty_midi.PrettyMIDI(src)
notes = [n for i in pm.instruments if not i.is_drum for n in i.notes]
tmax = max(n.end for n in notes)
def warp(t): return t + 0.12*math.sin(t/7.0) + 0.05*math.sin(t/2.3)   # slow rubato
out = pretty_midi.PrettyMIDI(); inst = pretty_midi.Instrument(0)
for n in sorted(notes, key=lambda n:n.start):
    s = warp(n.start) + random.gauss(0, 0.012)
    e = max(s+0.06, warp(n.end) + random.gauss(0, 0.02))
    inst.notes.append(pretty_midi.Note(int(max(30,min(110, 72 + random.gauss(0,12)))), n.pitch, max(0,s), e))
out.instruments.append(inst); out.write(dst)
json.dump([{"start":n.start,"end":n.end,"pitch":n.pitch} for n in inst.notes], open(gt,"w"))
print(src, len(inst.notes), "notes", round(max(n.end for n in inst.notes)), "s")
