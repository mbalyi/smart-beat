//! Plays the engine through the default audio output (CoreAudio, WASAPI,
//! ALSA/PulseAudio via cpal).
//!
//! The stream lives on its own thread (cpal streams cannot move between
//! threads on every platform). The engine sits behind a mutex that the audio
//! callback only `try_lock`s: if the UI holds it at that moment the callback
//! outputs silence for one buffer instead of waiting.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::engine::Engine;

/// Interleaved scratch size (frames) used when the device asks for more.
const MAX_FRAMES: usize = 8_192;

/// What the callback publishes for the UI.
#[derive(Default)]
pub struct Published {
    /// Song position (seconds, f64 bits) of what is being heard now.
    pub position: AtomicU64,
    pub playing: AtomicBool,
    /// Measured output latency (microseconds).
    pub latency_us: AtomicU32,
    /// Buffers rendered as silence because the engine was busy.
    pub dropouts: AtomicU32,
    /// Time the callback took, as a share of the buffer's duration (per mille), peak.
    pub load_permille: AtomicU32,
}

pub struct Output {
    pub sample_rate: u32,
    pub channels: u16,
    pub published: Arc<Published>,
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

/// The default device's sample rate (to build the engine before opening it).
pub fn default_sample_rate() -> Result<u32, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No audio output device was found")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    Ok(config.sample_rate())
}

impl Output {
    pub fn open(engine: Arc<Mutex<Engine>>) -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(u32, u16, Arc<Published>), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("smart-beat-audio".into())
            .spawn(move || {
                let stream = match build_stream(engine) {
                    Ok((stream, rate, channels, published)) => {
                        if let Err(e) = stream.play() {
                            let _ = ready_tx.send(Err(e.to_string()));
                            return;
                        }
                        let _ = ready_tx.send(Ok((rate, channels, published)));
                        stream
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                // Keep the stream alive until asked to stop (or the handle is dropped).
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| e.to_string())?;
        let (sample_rate, channels, published) =
            ready_rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "The audio output did not start".to_string())??;
        Ok(Self {
            sample_rate,
            channels,
            published,
            stop: stop_tx,
            thread: Some(thread),
        })
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

type Built = (cpal::Stream, u32, u16, Arc<Published>);

fn build_stream(engine: Arc<Mutex<Engine>>) -> Result<Built, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No audio output device was found")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    if supported.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!(
            "The audio output uses {:?} samples; only 32-bit float output is supported yet",
            supported.sample_format()
        ));
    }
    let mut config: cpal::StreamConfig = supported.into();
    config.buffer_size = cpal::BufferSize::Default;
    let rate = config.sample_rate;
    let channels = config.channels.max(1);
    let published = Arc::new(Published::default());
    let shared = published.clone();
    let mut left = vec![0.0f32; MAX_FRAMES];
    let mut right = vec![0.0f32; MAX_FRAMES];
    let stream = device
        .build_output_stream::<f32, _, _>(
            config,
            move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                let started = std::time::Instant::now();
                let ch = channels as usize;
                let frames = (data.len() / ch).min(MAX_FRAMES);
                let ts = info.timestamp();
                let latency = ts
                    .playback
                    .checked_duration_since(ts.callback)
                    .unwrap_or_default();
                shared
                    .latency_us
                    .store(latency.as_micros() as u32, Ordering::Relaxed);
                match engine.try_lock() {
                    Ok(mut engine) => {
                        engine.render(&mut left[..frames], &mut right[..frames]);
                        // What is heard now was rendered `latency` ago.
                        let heard = (engine.position() - latency.as_secs_f64()).max(0.0);
                        shared.position.store(heard.to_bits(), Ordering::Relaxed);
                        shared.playing.store(engine.is_active(), Ordering::Relaxed);
                    }
                    Err(_) => {
                        left[..frames].fill(0.0);
                        right[..frames].fill(0.0);
                        shared.dropouts.fetch_add(1, Ordering::Relaxed);
                    }
                }
                data.fill(0.0);
                for (i, frame) in data.chunks_mut(ch).take(frames).enumerate() {
                    frame[0] = left[i];
                    if ch > 1 {
                        frame[1] = right[i];
                    }
                }
                let budget = frames as f64 / rate as f64;
                let load = (started.elapsed().as_secs_f64() / budget * 1000.0) as u32;
                shared.load_permille.fetch_max(load, Ordering::Relaxed);
            },
            |err| eprintln!("audio output: {err}"),
            Some(Duration::from_secs(3)),
        )
        .map_err(|e| e.to_string())?;
    Ok((stream, rate, channels, published))
}
