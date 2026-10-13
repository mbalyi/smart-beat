import sys, json, pretty_midi
pm = pretty_midi.PrettyMIDI(sys.argv[1])
json.dump({"notes":[{"start":n.start,"end":n.end,"pitch":n.pitch} for i in pm.instruments for n in i.notes]}, open(sys.argv[2],"w"))
