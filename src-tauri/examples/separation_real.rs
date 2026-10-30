//! Stem separation on real songs, with reference-free proxy numbers (issue #186).
//!
//! There is no ground truth for a real recording, so this prints what can be measured without
//! one:
//!
//! 1. timing, real-time factor and peak resident memory per song;
//! 2. per-stem energy share of the mix and the stems-sum-to-mix check (SDR);
//! 3. with a Guitar Pro file: the track list (name, MIDI program, kind, note count) as the
//!    instrument ground truth, and how well the onset envelope of every stem agrees with the
//!    onsets of the tab's drum track (see `Agreement` below for what that does and does not show);
//! 4. the output of `separation::detect::detect`, next to the tab's track list.
//!
//! ```sh
//! cargo run --release --example separation_real --manifest-path src-tauri/Cargo.toml -- \
//!     "song.mp3" "song.gp" "other.mp3" "other.gp"
//! ```
//!
//! Every audio argument may be followed by one `.gp` file. Only numbers and track names are
//! printed; no audio is written anywhere.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use smart_beat_lib::audio::backing::{DecodedAudio, decode};
use smart_beat_lib::separation::detect::detect;
use smart_beat_lib::separation::metrics::{energy, sdr_db};
use smart_beat_lib::separation::stft::{BINS, HOP, Stft};
use smart_beat_lib::separation::{MemorySink, Options, StemKind, separate};

// ---------------------------------------------------------------------------------------------
// Peak resident memory
// ---------------------------------------------------------------------------------------------

/// Samples the resident set size of this process (`ps -o rss=`, in KiB) in a thread and keeps
/// the maximum. Cheap enough at 10 Hz; short spikes between samples can be missed.
struct RssSampler {
    max_kib: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

fn rss_kib() -> Option<u64> {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

impl RssSampler {
    fn start() -> Self {
        let max_kib = Arc::new(AtomicU64::new(rss_kib().unwrap_or(0)));
        let stop = Arc::new(AtomicBool::new(false));
        let (m, s) = (max_kib.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                if let Some(k) = rss_kib() {
                    m.fetch_max(k, Ordering::Relaxed);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        Self {
            max_kib,
            stop,
            handle: Some(handle),
        }
    }

    /// Stops and returns the peak in MiB.
    fn finish(mut self) -> f64 {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        self.max_kib.load(Ordering::Relaxed) as f64 / 1024.0
    }
}

// ---------------------------------------------------------------------------------------------
// A tiny XML reader (no crate): enough for the score.gpif of Guitar Pro 7 and later
// ---------------------------------------------------------------------------------------------

#[derive(Default, Debug)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    kids: Vec<Node>,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.kids.iter().find(|k| k.name == name)
    }
    fn children<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.kids.iter().filter(move |k| k.name == name)
    }
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    fn id(&self) -> Option<usize> {
        self.attr("id")?.parse().ok()
    }
    fn text_of(&self, name: &str) -> Option<&str> {
        self.child(name).map(|c| c.text.trim())
    }
    /// A list of whitespace separated integers (`-1` is kept).
    fn ints(&self) -> Vec<i64> {
        self.text
            .split_whitespace()
            .filter_map(|t| t.parse().ok())
            .collect()
    }
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn parse_xml(src: &str) -> Result<Node, String> {
    let b = src.as_bytes();
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'<' {
            let end = src[i..].find('<').map_or(b.len(), |p| i + p);
            let top = stack.last_mut().unwrap();
            top.text.push_str(&unescape(&src[i..end]));
            i = end;
            continue;
        }
        let rest = &src[i..];
        if rest.starts_with("<![CDATA[") {
            let end = rest.find("]]>").ok_or("unterminated CDATA")?;
            stack.last_mut().unwrap().text.push_str(&rest[9..end]);
            i += end + 3;
        } else if rest.starts_with("<!--") {
            i += rest.find("-->").ok_or("unterminated comment")? + 3;
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            i += rest.find('>').ok_or("unterminated declaration")? + 1;
        } else if rest.starts_with("</") {
            let end = rest.find('>').ok_or("unterminated close tag")?;
            i += end + 1;
            if stack.len() < 2 {
                return Err("unbalanced close tag".into());
            }
            let done = stack.pop().unwrap();
            stack.last_mut().unwrap().kids.push(done);
        } else {
            // Open tag: find the closing '>' outside quotes.
            let tb = rest.as_bytes();
            let (mut j, mut quote) = (1, 0u8);
            while j < tb.len() {
                let c = tb[j];
                if quote != 0 {
                    if c == quote {
                        quote = 0;
                    }
                } else if c == b'"' || c == b'\'' {
                    quote = c;
                } else if c == b'>' {
                    break;
                }
                j += 1;
            }
            if j >= tb.len() {
                return Err("unterminated tag".into());
            }
            let mut inner = &rest[1..j];
            let self_closing = inner.ends_with('/');
            if self_closing {
                inner = &inner[..inner.len() - 1];
            }
            let name_end = inner
                .find(|c: char| c.is_whitespace())
                .unwrap_or(inner.len());
            let mut node = Node {
                name: inner[..name_end].to_string(),
                ..Node::default()
            };
            let mut attrs = &inner[name_end..];
            loop {
                attrs = attrs.trim_start();
                let Some(eq) = attrs.find('=') else { break };
                let key = attrs[..eq].trim().to_string();
                let after = attrs[eq + 1..].trim_start();
                let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else {
                    break;
                };
                let Some(close) = after[1..].find(q) else {
                    break;
                };
                node.attrs.push((key, unescape(&after[1..1 + close])));
                attrs = &after[close + 2..];
            }
            i += j + 1;
            if self_closing {
                stack.last_mut().unwrap().kids.push(node);
            } else {
                stack.push(node);
            }
        }
    }
    if stack.len() != 1 {
        return Err("unclosed tags".into());
    }
    let root = stack.pop().unwrap();
    root.kids
        .into_iter()
        .find(|k| k.name == "GPIF")
        .ok_or_else(|| "no <GPIF> root".to_string())
}

// ---------------------------------------------------------------------------------------------
// The tab: tracks, tempo, and onset times
// ---------------------------------------------------------------------------------------------

struct TrackInfo {
    name: String,
    program: Option<u32>,
    kind: String,
    is_drum: bool,
    notes: usize,
    /// Onsets in quarter notes from the start of the song (rests, tied continuations and
    /// simultaneous notes of one beat do not count; voices are merged).
    onsets_q: Vec<f64>,
}

struct Tab {
    tracks: Vec<TrackInfo>,
    /// (position in quarter notes, quarter notes per minute), sorted.
    tempo: Vec<(f64, f64)>,
    bars: usize,
}

impl Tab {
    fn seconds(&self, q: f64) -> f64 {
        let mut t = 0.0;
        let (mut last_q, mut bpm) = (0.0, self.tempo.first().map_or(120.0, |x| x.1));
        for &(tq, b) in &self.tempo {
            if tq >= q {
                break;
            }
            t += (tq - last_q) * 60.0 / bpm;
            last_q = tq;
            bpm = b;
        }
        t + (q - last_q) * 60.0 / bpm
    }
}

fn note_value_quarters(v: &str) -> f64 {
    match v {
        "Whole" => 4.0,
        "Half" => 2.0,
        "Quarter" => 1.0,
        "Eighth" => 0.5,
        "16th" => 0.25,
        "32nd" => 0.125,
        "64th" => 0.0625,
        "128th" => 0.03125,
        _ => 1.0,
    }
}

fn rhythm_quarters(r: &Node) -> f64 {
    let mut q = note_value_quarters(r.text_of("NoteValue").unwrap_or("Quarter"));
    if let Some(d) = r.child("AugmentationDot") {
        let n: i32 = d.attr("count").and_then(|c| c.parse().ok()).unwrap_or(1);
        q *= 2.0 - 0.5f64.powi(n);
    }
    if let Some(t) = r.child("PrimaryTuplet") {
        let num: f64 = t.attr("num").and_then(|c| c.parse().ok()).unwrap_or(1.0);
        let den: f64 = t.attr("den").and_then(|c| c.parse().ok()).unwrap_or(1.0);
        if num > 0.0 {
            q *= den / num;
        }
    }
    q
}

fn index_by_id(parent: Option<&Node>) -> std::collections::HashMap<usize, &Node> {
    parent
        .map(|p| {
            p.kids
                .iter()
                .filter_map(|k| k.id().map(|i| (i, k)))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_tab(xml: &str) -> Result<Tab, String> {
    let gpif = parse_xml(xml)?;
    let master_bars = gpif.child("MasterBars").ok_or("no MasterBars")?;
    let bars = index_by_id(gpif.child("Bars"));
    let voices = index_by_id(gpif.child("Voices"));
    let beats = index_by_id(gpif.child("Beats"));
    let notes = index_by_id(gpif.child("Notes"));
    let rhythms = index_by_id(gpif.child("Rhythms"));

    // Bar lengths and starts, in quarter notes.
    let mut bar_start = Vec::new();
    let mut at = 0.0;
    for mb in &master_bars.kids {
        bar_start.push(at);
        let time = mb.text_of("Time").unwrap_or("4/4");
        let (n, d) = time.split_once('/').unwrap_or(("4", "4"));
        let n: f64 = n.parse().unwrap_or(4.0);
        let d: f64 = d.parse().unwrap_or(4.0);
        at += n * 4.0 / d.max(1.0);
    }
    let bar_len = |m: usize| bar_start.get(m + 1).copied().unwrap_or(at) - bar_start[m];

    // Tempo automations: Value is "<bpm> <unit>", unit 1 = eighth, 2 = quarter, 3 = dotted
    // quarter, 4 = half, 5 = dotted half. Position is the fraction of the bar.
    let mut tempo: Vec<(f64, f64)> = Vec::new();
    if let Some(autos) = gpif
        .child("MasterTrack")
        .and_then(|m| m.child("Automations"))
    {
        for a in autos.children("Automation") {
            if a.text_of("Type") != Some("Tempo") {
                continue;
            }
            let bar: usize = a.text_of("Bar").and_then(|v| v.parse().ok()).unwrap_or(0);
            let pos: f64 = a
                .text_of("Position")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0);
            let mut it = a.text_of("Value").unwrap_or("120 2").split_whitespace();
            let bpm: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(120.0);
            let unit: u32 = it.next().and_then(|v| v.parse().ok()).unwrap_or(2);
            let per_quarter = match unit {
                1 => 0.5,
                3 => 1.5,
                4 => 2.0,
                5 => 3.0,
                _ => 1.0,
            };
            if bar < bar_start.len() {
                tempo.push((bar_start[bar] + pos * bar_len(bar), bpm * per_quarter));
            }
        }
    }
    tempo.sort_by(|a, b| a.0.total_cmp(&b.0));
    if tempo.is_empty() {
        tempo.push((0.0, 120.0));
    }

    let mut tracks = Vec::new();
    let track_nodes = gpif.child("Tracks").ok_or("no Tracks")?;
    for (pos, t) in track_nodes.children("Track").enumerate() {
        let name = t.text_of("Name").unwrap_or("?").to_string();
        let kind = t
            .child("InstrumentSet")
            .and_then(|s| s.text_of("Type"))
            .unwrap_or("?")
            .to_string();
        let program = t
            .child("Sounds")
            .and_then(|s| s.child("Sound"))
            .and_then(|s| s.child("MIDI"))
            .and_then(|m| m.text_of("Program"))
            .and_then(|p| p.parse().ok());
        let is_drum = kind == "drumKit";
        let mut onsets_q = Vec::new();
        let mut note_count = 0usize;
        for (m, mb) in master_bars.kids.iter().enumerate() {
            let ids = mb.child("Bars").map(|b| b.ints()).unwrap_or_default();
            let Some(&bar_id) = ids.get(pos) else {
                continue;
            };
            if bar_id < 0 {
                continue;
            }
            let Some(bar) = bars.get(&(bar_id as usize)) else {
                continue;
            };
            let voice_ids = bar.child("Voices").map(|v| v.ints()).unwrap_or_default();
            for v in voice_ids.into_iter().filter(|v| *v >= 0) {
                let Some(voice) = voices.get(&(v as usize)) else {
                    continue;
                };
                let mut cursor = 0.0;
                let beat_ids = voice.child("Beats").map(|b| b.ints()).unwrap_or_default();
                for bid in beat_ids.into_iter().filter(|b| *b >= 0) {
                    let Some(beat) = beats.get(&(bid as usize)) else {
                        continue;
                    };
                    let rhythm_ref = beat
                        .child("Rhythm")
                        .and_then(|r| r.attr("ref"))
                        .and_then(|r| r.parse::<usize>().ok());
                    let dur = rhythm_ref
                        .and_then(|r| rhythms.get(&r))
                        .map_or(1.0, |r| rhythm_quarters(r));
                    let is_grace = beat.child("GraceNotes").is_some();
                    let note_ids = beat.child("Notes").map(|n| n.ints()).unwrap_or_default();
                    let mut struck = false;
                    for nid in note_ids {
                        let Some(note) = notes.get(&(nid as usize)) else {
                            continue;
                        };
                        note_count += 1;
                        let tied = note
                            .child("Tie")
                            .is_some_and(|t| t.attr("destination") == Some("true"));
                        if !tied {
                            struck = true;
                        }
                    }
                    if struck && !is_grace {
                        onsets_q.push(bar_start[m] + cursor);
                    }
                    if !is_grace {
                        cursor += dur;
                    }
                }
            }
        }
        onsets_q.sort_by(|a, b| a.total_cmp(b));
        onsets_q.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        tracks.push(TrackInfo {
            name,
            program,
            kind,
            is_drum,
            notes: note_count,
            onsets_q,
        });
    }
    Ok(Tab {
        tracks,
        tempo,
        bars: master_bars.kids.len(),
    })
}

fn read_gpif(path: &Path) -> Result<String, String> {
    // The `zip` crate is a dependency of the app, but shelling out keeps this example small.
    let out = Command::new("unzip")
        .args(["-p"])
        .arg(path)
        .arg("Content/score.gpif")
        .output()
        .map_err(|e| format!("cannot run unzip: {e}"))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err("no Content/score.gpif in the file (not a Guitar Pro 7+ file?)".into());
    }
    String::from_utf8(out.stdout).map_err(|e| format!("score.gpif is not UTF-8: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Agreement of a stem's onset envelope with the tab's drum onsets
// ---------------------------------------------------------------------------------------------
//
// What this is: for every stem, the log-compressed spectral flux (an onset strength envelope)
// is compared with the times at which the tab's drum track strikes a note. The tab is placed on
// the recording by a search over a start offset and a small tempo scale (the recording is not
// guaranteed to start at the tab's bar 1 or to play at exactly the tab's tempo).
//
// "lift" is the mean of the (locally de-trended, max-filtered) envelope at the tab's onsets
// divided by its mean over all frames: 1 means no relation, larger means the envelope peaks
// where the tab says drums are hit. "median" is the lift over all searched offsets at the best
// tempo scale, i.e. the null level for that stem; best/median is the contrast.
// P / R / F1 compare peak-picked envelope onsets (local maxima above mean + 1 std) with the
// tab onsets inside a 50 ms tolerance, only over the span the tab covers.
//
// What it cannot show: how clean the drum stem sounds, whether other instruments leaked into
// it (guitar palm mutes also produce onsets at the same beats), or how much of the drums is
// left in the other stems. It also trusts the transcription: a tab that is a rough sketch, or
// a recording that is not on a click, lowers the numbers for every stem alike.

const FRAME_TOL_S: f64 = 0.050;

struct Envelope {
    /// Locally de-trended onset strength, one value per STFT hop.
    flat: Vec<f32>,
    /// Max-filtered over +-1 frame.
    max1: Vec<f32>,
    mean_max1: f64,
    mean: f64,
    std: f64,
}

fn onset_envelope(stft: &Stft, left: &[f32], right: &[f32]) -> Envelope {
    let mono: Vec<f32> = left.iter().zip(right).map(|(l, r)| 0.5 * (l + r)).collect();
    let spec = stft.analyse(&mono);
    drop(mono);
    let frames = spec.frames();
    let mut flux = vec![0.0f32; frames];
    let mut prev = vec![0.0f32; BINS];
    for (t, f) in flux.iter_mut().enumerate() {
        let row = &spec.data[t * BINS..(t + 1) * BINS];
        let mut sum = 0.0f32;
        for (p, c) in prev.iter_mut().zip(row) {
            let v = c.norm().ln_1p();
            if t > 0 {
                sum += (v - *p).max(0.0);
            }
            *p = v;
        }
        *f = sum;
    }
    drop(spec);
    // Subtract a moving average of +-0.25 s, clip at zero.
    let half = ((0.25 * 44_100.0) / HOP as f64).round() as usize;
    let mut prefix = vec![0.0f64; frames + 1];
    for (i, v) in flux.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *v as f64;
    }
    let flat: Vec<f32> = (0..frames)
        .map(|i| {
            let (a, b) = (i.saturating_sub(half), (i + half + 1).min(frames));
            let avg = (prefix[b] - prefix[a]) / (b - a) as f64;
            (flux[i] as f64 - avg).max(0.0) as f32
        })
        .collect();
    let max1: Vec<f32> = (0..frames)
        .map(|i| {
            let (a, b) = (i.saturating_sub(1), (i + 2).min(frames));
            flat[a..b].iter().cloned().fold(0.0, f32::max)
        })
        .collect();
    let n = frames.max(1) as f64;
    let mean = flat.iter().map(|&v| v as f64).sum::<f64>() / n;
    let var = flat.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n;
    let mean_max1 = max1.iter().map(|&v| v as f64).sum::<f64>() / n;
    Envelope {
        flat,
        max1,
        mean_max1,
        mean,
        std: var.sqrt(),
    }
}

/// Lift of `env` at tab times mapped to the audio by `offset + scale * t`.
fn lift(env: &Envelope, tab_s: &[f64], offset: f64, scale: f64, hop_s: f64) -> f64 {
    if env.mean_max1 <= 0.0 {
        return 0.0;
    }
    let (mut sum, mut n) = (0.0f64, 0usize);
    for &t in tab_s {
        let idx = ((offset + scale * t) / hop_s).round();
        if idx >= 0.0 && (idx as usize) < env.max1.len() {
            sum += env.max1[idx as usize] as f64;
            n += 1;
        }
    }
    // Hypotheses that push most of the tab outside the recording do not count.
    if n * 2 < tab_s.len() {
        return 0.0;
    }
    sum / n as f64 / env.mean_max1
}

struct Placement {
    offset: f64,
    scale: f64,
    best: f64,
    median: f64,
}

/// Searches offsets in [-5 s, +20 s] and tempo scales in +-4 %.
fn place(env: &Envelope, tab_s: &[f64], hop_s: f64) -> Placement {
    let lo = (-5.0 / hop_s) as i64;
    let hi = (20.0 / hop_s) as i64;
    let mut best = (0.0f64, 0.0f64, 1.0f64);
    let mut best_scale_lifts: Vec<f64> = Vec::new();
    for k in -16..=16 {
        let scale = 1.0 + k as f64 * 0.0025;
        let lifts: Vec<f64> = (lo..=hi)
            .map(|o| lift(env, tab_s, o as f64 * hop_s, scale, hop_s))
            .collect();
        let (bi, bv) = lifts
            .iter()
            .enumerate()
            .fold((0, 0.0), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
        if bv > best.0 {
            best = (bv, (lo + bi as i64) as f64 * hop_s, scale);
            best_scale_lifts = lifts;
        }
    }
    best_scale_lifts.sort_by(|a, b| a.total_cmp(b));
    let median = best_scale_lifts
        .get(best_scale_lifts.len() / 2)
        .copied()
        .unwrap_or(0.0);
    Placement {
        offset: best.1,
        scale: best.2,
        best: best.0,
        median,
    }
}

fn pick_peaks(env: &Envelope, hop_s: f64) -> Vec<f64> {
    let thr = (env.mean + env.std) as f32;
    let n = env.flat.len();
    let r = 3usize;
    let mut out = Vec::new();
    for i in 0..n {
        let v = env.flat[i];
        if v <= thr {
            continue;
        }
        let (a, b) = (i.saturating_sub(r), (i + r + 1).min(n));
        if env.flat[a..b].iter().all(|&w| w <= v) {
            out.push(i as f64 * hop_s);
        }
    }
    out
}

/// Greedy matching of two sorted time lists within the tolerance; returns the matched count.
fn matches(a: &[f64], b: &[f64], tol: f64) -> usize {
    let (mut i, mut j, mut m) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        let d = a[i] - b[j];
        if d.abs() <= tol {
            m += 1;
            i += 1;
            j += 1;
        } else if d < 0.0 {
            i += 1;
        } else {
            j += 1;
        }
    }
    m
}

/// (precision, recall, F1, detected count, tab count) in the audio time window `[from, to)`.
fn prf(detected: &[f64], tab_audio: &[f64], from: f64, to: f64) -> (f64, f64, f64, usize, usize) {
    let d: Vec<f64> = detected
        .iter()
        .cloned()
        .filter(|t| *t >= from && *t < to)
        .collect();
    let r: Vec<f64> = tab_audio
        .iter()
        .cloned()
        .filter(|t| *t >= from && *t < to)
        .collect();
    let m = matches(&d, &r, FRAME_TOL_S) as f64;
    let p = if d.is_empty() {
        0.0
    } else {
        m / d.len() as f64
    };
    let rec = if r.is_empty() {
        0.0
    } else {
        m / r.len() as f64
    };
    let f1 = if p + rec > 0.0 {
        2.0 * p * rec / (p + rec)
    } else {
        0.0
    };
    (p, rec, f1, d.len(), r.len())
}

// ---------------------------------------------------------------------------------------------
// One song
// ---------------------------------------------------------------------------------------------

fn db(x: f64) -> f64 {
    10.0 * (x.max(1e-20)).log10()
}

fn print_detection(v: &serde_json::Value) {
    let Some(obj) = v.as_object() else { return };
    for (k, val) in obj {
        match val.as_object() {
            Some(o) if o.contains_key("present") => {
                let ev = o
                    .get("evidence")
                    .and_then(|e| e.as_object())
                    .map(|e| {
                        e.iter()
                            .map(|(n, x)| format!("{n}={:.3}", x.as_f64().unwrap_or(f64::NAN)))
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default();
                println!(
                    "  {:<16} present={:<5} confidence={:.2}  {}",
                    k,
                    o["present"].as_bool().unwrap_or(false),
                    o["confidence"].as_f64().unwrap_or(0.0),
                    ev
                );
            }
            Some(o) => {
                let ev: Vec<String> = o.iter().map(|(n, x)| format!("{n}={x}")).collect();
                println!("  {:<16} {}", k, ev.join(" "));
            }
            None => println!("  {:<16} {}", k, val),
        }
    }
}

fn run_song(audio_path: &Path, gp_path: Option<&Path>) -> Result<(), String> {
    let title = audio_path
        .file_stem()
        .map(|s| s.to_string_lossy().trim().to_string())
        .unwrap_or_default();
    println!("\n==============================================================================");
    println!("SONG  {title}");
    println!("==============================================================================");

    let bytes = std::fs::read(audio_path).map_err(|e| format!("cannot read audio: {e}"))?;
    let ext = audio_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase());
    let sampler = RssSampler::start();
    let t0 = Instant::now();
    let audio: DecodedAudio = decode(bytes, ext.as_deref())?;
    let decode_s = t0.elapsed().as_secs_f64();
    let dur = audio.duration();
    println!(
        "audio: {:.1} s, {} Hz, {} channel(s) in file; decode {:.2} s",
        dur, audio.rate, audio.channels, decode_s
    );

    let opts = Options::default();
    let mut sink = MemorySink::default();
    let cancel = AtomicBool::new(false);
    let t1 = Instant::now();
    let report = separate(&audio, &opts, &mut sink, &cancel, &mut |_| {})?;
    let sep_s = t1.elapsed().as_secs_f64();
    let peak_mib = sampler.finish();
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());

    println!("\n[1] timing and memory");
    println!(
        "  separate: {:.2} s for {:.1} s of audio -> real-time factor {:.3} ({:.1}x faster than real time), {} cores",
        sep_s,
        dur,
        sep_s / dur,
        dur / sep_s,
        threads
    );
    println!(
        "  peak resident memory (sampled at 10 Hz, includes the decoded song and all stems in memory): {:.0} MiB",
        peak_mib
    );
    println!(
        "  report: mono={} skipped={:?} panned_share={:.3}",
        report.mono, report.skipped, report.panned_share
    );

    // Energy shares and sum check.
    println!("\n[2] stems against the mix");
    let mix_e = energy(&audio.left) + energy(&audio.right);
    println!(
        "  {:<8} {:>12} {:>14}",
        "stem", "energy share", "level (dB re mix)"
    );
    let mut share_sum = 0.0;
    let n = audio.frames();
    let mut sum_l = vec![0.0f32; n];
    let mut sum_r = vec![0.0f32; n];
    for kind in StemKind::ALL {
        let Some((l, r)) = sink.stems.get(&kind) else {
            println!("  {:<8} {:>12}", kind.id(), "not made");
            continue;
        };
        let e = energy(l) + energy(r);
        let share = if mix_e > 0.0 { e / mix_e } else { 0.0 };
        share_sum += share;
        println!(
            "  {:<8} {:>11.1}% {:>14.1}",
            kind.id(),
            share * 100.0,
            db(share)
        );
        for (s, v) in sum_l.iter_mut().zip(l) {
            *s += v;
        }
        for (s, v) in sum_r.iter_mut().zip(r) {
            *s += v;
        }
    }
    println!(
        "  (shares add to {:.1}%; they need not be 100 % because stems are correlated)",
        share_sum * 100.0
    );
    let sdr = sdr_db(&audio.left, &sum_l).min(sdr_db(&audio.right, &sum_r));
    println!(
        "  stems sum to mix: SDR {:.1} dB (worst channel; > 60 dB = exact up to float rounding)",
        sdr
    );
    drop((sum_l, sum_r));

    // Detection.
    println!("\n[3] instrument detection");
    // `detect` runs its own excerpts through the chain; printed generically (through JSON) so
    // that this example keeps compiling when the fields of `Detection` change.
    let t3 = Instant::now();
    let detection = detect(&audio, &cancel);
    println!(
        "  detect took {:.2} s ({:.3} x real time)",
        t3.elapsed().as_secs_f64(),
        t3.elapsed().as_secs_f64() / dur
    );
    print_detection(&serde_json::to_value(&detection).unwrap_or_default());

    // Tab.
    let Some(gp_path) = gp_path else {
        println!("\n[4] no .gp file given: no tab agreement");
        return Ok(());
    };
    let tab = parse_tab(&read_gpif(gp_path)?)?;
    println!("\n[4] tab ground truth ({} bars)", tab.bars);
    println!(
        "  {:<3} {:<34} {:<14} {:>7} {:>7} {:>8}",
        "#", "track", "kind", "program", "notes", "onsets"
    );
    for (i, t) in tab.tracks.iter().enumerate() {
        println!(
            "  {:<3} {:<34} {:<14} {:>7} {:>7} {:>8}",
            i,
            t.name.chars().take(34).collect::<String>(),
            t.kind,
            t.program.map_or("-".to_string(), |p| p.to_string()),
            t.notes,
            t.onsets_q.len()
        );
    }
    let tempos: Vec<String> = tab.tempo.iter().map(|t| format!("{:.1}", t.1)).collect();
    println!(
        "  tempo (quarter notes per minute): {}; tab length {:.1} s",
        tempos.join(" -> "),
        tab.seconds(tab.bars as f64 * 4.0)
    );
    let Some(drums) = tab
        .tracks
        .iter()
        .find(|t| t.is_drum && !t.onsets_q.is_empty())
    else {
        println!("  no drum track with notes in the tab: no onset agreement");
        return Ok(());
    };
    let tab_s: Vec<f64> = drums.onsets_q.iter().map(|&q| tab.seconds(q)).collect();

    println!(
        "\n[5] onset agreement with the tab's drum track '{}' ({} onsets)",
        drums.name,
        tab_s.len()
    );
    let stft = Stft::new();
    let hop_s = HOP as f64 / audio.rate as f64;
    let t2 = Instant::now();
    let mix_env = onset_envelope(&stft, &audio.left, &audio.right);
    let mut envs: Vec<(&'static str, Envelope)> = vec![("mix", mix_env)];
    for kind in StemKind::ALL {
        if let Some((l, r)) = sink.stems.get(&kind) {
            envs.push((kind.id(), onset_envelope(&stft, l, r)));
        }
    }
    let drum_env = &envs.iter().find(|(n, _)| *n == "drums").map(|(_, e)| e);
    let Some(drum_env) = drum_env else {
        println!("  no drums stem: no onset agreement");
        return Ok(());
    };
    let pl = place(drum_env, &tab_s, hop_s);
    let mix_pl = place(&envs[0].1, &tab_s, hop_s);
    println!(
        "  placement from the drums stem: tab starts at {:+.3} s, tempo scale {:.4}, lift {:.2} (search took {:.1} s)",
        pl.offset,
        pl.scale,
        pl.best,
        t2.elapsed().as_secs_f64()
    );
    println!(
        "  placement from the mix:        tab starts at {:+.3} s, tempo scale {:.4}, lift {:.2}  (should agree if the tab matches the recording)",
        mix_pl.offset, mix_pl.scale, mix_pl.best
    );
    let tab_audio: Vec<f64> = tab_s.iter().map(|&t| pl.offset + pl.scale * t).collect();
    let (from, to) = (
        tab_audio.first().copied().unwrap_or(0.0) - 0.1,
        tab_audio.last().copied().unwrap_or(0.0) + 0.1,
    );
    println!(
        "\n  all rows use the drums-stem placement (offset {:+.3} s, scale {:.4}):",
        pl.offset, pl.scale
    );
    println!(
        "  {:<8} {:>8} {:>8} {:>10}   {:>6} {:>6} {:>6} {:>8}",
        "signal", "lift", "null", "contrast", "P", "R", "F1", "peaks"
    );
    for (name, env) in &envs {
        let l = lift(env, &tab_s, pl.offset, pl.scale, hop_s);
        let own = place(env, &tab_s, hop_s);
        let peaks = pick_peaks(env, hop_s);
        let (p, r, f1, d, _) = prf(&peaks, &tab_audio, from, to);
        println!(
            "  {:<8} {:>8.2} {:>8.2} {:>9.2}x   {:>6.2} {:>6.2} {:>6.2} {:>8}",
            name,
            l,
            own.median,
            l / own.median.max(1e-9),
            p,
            r,
            f1,
            d
        );
    }
    println!(
        "  (lift: envelope at tab onsets / envelope average, 1 = no relation; null: median lift over all searched offsets for that signal)"
    );

    // Drift: the same placement, thirds of the tab.
    let third = (to - from) / 3.0;
    let peaks = pick_peaks(drum_env, hop_s);
    let mut parts = Vec::new();
    for k in 0..3 {
        let (a, b) = (from + k as f64 * third, from + (k + 1) as f64 * third);
        let (p, r, f1, _, nt) = prf(&peaks, &tab_audio, a, b);
        let sub: Vec<f64> = tab_s
            .iter()
            .cloned()
            .filter(|t| {
                let x = pl.offset + pl.scale * t;
                x >= a && x < b
            })
            .collect();
        parts.push(format!(
            "third {}: lift {:.2} P {:.2} R {:.2} F1 {:.2} ({} tab onsets)",
            k + 1,
            lift(drum_env, &sub, pl.offset, pl.scale, hop_s),
            p,
            r,
            f1,
            nt
        ));
    }
    println!(
        "  drums stem over the song (drift check):\n    {}",
        parts.join("\n    ")
    );
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: separation_real <audio> [<tab.gp>] [<audio> [<tab.gp>]]...");
        std::process::exit(2);
    }
    let mut songs: Vec<(String, Option<String>)> = Vec::new();
    for a in args {
        let is_gp = Path::new(&a)
            .extension()
            .is_some_and(|e| e.to_string_lossy().to_lowercase().starts_with("gp"));
        if is_gp {
            match songs.last_mut() {
                Some(last) if last.1.is_none() => last.1 = Some(a),
                _ => eprintln!("ignoring {a}: it does not follow an audio file"),
            }
        } else {
            songs.push((a, None));
        }
    }
    println!(
        "separation_real: reference-free proxies, default options, {} song(s)",
        songs.len()
    );
    for (audio, gp) in songs {
        if let Err(e) = run_song(Path::new(&audio), gp.as_deref().map(Path::new)) {
            println!("  FAILED: {e}");
        }
    }
}
