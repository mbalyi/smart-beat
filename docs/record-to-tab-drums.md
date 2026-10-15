# Record to tab: drums

Issue: [#121](https://github.com/mbalyi/smart-beat/issues/121)

Record to tab can now listen to a drum kit, an e-kit, or hands on a pad or a table, and writes the hits to a drum track. This page records how the hits are found, how well, which open-source models were looked at, and why none of them ships yet.

## What shipped

- The dialog has a **Drums** choice next to Guitar, Bass and Piano. A drum take has no tuning. Click mode writes onto a drum track (or a new one called "Drums") over the bars it covers, as one undo step. Free mode and the File mode open a new song with one drum track. The track is an ordinary drum track and stays editable.
- The Rust command takes `x-instrument: drums` and runs the hit finder (`src-tauri/src/recording/drums.rs`). Notes come back with the General MIDI drum number as the pitch (`drum-map.ts` and [drum-midi-support.md](drum-midi-support.md) map them to the Guitar Pro 8 names), a fixed 120 ms length and a velocity from the loudness of the hit.
- `src/lib/import/drum-hits.ts` drops unknown numbers and merges a drum found twice within 30 ms, then the hits go through the same grid fitting as every other take (`fillTrack`). Free mode measures the tempo from the hits.
- Everything runs on this computer. No model, no weights, no network, no account: the finder is our own signal processing, so there is nothing new to licence.

## How the hits are found

1. Resample to 22.05 kHz, 1024-sample Hann windows every 128 samples.
2. Power in three bands: low (30–160 Hz), mid (160 Hz–4 kHz) and high (6–10.5 kHz).
3. Spectral flux per band: the rise of the log energy against the larger of the two frames before. Peaks are picked with an adaptive threshold (3× the local mean, never below a fixed minimum and never below 15% of the band's loud peaks) and a 45 ms refractory time.
4. Peaks of different bands within 35 ms are one hit. Each hit is named from the **shape of its spectrum**, not its loudness (power per bin, so the bands compare):
   - the high band far above the mid band: a hat or a cymbal. How fast the high band dies away until the next hit decides: slower than 12 /s (natural-log energy) is open hat 46, slower than 7.5 /s over at least 200 ms is crash 49, else closed hat 42;
   - a low tone below 110 Hz with the low band far above the mid band: kick 36;
   - a low tone above 110 Hz: tom 41, 47 or 48 by pitch, unless a snare's noise is there too (then it is the snare's ring);
   - mid band without a low tone: snare 38. A snare played together with a kick is found when the mid band is 2.5× what the kick has alone in this take;
   - a hat with a snare, kick or tom needs only a small share of high band (1.5% of the mid band), as those drums have almost none up there.
5. A hit is placed where its flux peaks, corrected by a fixed offset found on synthetic hits (about 5 ms late on the rendered kits).

## Test set

No free recording comes with exact drum onsets and a licence for audio, so the test audio is rendered, as for piano:

- `research/record-to-tab/drums/gen.py` writes 12 clips of 60 s: rock, funk (16th hats), shuffle and half-time grooves at 72–156 BPM, a tom fill every fourth bar, a crash on every phrase, timing noise of about 8 ms and varied velocity. 3,993 hits.
- `render/` (a small `rustysynth` program) plays them through the **Sonivox** drum kit (Apache-2.0, the SoundFont Smart Beat plays with).
- `score.py` counts a hit found when the same drum is within 50 ms (greedy one-to-one), per class. Toms and crash are grouped as the finder names them (41/43, 45/47, 48/50, 49/57).

**Limit:** this is one synthesized kit, not a room with a microphone. The thresholds were tuned on these 12 clips, so the numbers are optimistic, and a different kit (a snare with a lot of high end, a dead hat) can move the boundaries. Real recordings will score lower. A real recording with exact onsets was not available for free: [E-GMD](https://magenta.tensorflow.org/datasets/e-gmd) (CC BY 4.0) has it but is 90 GB as a single download and was not fetched. Its MIDI-only part could drive the same renderer; that is a next step.

## Results

Onset F1, 50 ms, mean over the 12 clips (precision / recall / F1):

| Drum                                   |    Hits |   Found |    P |    R |       F1 |
| -------------------------------------- | ------: | ------: | ---: | ---: | -------: |
| Kick                                   |     688 |     834 | 0.82 | 1.00 |     0.90 |
| Snare                                  |     539 |     670 | 0.80 | 0.99 |     0.88 |
| Hi-hat, closed                         |   2,269 |   1,859 | 0.99 | 0.81 |     0.89 |
| Hi-hat, open                           |      91 |     135 | 0.48 | 0.71 |     0.58 |
| Crash                                  |      78 |      81 | 0.94 | 0.97 |     0.96 |
| Tom, middle                            |     164 |     172 | 0.48 | 0.50 |     0.49 |
| Tom, low / high                        | 82 / 82 | 85 / 88 | 0.00 | 0.00 |     0.00 |
| **Kick, snare, hat (closed and open)** |   3,587 |   3,498 | 0.89 | 0.87 | **0.88** |
| All classes                            |   3,993 |   3,924 | 0.84 | 0.82 |     0.83 |

- This agrees with the earlier research on a drum stem (0.78–0.82 for kick, snare and hat from bands).
- Speed: 0.24 s for 60 s of audio on this Mac (real-time factor 0.004), one core. Memory is a few MB.
- Open and closed hat are the weak spot: a closed hat in a dense 16th pattern rings into the next hit, so some read as open (precision 0.48).
- **Toms are not usable yet.** The low and high toms are mostly found as a kick or as the middle tom, as their pitch sits near other drums on this kit. They are labelled experimental in the dialog.
- Tuning, one change at a time on the same clips (kick/snare/hat F1): the first version with a snare test based on high-band noise gave 0.31; telling drums by the spectrum shape per bin gave 0.59; measuring the hat decay up to the next hit gave 0.83; hat share 1.5%, open-hat decay 12 /s and peak threshold 3× gave 0.88. Lowering the loud-peak floor from 15% to 8% gave 0.68 (many false hits).

## Open-source models

All are **not shipped**: nothing here has both clear weights and a result that beats the baseline. Code and weights licences were read from the repositories on 2026-10-14.

| Model                                                                                    | Kind                      | Code / weights licence                                                                            | Status                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Our band classifier (this page)                                                          | Signal processing         | ours                                                                                              | **Ships.** 0.88 on kick, snare, hat                                                         |
| [ADTOF](https://github.com/MZehren/ADTOF)                                                | CRNN                      | code (not checked) / CC BY-NC-SA 4.0                                                              | Not usable: non-commercial weights                                                          |
| [Magenta Onsets and Frames Drums](https://github.com/magenta/magenta) (E-GMD checkpoint) | CRNN                      | Apache-2.0 repository, archived / **checkpoint: no licence stated** (trained on E-GMD, CC BY 4.0) | Not measured; unclear weights do not ship. Own training on E-GMD would be clean (see below) |
| [YourMT3+](https://github.com/mimbres/YourMT3)                                           | T5-style sequence model   | **GPL-3.0** code / weights: not stated                                                            | Not usable: GPL code, unclear weights                                                       |
| [Omnizart](https://github.com/Music-and-Culture-Technology-Lab/omnizart) drum module     | CNN                       | MIT / checkpoints: not stated; the project lists "unknown bugs" for drum training                 | Not measured; unclear weights do not ship                                                   |
| [MuScriptor](https://github.com/muscriptor/muscriptor)                                   | Multi-instrument sequence | MIT / CC BY-NC 4.0                                                                                | Not usable: non-commercial weights (0.94 drums F1 on the earlier test)                      |
| [MR-MT3 / MT3](https://github.com/magenta/mt3)                                           | T5-style sequence         | MIT, Apache-2.0 / Apache-2.0                                                                      | Weak and slow on CPU in the earlier test (0.37–0.41 drums F1)                               |
| Cloud language models with audio                                                         | closed API                | n/a                                                                                               | Out: needs a network and an account, and gives no exact onsets                              |

The numbers for ADTOF, Magenta, YourMT3+ and Omnizart in the issue discussion are from the projects' papers and READMEs, not from our test set. **No neural model was run on the 12 clips**: running them needs large downloads and a Python stack the project does not carry (see next steps).

## Next steps

1. **Measure a neural model against the baseline.** Both needed before any code: a licence for the weights and a result on the same clips. Candidates to run for the record: the Magenta E-GMD checkpoint and Omnizart (measurement only, never shipped without a licence).
2. **Own small CRNN** trained on E-GMD (CC BY 4.0) and Slakh2100 (CC BY 4.0). Clean licence, but the data is about 90 GB and training needs a GPU box, which this Mac does not have (21 GB free).
3. **Real recordings.** E-GMD's MIDI-only part rendered through the same kit, then a few real takes with hand-checked onsets. The thresholds in `DrumOptions` will move.
4. **Kit calibration** ("hit each drum twice"): the finder already compares every hit with the kick's own mid band in the same take; learned templates per drum would fix toms and the open/closed hat. Not built.
5. **Hat share with a snare** (1.5% of the mid band) fits the Sonivox kit. A snare with more high end needs a higher value.

## Reproducing

```sh
cd research/record-to-tab/drums
cargo build --release --manifest-path ../../../src-tauri/Cargo.toml --example transcribe_wav
./run.sh                          # the shipped settings
./run.sh TOMS=0 CRASH=0           # without the experimental drums
./run.sh HAT_RATIO=0.025 SENSITIVITY=2.5   # your own settings (see transcribe_wav.rs)
```
