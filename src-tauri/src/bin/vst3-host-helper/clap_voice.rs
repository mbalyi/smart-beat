//! CLAP hosting inside the out-of-process plugin helper (#80).
//!
//! The helper speaks one JSON protocol (imported from `vst3_host`) no matter
//! the format: a `.clap` file takes the CLAP path here, a `.vst3` bundle the
//! VST3 path in the main helper file. Either way the plugin lives in this
//! throwaway process, never in the audio engine.
//!
//! Threading follows the helper's: every function except [`process`] runs on
//! the helper's main thread (control commands are delegated there on macOS,
//! everything shares one thread elsewhere). [`process`] runs on the worker
//! thread and only touches the audio processor behind [`AUDIO`]. The CLAP
//! main-thread state lives in a thread-local ([`MAIN`]) so it cannot be
//! touched from the audio path at all.

use std::cell::RefCell;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};

use clack_extensions::audio_ports::{AudioPortInfoBuffer, PluginAudioPorts};
#[cfg(target_os = "macos")]
use clack_extensions::gui::Window;
use clack_extensions::gui::{GuiApiType, GuiConfiguration, PluginGui};
use clack_extensions::latency::PluginLatency;
use clack_extensions::state::PluginState;
use clack_host::entry::PluginEntry;
use clack_host::host::HostInfo;
use clack_host::plugin::PluginInstance;
use clack_host::prelude::*;
use clack_host::process::{
    PluginAudioConfiguration, StartedPluginAudioProcessor, StoppedPluginAudioProcessor,
};

/// No-op CLAP host callbacks: the engine drives the plugin (audio in, audio
/// out, saved state), so the plugin never needs anything back.
type ClapHost = ();

/// What the protocol reports about a loaded plugin (mirrors the VST3
/// `PluginInfo` reply fields the engine uses).
pub struct ClapInfo {
    pub vendor: String,
    pub name: String,
    pub version: String,
    pub category: String,
    pub uid: String,
    pub has_gui: bool,
    pub audio_inputs: i32,
    pub audio_outputs: i32,
    pub output_channels: i32,
}

/// Main-thread CLAP state. `!Send` by design (CLAP main-thread affinity), so
/// it lives in [`MAIN`], reachable only from control commands.
struct ClapMain {
    _entry: PluginEntry,
    instance: PluginInstance<ClapHost>,
}

/// The audio processor, shared with the worker thread. Both states are `Send`
/// (reference-counted plugin internals); the mutex only guards the handover.
enum ClapProc {
    Stopped(StoppedPluginAudioProcessor<ClapHost>),
    Started(StartedPluginAudioProcessor<ClapHost>),
}

/// Everything [`process`] needs. On macOS that runs on the helper's worker
/// thread, which cannot read [`MAIN`] (a thread-local filled on the main
/// thread), so the port channel counts are copied here at load time. Reading
/// them from `MAIN` silently fell back to stereo for mono plugins.
struct ClapAudio {
    proc_: Option<ClapProc>,
    /// Channels of the first input and output audio port.
    channels: (usize, usize),
}

impl Default for ClapAudio {
    fn default() -> Self {
        Self {
            proc_: None,
            channels: (2, 2),
        }
    }
}

thread_local! {
    static MAIN: RefCell<Option<ClapMain>> = const { RefCell::new(None) };
    // Whether `open_editor` currently holds an editor (so `close_editor`
    // and `unload` stay quiet when there is nothing to close). Main thread only.
    static GUI_OPEN: RefCell<bool> = const { RefCell::new(false) };
}

static AUDIO: OnceLock<Mutex<ClapAudio>> = OnceLock::new();

fn audio() -> &'static Mutex<ClapAudio> {
    AUDIO.get_or_init(|| Mutex::new(ClapAudio::default()))
}

fn with_main<T>(f: impl FnOnce(&mut ClapMain) -> Result<T, String>) -> Result<T, String> {
    MAIN.with(|main| {
        let mut main = main.borrow_mut();
        let main = main
            .as_mut()
            .ok_or_else(|| "No plugin loaded".to_string())?;
        f(main)
    })
}

/// Whether `path` selects the CLAP backend: a `.clap` file, or a library
/// inside a `.clap` bundle (macOS wraps the dylib in `Contents/MacOS`).
pub fn is_clap_path(path: &str) -> bool {
    smart_beat_lib::audio::plugin::PluginFormat::of(path)
        == smart_beat_lib::audio::plugin::PluginFormat::Clap
}

/// Resolves a `.clap` file or bundle directory to the library to load.
pub fn entry_path(path: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(path);
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if path.is_dir() {
        let macos = path.join("Contents").join("MacOS");
        if let Ok(entries) = std::fs::read_dir(&macos) {
            for entry in entries.flatten() {
                if entry.path().is_file() {
                    return Some(entry.path());
                }
            }
        }
    }
    None
}

fn host_info() -> Result<HostInfo, String> {
    HostInfo::new(
        "Smart Beat",
        "Smart Beat",
        "https://github.com/mbalyi/smart-beat",
        "1.0.0",
    )
    .map_err(|e| format!("Invalid host info: {e}"))
}

/// The channel counts of the first input and output audio ports (1 or 2;
/// anything else is rejected: the engine is stereo).
fn port_channels(
    handle: &mut clack_host::plugin::PluginMainThreadHandle<'_>,
) -> Result<(usize, usize), String> {
    let Some(ports) = handle.get_extension::<PluginAudioPorts>() else {
        // No audio-ports extension: assume the guitar-plugin standard, stereo in/out.
        return Ok((2, 2));
    };
    let inputs = ports.count(handle, true);
    let outputs = ports.count(handle, false);
    if inputs < 1 || outputs < 1 {
        return Err("The CLAP plugin has no audio input or output port".to_string());
    }
    let in_ch = ports
        .get(handle, 0, true, &mut AudioPortInfoBuffer::new())
        .map(|info| info.channel_count as usize)
        .unwrap_or(2);
    let out_ch = ports
        .get(handle, 0, false, &mut AudioPortInfoBuffer::new())
        .map(|info| info.channel_count as usize)
        .unwrap_or(2);
    if !(1..=2).contains(&in_ch) || !(1..=2).contains(&out_ch) {
        return Err(format!(
            "The CLAP plugin wants {in_ch} input and {out_ch} output channels; only mono and stereo are supported"
        ));
    }
    Ok((in_ch, out_ch))
}

/// Loads a `.clap` file: first plugin, activated at `sample_rate`. Runs on
/// the helper's main thread.
pub fn load(path: &str, sample_rate: f64) -> Result<ClapInfo, String> {
    unload();
    let path =
        entry_path(path).ok_or_else(|| format!("The CLAP plugin cannot be opened: {path}"))?;
    let path = path.to_string_lossy().into_owned();
    let entry = unsafe { PluginEntry::load(&path) }
        .map_err(|e| format!("The CLAP plugin cannot be opened: {e}"))?;
    let factory = entry
        .get_plugin_factory()
        .ok_or_else(|| "The CLAP file has no plugin factory".to_string())?;
    let descriptor = factory
        .plugin_descriptors()
        .next()
        .ok_or_else(|| "The CLAP file contains no plugins".to_string())?;
    let name = descriptor.name().map(|n| n.to_string_lossy().into_owned());
    let vendor = descriptor
        .vendor()
        .map(|v| v.to_string_lossy().into_owned());
    let version = descriptor
        .version()
        .map(|v| v.to_string_lossy().into_owned());
    let id = descriptor
        .id()
        .map(|id| String::from_utf8_lossy(id.to_bytes()).into_owned());
    let category = descriptor
        .features()
        .map(|f| f.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ");
    let plugin_id = descriptor
        .id()
        .ok_or_else(|| "The CLAP plugin has no id".to_string())?;
    let info = host_info()?;
    let mut instance = PluginInstance::<ClapHost>::new(|_| (), |_| (), &entry, plugin_id, &info)
        .map_err(|e| format!("The CLAP plugin cannot be created: {e}"))?;
    let (in_channels, out_channels) = port_channels(&mut instance.plugin_handle())?;
    let handle = instance.plugin_handle();
    let has_gui = gui_supported(&handle).is_some();
    let config = PluginAudioConfiguration {
        sample_rate,
        min_frames_count: 1,
        max_frames_count: 4096,
    };
    let stopped = instance
        .activate(|_, _| (), config)
        .map_err(|e| format!("The CLAP plugin cannot be activated: {e}"))?;
    let started = stopped
        .start_processing()
        .map_err(|e| format!("The CLAP plugin cannot start: {e}"))?;
    {
        let mut audio = audio().lock().unwrap();
        audio.proc_ = Some(ClapProc::Started(started));
        audio.channels = (in_channels, out_channels);
    }
    let reported_in = port_count(&mut instance.plugin_handle(), true);
    let reported_out = port_count(&mut instance.plugin_handle(), false);
    let info = ClapInfo {
        vendor: vendor.unwrap_or_default(),
        name: name.unwrap_or_else(|| "CLAP plugin".to_string()),
        version: version.unwrap_or_default(),
        category,
        uid: id.unwrap_or_default(),
        has_gui,
        audio_inputs: reported_in,
        audio_outputs: reported_out,
        output_channels: out_channels as i32,
    };
    MAIN.with(|main| {
        *main.borrow_mut() = Some(ClapMain {
            _entry: entry,
            instance,
        });
    });
    Ok(info)
}

fn port_count(handle: &mut clack_host::plugin::PluginMainThreadHandle<'_>, is_input: bool) -> i32 {
    handle
        .get_extension::<PluginAudioPorts>()
        .map(|ports| ports.count(handle, is_input) as i32)
        .unwrap_or(1)
}

/// Unloads the plugin, dropping the audio processor on this (main) thread so
/// no de-allocation happens on the audio path.
pub fn unload() {
    close_editor();
    let stopped = {
        let mut audio = audio().lock().unwrap();
        let taken = audio.proc_.take();
        audio.channels = (2, 2);
        match taken {
            Some(ClapProc::Started(started)) => Some(started.stop_processing()),
            Some(ClapProc::Stopped(stopped)) => Some(stopped),
            None => None,
        }
    };
    if let Some(stopped) = stopped {
        MAIN.with(|main| {
            if let Some(main) = main.borrow_mut().as_mut() {
                main.instance.deactivate(stopped);
            }
        });
    }
    MAIN.with(|main| *main.borrow_mut() = None);
}

/// Starts processing after a [`stop`] (a fresh [`load`] already processes).
pub fn start() -> Result<(), String> {
    let mut audio = audio().lock().unwrap();
    match audio.proc_.take() {
        Some(ClapProc::Stopped(stopped)) => {
            audio.proc_ = Some(ClapProc::Started(
                stopped
                    .start_processing()
                    .map_err(|e| format!("The CLAP plugin cannot start: {e}"))?,
            ));
            Ok(())
        }
        other => {
            audio.proc_ = other;
            Ok(())
        }
    }
}

/// Stops processing; [`process`] bypasses until [`start`].
pub fn stop() -> Result<(), String> {
    let mut audio = audio().lock().unwrap();
    match audio.proc_.take() {
        Some(ClapProc::Started(started)) => {
            audio.proc_ = Some(ClapProc::Stopped(started.stop_processing()));
            Ok(())
        }
        other => {
            audio.proc_ = other;
            Ok(())
        }
    }
}

/// Re-activates the plugin at a new sample rate.
pub fn reconfigure(sample_rate: f64) -> Result<(), String> {
    let stopped = {
        let mut audio = audio().lock().unwrap();
        match audio.proc_.take() {
            Some(ClapProc::Started(started)) => started.stop_processing(),
            Some(ClapProc::Stopped(stopped)) => stopped,
            None => return Err("No plugin loaded".to_string()),
        }
    };
    let result = with_main(|main| {
        main.instance.deactivate(stopped);
        let config = PluginAudioConfiguration {
            sample_rate,
            min_frames_count: 1,
            max_frames_count: 4096,
        };
        let stopped = main
            .instance
            .activate(|_, _| (), config)
            .map_err(|e| format!("The CLAP plugin cannot be activated: {e}"))?;
        let started = stopped
            .start_processing()
            .map_err(|e| format!("The CLAP plugin cannot start: {e}"))?;
        audio().lock().unwrap().proc_ = Some(ClapProc::Started(started));
        Ok(())
    });
    if result.is_err() {
        unload();
    }
    result
}

/// Runs one stereo block through the plugin. Called on the worker thread:
/// never touches [`MAIN`], never blocks beyond the mutex. A stopped plugin
/// passes audio through, so a half-loaded chain stays silent-free.
pub fn process(inputs: Vec<Vec<f32>>, frames: u32) -> Result<Vec<Vec<f32>>, String> {
    let frames = frames as usize;
    let mut audio = audio().lock().unwrap();
    // Read before borrowing the processor: the counts come from `load`, so the
    // worker thread sees the loaded plugin's own ports, not a stereo guess.
    let (in_channels, out_channels) = audio.channels;
    let Some(proc_) = audio.proc_.as_mut() else {
        return Err("No plugin loaded".to_string());
    };
    let ClapProc::Started(started) = proc_ else {
        return Ok(bypass(&inputs, frames));
    };
    // The engine is always stereo: fold down (or fan out) at the edges.
    let mut in_bufs: Vec<Vec<f32>> = Vec::with_capacity(in_channels);
    if in_channels == 1 {
        let mut mono = vec![0.0f32; frames];
        let right = inputs.get(1);
        for (i, m) in mono.iter_mut().enumerate() {
            let l = inputs
                .first()
                .and_then(|v| v.get(i))
                .copied()
                .unwrap_or(0.0);
            let r = right.and_then(|v| v.get(i)).copied().unwrap_or(l);
            *m = 0.5 * (l + r);
        }
        in_bufs.push(mono);
    } else {
        for ch in 0..in_channels {
            let mut buf = vec![0.0f32; frames];
            if let Some(src) = inputs.get(ch) {
                buf.copy_from_slice(&src[..frames.min(src.len())]);
            }
            in_bufs.push(buf);
        }
    }
    let mut out_bufs: Vec<Vec<f32>> = (0..out_channels).map(|_| vec![0.0; frames]).collect();
    let result = {
        let mut input_ports = AudioPorts::with_capacity(in_channels, 1);
        let mut output_ports = AudioPorts::with_capacity(out_channels, 1);
        let input_audio = input_ports.with_input_buffers([AudioPortBuffer {
            latency: 0,
            channels: AudioPortBufferType::f32_input_only(
                in_bufs.iter_mut().map(InputChannel::variable),
            ),
        }]);
        let mut output_audio = output_ports.with_output_buffers([AudioPortBuffer {
            latency: 0,
            channels: AudioPortBufferType::f32_output_only(
                out_bufs.iter_mut().map(|b| b.as_mut_slice()),
            ),
        }]);
        let input_events = InputEvents::empty();
        let mut output_events = OutputEvents::void();
        started
            .process(
                &input_audio,
                &mut output_audio,
                &input_events,
                &mut output_events,
                None,
                None,
            )
            .map_err(|e| format!("The CLAP plugin failed to process audio: {e}"))
    };
    match result {
        Ok(_) => {
            // Fan a mono output out to both engine channels.
            if out_bufs.len() == 1 {
                out_bufs.push(out_bufs[0].clone());
            }
            for buf in &mut out_bufs {
                buf.resize(frames, 0.0);
            }
            Ok(out_bufs)
        }
        Err(e) => Err(e),
    }
}

/// Dry pass-through shaped like a stereo plugin reply.
fn bypass(inputs: &[Vec<f32>], frames: usize) -> Vec<Vec<f32>> {
    let mut left = vec![0.0; frames];
    let mut right = vec![0.0; frames];
    if let Some(l) = inputs.first() {
        left.copy_from_slice(&l[..frames.min(l.len())]);
    }
    if let Some(r) = inputs.get(1) {
        right.copy_from_slice(&r[..frames.min(r.len())]);
    } else {
        right.copy_from_slice(&left);
    }
    vec![left, right]
}

/// Serializes the plugin's state (preset).
pub fn save_state() -> Result<Vec<u8>, String> {
    with_main(|main| {
        let handle = main.instance.plugin_handle();
        let state = handle
            .get_extension::<PluginState>()
            .ok_or_else(|| "The CLAP plugin cannot save its settings".to_string())?;
        let mut bytes = Vec::new();
        state
            .save(&handle, &mut bytes)
            .map_err(|e| format!("The CLAP plugin cannot save its settings: {e}"))?;
        Ok(bytes)
    })
}

/// Restores a state previously returned by [`save_state`].
pub fn load_state(data: &[u8]) -> Result<(), String> {
    with_main(|main| {
        let handle = main.instance.plugin_handle();
        let state = handle
            .get_extension::<PluginState>()
            .ok_or_else(|| "The CLAP plugin cannot restore its settings".to_string())?;
        let mut reader = Cursor::new(data);
        state
            .load(&handle, &mut reader)
            .map_err(|e| format!("The CLAP plugin cannot restore its settings: {e}"))
    })
}

/// The plugin's processing latency in samples (0 when unreported).
pub fn latency_samples() -> u32 {
    with_main(|main| {
        let handle = main.instance.plugin_handle();
        Ok(handle
            .get_extension::<PluginLatency>()
            .map(|latency| latency.get(&handle))
            .unwrap_or(0))
    })
    .unwrap_or(0)
}

/// Whether the plugin offers an embeddable editor on this platform.
fn gui_supported(
    handle: &clack_host::plugin::PluginMainThreadHandle<'_>,
) -> Option<(PluginGui, GuiApiType<'static>)> {
    let gui = handle.get_extension::<PluginGui>()?;
    let api = GuiApiType::default_for_current_platform()?;
    gui.is_api_supported(
        handle,
        GuiConfiguration {
            api_type: api,
            is_floating: false,
        },
    )
    .then_some((gui, api))
}

/// Whether the plugin has an embeddable editor on this platform. Only the
/// macOS helper can show one, so the rest compiles without it.
#[cfg(target_os = "macos")]
pub fn has_editor() -> bool {
    with_main(|main| {
        let handle = main.instance.plugin_handle();
        Ok(gui_supported(&handle).is_some())
    })
    .unwrap_or(false)
}

/// The editor's size, if the plugin reports one. macOS helper only.
#[cfg(target_os = "macos")]
pub fn editor_size() -> Option<(u32, u32)> {
    with_main(|main| {
        let handle = main.instance.plugin_handle();
        let (gui, _) = gui_supported(&handle)
            .ok_or_else(|| "The CLAP plugin has no embeddable editor".to_string())?;
        let size = gui
            .get_size(&handle)
            .ok_or_else(|| "The CLAP plugin reports no editor size".to_string())?;
        Ok((size.width, size.height))
    })
    .ok()
}

/// Embeds the editor into `parent` (a live `NSView` on macOS) and shows it.
/// The view must stay alive until [`close_editor`].
///
/// # Safety
///
/// `parent` must point to a live view owned by the caller.
#[cfg(target_os = "macos")]
pub unsafe fn open_editor(parent: *mut std::ffi::c_void) -> Result<(), String> {
    with_main(|main| {
        let handle = main.instance.plugin_handle();
        let (gui, api) = gui_supported(&handle)
            .ok_or_else(|| "The CLAP plugin has no embeddable editor".to_string())?;
        let config = || GuiConfiguration {
            api_type: api,
            is_floating: false,
        };
        gui.create(&handle, config())
            .map_err(|e| format!("The CLAP editor cannot be created: {e}"))?;
        let window = Window::from_generic_ptr(api, parent);
        let attached = unsafe { gui.set_parent(&handle, window) }
            .map(|_| true)
            .unwrap_or(false);
        if !attached {
            gui.destroy(&handle);
            return Err("The CLAP editor cannot be attached".to_string());
        }
        if let Err(e) = gui.show(&handle) {
            gui.destroy(&handle);
            return Err(format!("The CLAP editor cannot be shown: {e}"));
        }
        GUI_OPEN.with(|open| *open.borrow_mut() = true);
        Ok(())
    })
}

/// Hides and destroys the editor opened by [`open_editor`].
#[cfg(target_os = "macos")]
pub fn close_editor() {
    let open = GUI_OPEN.with(|open| std::mem::replace(&mut *open.borrow_mut(), false));
    if !open {
        return;
    }
    let _ = with_main(|main| {
        let handle = main.instance.plugin_handle();
        if let Some(gui) = handle.get_extension::<PluginGui>() {
            let _ = gui.hide(&handle);
            gui.destroy(&handle);
        }
        Ok(())
    });
}

/// No native parent on other platforms yet: only macOS can embed an editor, so
/// `close_editor` stays a no-op there rather than reporting an error.
#[cfg(not(target_os = "macos"))]
pub fn close_editor() {}
