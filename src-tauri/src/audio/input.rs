//! Listens to an audio input (cpal: CoreAudio, WASAPI, ALSA/PulseAudio) for
//! the monitor track and writes what it hears into a [`Ring`].
//!
//! Like the output, the stream lives on its own thread. It opens at the
//! device's current rate: asking for another one would make cpal change the
//! device's rate for every app on macOS. The engine converts the rate.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};

use super::monitor::{RING_CAPACITY, Ring};

/// The buffer the input asks for when the device allows it (frames).
pub const LOW_LATENCY_FRAMES: u32 = 128;
/// Interleaved frames converted at a time.
const MAX_FRAMES: usize = 8_192;
/// Longest device name accepted from the UI.
pub const MAX_NAME: usize = 256;

/// What the input callback reports to the rest of the app.
#[derive(Default)]
pub struct InputShared {
    /// Set when the stream stopped (the device was unplugged …).
    pub failed: AtomicBool,
    pub error: Mutex<Option<String>>,
    /// From the moment a sample was captured to its callback (microseconds).
    pub latency_us: AtomicU32,
}

pub struct Input {
    /// The input's name as the system gives it.
    pub device: String,
    pub channels: u16,
    pub sample_rate: u32,
    pub ring: Arc<Ring>,
    pub shared: Arc<InputShared>,
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}

/// A device name without the USB id Chromium and WebView2 add to input
/// labels ("Scarlett 2i2 USB (1235:8210)").
fn without_usb_id(name: &str) -> &str {
    let trimmed = name.trim_end();
    if let Some(open) = trimmed.rfind(" (")
        && let Some(id) = trimmed[open + 2..].strip_suffix(')')
        && id.len() == 9
        && id.as_bytes()[4] == b':'
        && id
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || b.is_ascii_hexdigit())
    {
        return trimmed[..open].trim_end();
    }
    trimmed
}

/// The index of the device called `wanted` in `names`: the same name, then
/// the same without a USB id, then ignoring case. A missing device must not
/// silently select another microphone.
pub fn match_device(wanted: &str, names: &[String]) -> Option<usize> {
    let wanted = without_usb_id(wanted);
    if wanted.is_empty() {
        return None;
    }
    let lower = wanted.to_lowercase();
    names
        .iter()
        .position(|n| n == wanted)
        .or_else(|| names.iter().position(|n| without_usb_id(n) == wanted))
        .or_else(|| {
            names
                .iter()
                .position(|n| without_usb_id(n).to_lowercase() == lower)
        })
}

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| device.to_string())
}

/// The input called `name` (None: the system's default input).
fn find_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let Some(name) = name else {
        return host
            .default_input_device()
            .ok_or_else(|| "No audio input was found.".to_string());
    };
    let devices: Vec<cpal::Device> = host
        .input_devices()
        .map_err(|e| format!("The audio inputs cannot be listed: {e}"))?
        .collect();
    let names: Vec<String> = devices.iter().map(device_name).collect();
    match_device(name, &names)
        .map(|i| devices[i].clone())
        .ok_or_else(|| format!("“{name}” is not connected."))
}

/// How many channels an input has.
pub fn input_channels(name: Option<&str>) -> Result<u16, String> {
    let device = find_device(name)?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("The input cannot be used: {e}"))?;
    Ok(config.channels())
}

/// Mixes interleaved `data` down to one channel (`channel`, or the average of
/// all of them) into `out`; returns the frames written.
pub fn pick_channel<T>(data: &[T], channels: usize, channel: Option<u16>, out: &mut [f32]) -> usize
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    let frames = (data.len() / channels).min(out.len());
    let pick = channel.map(|c| (c as usize).min(channels - 1));
    for (frame, slot) in data.chunks_exact(channels).take(frames).zip(out.iter_mut()) {
        *slot = match pick {
            Some(c) => frame[c].to_sample::<f32>(),
            None => frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32,
        };
    }
    frames
}

type Opened = (String, u16, u32);

impl Input {
    /// Opens the input called `name` (None: the system's default) and listens
    /// to one channel of it (0-based; None: all of them mixed).
    pub fn open(name: Option<&str>, channel: Option<u16>) -> Result<Self, String> {
        let name = name.map(str::to_string);
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        let shared = Arc::new(InputShared::default());
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Opened, String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (thread_ring, thread_shared) = (ring.clone(), shared.clone());
        let thread = std::thread::Builder::new()
            .name("smart-beat-input".into())
            .spawn(move || {
                let built = build_stream(name.as_deref(), channel, thread_ring, thread_shared);
                let stream = match built {
                    Ok((stream, opened)) => {
                        if let Err(e) = stream.play() {
                            let _ = ready_tx.send(Err(format!("The input cannot start: {e}")));
                            return;
                        }
                        let _ = ready_tx.send(Ok(opened));
                        stream
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| e.to_string())?;
        let (device, channels, sample_rate) = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "The audio input did not start.".to_string())??;
        Ok(Self {
            device,
            channels,
            sample_rate,
            ring,
            shared,
            stop: stop_tx,
            thread: Some(thread),
        })
    }

    /// Why the stream stopped, if it did.
    pub fn error(&self) -> Option<String> {
        if !self.shared.failed.load(Ordering::Relaxed) {
            return None;
        }
        self.shared.error.lock().map(|e| e.clone()).ok().flatten()
    }

    pub fn latency(&self) -> Duration {
        Duration::from_micros(self.shared.latency_us.load(Ordering::Relaxed) as u64)
    }
}

impl Drop for Input {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn build_stream(
    name: Option<&str>,
    channel: Option<u16>,
    ring: Arc<Ring>,
    shared: Arc<InputShared>,
) -> Result<(cpal::Stream, Opened), String> {
    let device = find_device(name)?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("The input cannot be used: {e}"))?;
    let format = supported.sample_format();
    let small = matches!(
        supported.buffer_size(),
        cpal::SupportedBufferSize::Range { min, max }
            if (*min..=*max).contains(&LOW_LATENCY_FRAMES)
    );
    let mut config: cpal::StreamConfig = supported.into();
    let opened = (device_name(&device), config.channels, config.sample_rate);
    let attempts = if small {
        vec![
            cpal::BufferSize::Fixed(LOW_LATENCY_FRAMES),
            cpal::BufferSize::Default,
        ]
    } else {
        vec![cpal::BufferSize::Default]
    };
    let mut last_error = String::new();
    for buffer_size in attempts {
        config.buffer_size = buffer_size;
        let built = match format {
            SampleFormat::F32 => build::<f32>(&device, &config, channel, &ring, &shared),
            SampleFormat::F64 => build::<f64>(&device, &config, channel, &ring, &shared),
            SampleFormat::I8 => build::<i8>(&device, &config, channel, &ring, &shared),
            SampleFormat::I16 => build::<i16>(&device, &config, channel, &ring, &shared),
            SampleFormat::I32 => build::<i32>(&device, &config, channel, &ring, &shared),
            SampleFormat::U8 => build::<u8>(&device, &config, channel, &ring, &shared),
            SampleFormat::U16 => build::<u16>(&device, &config, channel, &ring, &shared),
            SampleFormat::U32 => build::<u32>(&device, &config, channel, &ring, &shared),
            other => {
                return Err(format!(
                    "The input uses {other:?} samples, which Smart Beat cannot read yet."
                ));
            }
        };
        match built {
            Ok(stream) => return Ok((stream, opened)),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channel: Option<u16>,
    ring: &Arc<Ring>,
    shared: &Arc<InputShared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let mut mono = vec![0.0f32; MAX_FRAMES];
    let (ring, data_shared, error_shared) = (ring.clone(), shared.clone(), shared.clone());
    device
        .build_input_stream::<T, _, _>(
            *config,
            move |data: &[T], info: &cpal::InputCallbackInfo| {
                let ts = info.timestamp();
                if let Some(latency) = ts.callback.checked_duration_since(ts.capture) {
                    data_shared
                        .latency_us
                        .store(latency.as_micros() as u32, Ordering::Relaxed);
                }
                for part in data.chunks(MAX_FRAMES * channels) {
                    let frames = pick_channel(part, channels, channel, &mut mono);
                    ring.push(&mono[..frames]);
                }
            },
            move |err| {
                if let Ok(mut error) = error_shared.error.lock() {
                    *error = Some(format!("The input stopped: {err}"));
                }
                error_shared.failed.store(true, Ordering::Relaxed);
            },
            Some(Duration::from_secs(3)),
        )
        .map_err(|e| format!("The input cannot be opened: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_a_device_by_its_web_view_label() {
        let list = names(&[
            "MacBook Pro Microphone",
            "Microphone (Scarlett 2i2 USB)",
            "Scarlett 2i2 USB",
        ]);
        assert_eq!(match_device("Scarlett 2i2 USB", &list), Some(2));
        // Chromium and WebView2 add the USB id.
        assert_eq!(match_device("Scarlett 2i2 USB (1235:8210)", &list), Some(2));
        assert_eq!(match_device("macbook pro microphone", &list), Some(0));
        // A different endpoint label is not an exact match.
        let windows = names(&[
            "Microphone (Realtek(R) Audio)",
            "Line In (Scarlett 2i2 USB)",
        ]);
        assert_eq!(match_device("Scarlett 2i2 USB", &windows), None);
        assert_eq!(
            match_device("Line In (Scarlett 2i2 USB) (1235:8210)", &windows),
            Some(1)
        );
        assert_eq!(match_device("Behringer UMC204HD", &list), None);
        assert_eq!(match_device("", &list), None);
    }

    #[test]
    fn does_not_select_an_input_by_a_partial_name() {
        let list = names(&["MacBook Microphone", "USB Audio Pro", "USB Audio Mini"]);
        for wanted in ["Microphone", "USB Audio", "MacBook Microphone External"] {
            assert_eq!(match_device(wanted, &list), None);
        }
    }

    #[test]
    fn keeps_names_that_only_look_like_usb_ids() {
        assert_eq!(without_usb_id("Studio (Left)"), "Studio (Left)");
        assert_eq!(without_usb_id("Mic (12:34)"), "Mic (12:34)");
        assert_eq!(without_usb_id("Mic (abcd:01ef)"), "Mic");
    }

    #[test]
    fn picks_one_channel_or_mixes_them() {
        let data: [i16; 6] = [i16::MAX, 0, i16::MIN, 0, 0, i16::MAX];
        let mut out = [0.0f32; 4];
        assert_eq!(pick_channel(&data, 2, Some(0), &mut out), 3);
        assert!((out[0] - 1.0).abs() < 1e-3 && out[1] == -1.0 && out[2] == 0.0);
        pick_channel(&data, 2, Some(1), &mut out);
        assert!(out[0] == 0.0 && (out[2] - 1.0).abs() < 1e-3);
        pick_channel(&data, 2, None, &mut out);
        assert!((out[0] - 0.5).abs() < 1e-3 && (out[1] + 0.5).abs() < 1e-3);
        // A channel past the last one reads the last one.
        pick_channel(&data, 2, Some(7), &mut out);
        assert!((out[2] - 1.0).abs() < 1e-3);
        let floats = [0.25f32, -0.5];
        assert_eq!(pick_channel(&floats, 1, None, &mut out), 2);
        assert_eq!(&out[..2], &[0.25, -0.5]);
    }
}
