# Smart Beat: high-level plan

Goal: a modern rewrite of Guitar Pro 5 that runs on Mac, Windows and Linux, with a self-hosted AI that generates an accompaniment (drums, guitar, bass, piano) in notation and tab that fits a hummed melody harmonically.

> Note: GP5 was not free (Arobas Music, about €50–60). It also had a Mac version (July 2006), but that is a 32-bit Carbon application and has not run since macOS 10.15. Arobas's official GP5 release notes are no longer publicly available, so the version history is incomplete.

---

## 1. GP5 version history

| Version               | When                                    | What we know about it                                                                                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **5.0**               | Nov 2005 (Windows)                      | New interface, selecting several elements at once, two voices per track, new effects (wah-wah, accented notes, better artificial harmonics, bend and tremolo). New "Realistic Sound Engine" (RSE): playback uses samples recorded from real instruments.                                                                                    |
| **5.0 Mac**           | Jul 2006                                | Mac OS X, PowerPC and Intel                                                                                                                                                                                                                                                                                                                |
| **5.1**               | about 2006–2007                         | Bug fixes, RSE improvements. No detailed list available.                                                                                                                                                                                                                                                                                   |
| **5.2**               | 2007–2008 (sources contradict each other) | The last Windows version. More stable (a known problem was error messages after long sessions), Windows Vista support. RSE shipped with 14 sound banks (2 nylon, 2 acoustic, 2 electric, 1 jazz guitar, 4 bass, 3 drum kits), 44.1 kHz / 16 bit.                                                                                         |
| **5.3.2b5 (Mac)**     | –                                       | A Mac build with this number is listed in the Macintosh Garden archive. Not verified.                                                                                                                                                                                                                                                      |

## 2. GP5 features (summary of the known feature set, to be verified)

- **Tracks and instruments:** multiple tracks; guitar with up to 7 strings, bass, banjo, drums, any MIDI instrument. Tuning presets, capo, copying a track.
- **Notation:** tablature, standard notation and rhythm notation together, two voices per track. Key signature, time signature, triplet feel, n-tuplets, ties, grace notes, dynamics, fingering.
- **Guitar techniques:** bends with an editable curve, slides (legato, shift, in, out), hammer-on and pull-off, vibrato, trill, tremolo picking, palm mute, let ring, dead and ghost notes, staccato, accents. Harmonics: natural, artificial, tapped, pinch, semi. Tapping, slap, pop, whammy bar (dive, dip), rasgueado, pick direction, arpeggio/brush, fade-in, wah open/closed.
- **Structure:** repeat signs, alternative endings, Coda, Segno, D.C./D.S. al Fine, section markers, text, up to 5 lyrics lines that follow the music during playback.
- **Chords and scales:** chord diagrams, chord detection, chord wizard, scale tool.
- **Playback:** RSE mixer with amp and effect chains, automatable volume, pan, tempo and effects. MIDI playback, metronome, count-in, loop, Speed Trainer (gradually speeding up practice).
- **Tools:** virtual fretboard and keyboard, microphone tuner, bar-length check, transposition, automatic conversion between tab and notation, step-by-step input from a MIDI keyboard.
- **Import/export:** GP3, GP4, GP5, MIDI, ASCII tab, MusicXML, PowerTab. Output: WAV, printing, style sheets, three views (page, screen, "parchment").
- **File format:** the open-source community has fully reverse-engineered the binary `.gp5` format (PyGuitarPro, alphaTab and TuxGuitar read it).

## 3. Free alternatives for Mac

| Program                    | What it is good for                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TuxGuitar** (2.1.0, Jul 2026) | The closest to GP5. Open source, **reads and writes GP3/4/5**. The Mac package is not signed, so Gatekeeper warns on installation.                                                         |
| **MuseScore 4**            | Notation editor, imports GP files, has tab too. Free.                                                                                                                                            |
| **alphaTab**               | A GP viewer and player that runs in the browser. Not an editor, but a good starting point (see section 6).                                                                                       |
| **GP5 under Wine / CrossOver** | The original GP5 runs quite well this way, even on Apple Silicon Macs.                                                                                                                       |

A paid option is Guitar Pro 8 (about €70).

## 4. AI accompaniment for a hummed melody: market situation

A ready-made program that does exactly this (humming → notation → matching drum, guitar and piano parts in notation) **does not exist for free**. The closest ones:

- **Logic Pro 11 (Mac, paid):** Session Players follow the chord track and generate fitting bass, keyboard and drum parts that can be edited as MIDI.
- **Band-in-a-Box (Mac/Windows, paid):** creates chords and a full band accompaniment for a melody, with notation and tab.
- **Hookpad Aria (Hooktheory):** AI chord and melody suggestions.
- **Humming → notation:** Songscription, Klangio (only the transcription is AI-based; you have to write the accompaniment yourself).
- **Suno and similar:** they generate audio, not editable notation, so they do not fit this purpose.

This is the gap Smart Beat can fill.

## 5. The rewrite: architecture and technologies

| Layer                      | Choice                                                                                       | Why                                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop shell              | **Tauri 2** (Rust)                                                                           | Small, native, runs on all three systems. Electron is a heavier alternative.                                                                                                                                                                           |
| UI                         | TypeScript + React or Svelte                                                                 | Modern UI, fast development                                                                                                                                                                                                                            |
| Notation rendering and playback | **alphaTab** (MPL-2.0)                                                                  | Renders GP3–7 files and standard notation, has a built-in synthesizer (SoundFont-based) and shows the current note during playback. It provides about 40% of the project.                                                                              |
| File reading and writing   | alphaTab importers; for **writing GP5**, PyGuitarPro or the TuxGuitar logic ported (see the licensing note below), plus MusicXML | –                                                                                                                                                                                                                                       |
| Sound (instead of RSE)     | FluidSynth or alphaSynth with an SF2/SF3 sound bank, later a sample-based engine             | –                                                                                                                                                                                                                                                      |
| AI service                 | Python (FastAPI) sidecar process or Docker server; ONNX Runtime in the app                   | Can be installed on its own, even on a GPU server                                                                                                                                                                                                      |

> Licensing note: porting code from PyGuitarPro or TuxGuitar is not allowed under Smart Beat's licence policy. GP5 writing is implemented clean-room from public format documentation. See [`docs/licensing.md`](docs/licensing.md).

### AI chain: "I hum, and I get an accompaniment"

1. **Humming → notes:** Spotify Basic Pitch (Apache-2.0) or torchcrepe/pYIN for monophonic pitch detection. Then rhythm alignment (quantization) and key detection with the music21 library.
2. **Chords for the melody:** rule-based or hidden Markov model (HMM) harmonization, or AccoMontage2/3.
3. **Generating the accompaniment:** **Anticipatory Music Transformer** (Stanford, open). It was built to add further parts to an existing melody without changing the melody.
4. **Playable guitar tab:** an optimization algorithm (dynamic programming) chooses which string and fret each generated note is played on, so that the fingering is actually playable. A critical part that no ready-made AI does well today.
5. **Conversational assistant** (for example "put a walking bass under it"): a local LLM under Ollama or llama.cpp (Qwen, Llama). It calls the models above through tool calls and does not write notes itself.

### Music-trained, free models

- **ChatMusician:** LLaMA2-based, "thinks" in ABC notation.
- **NotaGen:** ABC format, mainly for classical music.
- **MuPT** and **MIDI-LLM:** generate MIDI from text.
- **Anticipatory Music Transformer:** the best choice for accompaniment generation.
- **Magenta** (Coconet: Bach-style harmonization; Music Transformer).
- **CLaMP 3:** for music retrieval.
- Audio-based models, not notation: YuE, MusicGen.

Large general-purpose LLMs are weak at generating notes directly. For this purpose, smaller music-specialized models combined with music-theory rules work.

### Time estimate

| Milestone                                                                                         | 1 developer (with AI coding assistants) | Team of 3–4              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| MVP: open, display and play a GP file, basic editing, MusicXML export                             | 2–3 months                              | 1–1.5 months             |
| Humming → notation + AI accompaniment (drums, bass, piano) + tab optimization                    | +3–4 months                             | +2 months                |
| Nearly the full GP5 feature set (every effect, printing, mixer, GP5 writing)                      | 12–18 months in total                   | 8–12 months in total     |
| RSE-level sound (own sample library)                                                              | a separate project, expensive because of the audio samples | –       |

## 6. Open-source starting points

- **alphaTab** (CoderLine/alphaTab): rendering and playback, the best foundation.
- **TuxGuitar** (helge17/tuxguitar): a full editor in Java, LGPL. A reference for editing logic and GP5 writing.
- **PyGuitarPro:** reads and writes GP3/4/5 in Python, ideal for the AI service.
- **MuseScore 4:** C++/Qt, GPL. A model for engraving and sound.
- **music21**, **Basic Pitch**, **Anticipatory Music Transformer**, **AccoMontage**.

Licenses: taking GPL code (MuseScore) would force our own product to be GPL as well. alphaTab's MPL-2.0 license is more permissive than that.

## Sources

- [Guitar Pro – Wikipedia](https://en.wikipedia.org/wiki/Guitar_Pro)
- [Macintosh Garden – Guitar Pro 5](https://macintoshgarden.org/apps/guitar-pro-5)
- [Audiofanzine – Guitar Pro 5](https://en.audiofanzine.com/tablature-editor/arobas-music/Guitar-Pro-5/)
- [GP 5.2 + RSE sound banks](http://marcelo93.blogspot.com/2008/06/guitar-pro-52-rse_26.html)
- [Guitar Pro 5.0 – Internet Archive](https://archive.org/details/gp5_20210423)
- [TuxGuitar – Wikipedia](https://en.wikipedia.org/wiki/TuxGuitar)
- [TuxGuitar releases](https://github.com/helge17/tuxguitar/releases)
- [ChatMusician (arXiv)](https://arxiv.org/abs/2402.16153)
- [AccoMontage2 (arXiv)](https://arxiv.org/pdf/2209.00353)
- [MIDI-based vocal accompaniment generation (arXiv)](https://arxiv.org/html/2602.22029v1)
- [Real-time accompaniment generation (Springer)](https://link.springer.com/chapter/10.1007/978-3-032-05748-8_44)
- [Songscription: sheet music from humming](https://www.songscription.ai/blog/hum-to-sheet-music)
- [YuE2](https://yue2ai.app/)
- [List of music generation demos](https://github.com/affige/genmusic_demo_list)
