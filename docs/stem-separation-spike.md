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

## Neural models compared (SCNet, HTDemucs vs UMX-HQ)

Run on 2026-11-03 with the example `separation_tract` (`src-tauri/examples/separation_tract.rs`), which runs each model through `tract` (already in the app, no new crate) and measures it. STFT, iSTFT, segmenting (7.8 s or 11 s, 25% overlap, triangular overlap-add) and stem assembly are Rust code; the graph is the network core only. Conversion notes and parity checks: `scripts/stem-models/README.md`. Weights used: SCNet Small (upstream ONNX), SCNet XL (our ONNX export of the ZFTurbo `v1.0.15` checkpoint), HTDemucs (our export of `htdemucs`), UMX-HQ (the app's own Rust engine).

**Measured here: synthetic band, 30 s, exact ground truth.** SDR in dB against the true parts (higher is better; 0 means as far off as silence). "Other" is the guitars in this band. Real-time factor (RTF) is compute seconds per second of audio, one `tract` thread.

| Model         | Drums | Bass | Vocals | Other | RTF  | Peak memory (RSS) |
| ------------- | ----- | ---- | ------ | ----- | ---- | ----------------- |
| UMX-HQ (Rust) | 4.2   | 5.3  | 11.2   | 8.3   | 0.07 | not measured here |
| SCNet Small   | 11.7  | 14.0 | 20.8   | 16.7  | 0.57 | 993 MiB           |
| SCNet XL      | 11.9  | 14.0 | 24.9   | 16.6  | 6.03 | 2592 MiB          |
| HTDemucs      | 13.9  | 16.4 | 17.0   | 17.6  | 0.76 | 1449 MiB          |

The stems of every model add back up to the mixture (36.8 dB for Small, 39.3 for XL, 31.1 for HTDemucs). UMX-HQ's RTF is its own run on the same clip, 0.07 to 0.27 across the three runs (clip length and machine load differ).

**Measured here: one real song, first 45 s ("StereoHangar - Attitude"), no ground truth.**

| Model       | RTF  | Peak memory (RSS) | Stems summed against the mix |
| ----------- | ---- | ----------------- | ---------------------------- |
| SCNet Small | 0.63 | 1005 MiB          | 37.3 dB                      |
| HTDemucs    | 0.57 | 1564 MiB          | 34.0 dB                      |
| SCNet XL    | 6.86 | 3499 MiB          | 40.9 dB                      |

The agreement of each model with UMX-HQ on this song is a measure of difference, not of quality: drums about 11 dB, bass about 6 dB, vocals 3.3 to 4.1 dB, other about 5 dB. The sum against the mix only shows that nothing is lost or invented overall. **How the stems sound has not been judged.** The WAV stems (drums, bass, vocals, other for each model) are in `~/Documents/smart-beat-spike-notes/listen/` on the owner's machine and are not in the repository; listening notes are left for the owner.

**What the numbers cannot say.**

- The synthetic band is easy and unlike real records; the gaps on real music will be smaller. Take the ranking between the neural models on it lightly: HTDemucs wins drums, bass and other, SCNet XL wins vocals, by amounts that one synthetic clip cannot settle.
- Speed is single-threaded `tract`. A 4-minute song takes about 2.5 minutes with SCNet Small or HTDemucs and about 27 minutes with SCNet XL at the measured RTF. Running segments on several threads was not tried; it would trade memory (up to several GB for XL) for time. On the synthetic run the last XL segment took about twice as long as the others, so the XL speed may be pessimistic.
- One real song, 45 s, and one machine (10 cores, 16 GB).
- MUSDB-style SDR figures quoted below for SCNet and HTDemucs are upstream's, on a different test set and metric than the synthetic band here. Do not compare them with the table above.

**Strengths, by model.** The owner asked for these to be noted next to the models, and for HTDemucs to be the general recommendation. The first column is what we measured; the second is what upstream and MVSep report and was not checked here.

| Model       | Download in the app | Recommended for                                                  | Measured here                                                                                                     | Claimed elsewhere (not verified here)                                  |
| ----------- | ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HTDemucs    | 177 MB (ONNX)       | **General use: the recommended default** among the neural models | Best drums, bass and other on the synthetic band; RTF 0.57 to 0.76                                                | About 12.5 dB bass on the MVSep multisong table (SCNet XL about 13.8)  |
| SCNet XL    | 216 MB (ONNX)       | **Vocals**; best quality when time does not matter               | Best vocals on the synthetic band (24.9 dB); about 10 times slower than the others; 3.5 GB RAM                    | 10.09 dB average on MUSDB18-HQ (upstream); bass about 13.8 dB on MVSep |
| SCNet Small | 52 MB (ONNX)        | **Fast and light**: the quick neural option                      | Close to HTDemucs on the synthetic band at the same speed, about a third less memory than HTDemucs on a real song | 9.03 dB average on MUSDB18-HQ (upstream)                               |
| UMX-HQ      | 143 MB (4 files)    | Older, smaller download; fastest (memory not measured here)      | 6 to 14 dB behind the three newer models on every part                                                            | About 5 to 6 dB median SDR on MUSDB (a different metric)               |

"Other" means everything that is not drums, bass or vocals, so for a guitar or piano part it is a catch-all, not a guitar stem. None of these four models separates guitar or piano on its own.

**More than one model for more than one job.** The owner noted (2026-11-03) that several models may be needed, one per task. What the research says, with the caveat that the figures are MVSep's own and not independent:

- Vocals versus instrumental: the RoFormer family (Mel-Band RoFormer, BS-RoFormer) is reported strongest, about 11.0 dB vocals against about 8.3 for `htdemucs_ft` on the MVSep multisong set. The weights are large (about 460 to 930 MB) and were not tried here.
- Drums, bass, other: HTDemucs or SCNet XL (SCNet XL bass about 13.8 dB against about 12.5 for HTDemucs on the same table).
- A two-pass pipeline is possible: split vocals from instrumental first, then run the bass and drums model on the instrumental. A small gain for no extra download, not measured here.
- Guitar and piano: `htdemucs_6s` has them, but its piano is reported weak ("medium"); a targeted model is still to be found. The app now has an engine for `htdemucs_6s` (next section); it is not offered until its converted file is hosted.
- Practical rules from the notes: keep 44.1 kHz and float32 between steps, no normalisation between steps, and check with a null test (sum of the stems against the input).
- The app's engine type and download registry should therefore take a list of models, and a pipeline can use several. That is design, not built.

## HTDemucs 6-source (guitar and piano)

Added 2026-11-03 at the owner's request (the research above and the owner's note named `htdemucs_6s`). **Status: implemented and tested against a synthetic six-source stand-in; the real model has not been exported, hosted or run.** Nothing in this section was measured on real music.

**What it is.** The `htdemucs_6s` model of the Demucs project (Demucs signature `5c90dfd2`, file `5c90dfd2-34c22ccb.th`, listed in `demucs/remote/files.txt` and `htdemucs_6s.yaml` as `models: ['5c90dfd2']`). It is the HTDemucs network with six sources, in the order `drums`, `bass`, `other`, `vocals`, `guitar`, `piano`. The upstream checkpoint is 54,996,327 bytes (read from the `Content-Length` of the download address on 2026-11-03; the file was not downloaded), against 84,141,911 for `htdemucs`, so it is not simply the four-source network with two more outputs: **the export script stops if the checkpoint's sources, segment (7.8 s) or transformer width (512) differ from what the wrapper assumes**, instead of writing a wrong graph.

**What the app does with it.** Engine id `htdemucs-6s`, model id `htdemucs-6s`, file `htdemucs_6s_core.onnx` in the `stem-models-v1` release like the other two converted files. Same host code as HTDemucs (`separation::onnx`: the contract differs only in the name and the stem list), so the segmenting, STFT, overlap-add and the `drums, bass, other, vocals, guitar, piano` assembly are the code already tested on the other models. Songs separated with it have the stems `drums`, `bass`, `vocals`, `guitar`, `piano` and `other`; the page lists them in that order, each with Mute, Solo, volume and a waveform like every other stem. The mix and the playback code were already generic over the stem list.

**What it can and cannot do (from the upstream notes, not measured here).** The Demucs project calls the 6-source model experimental and says its piano part is weak. Guitar is better but clearly behind drums, bass and vocals: distorted guitar can leak into Other, and piano or keys can land in Guitar or Other. The app says so on the engine card, in the dialog and under each part on the page ("Limits:"), and does not recommend it over HTDemucs for general use (HTDemucs stays the recommended default).

**Size and speed.** Not known until it is exported. The ONNX of `htdemucs` is about 2.1 times its `.th` file (176.6 MB from 84.1 MB, float32 against float16), which would put this one near 115 MB (an estimate from that ratio; the real number depends on the checkpoint's configuration). Speed and memory should be close to HTDemucs (same network, the segment length is the same) but are not measured.

**Gate.** `HTDEMUCS_6S_PUBLISHED` in `src-tauri/src/stems/models.rs` is `false` and the model's size and SHA-256 are empty placeholders (0 and `""`). While it is false the model reports `available: false`, its download refuses before any request, and the dialog leaves the engine card out of the list. A unit test fails if the flag is turned on without a real size and a 64-digit SHA-256.

**To publish it (owner, needs a download of the checkpoint and an upload).**

1. Download `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/5c90dfd2-34c22ccb.th` (about 55 MB) into the work folder.
2. `WORK=<folder> IMAGE=<image with torch, einops, numpy> scripts/stem-models/htdemucs/run.sh parity htdemucs_6s`, then `... run.sh export htdemucs_6s` (after `setup_pylib.sh` once). Read the printed parity (SNR against the stock model; the 4-source export gave 129 dB) and the ONNX-against-torch check.
3. `shasum -a 256 htdemucs_6s_core.onnx` and `stat -f %z htdemucs_6s_core.onnx` give the SHA-256 and the exact size.
4. Upload `htdemucs_6s_core.onnx` to the `stem-models-v1` release.
5. Put the size and SHA-256 into `HTDEMUCS_6S` and set `HTDEMUCS_6S_PUBLISHED` to `true` in `src-tauri/src/stems/models.rs`; update the table in `scripts/stem-models/README.md` and the row in `licensing.md`; run it on a real song (`separation_tract <model.onnx> htdemucs-6s <audio>`) and record the measured speed and memory here.

## Neural licences

Read from primary pages on 2026-10-28.

| Model                                  | Code | Weights licence as stated upstream                                                                   | Size                                 |
| -------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Demucs (facebookresearch)              | MIT  | **None stated in the README**; the repo is no longer maintained; trained on MUSDB-HQ                 | not read                             |
| Third-party Demucs ONNX (Hugging Face) | n/a  | Card says `mit`; another ONNX port is quoted in the issue as CC BY-NC 4.0, so repackagers disagree   | 21 files, 1.46 GB in total           |
| Open-Unmix UMX-HQ (Zenodo 3370489)     | MIT  | Zenodo licence field `mit-license`; the README states nothing for the weights; trained on MUSDB18-HQ | 4 x 35.6 MB = about 142.5 MB         |
| Open-Unmix UMXL                        | MIT  | "only licensed for non-commercial use (CC BY-NC-SA 4.0)": excluded                                   | not read                             |
| SCNet Small (demixr ONNX)              | MIT  | MIT per the author's statement to us (Small and Large); trained on MUSDB18-HQ only                   | 52,271,228 bytes                     |
| SCNet XL IHF (ZFTurbo `v1.0.15`)       | MIT  | **None stated**; trained on MUSDB18-HQ only; only a PyTorch checkpoint upstream                      | 214,063,778 bytes (ONNX 216,163,649) |
| HTDemucs `htdemucs` (Meta)             | MIT  | **None stated**; trained on MUSDB18-HQ plus 800 non-public songs; only a PyTorch file upstream       | 84,141,911 bytes (ONNX 176,589,623)  |
| HTDemucs `htdemucs_6s` (Meta)          | MIT  | **None stated**; the same family and training data as above; only a PyTorch file upstream            | 54,996,327 bytes (ONNX not made yet) |

**MUSDB18-HQ terms.** UMX-HQ was trained on MUSDB18-HQ ([Zenodo record 3338373](https://zenodo.org/records/3338373), licence field other-nc). Its description says the tracks are "provided for educational purposes only" and "should not be used for any commercial purpose without the express permission of the copyright holders". The Open-Unmix authors do not say whether those terms reach the weights, and the Zenodo field for the weights says MIT. That is the same kind of open question as Transkun and MAESTRO in [`licensing.md`](licensing.md).

**What the app does about it.** The weights are never bundled, hosted or mirrored by Smart Beat. The optional neural engine downloads the four files straight from Zenodo (record 3370489) after the user has read the terms above and confirmed that they only use music they have the rights to (`src-tauri/src/stems/umx_model.rs`). The owner decided on 2026-10-28 to offer this download in the free app, accepting the open question above as the same kind of risk as Transkun (see [`licensing.md`](licensing.md)); the UI offers it behind the `stem-separation-neural` flag, which is on. The fast engine has no model and no weights.

Not verified: Spleeter and RoFormer weights licences. UMX-HQ ships as an optional download on the owner's decision, not because the question is settled.

## Saving a separation

A separation lives in the cache under the app's data folder, which is limited (2 GB) and can be cleared, so the stem page has **Save stems**. It writes one `.sbstems` file (a ZIP of FLAC stems, a manifest and optionally the original song) to a place the user picks, with a progress bar, and **Open saved stems** on the start screen reads it back into the library without separating again (about the time it takes to copy the files, not the minutes a separation takes). The cached copy is kept, so a song can be saved and also stay in the Recent grid with a "Saved" mark. The format, its versioning and the privacy rule (the original song is included only when the user ticks the box) are in [`file-formats.md`](file-formats.md#saved-stems-sbstems).

## Not done yet

- The score-informed prototype (tab alignment plus constrained NMF).
- Synthetic mixes rendered from the tabs with the app's SoundFonts, for exact SDR on realistic timbres.
- Listening notes. They are left for the owner to fill in.
- App size: the engine adds no dependency; the number comes from a release build before and after, which is still to be taken.

## Decision

The built-in engine ships as the default. Open-Unmix UMX-HQ is offered as an optional download (owner's decision, 2026-10-28). SCNet Small, SCNet XL and HTDemucs run well in `tract` and are further optional downloads (owner's decision, 2026-11-03). The two converted ONNX files (SCNet XL, HTDemucs) are hosted in the pre-release [`stem-models-v1`](https://github.com/mbalyi/smart-beat/releases/tag/stem-models-v1); their weights licences are unstated, the owner accepted that risk and the project removes the files immediately if an obligation arises (see [`licensing.md`](licensing.md)). Tab-aligned separation and stems as lanes in the tab view are follow-ups that depend on multi-lane audio (#185).
