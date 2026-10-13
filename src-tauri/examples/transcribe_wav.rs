//! Turns a WAV recording into notes with the code the Record to tab command runs, and prints
//! `{ "notes": [...] }` as JSON on stdout. For comparing engines on recorded takes:
//! `cargo run --release --example transcribe_wav -- take.wav`.

use smart_beat_lib::recording::{BasicPitch, NoteOptions, Transcribed, transcribe_take};

/// A note option from an environment variable, for tuning runs: `ONSET`, `FRAME`, `MIN_MS`,
/// `MIN_PITCH`, `MAX_PITCH`, `INSTRUMENT=piano` (the starting point), `INFER` (0 or 1) and `MELODIA` (0 or 1).
fn env_options() -> NoteOptions {
    let get = |name: &str| std::env::var(name).ok();
    let mut options = if get("INSTRUMENT").as_deref() == Some("piano") {
        NoteOptions::piano()
    } else {
        NoteOptions::default()
    };
    if let Some(v) = get("ONSET").and_then(|v| v.parse().ok()) {
        options.onset_threshold = v;
    }
    if let Some(v) = get("FRAME").and_then(|v| v.parse().ok()) {
        options.frame_threshold = v;
    }
    if let Some(v) = get("MIN_MS").and_then(|v| v.parse().ok()) {
        options.min_note_ms = v;
    }
    options.min_pitch = get("MIN_PITCH").and_then(|v| v.parse().ok());
    options.max_pitch = get("MAX_PITCH").and_then(|v| v.parse().ok());
    if let Some(v) = get("INFER") {
        options.infer_onsets = v == "1";
    }
    if let Some(v) = get("MELODIA") {
        options.melodia = v == "1";
    }
    options
}

/// The samples of a WAV file as mono floats, and their rate.
fn read_wav(path: &str) -> Result<(Vec<f32>, u32), Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let channels = usize::from(spec.channels.max(1));
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 * scale))
                .collect::<Result<_, _>>()?
        }
    };
    let mono = samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: transcribe_wav <in.wav>");
        std::process::exit(2);
    };
    let (samples, rate) = read_wav(&path)?;
    let notes = transcribe_take(
        &BasicPitch {
            options: env_options(),
        },
        &samples,
        rate,
        &mut |fraction| eprint!("\r{:3.0}%", fraction * 100.0),
        &|| false,
    )?;
    eprintln!();
    println!("{}", serde_json::to_string(&Transcribed { notes })?);
    Ok(())
}
