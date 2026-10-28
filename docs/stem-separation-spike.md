# Stem separation: spike results (draft)

Issue: [#186](https://github.com/mbalyi/smart-beat/issues/186)

Status: **draft after the first measurements.** The classical engine and the neural comparison are measured. The score-informed prototype and the listening notes are not done yet and are marked as such below.

## What was built

`src-tauri/src/separation/` separates a stereo recording into drums, bass, vocals, hard-panned parts ("guitars or keys") and a remainder, with signal processing only, on the user's computer. The stems add up to the original (SDR 138 dB on all three real songs), so muting one never changes the others.

| Part           | Method                                                                                                                                                    | Source                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Panned guitars | Pan mask: cells where one channel dominates. Runs first                                                                                                   | Own code, pan ratio per cell                  |
| Drums          | Median-filter HPSS with a soft Wiener mask. "Gentle" = long window; "Strong" = long window, then a short-window pass on the rest                          | FitzGerald 2010; Driedger, Müller, Disch 2014 |
| Bass           | YIN pitch (30 to 250 Hz) on the drum-free mix, gaps bridged, fundamental checked, then a harmonic comb mask that must also be centred in the stereo image | de Cheveigné and Kawahara 2002                |
| Vocals         | Stereo coherence mask (in phase, equal level), off below 120 Hz and fully on above 240 Hz to keep kick and bass remains out                               | Own code                                      |
| Other          | What is left, labelled "not separated"                                                                                                                    |                                               |

No part is removed by a plain frequency cut. The mono case is detected: vocals and panned are skipped and reported as not separable.

## Method choices the measurements decided

- **Soft masks beat binary masks on calmness.** A unit test checks that the soft drum mask changes less between neighbouring frames than its binary version ("musical noise"). The benchmark shows the two within about 1 dB of each other in removal, so the gain is in artefacts, not in dB.
- **Octave doubling is the main trap.** In the synthetic band the guitar plays the bass line an octave up. A bass comb alone took 42% (amplitude) of the guitar into the bass stem. Requiring the bass mask to be centred, and running the pan stage first, cut that to 8%.
- **The short window removes more drums and costs more music.** On the synthetic band the drums fall 5.0 dB (gentle) or 10.1 dB (strong), and muting them then costs the bass 1.1 dB (gentle) or 5.5 dB (strong). A short window cannot tell a kick from a bass note, and keeping the short pass off the bottom octaves gave no gain over gentle. The app should offer both as a choice.

## Synthetic band (exact ground truth)

12 s at 120 BPM: kick, snare and hats; a bass line; a vocal-like line; two distorted guitars hard left and right. Run `cargo run --release --example separation_bench`. Drop of each part when its own stem is muted, and the collateral loss of the other parts:

| Muted   | Part falls by (gentle) | Part falls by (strong) | Worst collateral (gentle) |
| ------- | ---------------------- | ---------------------- | ------------------------- |
| Drums   | 5.0 dB                 | 10.1 dB                | vocals 2.4 dB             |
| Bass    | 6.0 dB                 | 2.7 dB                 | vocals 3.8 dB             |
| Vocals  | 4.1 dB                 | 2.9 dB                 | guitars 0.2 dB            |
| Guitars | 8.0 dB                 | 8.0 dB                 | bass 1.2 dB               |

For comparison, the neural systems in the issue's table reach about 7 to 9 dB SDR per stem on MUSDB18 (different measure, real music). The classical engine is in the "clearly quieter, with audible residue" range on this synthetic band, not "gone".

A 150 Hz low cut removes this clean, low synthetic bass better than the comb mask (about 23 dB against 6 dB) but also takes about 5 dB of the kick. That is why the unit test asserts the kick damage and not the bass removal. Real bass guitar has strong harmonics above 150 Hz, which the cut leaves; this is not yet measured on a real bass.

## Real songs (no ground truth, proxies only)

Three songs from the owner's own library (anonymised as songs A, B and C; each has a Guitar Pro tab with two distorted guitars, a bass and drums), run on a 10-core Apple Silicon Mac, release build. Files are never uploaded or copied into the repository.

| Song   | Length | Separation time | Real-time factor | Drum onset F1 vs tab (drums stem) |
| ------ | ------ | --------------- | ---------------- | --------------------------------- |
| Song A | 361 s  | 2.9 s           | 0.008            | 0.47 (alignment unreliable)       |
| Song B | 215 s  | 1.9 s           | 0.009            | 0.77                              |
| Song C | 204 s  | 1.9 s           | 0.009            | 0.66                              |

- Speed is not a problem: about 110 to 120 times faster than real time. Peak memory in the benchmark is 1 to 2 GB because it holds all stems; the app streams them to disk.
- The drums stem follows the tab's drum onsets about as well as the whole mix does. In Song B the **vocals stem has an onset lift of 3.0 and the bass stem 1.9** against the tab's drums, so drum hits are leaking into both. The "other" stem scores below 1 (fewer drum onsets than average) in two songs, which is the intended direction.
- The proxies cannot say how much drum is left in each stem. That needs ground truth (the planned synthetic renders from the tab with the app's SoundFonts) and **a listening test, which has not been done**.

## Instrument detection without a tab

The detector tuned on the synthetic band does **not** carry over to real songs:

| Song   | Bass | Drums             | Vocals | Panned |
| ------ | ---- | ----------------- | ------ | ------ |
| Song A | yes  | **missed** (0.17) | missed | missed |
| Song B | yes  | **missed** (0.12) | missed | missed |
| Song C | yes  | yes (0.91)        | missed | missed |

The tabs list two distorted guitars, a bass and drums in each song and have no vocal track; the owner says all three have a singer. So the truth is drums and bass in 3 of 3, vocals in 3 of 3 (from the owner), guitars in 3 of 3. Detection got 4 of 9 of the drum, bass and vocal calls right. The real songs have drums that are irregular (regularity 0.18 to 0.26 where the synthetic band has 0.97), a singer who is mostly not separable by the centre cue, and guitars that are not hard-panned (panned share 0.07 to 0.15). Thresholds need to be learned from real songs, which needs more labelled material than three songs. The electric/acoustic guesser `distortion_index` was not validated; the three songs give 0.20, 0.27 and 0.30, all distorted guitar, with nothing to compare against.

## Neural comparison: Open-Unmix UMX-HQ

Run on 2026-10-28 with the four UMX-HQ weight files (Zenodo record 3370489, MIT licence field; 4 x 35.6 MB; downloaded to a scratch folder outside the repository, sizes and SHA-256 prefixes match the file names). The network was re-written in PyTorch (`scripts/stem-separation/umx_run.py`) and ran inside a Docker container with the network switched off and the audio mounted read-only. The final step is a soft power-ratio mask, not the reference iterative Wiener filter, so the reference would be somewhat better. Compare with `cargo run --release --example separation_compare`.

**Synthetic band (exact ground truth), drop of a part in dB when its stem is muted:**

| System                                | Drums | Bass | Vocals | Guitars |
| ------------------------------------- | ----- | ---- | ------ | ------- |
| Ours, gentle drums                    | 5.1   | 6.0  | 4.1    | 8.0     |
| Ours, strong drums                    | 10.3  | 2.6  | 3.0    | 8.0     |
| Neural UMX-HQ (guitars = its "other") | 8.3   | 17.1 | 17.3   | 9.9     |

The neural stems also lose less of the other parts (worst collateral 0.1 to 2.9 dB against 0.1 to 5.5 dB for ours), except that muting its bass still takes 2.9 dB from another part. On this band the neural bass and vocals are 11 and 13 dB better than ours; the drums and guitars are comparable (strong drums beat neural on pure drum removal but cost the bass 5.5 dB). The synthetic band is not music UMX was trained on, so these numbers say how the two approaches behave on clean, separable material, not how they will sound on a record.

**Real songs:** the classical stems agree only loosely with the neural ones, which is a measure of agreement, not of quality: SDR of our bass against the neural bass 4.8, 2.7 and 7.2 dB; of our vocals 2.3, -9.2 and 2.3 dB; of our drums -0.8, 1.3 and 1.1 dB (gentle) for Song B, Song C and Song A. In Song B and Song A about 55 to 60% (amplitude) of the neural vocals land in our drums stem: screamed vocals look percussive to HPSS. The neural vocal stem of Song C holds 0.2% of the energy, so that song is probably instrumental, and our detector's "no vocals" there was right; the other two have a clear vocal (21 to 24% of the energy).

**Cost:**

| System                  | Time for a 3 to 6 minute song                                         | Added to the installer              |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| Ours                    | about 2 s                                                             | no new dependency; not yet measured |
| UMX-HQ in the container | 46 s (361 s song), 65 s (204 s), 88 s (215 s), 10 CPU cores in Docker | 0 MB; 142.5 MB download             |

**Running it in the app.** No ONNX export and no new dependency are needed. The app reads the original `.pth` files (the legacy PyTorch format, parsed by `src-tauri/src/separation/torch_legacy.rs`, which only understands the few pickle instructions a state dict uses and never runs anything named in the file) and runs the network in Rust (`separation/umx.rs`: three bidirectional LSTM layers between linear layers). Checked against the PyTorch run on the synthetic band, the Rust stems agree to 32.9 dB (drums), 39.4 dB (bass), 49.9 dB (vocals) and 42.5 dB (other) SDR, and give the same drop figures in the table above. A 30 s clip takes 2.2 s in a release build on the 10-core test Mac, so a 6-minute song takes roughly half a minute, faster than the container run. `tract` was not needed; whether it handles bidirectional LSTM was not checked.

## Neural licences

Read from primary pages on 2026-10-28.

| Model                                  | Code | Weights licence as stated upstream                                                                   | Size                         |
| -------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| Demucs (facebookresearch)              | MIT  | **None stated in the README**; the repo is no longer maintained; trained on MUSDB-HQ                 | not read                     |
| Third-party Demucs ONNX (Hugging Face) | n/a  | Card says `mit`; another ONNX port is quoted in the issue as CC BY-NC 4.0, so repackagers disagree   | 21 files, 1.46 GB in total   |
| Open-Unmix UMX-HQ (Zenodo 3370489)     | MIT  | Zenodo licence field `mit-license`; the README states nothing for the weights; trained on MUSDB18-HQ | 4 x 35.6 MB = about 142.5 MB |
| Open-Unmix UMXL                        | MIT  | "only licensed for non-commercial use (CC BY-NC-SA 4.0)": excluded                                   | not read                     |

**MUSDB18-HQ terms.** UMX-HQ was trained on MUSDB18-HQ ([Zenodo record 3338373](https://zenodo.org/records/3338373), licence field other-nc). Its description says the tracks are "provided for educational purposes only" and "should not be used for any commercial purpose without the express permission of the copyright holders". The Open-Unmix authors do not say whether those terms reach the weights, and the Zenodo field for the weights says MIT. That is the same kind of open question as Transkun and MAESTRO in [`licensing.md`](licensing.md).

**What the app does about it.** The weights are never bundled, hosted or mirrored by Smart Beat. The optional neural engine downloads the four files straight from Zenodo (record 3370489) after the user has read the terms above and confirmed that they only use music they have the rights to (`src-tauri/src/stems/umx_model.rs`). The owner decided on 2026-10-28 to offer this download in the free app, accepting the open question above as the same kind of risk as Transkun (see [`licensing.md`](licensing.md)); the UI offers it behind the `stem-separation-neural` flag, which is on. The fast engine has no model and no weights.

Not verified: Spleeter and RoFormer weights licences. UMX-HQ ships as an optional download on the owner's decision, not because the question is settled.

## Not done yet

- The score-informed prototype (tab alignment plus constrained NMF).
- Synthetic mixes rendered from the tabs with the app's SoundFonts, for exact SDR on realistic timbres.
- Listening notes. They are left for the owner to fill in.
- App size: the engine adds no dependency; the number comes from a release build before and after, which is still to be taken.

## Decision

The built-in engine ships as the default. Open-Unmix UMX-HQ is offered as an optional download (owner's decision, 2026-10-28). Tab-aligned separation and stems as lanes in the tab view are follow-ups that depend on multi-lane audio (#185).
