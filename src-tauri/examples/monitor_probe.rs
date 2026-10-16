//! Checks the monitor track on real devices: opens an audio input and the
//! default output the way the app does, with the monitor muted (no sound, so
//! no feedback), and prints how the input and the ring behave. Run with:
//!
//! ```sh
//! cargo run --release --example monitor_probe --manifest-path src-tauri/Cargo.toml -- [seconds] [input name] [channel]
//! ```
//!
//! Without a name it uses the system's default input; without a channel it
//! mixes all of them. macOS asks the terminal for the microphone the first
//! time.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use smart_beat_lib::audio::chain::Chain;
use smart_beat_lib::audio::engine::{BLOCK, Engine};
use smart_beat_lib::audio::input::Input;
use smart_beat_lib::audio::monitor::{Monitor, MonitorParams, Reader};
use smart_beat_lib::audio::output::{self, Output};
use smart_beat_lib::audio::parse_sound_font;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let seconds: f64 = args.first().and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let name = args.get(1).map(String::as_str);
    let channel = args.get(2).and_then(|s| s.parse::<u16>().ok());

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let bytes =
        std::fs::read(root.join("node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3"))
            .expect("run `pnpm install` first (the SoundFont comes with alphaTab)");
    let font = Arc::new(parse_sound_font(&bytes).unwrap());

    let rate = output::default_sample_rate().expect("no audio output");
    let input = match Input::open(name, channel) {
        Ok(input) => input,
        Err(e) => {
            eprintln!("The input did not open: {e}");
            std::process::exit(1);
        }
    };
    println!(
        "Input: {} ({} channels, {} Hz); output: {rate} Hz",
        input.device, input.channels, input.sample_rate
    );

    let engine = Arc::new(Mutex::new(Engine::new(font, rate as f32)));
    let mut monitor = Monitor::new(Chain::empty(), rate as f32, BLOCK);
    monitor.set_params(&MonitorParams {
        mute: true,
        ..MonitorParams::default()
    });
    monitor.set_reader(Some(Reader::new(
        input.ring.clone(),
        input.sample_rate as f32,
        rate as f32,
    )));
    engine.lock().unwrap().set_monitor(Some(monitor));
    let out = Output::open(engine.clone(), true).expect("the output did not open");

    println!("time  input peak  queued  margin  underruns  in ms  out ms  dropouts");
    let started = Instant::now();
    while started.elapsed().as_secs_f64() < seconds {
        std::thread::sleep(Duration::from_millis(500));
        let mut e = engine.lock().unwrap();
        let peak = e.monitor_mut().map_or(0.0, Monitor::take_input_peak);
        let reader = e.monitor().and_then(Monitor::reader);
        let (queued, margin, underruns) =
            reader.map_or((0, 0, 0), |r| (r.queued(), r.margin(), r.underruns));
        drop(e);
        println!(
            "{:>4.1}  {:>10.4}  {:>6}  {:>6}  {:>9}  {:>5.1}  {:>6.1}  {:>8}",
            started.elapsed().as_secs_f64(),
            peak,
            queued,
            margin,
            underruns,
            input.latency().as_secs_f64() * 1000.0,
            out.published
                .latency_us
                .load(std::sync::atomic::Ordering::Relaxed) as f64
                / 1000.0,
            out.published
                .dropouts
                .swap(0, std::sync::atomic::Ordering::Relaxed),
        );
    }
    if let Some(error) = input.error() {
        println!("The input reported: {error}");
    }
}
