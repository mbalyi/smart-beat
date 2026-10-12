//! Turns a WAV recording into notes with the code the Record to tab command runs, and prints
//! `{ "notes": [...] }` as JSON on stdout. For comparing engines on recorded takes:
//! `cargo run --release --example transcribe_wav -- take.wav`.

use smart_beat_lib::recording::{BasicPitch, Transcribed, transcribe_take};

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
        &BasicPitch::default(),
        &samples,
        rate,
        &mut |fraction| eprint!("\r{:3.0}%", fraction * 100.0),
        &|| false,
    )?;
    eprintln!();
    println!("{}", serde_json::to_string(&Transcribed { notes })?);
    Ok(())
}
