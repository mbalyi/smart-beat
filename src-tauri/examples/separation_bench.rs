//! Measurements for the stem separation spike (issue #186) on a synthetic band whose parts are
//! known exactly. Run with:
//!
//! ```sh
//! cargo run --release --example separation_bench --manifest-path src-tauri/Cargo.toml
//! ```
//!
//! Prints, for each method, the confusion table (how much of each true part ends up in each
//! stem; the diagonal should be near 1), how many dB each part drops when its stem is muted,
//! and how much of the other parts survives, plus timing.

use std::sync::atomic::AtomicBool;
use std::time::Instant;

use smart_beat_lib::audio::backing::DecodedAudio;
use smart_beat_lib::separation::metrics::{reduction_db, share_of};
use smart_beat_lib::separation::pipeline::{Options, separate};
use smart_beat_lib::separation::synth::{self, Stereo};
use smart_beat_lib::separation::{MemorySink, StemKind};

fn audio(s: &Stereo) -> DecodedAudio {
    DecodedAudio {
        rate: synth::RATE,
        channels: 2,
        left: s.left.clone(),
        right: s.right.clone(),
    }
}

fn main() {
    let secs: f32 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(20.0);
    let band = synth::band(secs);
    let truth: [(&str, &Stereo, StemKind); 4] = [
        ("drums", &band.drums, StemKind::Drums),
        ("bass", &band.bass, StemKind::Bass),
        ("vocals", &band.vocals, StemKind::Vocals),
        ("guitars", &band.guitars, StemKind::Panned),
    ];
    let variants: Vec<(&str, Options)> = vec![
        ("default (gentle drums)", Options::default()),
        ("strong drums", Options::default().strong_drums()),
        (
            "binary drum mask (baseline)",
            Options {
                binary_drum_mask: true,
                ..Options::default()
            },
        ),
    ];
    for (name, opts) in variants {
        let mut sink = MemorySink::default();
        let t = Instant::now();
        separate(
            &audio(&band.mix),
            &opts,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        let took = t.elapsed().as_secs_f32();
        println!("\n== {name}: {secs:.0} s of audio in {took:.2} s");
        let kinds: Vec<StemKind> = sink.stems.keys().copied().collect();
        print!("{:<10}", "true part");
        for k in &kinds {
            print!("{:>9}", k.id());
        }
        println!("   | muted stem -> drop of the part (dB)");
        for (label, part, own) in &truth {
            print!("{label:<10}");
            for k in &kinds {
                print!("{:>9.2}", share_of(&part.left, &sink.stems[k].0));
            }
            let rest: Vec<f32> = band
                .mix
                .left
                .iter()
                .zip(&sink.stems[own].0)
                .map(|(m, s)| m - s)
                .collect();
            println!(
                "   | {:>6.1} dB",
                reduction_db(&part.left, &band.mix.left, &rest)
            );
        }
        // Collateral: what the other parts lose when this stem is muted.
        for (label, _, own) in &truth {
            let rest: Vec<f32> = band
                .mix
                .left
                .iter()
                .zip(&sink.stems[own].0)
                .map(|(m, s)| m - s)
                .collect();
            let drops: Vec<String> = truth
                .iter()
                .filter(|(other, _, _)| other != label)
                .map(|(other, part, _)| {
                    format!(
                        "{other} {:.1}",
                        reduction_db(&part.left, &band.mix.left, &rest)
                    )
                })
                .collect();
            println!("mute {label:<8} collateral loss (dB): {}", drops.join(", "));
        }
    }
}
