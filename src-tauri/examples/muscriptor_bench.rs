//! Times MuScriptor on one machine: how long a model takes to load and to transcribe a stretch of
//! a recording, on the best device and on the CPU alone. The numbers behind the speed table in
//! the AI Models dialog (src/lib/ai/muscriptor-sizes.ts).
//!
//! ```text
//! cargo run --release --example muscriptor_bench -- <model.gguf> <16 kHz mono 16-bit WAV> [start_s] [seconds]
//! SMART_BEAT_MUSCRIPTOR_DEVICE=cpu cargo run --release --example muscriptor_bench -- ...
//! ```
//!
//! Convert a recording first: `afconvert -f WAVE -d LEI16@16000 -c 1 song.mp3 song.wav`.
//! Leave the machine idle while it runs; a build or a video call changes the result.

use std::time::Instant;

use smart_beat_lib::recording::muscriptor_ffi::Model;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(model_path), Some(wav_path)) = (args.next(), args.next()) else {
        eprintln!("usage: muscriptor_bench <model.gguf> <in.wav> [start_s] [seconds]");
        std::process::exit(2);
    };
    let start: f64 = args.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let length: f64 = args.next().and_then(|v| v.parse().ok()).unwrap_or(60.0);

    let mut reader = hound::WavReader::open(&wav_path)?;
    let spec = reader.spec();
    if spec.sample_rate != 16_000 || spec.channels != 1 {
        return Err("the WAV must be 16 kHz mono (see the afconvert line above)".into());
    }
    let scale = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
    let all: Vec<f32> = reader
        .samples::<i32>()
        .map(|sample| sample.map(|value| value as f32 * scale))
        .collect::<Result<_, _>>()?;
    let from = ((start * 16_000.0) as usize).min(all.len());
    let to = (from + (length * 16_000.0) as usize).min(all.len());
    let samples = &all[from..to];
    let seconds = samples.len() as f64 / 16_000.0;

    let loading = Instant::now();
    let mut model = Model::load(std::path::Path::new(&model_path), &|| false)
        .map_err(|failure| format!("{failure:?}"))?;
    let load_s = loading.elapsed().as_secs_f64();
    let device = model.device();

    let running = Instant::now();
    let notes = model
        .transcribe(samples, &[], &mut |_| {}, &|| false)
        .map_err(|failure| format!("{failure:?}"))?;
    let took = running.elapsed().as_secs_f64();

    println!(
        "{{\"model\":\"{}\",\"device\":\"{}\",\"audio_s\":{:.1},\"load_s\":{:.1},\"transcribe_s\":{:.1},\"factor\":{:.2},\"s_per_minute\":{:.0},\"notes\":{}}}",
        std::path::Path::new(&model_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("?"),
        device,
        seconds,
        load_s,
        took,
        seconds / took,
        took / seconds * 60.0,
        notes.len()
    );
    Ok(())
}
