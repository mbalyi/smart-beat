//! MIDI input (ADR 0006): pad controllers, keyboards, electronic drum kits and the app's own
//! on-screen pads, played on the armed MIDI lane and recorded with their place in the song.
//!
//! - A scan every 1.5 s (on the main thread, where CoreMIDI keeps its device list current)
//!   connects new ports and lets go of removed ones, and tells the app when the list changes.
//! - The driver's callback only stamps the time and hands the bytes to the router thread.
//! - The router applies the device's settings (channel filter, pad map, fixed velocity,
//!   controls), plays the note on the armed lane through the engine's lock-free queue, stamps
//!   it with the timeline position the player heard for the recorder, and reports activity,
//!   learned controls and control actions to the app.

pub mod mapping;
pub mod message;

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::audio::AudioState;
use crate::error::{CommandError, ErrorKind};
use mapping::{DeviceSettings, DeviceStore, PadPreset, Routed, settings_for};
use message::MidiMessage;

/// The name the app's own pads and computer keyboard play under.
pub const ON_SCREEN: &str = "On-screen pads";
/// How often the device list is checked.
const SCAN_EVERY: Duration = Duration::from_millis(1_500);
/// The most messages one recording keeps.
const MAX_RECORDED: usize = 200_000;
/// The most messages one injection call carries.
const MAX_INJECT: usize = 256;

/// A message from a device, with when it arrived.
struct Incoming {
    device: Arc<str>,
    at: Instant,
    bytes: [u8; 8],
    len: usize,
}

/// A note or controller recorded with its place on the audio timeline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedEvent {
    /// Timeline ms the player heard when it was played (the device's offset applied).
    pub ms: f64,
    pub status: u8,
    pub d1: u8,
    pub d2: u8,
}

struct Recording {
    latency_ms: f64,
    events: Vec<RecordedEvent>,
}

/// What the app shows about a device.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub name: String,
    pub connected: bool,
    pub settings: DeviceSettings,
}

/// A note, controller or button seen on a device (the test light and learn).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub device: String,
    /// "note", "cc", "bend", "pressure", "program" or "transport".
    pub kind: &'static str,
    pub chan: u8,
    /// The note or controller number as sent (before the pad map).
    pub number: u8,
    pub value: i32,
    /// The note it plays after the pad map (notes only).
    pub plays: Option<u8>,
}

/// A mapped knob or button was used.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEvent {
    pub action: mapping::ControlAction,
    pub value: Option<f32>,
    pub relative: bool,
}

#[derive(Default)]
struct Inner {
    settings: Vec<DeviceSettings>,
    /// Ports seen by the last scan.
    ports: Vec<String>,
    connections: HashMap<String, midir::MidiInputConnection<()>>,
    /// Port name → why it could not be opened.
    errors: HashMap<String, String>,
    recording: Option<Recording>,
    /// Notes held now, by lane (to release them when a device goes or the lane changes).
    held: HashMap<(u8, u8), String>,
}

/// MIDI input, managed by Tauri.
pub struct MidiState {
    inner: Arc<Mutex<Inner>>,
    tx: Sender<Incoming>,
    rx: Mutex<Option<Receiver<Incoming>>>,
    store: DeviceStore,
}

impl MidiState {
    pub fn new(dir: std::path::PathBuf) -> Self {
        let store = DeviceStore::new(&dir);
        let (tx, rx) = channel();
        Self {
            inner: Arc::new(Mutex::new(Inner {
                settings: store.load(),
                ..Default::default()
            })),
            tx,
            rx: Mutex::new(Some(rx)),
            store,
        }
    }

    /// Starts the router and the device scan (once, after the app is set up).
    pub fn start<R: Runtime>(&self, app: &AppHandle<R>) {
        let Some(rx) = self.rx.lock().unwrap().take() else {
            return;
        };
        let inner = self.inner.clone();
        let router_app = app.clone();
        std::thread::Builder::new()
            .name("midi-router".into())
            .spawn(move || route_loop(router_app, inner, rx))
            .ok();
        let scan_app = app.clone();
        std::thread::Builder::new()
            .name("midi-scan".into())
            .spawn(move || {
                loop {
                    let app = scan_app.clone();
                    // CoreMIDI updates its port list for clients on a thread with a run loop.
                    if scan_app.run_on_main_thread(move || scan(&app)).is_err() {
                        break;
                    }
                    std::thread::sleep(SCAN_EVERY);
                }
            })
            .ok();
    }

    fn views(&self) -> Vec<DeviceView> {
        let inner = self.inner.lock().unwrap();
        let mut views: Vec<DeviceView> = inner
            .ports
            .iter()
            .map(|name| DeviceView {
                name: name.clone(),
                connected: inner.connections.contains_key(name),
                settings: settings_for(&inner.settings, name)
                    .cloned()
                    .unwrap_or_else(|| DeviceSettings::new(name)),
            })
            .collect();
        for s in &inner.settings {
            if !views.iter().any(|v| v.settings.name == s.name) {
                views.push(DeviceView {
                    name: s.name.clone(),
                    connected: false,
                    settings: s.clone(),
                });
            }
        }
        views
    }
}

/// Lists the ports, connects enabled new ones and lets go of the removed or disabled ones.
fn scan<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MidiState>();
    let Ok(probe) = midir::MidiInput::new("Smart Beat scan") else {
        return;
    };
    let names: Vec<String> = probe
        .ports()
        .iter()
        .filter_map(|p| probe.port_name(p).ok())
        .collect();
    let mut changed = false;
    let mut released: Vec<String> = Vec::new();
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.ports != names {
            inner.ports = names.clone();
            changed = true;
        }
        let gone: Vec<String> = inner
            .connections
            .keys()
            .filter(|name| {
                !names.contains(name)
                    || settings_for(&inner.settings, name).is_some_and(|s| !s.enabled)
            })
            .cloned()
            .collect();
        for name in gone {
            if let Some(connection) = inner.connections.remove(&name) {
                connection.close();
                released.push(name);
                changed = true;
            }
        }
        for name in &names {
            let enabled = settings_for(&inner.settings, name).is_none_or(|s| s.enabled);
            if !enabled || inner.connections.contains_key(name) {
                continue;
            }
            match connect(name, state.tx.clone()) {
                Ok(connection) => {
                    inner.errors.remove(name);
                    inner.connections.insert(name.clone(), connection);
                    changed = true;
                }
                Err(e) => {
                    if inner.errors.insert(name.clone(), e).is_none() {
                        changed = true;
                    }
                }
            }
        }
    }
    // A device that went away mid-note must not leave a note hanging.
    if !released.is_empty() {
        app.state::<AudioState>().midi_panic();
        state.inner.lock().unwrap().held.clear();
    }
    if changed {
        let _ = app.emit("midi://devices", state.views());
    }
}

fn connect(name: &str, tx: Sender<Incoming>) -> Result<midir::MidiInputConnection<()>, String> {
    let mut input = midir::MidiInput::new("Smart Beat").map_err(|e| e.to_string())?;
    // Transport buttons send MIDI Machine Control as system exclusive messages.
    input.ignore(midir::Ignore::TimeAndActiveSense);
    let port = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).is_ok_and(|n| n == name))
        .ok_or("the device is gone")?;
    let device: Arc<str> = Arc::from(name);
    input
        .connect(
            &port,
            "Smart Beat input",
            move |_stamp, bytes, _| {
                // Keep the driver's thread quick and never let a panic reach it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut buf = [0u8; 8];
                    let len = bytes.len().min(8);
                    buf[..len].copy_from_slice(&bytes[..len]);
                    let _ = tx.send(Incoming {
                        device: device.clone(),
                        at: Instant::now(),
                        bytes: buf,
                        len,
                    });
                }));
            },
            (),
        )
        .map_err(|e| e.to_string())
}

fn route_loop<R: Runtime>(app: AppHandle<R>, inner: Arc<Mutex<Inner>>, rx: Receiver<Incoming>) {
    let audio = app.state::<AudioState>();
    let clock = audio.timeline_clock();
    while let Ok(incoming) = rx.recv() {
        let Some(message) = MidiMessage::decode(&incoming.bytes[..incoming.len]) else {
            continue;
        };
        let settings = {
            let inner = inner.lock().unwrap();
            settings_for(&inner.settings, &incoming.device)
                .cloned()
                .unwrap_or_else(|| DeviceSettings::new(&incoming.device))
        };
        let routed = if &*incoming.device == ON_SCREEN {
            Routed::Play(message)
        } else {
            settings.route(message)
        };
        let _ = app.emit(
            "midi://activity",
            activity(&incoming.device, message, routed),
        );
        match routed {
            Routed::Ignored => {}
            Routed::Action(action, value) => {
                let _ = app.emit(
                    "midi://control",
                    ControlEvent {
                        action,
                        value: value.map(|v| v.0),
                        relative: value.is_some_and(|v| v.1),
                    },
                );
            }
            Routed::Play(played) => {
                let Some(bytes) = played.bytes() else {
                    continue;
                };
                let lane = audio.live_lane();
                let mut inner = inner.lock().unwrap();
                track_held(&mut inner.held, played, lane.as_deref());
                if let Some(lane) = &lane {
                    let _ = audio.live_queue(lane).push(bytes);
                }
                if let Some(rec) = &mut inner.recording
                    && rec.events.len() < MAX_RECORDED
                    && let Some(ms) = clock.timeline_ms(incoming.at, rec.latency_ms)
                {
                    rec.events.push(RecordedEvent {
                        ms: ms + settings.offset_ms,
                        status: bytes[0],
                        d1: bytes[1],
                        d2: bytes[2],
                    });
                }
            }
        }
    }
}

/// Remembers which notes sound, so they can be let go when a device disappears.
fn track_held(held: &mut HashMap<(u8, u8), String>, message: MidiMessage, lane: Option<&str>) {
    match (message, lane) {
        (MidiMessage::NoteOn { chan, key, .. }, Some(lane)) => {
            held.insert((chan, key), lane.to_string());
        }
        (MidiMessage::NoteOff { chan, key }, _) => {
            held.remove(&(chan, key));
        }
        _ => {}
    }
}

fn activity(device: &str, message: MidiMessage, routed: Routed) -> Activity {
    let plays = match routed {
        Routed::Play(MidiMessage::NoteOn { key, .. }) => Some(key),
        _ => None,
    };
    let (kind, chan, number, value) = match message {
        MidiMessage::NoteOn { chan, key, vel } => ("note", chan, key, vel as i32),
        MidiMessage::NoteOff { chan, key } => ("noteOff", chan, key, 0),
        MidiMessage::Cc { chan, cc, value } => ("cc", chan, cc, value as i32),
        MidiMessage::Bend { chan, value } => ("bend", chan, 0, value as i32),
        MidiMessage::Pressure { chan, value } => ("pressure", chan, 0, value as i32),
        MidiMessage::PolyPressure { chan, key, value } => ("pressure", chan, key, value as i32),
        MidiMessage::Program { chan, program } => ("program", chan, program, 0),
        MidiMessage::Transport(_) => ("transport", 0, 0, 0),
    };
    Activity {
        device: device.to_string(),
        kind,
        chan,
        number,
        value,
        plays,
    }
}

fn midi_error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::InvalidSettings, message.into())
}

/// The MIDI devices: connected ones and remembered ones.
#[tauri::command]
pub fn midi_devices(state: State<'_, MidiState>) -> Vec<DeviceView> {
    state.views()
}

/// Saves a device's settings (alias, offset, channel, pad map, controls, on or off).
#[tauri::command]
pub fn midi_device_update<R: Runtime>(
    settings: DeviceSettings,
    app: AppHandle<R>,
    state: State<'_, MidiState>,
) -> Result<Vec<DeviceView>, CommandError> {
    settings.validate().map_err(midi_error)?;
    let all = {
        let mut inner = state.inner.lock().unwrap();
        if let Some(existing) = inner.settings.iter_mut().find(|d| d.name == settings.name) {
            *existing = settings.clone();
        } else if inner.settings.len() < mapping::MAX_DEVICES {
            inner.settings.push(settings.clone());
        } else {
            return Err(midi_error("Too many MIDI devices are remembered"));
        }
        if !settings.enabled
            && let Some(connection) = inner.connections.remove(&settings.name)
        {
            connection.close();
        }
        inner.settings.clone()
    };
    state.store.save(&all).map_err(midi_error)?;
    let views = state.views();
    let _ = app.emit("midi://devices", views.clone());
    Ok(views)
}

/// Forgets a device's settings.
#[tauri::command]
pub fn midi_device_forget(
    name: String,
    state: State<'_, MidiState>,
) -> Result<Vec<DeviceView>, CommandError> {
    let all = {
        let mut inner = state.inner.lock().unwrap();
        inner.settings.retain(|d| d.name != name);
        inner.settings.clone()
    };
    state.store.save(&all).map_err(midi_error)?;
    Ok(state.views())
}

/// A ready-made pad map for pads that send notes from `first` on.
#[tauri::command]
pub fn midi_pad_preset(preset: PadPreset, first: u8, count: usize) -> Vec<mapping::PadRoute> {
    mapping::preset_pads(preset, first.min(127), count.min(mapping::MAX_PAD_MAP))
}

/// Starts recording what is played on the armed lane. `latency_ms` is the output's delay: a
/// note is placed where the player heard the song when they played it.
#[tauri::command]
pub fn midi_record_start(latency_ms: f64, state: State<'_, MidiState>) -> Result<(), CommandError> {
    if !latency_ms.is_finite() || !(0.0..=1_000.0).contains(&latency_ms) {
        return Err(midi_error("Invalid output latency"));
    }
    state.inner.lock().unwrap().recording = Some(Recording {
        latency_ms,
        events: Vec::new(),
    });
    Ok(())
}

/// Stops recording and hands over what was played, in timeline ms.
#[tauri::command]
pub fn midi_record_stop(state: State<'_, MidiState>) -> Vec<RecordedEvent> {
    state
        .inner
        .lock()
        .unwrap()
        .recording
        .take()
        .map(|r| r.events)
        .unwrap_or_default()
}

/// Plays the app's own pads or computer keyboard like a device (heard and recorded).
#[tauri::command]
pub fn midi_inject(
    messages: Vec<[u8; 3]>,
    state: State<'_, MidiState>,
) -> Result<(), CommandError> {
    if messages.len() > MAX_INJECT {
        return Err(midi_error("Too many MIDI messages"));
    }
    let at = Instant::now();
    for m in messages {
        if m[0] < 0x80 || m[0] >= 0xf0 || m[1] > 127 || m[2] > 127 {
            return Err(midi_error("Invalid MIDI message"));
        }
        let mut bytes = [0u8; 8];
        bytes[..3].copy_from_slice(&m);
        let _ = state.tx.send(Incoming {
            device: Arc::from(ON_SCREEN),
            at,
            bytes,
            len: 3,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_notes_follow_note_on_and_off() {
        let mut held = HashMap::new();
        track_held(
            &mut held,
            MidiMessage::NoteOn {
                chan: 9,
                key: 36,
                vel: 1,
            },
            Some("lane"),
        );
        assert_eq!(held.len(), 1);
        track_held(&mut held, MidiMessage::NoteOff { chan: 9, key: 36 }, None);
        assert!(held.is_empty());
    }

    #[test]
    fn activity_reports_the_sent_and_the_played_note() {
        let a = activity(
            "Pads",
            MidiMessage::NoteOn {
                chan: 9,
                key: 37,
                vel: 90,
            },
            Routed::Play(MidiMessage::NoteOn {
                chan: 9,
                key: 38,
                vel: 90,
            }),
        );
        assert_eq!(
            (a.kind, a.number, a.plays, a.value),
            ("note", 37, Some(38), 90)
        );
    }
}
