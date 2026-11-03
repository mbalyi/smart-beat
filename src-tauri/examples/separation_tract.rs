//! Runs an ONNX stem separator (SCNet or HTDemucs) with `tract` and measures it (issue #186
//! spike). The separation itself is the app's own `separation::onnx`; this only loads, times and
//! scores it.
//!
//! ```sh
//! source ~/.cargo/env; export PATH=/opt/homebrew/bin:$PATH
//! cd src-tauri
//! /usr/bin/time -l cargo run --release --example separation_tract -- \
//!     <model.onnx> <scnet|scnet-xl|htdemucs> <audio> [<UMX-HQ weights dir>] [--seconds N] \
//!     [--segment SAMPLES] [--overlap F] [--out DIR]
//! ```
//!
//! `<audio>` is one of
//!
//! * a song file (anything `audio::backing::decode` reads; must be 44.1 kHz);
//! * `synth` or `synth:SECONDS`: the synthetic band of `separation::synth` (default 30 s), with
//!   exact ground truth for every stem;
//! * a folder written by `export_wav` (`mix.wav`, and `drums.wav`, `bass.wav`, `vocals.wav`,
//!   `guitars.wav` for exact ground truth).
//!
//! With only `<model.onnx> <kind>` the example loads the model (checking the graph fits the
//! contract of `separation::onnx`) and stops.
//!
//! What it prints: load time, wall-clock separation time, real-time factor (seconds of compute
//! per second of audio; below 1 is faster than real time) and the peak resident memory of the
//! separation (sampled with `ps` every 100 ms, as `separation_real` does; wrap the whole command
//! in `/usr/bin/time -l` for the kernel's exact "maximum resident set size", in bytes, which also
//! includes the input, the UMX-HQ comparison run and the build tooling when run through cargo:
//! run the built binary `target/release/examples/separation_tract` directly to avoid that). Then
//! the SDR of each stem against the UMX-HQ stems of the same input (Rust implementation,
//! `separation::umx`, when a weights folder is given) and, for `synth` or an exact-truth folder,
//! against the true parts. SDR is `metrics::sdr_db`, over both channels, in dB: higher is
//! better, 0 dB is as far off as silence. Against UMX-HQ it is a measure of agreement, not of
//! quality.
//!
//! `--seconds N` keeps only the first N seconds of the input; `--out DIR` writes the four stems
//! as 32-bit float WAV files for listening.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use smart_beat_lib::audio::backing::{DecodedAudio, decode};
use smart_beat_lib::separation::metrics::sdr_db;
use smart_beat_lib::separation::onnx::{self, HTDEMUCS, Model, RATE, SCNET, SCNET_XL};
use smart_beat_lib::separation::synth;
use smart_beat_lib::separation::{MemorySink, StemKind, umx};

struct Separated {
    /// One entry per stem, in the contract's order, two channels each.
    stems: Vec<(&'static str, [Vec<f32>; 2])>,
    segments: usize,
}

/// Runs the library's separation and prints the time of every segment.
fn separate(model: &Model, audio: &DecodedAudio) -> Result<Separated, String> {
    let c = model.contract();
    let mut sink = MemorySink::default();
    let mut segments = 0usize;
    let mut last = Instant::now();
    onnx::separate(
        model,
        audio,
        &mut sink,
        &AtomicBool::new(false),
        &mut |fraction| {
            if fraction > 0.0 {
                segments += 1;
                println!(
                    "  segment {segments}: {:.2} s",
                    last.elapsed().as_secs_f32()
                );
                last = Instant::now();
            }
        },
    )?;
    let stems = c
        .stems
        .iter()
        .map(|name| {
            let (l, r) = sink
                .stems
                .remove(&StemKind::from_id(name).expect("known stem"))
                .expect("the model wrote every stem");
            (*name, [l, r])
        })
        .collect();
    Ok(Separated { stems, segments })
}

// ---------------------------------------------------------------------------------------------
// Peak resident memory (same method as `separation_real`)
// ---------------------------------------------------------------------------------------------

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
// Input and ground truth
// ---------------------------------------------------------------------------------------------

/// Exact parts of the input, when it has them: drums, bass, vocals, other (= the guitars).
struct Truth {
    parts: Vec<(&'static str, [Vec<f32>; 2])>,
}

fn read_audio(path: &Path) -> Result<DecodedAudio, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    decode(bytes, path.extension().and_then(|e| e.to_str()))
}

fn load_input(arg: &str) -> Result<(String, DecodedAudio, Option<Truth>), String> {
    if let Some(rest) = arg.strip_prefix("synth") {
        let secs: f32 = match rest.strip_prefix(':') {
            Some(s) => s.parse().map_err(|_| format!("bad seconds in {arg}"))?,
            None if rest.is_empty() => 30.0,
            None => return Err(format!("unknown input {arg}")),
        };
        let band = synth::band(secs);
        let audio = DecodedAudio {
            rate: synth::RATE,
            channels: 2,
            left: band.mix.left.clone(),
            right: band.mix.right.clone(),
        };
        let part = |s: &synth::Stereo| [s.left.clone(), s.right.clone()];
        let truth = Truth {
            parts: vec![
                ("drums", part(&band.drums)),
                ("bass", part(&band.bass)),
                ("vocals", part(&band.vocals)),
                ("other", part(&band.guitars)),
            ],
        };
        return Ok((format!("synth {secs} s"), audio, Some(truth)));
    }
    let path = PathBuf::from(arg);
    if path.is_dir() {
        let audio = read_audio(&path.join("mix.wav"))?;
        let mut parts = Vec::new();
        for (name, file) in [
            ("drums", "drums.wav"),
            ("bass", "bass.wav"),
            ("vocals", "vocals.wav"),
            ("other", "guitars.wav"),
        ] {
            if let Ok(a) = read_audio(&path.join(file)) {
                parts.push((name, [a.left, a.right]));
            }
        }
        let truth = (parts.len() == 4).then_some(Truth { parts });
        return Ok((arg.to_string(), audio, truth));
    }
    Ok((arg.to_string(), read_audio(&path)?, None))
}

fn write_wav(path: &Path, left: &[f32], right: &[f32]) -> Result<(), String> {
    let data_len = (left.len() * 8) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 8).to_le_bytes());
    out.extend_from_slice(&8u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for (l, r) in left.iter().zip(right) {
        out.extend_from_slice(&l.to_le_bytes());
        out.extend_from_slice(&r.to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("{}: {e}", path.display()))
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

/// Two channels.
type Stereo = [Vec<f32>; 2];
type NamedStems = Vec<(&'static str, Stereo)>;

/// SDR over both channels.
fn sdr_stereo(reference: &[Vec<f32>; 2], estimate: &[Vec<f32>; 2]) -> f32 {
    let r: Vec<f32> = reference[0].iter().chain(&reference[1]).copied().collect();
    let e: Vec<f32> = estimate[0].iter().chain(&estimate[1]).copied().collect();
    sdr_db(&r, &e)
}

fn print_row(label: &str, names: &[&str], values: impl Fn(&str) -> Option<f32>) {
    print!("{label:<34}");
    for n in names {
        match values(n) {
            Some(v) => print!("{v:>9.1}"),
            None => print!("{:>9}", "-"),
        }
    }
    println!();
}

fn run() -> Result<(), String> {
    let mut positional = Vec::new();
    let mut seconds: Option<f32> = None;
    let mut out_dir: Option<PathBuf> = None;
    let mut segment: Option<usize> = None;
    let mut overlap: Option<f32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--seconds" => {
                seconds = Some(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .ok_or("--seconds needs a number")?,
                );
            }
            "--segment" => {
                segment = Some(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .ok_or("--segment needs a sample count")?,
                );
            }
            "--overlap" => {
                overlap = Some(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .ok_or("--overlap needs a fraction below 1")?,
                );
            }
            "--out" => out_dir = Some(args.next().ok_or("--out needs a folder")?.into()),
            _ => positional.push(a),
        }
    }
    if positional.len() < 2 {
        return Err(
            "usage: separation_tract <model.onnx> <scnet|scnet-xl|htdemucs> [<audio> \
                    [<UMX-HQ weights dir>]] [--seconds N] [--segment SAMPLES] [--overlap F] \
                    [--out DIR]"
                .into(),
        );
    }
    let mut contract = match positional[1].as_str() {
        "scnet" => SCNET,
        "scnet-xl" => SCNET_XL,
        "htdemucs" => HTDEMUCS,
        other => {
            return Err(format!(
                "unknown model kind {other} (scnet | scnet-xl | htdemucs)"
            ));
        }
    };
    // The graphs have static shapes, so these must match the export (the frame count follows).
    if let Some(s) = segment {
        contract.segment = s;
    }
    if let Some(o) = overlap {
        contract.overlap = o;
    }
    let contract = &contract;

    let t = Instant::now();
    let model = Model::load(Path::new(&positional[0]), contract)?;
    println!(
        "model loaded and optimised in {:.1} s",
        t.elapsed().as_secs_f32()
    );
    let Some(input) = positional.get(2) else {
        println!("no audio given: nothing run");
        return Ok(());
    };

    let (label, mut audio, mut truth) = load_input(input)?;
    if audio.rate != RATE {
        return Err(format!(
            "the models need 44.1 kHz, the input is {} Hz",
            audio.rate
        ));
    }
    if let Some(secs) = seconds {
        let keep = ((secs * RATE as f32) as usize).min(audio.frames());
        audio.left.truncate(keep);
        audio.right.truncate(keep);
        if let Some(tr) = &mut truth {
            for (_, ch) in &mut tr.parts {
                ch[0].truncate(keep);
                ch[1].truncate(keep);
            }
        }
    }
    let duration = audio.frames() as f64 / RATE as f64;
    println!(
        "input {label}: {duration:.1} s, segment {:.2} s, overlap {}",
        contract.segment as f64 / RATE as f64,
        contract.overlap
    );

    let sampler = RssSampler::start();
    let started = Instant::now();
    let result = separate(&model, &audio);
    let wall = started.elapsed().as_secs_f64();
    let peak = sampler.finish();
    let ours = result?;
    println!(
        "\n{} segments in {wall:.1} s wall-clock; real-time factor {:.2} (compute seconds per \
         audio second, below 1 is faster than real time); peak RSS {peak:.0} MiB",
        ours.segments,
        wall / duration
    );

    if let Some(dir) = &out_dir {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for (name, ch) in &ours.stems {
            write_wav(&dir.join(format!("{name}.wav")), &ch[0], &ch[1])?;
        }
        println!("stems written to {}", dir.display());
    }

    // UMX-HQ stems of the same input (our Rust implementation).
    let umx_stems: Option<NamedStems> = match positional.get(3) {
        Some(dir) => {
            let net = umx::Model::load(Path::new(dir))?;
            let t = Instant::now();
            let mut sink = MemorySink::default();
            umx::separate(
                &net,
                &audio,
                &mut sink,
                &AtomicBool::new(false),
                &mut |_| {},
            )?;
            println!(
                "UMX-HQ (Rust, separation::umx): {:.1} s, real-time factor {:.2}",
                t.elapsed().as_secs_f32(),
                t.elapsed().as_secs_f64() / duration
            );
            Some(
                ["drums", "bass", "vocals", "other"]
                    .into_iter()
                    .map(|n| {
                        let (l, r) = sink.stems.remove(&StemKind::from_id(n).unwrap()).unwrap();
                        (n, [l, r])
                    })
                    .collect(),
            )
        }
        None => None,
    };

    let names = ["drums", "bass", "vocals", "other"];
    let find = |set: &[(&str, Stereo)], n: &str| -> Option<Stereo> {
        set.iter().find(|(m, _)| *m == n).map(|(_, c)| c.clone())
    };
    println!("\nSDR in dB (higher is better; 0 = as far off as silence)");
    print!("{:<34}", "");
    for n in names {
        print!("{n:>9}");
    }
    println!();
    if let Some(u) = &umx_stems {
        print_row("tract vs UMX-HQ (agreement)", &names, |n| {
            Some(sdr_stereo(&find(u, n)?, &find(&ours.stems, n)?))
        });
    }
    if let Some(tr) = &truth {
        print_row("tract vs exact truth", &names, |n| {
            Some(sdr_stereo(&find(&tr.parts, n)?, &find(&ours.stems, n)?))
        });
        if let Some(u) = &umx_stems {
            print_row("UMX-HQ vs exact truth", &names, |n| {
                Some(sdr_stereo(&find(&tr.parts, n)?, &find(u, n)?))
            });
        }
        println!("(for the synthetic band the true 'other' part is the guitars)");
    } else if umx_stems.is_none() {
        println!("(no UMX-HQ weights dir and no exact truth: nothing to compare against)");
    }
    // The stems of a separator should add up to the mixture.
    let sum: [Vec<f32>; 2] = std::array::from_fn(|ch| {
        let mut s = vec![0.0f32; audio.frames()];
        for (_, c) in &ours.stems {
            for (d, v) in s.iter_mut().zip(&c[ch]) {
                *d += v;
            }
        }
        s
    });
    println!(
        "stems summed against the mixture: SDR {:.1} dB",
        sdr_stereo(&[audio.left.clone(), audio.right.clone()], &sum)
    );
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
