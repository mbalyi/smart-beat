# Research: tab formats, drum kits, effects and heavy-genre tones

Background research for the roadmap items on file formats, importable drum kits, user-supplied effects and heavy-genre presets. Licence rules from [licensing.md](licensing.md) and `CLAUDE.md` apply: no code from MuseScore, TuxGuitar or PyGuitarPro, no models or assets with non-commercial licences. Reading a file format from its public documentation is fine; copying a GPL implementation is not.

## 1. Tab and score file formats

Smart Beat already opens GP3/4/5, GPX and GP7 through alphaTab (issue #4). alphaTab's own list is: Guitar Pro 3-5, Guitar Pro 6 (`.gpx`), Guitar Pro 7/8 (`.gp`), MusicXML, CapXML, plus its own text format alphaTex ([alphaTab docs](https://www.alphatab.net/docs/introduction/)).

| Format | Ext | Origin | Read | Write | Priority | Notes |
|---|---|---|---|---|---|---|
| Guitar Pro 3/4/5 | `.gp3 .gp4 .gp5` | Arobas | done | planned (#15) | must | Binary, reverse-engineered; GP5 is the interchange standard |
| Guitar Pro 6 | `.gpx` | Arobas | done | no | must | Read-only is enough; GPX has a custom container |
| Guitar Pro 7/8 | `.gp` | Arobas | done | planned | must | Zip + XML. Write support is needed to avoid lossy GP5 round-trips |
| Guitar Pro 1/2 | `.gtp` | Arobas | no | no | low | GP8 still imports it; very old files |
| MusicXML | `.musicxml .xml .mxl` | W3C/MakeMusic | alphaTab | planned (#16) | must | Open standard, exchange with MuseScore, Finale, Sibelius, Dorico; `.mxl` is zipped |
| MIDI | `.mid .midi` | MMA | planned (#16) | planned (#16) | must | No tab info; guitar string assignment needs the fingering optimiser (#23) |
| Power Tab | `.ptb` (v1.7), `.pt2` | Power Tab Editor | no | no | high | Huge legacy library of free tabs. Format is documented by the community; write a clean-room reader |
| TuxGuitar | `.tg` | TuxGuitar | no | no | medium | Native format of the free editor; TuxGuitar itself reads/writes GP3-5 too |
| TablEdit | `.tef` | TablEdit | no | no | medium | Popular for banjo, mandolin, fingerstyle; GP8 imports and exports it |
| ASCII tab | `.txt` | de facto | no | no | high | What Ultimate Guitar and forums use; import needs a heuristic parser, export is easy |
| alphaTex | `.atex` | alphaTab | via alphaTab | via alphaTab | medium | Text-based score language, great for tests and diffable scores |
| CapXML | `.cap` | Capella | alphaTab | no | low | Supported by alphaTab already |
| MuseScore | `.mscz .mscx` | MuseScore | no | no | medium | `.mscz` is a zip with XML. Read the format only, **do not copy MuseScore code** (GPL). MusicXML already covers most cases |
| ChordPro | `.cho .chordpro` | community | no | no | low | Lyrics + chords sheets, no tab |
| Rocksmith | `.psarc` | Ubisoft | no | no | skip | Encrypted; legal risk |
| Clone Hero / Guitar Hero charts | `.chart`, `.mid` | community | no | no | skip | Game charts, not notation |
| Songsterr / UG Pro | web only | - | no | no | skip | Not files |
| Kontakt/DAW projects | - | - | no | no | skip | Out of scope |

Recommended order: MusicXML + MIDI (#16), GP7 write, Power Tab read, ASCII tab import/export, TablEdit read, TuxGuitar read, MuseScore read. Every importer must degrade gracefully (unknown effects become plain notes plus a warning list shown to the user) and every one needs a synthetic fixture in `e2e/fixtures` (never a user's song).

Sources: [alphaTab: Guitar Pro 3-5](https://alphatab.net/docs/formats/guitar-pro-3-5), [Guitar Pro 6](https://alphatab.net/docs/formats/guitar-pro-6), [Guitar Pro 7](https://alphatab.net/docs/formats/guitar-pro-7), [TuxGuitar file formats](https://www.tuxguitar.app/files/devel/desktop/help/file_formats.html), [TablEdit formats](https://tabledit.com/help/english/filemenu.shtml), [Guitar Pro features](https://www.guitar-pro.com/c/14-guitar-pro-features).

## 2. Free drum kits users can import

Goal: let users drop a kit into Smart Beat and assign it to a drum track, instead of only using the bundled SoundFont. Sampled kits come as SFZ (text mapping + FLAC/WAV samples) or SF2/SF3. Multi-mic, multi-velocity kits are large (hundreds of MB to GB) so they must be imported by the user, not bundled.

| Kit | Licence | Size | Character | Metal suitability |
|---|---|---|---|---|
| [Muldjord Kit](https://github.com/sfzinstruments/DrumGizmo.MuldjordKit/) (DrumGizmo, SFZ mapping) | CC-BY-4.0 | 347 MB | Tama Superstar, 2 kicks, 3 hanging toms + floor tom, 2 crashes, 2 rides, china | Explicitly a rock/metal-style layout, double-kick friendly |
| [DRS Kit](https://sfzinstruments.github.io/drums/) | CC-BY-4.0 | 754 MB | General purpose | Good tight modern kit |
| [Naked Drums](https://sfzinstruments.github.io/drums/) | CC-BY-4.0 | 1.3 GB | Multi-mic, up to 5 velocity layers, 10 round robins | Very good, needs mixing |
| [SM Drums](https://sfzinstruments.github.io/drums/sm_drums/) | Public domain | 2.2 GB | 127 velocity layers, 4 round robins | Excellent for triggering / layering |
| Salamander Drumkit | CC-BY-SA-3.0 | ~370 MB | General | Share-alike: **check before bundling** |
| Sam's Sonor | CC-BY-SA-4.0 | n/a | Sonor Force | Share-alike |
| Big Rusty, Swirly, Unruly, Frankensnare | CC0 | 1.6-2.3 GB | Vintage / punk / experimental | Layers for character, not core kit |
| Freepats banks | mostly CC | small | SF2 GM drums | Lightweight fallback |

Requirements for the importer:
- Parse SFZ (regions, `key`/`lokey`/`hikey`, `lovel`/`hivel`, `seq_length`/`seq_position` round robin, `group`/`off_by` for hi-hat choke, `sample`), SF2 and SF3.
- Map kit pieces to the GP drum element list (kick, snare, hats with closed/half/open/pedal, 5 toms, 2 crashes, ride edge/bell, china, splash) so the **drum mixer** (per element volume/pan) works with imported kits.
- Store kits in the app data directory with the licence text and attribution; show attribution in the licences dialog for CC-BY kits.
- Reject or warn on non-commercial licences (project rule).
- Streaming or lazy loading of samples so a 2 GB kit does not stall startup.
- Sources of truth for kits: the [SFZ Instruments](https://sfzinstruments.github.io/drums/) catalogue and DrumGizmo kits.

## 3. User-supplied guitar pedals, amps and effects

What advanced users already own and what exists as open formats:

| Kind | Format | Licence / notes |
|---|---|---|
| Amp captures | Neural Amp Modeler `.nam` | [NAM](https://github.com/sdatkinson/neural-amp-modeler) and NeuralAmpModelerCore are MIT. Thousands of community captures on [TONE3000](https://www.tone3000.com/) (check each capture's licence) |
| Cabinet simulation | Impulse response `.wav` (mono, 24-bit, 44.1/48 kHz) | Free packs exist (Seacow Cabs, Wilkinson "God's Cab", Catharsis "Fredman Pack" per [Nail The Mix](https://www.nailthemix.com/best-free-amp-sims)); user-supplied only, do not redistribute |
| Pedal captures | `.nam` (pedal/overdrive captures) | Same as amps |
| Plugins | VST3, CLAP, LV2, AU | VST3 SDK is now MIT-licensed; CLAP is MIT; hosting third-party binaries in-process is a stability and sandbox risk |
| Freeware amp sims (cannot bundle, users install themselves) | VST/AU | STL Tones Ignite Emissary, ML Sound Lab Amped Roots Free, Nembrini Crunck V2 |

Proposed approach, in order of value and risk:
1. **Built-in effect DSP** in Rust (noise gate, compressor, 10-band EQ, tube-screamer style overdrive, delay, reverb, chorus, phaser, tremolo) with the GP8 pedalboard UI. No third-party code needed.
2. **User-importable assets**: NAM models + cabinet IRs (WAV) dropped into a user library, usable as "Amp" and "Cab" blocks in the chain. Small, safe, no native code from strangers.
3. **Plugin hosting** (VST3/CLAP) later as an opt-in, out-of-process feature.

## 4. Heavy-genre tone building blocks (nu-metal, metalcore, hardcore, deathcore, djent)

Common signal chain for modern heavy tones ([sevenstring.org djent guide](https://sevenstring.org/threads/guide-to-djent-tone-updated-march-7-13.219326/), [Reverb: modern amps for djent](https://reverb.com/news/5-modern-tube-amps-to-achieve-djent-tones)):

`Noise gate -> Compressor (optional) -> Tube-screamer style boost (drive low, level high, tightens the low end) -> High-gain amp -> Cab IR -> EQ (mid-heavy, bass low for low tunings) -> Noise gate (post) -> Limiter/mastering`

| Genre | Tuning / instruments | Amp voicing | Effects and mix |
|---|---|---|---|
| **Nu-metal** | Drop C/B, 7-string common | Mesa Rectifier-style scooped-mid crunch, clanky bass, lots of low end | Wah, auto-wah, DJ-style delays, plain compressor; bass loud and clanky; snare tuned high |
| **Metalcore** | Drop C to drop A#, 6-7 strings | 5150 / Recto / Diezel style, tight and bright; boosted with TS | Gate, TS boost, delay + reverb on cleans/leads, clean arpeggio tracks with chorus; bass DI plus amp |
| **Hardcore** | Drop D to drop C, often single guitar-forward | Marshall / Peavey style crunch, less gain | Little processing, room reverb, fast attack drums |
| **Deathcore** | Drop A to drop F#, 7-8 strings | Ultra-tight 5150 / Recto style, mids scooped less than in nu-metal | Very heavy gating, EQ high-pass at 80-100 Hz, 10-band EQ, triggered kicks, pinch harmonics, breakdown slides |
| **Djent** | 7-9 strings, extended range (down to F# / drop E on 8 strings) | 5150III / 6505+ / Axe-FX Bogner style, gain around 7.5 median, bass 2-3, mids 8-10 | Gating to cut sustain exactly (palm-mute chugs), compressor, TS boost, polymetric riffs (odd meters, polyrhythms), synth pads and ambient clean layers, sub-heavy kick, mono low end |

Median djent settings across 104 collected tones: gain 7.5 (2.5-9.5), bass 6, mid 5, treble 6 (0-10 scale); for low tunings set bass 2-3 and mids 8-10 instead ([musicsculpt](https://musicsculpt.com/how-to-get-a-djent-tone/), [tonemirror](https://www.tonemirror.so/genres/djent)).

### What this means for the editor and player

- **Extended range instruments**: 7-, 8- and 9-string guitars and 5/6-string basses in the track dialog, with tuning presets (drop C, drop A, drop F#, F# standard 8 string, etc.). GP8 supports 3-10 strings.
- **Tight rhythm**: palm-mute-heavy playback (already alphaTab-supported), gate + palm mute sample layers, tremolo-picking, sub-16th chug patterns and tempo automation.
- **Polymeter and polyrhythm**: odd time signatures, nested tuplets, per-track alternate time (djent staple); at minimum, display and correct playback for 5/8, 7/8, 11/16 etc.
- **Drums**: double-kick friendly kit, blast beats, China cymbals, kick/snare triggering samples, per-element mixer, drum compressor (parallel).
- **Presets** shipped with the pedalboard: "Nu-metal crunch", "Metalcore tight", "Deathcore chug", "Djent 8-string", "Hardcore crunch", "Ambient clean layer", plus matching drum-mix presets and mastering chain (compressor/limiter, 10-band EQ).
- **Sample libraries and amp models**: only assets with commercial-use-compatible licences (CC0, CC-BY, MIT, public domain). Freeware-but-proprietary tones (Ignite Emissary and similar) must stay user-installed.
