//! Compares the classical engine with a neural separator's stems (issue #186). Run with:
//!
//! ```sh
//! cargo run --release --example separation_compare --manifest-path src-tauri/Cargo.toml -- \
//!     <audio root> <neural root> [name]...
//! ```
//!
//! `<audio root>/<name>/mix.wav` is the input (written by `export_wav`); for the name `synth` the
//! exact parts (`drums.wav`, `bass.wav`, `vocals.wav`, `guitars.wav`) sit next to it.
//! `<neural root>/<name>/{drums,bass,vocals,other}.wav` are the neural stems
//! (`scripts/stem-separation/umx_run.py`).
//!
//! For `synth` it prints how far each true part falls when its own stem is muted, for ours
//! (gentle and strong drums) and the neural separator. For a real song there is no ground
//! truth, so it prints how much of each neural stem our stems hold and how close our drums,
//! bass and vocals are to the neural ones (neural output as the reference: a measure of
//! agreement, not of quality).

use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use smart_beat_lib::audio::backing::DecodedAudio;
use smart_beat_lib::separation::metrics::{energy, reduction_db, sdr_db, share_of};
use smart_beat_lib::separation::pipeline::{Options, separate};
use smart_beat_lib::separation::{MemorySink, StemKind};

/// A stem of one separation run: its kind and the two channels.
type Stem = (StemKind, Vec<f32>, Vec<f32>);

struct Wav {
    rate: u32,
    left: Vec<f32>,
    right: Vec<f32>,
}

/// Reads a stereo RIFF/WAVE file, 16-bit integer or 32-bit float.
fn read_wav(path: &Path) -> Result<Wav, String> {
    let b = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if b.len() < 44 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(format!("{}: not a WAV file", path.display()));
    }
    let (mut pos, mut fmt, mut data) = (12, None, None);
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let len = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &b[pos + 8..(pos + 8 + len).min(b.len())];
        match id {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        pos += 8 + len + (len & 1);
    }
    let (fmt, data) = (fmt.ok_or("no fmt chunk")?, data.ok_or("no data chunk")?);
    let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
    let channels = u16::from_le_bytes([fmt[2], fmt[3]]) as usize;
    let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
    let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
    let samples: Vec<f32> = match (tag, bits) {
        (3, 32) => data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect(),
        (1, 16) => data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
            .collect(),
        _ => {
            return Err(format!(
                "{}: unsupported WAV format {tag}/{bits}",
                path.display()
            ));
        }
    };
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for frame in samples.chunks_exact(channels) {
        left.push(frame[0]);
        right.push(*frame.get(1).unwrap_or(&frame[0]));
    }
    Ok(Wav { rate, left, right })
}

fn minus(a: &[f32], b: &[f32]) -> Vec<f32> {
    a.iter().zip(b).map(|(x, y)| x - y).collect()
}

fn run(mix: &Wav, opts: &Options) -> MemorySink {
    let audio = DecodedAudio {
        rate: mix.rate,
        channels: 2,
        left: mix.left.clone(),
        right: mix.right.clone(),
    };
    let mut sink = MemorySink::default();
    separate(
        &audio,
        opts,
        &mut sink,
        &AtomicBool::new(false),
        &mut |_| {},
    )
    .unwrap();
    sink
}

fn synthetic(audio_dir: &Path, neural_dir: &Path) -> Result<(), String> {
    let mix = read_wav(&audio_dir.join("mix.wav"))?;
    let truth: Vec<(&str, Wav)> = ["drums", "bass", "vocals", "guitars"]
        .into_iter()
        .map(|n| read_wav(&audio_dir.join(format!("{n}.wav"))).map(|w| (n, w)))
        .collect::<Result<_, _>>()?;
    let neural: Vec<(&str, Wav)> = ["drums", "bass", "vocals", "other"]
        .into_iter()
        .map(|n| read_wav(&neural_dir.join(format!("{n}.wav"))).map(|w| (n, w)))
        .collect::<Result<_, _>>()?;
    // Our own Rust implementation of UMX-HQ, when the weights folder is given.
    let rust_umx: Option<Vec<Stem>> = std::env::var("UMX_WEIGHTS").ok().map(|dir| {
        let model = smart_beat_lib::separation::umx::Model::load(Path::new(&dir)).unwrap();
        let audio = DecodedAudio {
            rate: mix.rate,
            channels: 2,
            left: mix.left.clone(),
            right: mix.right.clone(),
        };
        let mut sink = MemorySink::default();
        let t = std::time::Instant::now();
        smart_beat_lib::separation::umx::separate(
            &model,
            &audio,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        println!(
            "Rust UMX-HQ: {:.1} s for {:.0} s of audio",
            t.elapsed().as_secs_f32(),
            mix.left.len() as f32 / mix.rate as f32
        );
        sink.stems
            .into_iter()
            .map(|(k, (l, r))| (k, l, r))
            .collect()
    });
    let gentle = run(&mix, &Options::default());
    let strong = run(&mix, &Options::default().strong_drums());
    // For each system, the stem that is muted for each true part.
    let ours = |s: &MemorySink, k: StemKind| s.stems[&k].0.clone();
    let neu = |n: &str| neural.iter().find(|(m, _)| *m == n).unwrap().1.left.clone();
    let mut systems: Vec<(&str, [Vec<f32>; 4])> = vec![
        (
            "ours, gentle drums",
            [
                ours(&gentle, StemKind::Drums),
                ours(&gentle, StemKind::Bass),
                ours(&gentle, StemKind::Vocals),
                ours(&gentle, StemKind::Panned),
            ],
        ),
        (
            "ours, strong drums",
            [
                ours(&strong, StemKind::Drums),
                ours(&strong, StemKind::Bass),
                ours(&strong, StemKind::Vocals),
                ours(&strong, StemKind::Panned),
            ],
        ),
        (
            "neural UMX-HQ (guitars = its 'other')",
            [neu("drums"), neu("bass"), neu("vocals"), neu("other")],
        ),
    ];
    if let Some(stems) = &rust_umx {
        let get = |k: StemKind| stems.iter().find(|(m, _, _)| *m == k).unwrap().1.clone();
        for (name, k) in [
            ("drums", StemKind::Drums),
            ("bass", StemKind::Bass),
            ("vocals", StemKind::Vocals),
            ("other", StemKind::Other),
        ] {
            println!(
                "Rust UMX-HQ {name} against the PyTorch run: SDR {:.1} dB",
                sdr_db(&neu(name), &get(k))
            );
        }
        systems.push((
            "neural UMX-HQ, our Rust code",
            [
                get(StemKind::Drums),
                get(StemKind::Bass),
                get(StemKind::Vocals),
                get(StemKind::Other),
            ],
        ));
    }
    println!("\n== synthetic band: drop of a part (dB) when its own stem is muted");
    println!(
        "{:<40}{:>9}{:>9}{:>9}{:>9}",
        "", "drums", "bass", "vocals", "guitars"
    );
    for (name, muted) in &systems {
        print!("{name:<40}");
        for (i, (_, part)) in truth.iter().enumerate() {
            let rest = minus(&mix.left, &muted[i]);
            print!("{:>9.1}", reduction_db(&part.left, &mix.left, &rest));
        }
        println!();
    }
    println!("\n== collateral: the worst loss (dB) of any OTHER part when a stem is muted");
    println!(
        "{:<40}{:>9}{:>9}{:>9}{:>9}",
        "", "drums", "bass", "vocals", "guitars"
    );
    for (name, muted) in &systems {
        print!("{name:<40}");
        for (i, _) in truth.iter().enumerate() {
            let rest = minus(&mix.left, &muted[i]);
            let worst = truth
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, (_, p))| reduction_db(&p.left, &mix.left, &rest))
                .fold(f32::MIN, f32::max);
            print!("{worst:>9.1}");
        }
        println!();
    }
    println!("\n== neural stems against the exact parts (SDR, dB)");
    for (n, t) in [("drums", 0), ("bass", 1), ("vocals", 2)] {
        println!("{n:<10}{:>8.1}", sdr_db(&truth[t].1.left, &neu(n)));
    }
    println!(
        "other vs guitars {:>8.1}  (other also holds the rest of the mix: only a note)",
        sdr_db(&truth[3].1.left, &neu("other"))
    );
    Ok(())
}

fn real(name: &str, audio_dir: &Path, neural_dir: &Path) -> Result<(), String> {
    let mix = read_wav(&audio_dir.join("mix.wav"))?;
    let neural: Vec<(&str, Wav)> = ["drums", "bass", "vocals", "other"]
        .into_iter()
        .map(|n| read_wav(&neural_dir.join(format!("{n}.wav"))).map(|w| (n, w)))
        .collect::<Result<_, _>>()?;
    let mix_energy = energy(&mix.left);
    println!(
        "\n== {name}: {:.0} s",
        mix.left.len() as f64 / mix.rate as f64
    );
    println!("neural stem energy, % of the mix:");
    for (n, w) in &neural {
        println!("  {n:<8}{:>6.1} %", 100.0 * energy(&w.left) / mix_energy);
    }
    for (label, opts) in [
        ("gentle drums", Options::default()),
        ("strong drums", Options::default().strong_drums()),
    ] {
        let sink = run(&mix, &opts);
        println!("\nours ({label}): amplitude of each neural stem found in each of our stems");
        print!("{:<10}", "neural");
        for k in StemKind::ALL {
            print!("{:>9}", k.id());
        }
        println!();
        for (n, w) in &neural {
            print!("{n:<10}");
            for k in StemKind::ALL {
                print!("{:>9.2}", share_of(&w.left, &sink.stems[&k].0));
            }
            println!();
        }
        println!("SDR of our stem against the neural stem (dB; 0 = as far off as silence):");
        for (n, k) in [
            ("drums", StemKind::Drums),
            ("bass", StemKind::Bass),
            ("vocals", StemKind::Vocals),
        ] {
            let w = &neural.iter().find(|(m, _)| *m == n).unwrap().1;
            println!("  {n:<8}{:>7.1}", sdr_db(&w.left, &sink.stems[&k].0));
        }
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: separation_compare <audio root> <neural root> [name]...");
        std::process::exit(2);
    }
    let (audio_root, neural_root) = (Path::new(&args[0]), Path::new(&args[1]));
    let names: Vec<String> = if args.len() > 2 {
        args[2..].to_vec()
    } else {
        ["synth", "silly", "stereohangar", "limp"]
            .map(String::from)
            .to_vec()
    };
    for name in names {
        let (a, n) = (audio_root.join(&name), neural_root.join(&name));
        let result = if name == "synth" {
            synthetic(&a, &n)
        } else {
            real(&name, &a, &n)
        };
        if let Err(e) = result {
            println!("\n== {name}: skipped ({e})");
        }
    }
}
