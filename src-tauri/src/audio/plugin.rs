//! Third-party plugins (VST3 and CLAP) as pedalboard blocks (#80).
//!
//! The plugin itself always runs in the out-of-process helper
//! (`src/bin/vst3-host-helper.rs`), one helper process per loaded plugin, so
//! a crashing plugin can never take down the audio engine or the app. The
//! audio thread never talks to the helper: it drops input blocks into a
//! slot and picks up the latest finished output, both with `try_lock`. When
//! the helper is behind, crashed or gone, the block passes audio through dry
//! and the worker thread reloads or recovers it in the background.
//!
//! The added latency is the plugin's own latency plus one engine block for
//! the handover; [`PluginWorker::latency_samples`] reports it and the UI
//! shows it under the block.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::Duration;

use super::plugin_process::HelperProcess;
use super::plugin_wire::{
    AUDIO_PROTOCOL_VERSION, AudioCommand, Command, MAX_AUDIO_FRAMES, SharedAudio,
};
use serde::{Deserialize, Serialize};
use vst3_host::process_isolation::{HostCommand, HostResponse};

/// VST3 or CLAP, as stored in a chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginFormat {
    Vst3,
    Clap,
}

impl PluginFormat {
    /// Picks the backend by path: `.clap` files (or libraries inside a
    /// `.clap` bundle) are CLAP, everything else VST3.
    pub fn of(path: &str) -> Self {
        let as_path = Path::new(path);
        if as_path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("clap"))
            || as_path.components().any(|c| {
                c.as_os_str()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".clap")
            })
        {
            Self::Clap
        } else {
            Self::Vst3
        }
    }
}

/// One plugin slot, as stored in a chain.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginSpec {
    pub format: PluginFormat,
    pub path: String,
    pub state: Vec<u8>,
}

/// A plugin found on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPlugin {
    pub format: PluginFormat,
    pub path: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub has_gui: bool,
}

/// What a scan found.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginScanReport {
    pub plugins: Vec<ScannedPlugin>,
    /// Installed files that could not be loaded (crashed, timed out, ...).
    pub skipped: Vec<String>,
}

/// Live status of one plugin block, for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSlotInfo {
    pub index: usize,
    pub name: String,
    pub latency_samples: u32,
    pub alive: bool,
    /// The last failure in plain words (empty while healthy).
    pub error: String,
}

/// How long a helper may take to answer one audio block before it counts as
/// hung (the worker kills and recovers it; the audio thread never waits).
const PROCESS_TIMEOUT: Duration = Duration::from_secs(2);
/// How long loading a plugin or its state may take (cold module loads are slow).
const SLOW_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a scan probe may take per plugin.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// Finds the helper binary: an explicit override for tests and deployments,
/// else `vst3-host-helper` next to the running executable (Tauri ships it as
/// a sidecar; `cargo build` puts it next to the test binaries too).
pub fn helper_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SMART_BEAT_PLUGIN_HELPER").map(PathBuf::from) {
        return Some(dir);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // Cargo's binary and the staged Tauri sidecar have different names:
    // tauri-build copies sidecars next to dev/test executables and must not
    // overwrite Cargo's freshly built helper with an older staged release.
    for name in ["vst3-host-helper", "smart-beat-plugin-helper"] {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        let beside = dir.join(&name);
        if beside.exists() {
            return Some(beside);
        }
        if dir.file_name().is_some_and(|n| n == "deps") {
            let sibling = dir.parent()?.join(&name);
            if sibling.exists() {
                return Some(sibling);
            }
        }
    }
    None
}

fn friendly(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "plugin".to_string())
}

/// Default plugin folders per platform.
fn scan_dirs(format: PluginFormat) -> Vec<PathBuf> {
    let home = dirs_home();
    let (vst3, clap): (Vec<&str>, Vec<&str>) = if cfg!(target_os = "macos") {
        (
            vec!["/Library/Audio/Plug-Ins/VST3"],
            vec!["/Library/Audio/Plug-Ins/CLAP"],
        )
    } else if cfg!(target_os = "windows") {
        (
            vec!["C:\\Program Files\\Common Files\\VST3"],
            vec!["C:\\Program Files\\Common Files\\CLAP"],
        )
    } else {
        (
            vec!["/usr/lib/vst3", "/usr/local/lib/vst3"],
            vec!["/usr/lib/clap", "/usr/local/lib/clap"],
        )
    };
    let user = home
        .map(|h| {
            if cfg!(target_os = "macos") {
                vec![
                    h.join("Library/Audio/Plug-Ins/VST3"),
                    h.join("Library/Audio/Plug-Ins/CLAP"),
                ]
            } else if cfg!(target_os = "windows") {
                vec![
                    h.join("AppData/Local/Programs/Common/VST3"),
                    h.join("AppData/Local/Programs/Common/CLAP"),
                ]
            } else {
                vec![h.join(".vst3"), h.join(".clap")]
            }
        })
        .unwrap_or_default();
    let system = match format {
        PluginFormat::Vst3 => vst3,
        PluginFormat::Clap => clap,
    }
    .into_iter()
    .map(PathBuf::from);
    user.into_iter()
        .filter(|dir| match format {
            PluginFormat::Vst3 => dir.to_string_lossy().contains("VST3") || dir.ends_with(".vst3"),
            PluginFormat::Clap => dir.to_string_lossy().contains("CLAP") || dir.ends_with(".clap"),
        })
        .chain(system)
        .collect()
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Candidate plugin paths: `.vst3` bundles and `.clap` files or bundles.
fn candidates(format: PluginFormat) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in scan_dirs(format) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let matches = match format {
                PluginFormat::Vst3 => path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("vst3")),
                PluginFormat::Clap => path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("clap")),
            };
            if matches {
                out.push(path);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Probes one plugin in a throwaway helper: loads it, reads its info, shuts
/// down. A crash or timeout skips the file, never the scan.
fn probe(helper: &Path, path: &Path, sample_rate: f64) -> Result<ScannedPlugin, String> {
    let format = PluginFormat::of(&path.to_string_lossy());
    match format {
        PluginFormat::Vst3 => probe_vst3(helper, path, sample_rate),
        PluginFormat::Clap => probe_clap(helper, path, sample_rate),
    }
}

fn probe_vst3(helper: &Path, path: &Path, sample_rate: f64) -> Result<ScannedPlugin, String> {
    let mut host = vst3_host::Vst3Host::builder()
        .sample_rate(sample_rate)
        .block_size(64)
        .with_process_isolation(true)
        .helper_path(helper)
        .response_timeout(PROCESS_TIMEOUT)
        .build()
        .map_err(|e| format!("The plugin helper cannot start: {e}"))?;
    let plugin = host
        .load_plugin(path)
        .map_err(|e| format!("{}: {e}", friendly(&path.to_string_lossy())))?;
    let info = plugin.info();
    Ok(ScannedPlugin {
        format: PluginFormat::Vst3,
        path: path.to_string_lossy().into_owned(),
        name: if info.name.is_empty() {
            friendly(&path.to_string_lossy())
        } else {
            info.name.clone()
        },
        vendor: info.vendor.clone(),
        version: info.version.clone(),
        has_gui: info.has_gui,
    })
}

fn probe_clap(helper: &Path, path: &Path, sample_rate: f64) -> Result<ScannedPlugin, String> {
    use vst3_host::process_isolation::{HostCommand, HostResponse, PluginHostProcess};
    let mut process = PluginHostProcess::new(Some(helper.to_path_buf()), PROBE_TIMEOUT)
        .map_err(|e| format!("The plugin helper cannot start: {e}"))?;
    process.set_slow_command_timeout(SLOW_TIMEOUT);
    let response = process
        .send_command(HostCommand::LoadPlugin {
            path: path.to_string_lossy().into_owned(),
            sample_rate,
            block_size: 64,
            tempo: 120.0,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
            class_id: None,
        })
        .map_err(|e| format!("{}: {e}", friendly(&path.to_string_lossy())))?;
    match response {
        HostResponse::PluginInfo {
            name,
            vendor,
            version,
            has_gui,
            ..
        } => Ok(ScannedPlugin {
            format: PluginFormat::Clap,
            path: path.to_string_lossy().into_owned(),
            name: if name.is_empty() {
                friendly(&path.to_string_lossy())
            } else {
                name
            },
            vendor,
            version,
            has_gui,
        }),
        HostResponse::Error { message } => {
            Err(format!("{}: {message}", friendly(&path.to_string_lossy())))
        }
        _ => Err(format!(
            "{}: the plugin did not answer the scan",
            friendly(&path.to_string_lossy())
        )),
    }
}

/// Scans the standard folders for VST3 and CLAP plugins, probing each in
/// isolation (eight at a time). Never throws: bad plugins are skipped.
pub fn scan() -> Result<PluginScanReport, String> {
    let helper = helper_path().ok_or_else(|| {
        "The plugin helper is missing from the installation, so no plugins can be listed"
            .to_string()
    })?;
    let paths: Vec<(PluginFormat, PathBuf)> = [PluginFormat::Vst3, PluginFormat::Clap]
        .into_iter()
        .flat_map(|f| candidates(f).into_iter().map(move |p| (f, p)))
        .collect();
    let report = Mutex::new(PluginScanReport::default());
    std::thread::scope(|scope| {
        for chunk in paths.chunks(8) {
            let mut handles = Vec::new();
            for (_, path) in chunk {
                let helper = &helper;
                let report = &report;
                handles.push(scope.spawn(move || {
                    let result = probe(helper, path, 48_000.0);
                    let mut report = report.lock().unwrap();
                    match result {
                        Ok(plugin) => report.plugins.push(plugin),
                        Err(skipped) => report.skipped.push(skipped),
                    }
                }));
            }
            for handle in handles {
                let _ = handle.join();
            }
        }
    });
    let mut report = report.into_inner().unwrap();
    report.plugins.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(report)
}

// --- Workers ---------------------------------------------------------------

/// Handover slots between the audio thread and a worker thread. Only
/// `try_lock` touches these from the audio thread.
#[derive(Debug)]
struct AudioSlot {
    seq: u64,
    frames: usize,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl AudioSlot {
    fn new() -> Self {
        Self {
            seq: 0,
            frames: 0,
            left: vec![0.0; MAX_AUDIO_FRAMES],
            right: vec![0.0; MAX_AUDIO_FRAMES],
        }
    }
}

#[derive(Debug)]
struct WorkerStatus {
    latency: u32,
    alive: bool,
    error: String,
}

type AudioResult = Result<(Vec<f32>, Vec<f32>), String>;

enum CtrlCmd {
    Process(Vec<f32>, Vec<f32>, mpsc::Sender<AudioResult>),
    Reconfigure(f32, mpsc::Sender<Result<u32, String>>),
    LoadState(Vec<u8>, mpsc::Sender<Result<(), String>>),
    SaveState(mpsc::Sender<Result<Vec<u8>, String>>),
    OpenEditor(mpsc::Sender<Result<(i32, i32), String>>),
    CloseEditor,
}

/// One loaded plugin: a helper process plus the background thread driving it.
/// Owned by one chain block. Different blocks never share an audio slot or
/// mutable plugin state, even when they load the same file.
#[derive(Debug)]
pub struct PluginWorker {
    enabled: Arc<AtomicBool>,
    sequence: AtomicU64,
    offline: bool,
    ctrl_tx: mpsc::Sender<CtrlCmd>,
    in_slot: Arc<Mutex<AudioSlot>>,
    out_slot: Arc<Mutex<AudioSlot>>,
    status: Mutex<WorkerStatus>,
    state: Mutex<Vec<u8>>,
    /// The sample rate the helper runs at (reconfigured, never reloaded).
    rate: Mutex<f32>,
}

/// Address of one live block. Export workers use a separate pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PluginInstance {
    pub track: Option<usize>,
    pub sound: usize,
    pub index: usize,
}

impl PluginWorker {
    /// Hands one stereo block to the worker (drops it when the worker is
    /// behind: the audio thread never waits).
    pub fn push(&self, left: &[f32], right: &[f32]) {
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        if !self.enabled.load(Ordering::Acquire)
            || left.len() != right.len()
            || left.is_empty()
            || left.len() > MAX_AUDIO_FRAMES
        {
            return;
        }
        let Ok(mut slot) = self.in_slot.try_lock() else {
            return;
        };
        slot.frames = left.len();
        slot.left[..left.len()].copy_from_slice(left);
        slot.right[..right.len()].copy_from_slice(right);
        slot.seq = seq;
    }

    pub fn process_offline(&self, left: &mut [f32], right: &mut [f32]) {
        if !self.enabled.load(Ordering::Acquire) {
            return;
        }
        if let Ok(Ok((out_l, out_r))) =
            self.ctrl(|reply| CtrlCmd::Process(left.to_vec(), right.to_vec(), reply))
        {
            left.copy_from_slice(&out_l);
            right.copy_from_slice(&out_r);
        }
    }

    pub fn offline(&self) -> bool {
        self.offline
    }

    /// The latest finished block, copied into `left`/`right` when newer than
    /// `seen`. Returns its sequence number. Allocates nothing: the audio
    /// thread must never wait on the worker.
    pub fn take_into(&self, seen: u64, left: &mut [f32], right: &mut [f32]) -> Option<u64> {
        if !self.enabled.load(Ordering::Acquire) {
            return None;
        }
        let slot = self.out_slot.try_lock().ok()?;
        if slot.seq <= seen
            || slot.seq == 0
            || slot.seq.checked_add(1) != Some(self.sequence.load(Ordering::Relaxed))
        {
            return None;
        }
        // The worker answers with the block it was given; a size change in
        // between (engine block vs. render tail) skips one block, never panics.
        if slot.frames != left.len() || slot.frames != right.len() {
            return None;
        }
        left.copy_from_slice(&slot.left[..slot.frames]);
        right.copy_from_slice(&slot.right[..slot.frames]);
        Some(slot.seq)
    }

    /// The newest input sequence handed over (to drop stale output after a seek).
    pub fn in_seq(&self) -> Option<u64> {
        Some(self.sequence.load(Ordering::Relaxed))
    }

    pub fn latency_samples(&self) -> u32 {
        self.status.lock().unwrap().latency
    }

    pub fn alive(&self) -> bool {
        self.status.lock().unwrap().alive
    }

    pub fn error(&self) -> String {
        self.status.lock().unwrap().error.clone()
    }

    fn set_status(&self, alive: bool, error: String) {
        let mut status = self.status.lock().unwrap();
        status.alive = alive;
        status.error = error;
    }

    fn ctrl<T>(&self, f: impl FnOnce(mpsc::Sender<T>) -> CtrlCmd) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.ctrl_tx
            .send(f(tx))
            .map_err(|_| "The plugin stopped responding".to_string())?;
        rx.recv_timeout(Duration::from_secs(25))
            .map_err(|_| "The plugin timed out".to_string())
    }

    fn flatten<T>(nested: Result<Result<T, String>, String>) -> Result<T, String> {
        match nested {
            Ok(inner) => inner,
            Err(e) => Err(e),
        }
    }

    /// Brings the helper to `sample_rate` without reloading (keeps state).
    pub fn ensure_rate(&self, sample_rate: f32) -> Result<(), String> {
        if (*self.rate.lock().unwrap() - sample_rate).abs() < 1.0 {
            return Ok(());
        }
        let latency = Self::flatten(self.ctrl(|tx| CtrlCmd::Reconfigure(sample_rate, tx)))?;
        *self.rate.lock().unwrap() = sample_rate;
        self.status.lock().unwrap().latency = latency;
        Ok(())
    }

    pub fn apply_state(&self, state: &[u8]) -> Result<(), String> {
        if *self.state.lock().unwrap() == state {
            return Ok(());
        }
        let result = Self::flatten(self.ctrl(|tx| CtrlCmd::LoadState(state.to_vec(), tx)));
        if result.is_ok() {
            *self.state.lock().unwrap() = state.to_vec();
        }
        result
    }

    pub fn save_state(&self) -> Result<Vec<u8>, String> {
        let state = Self::flatten(self.ctrl(CtrlCmd::SaveState))?;
        *self.state.lock().unwrap() = state.clone();
        Ok(state)
    }

    pub fn open_editor(&self) -> Result<(i32, i32), String> {
        Self::flatten(self.ctrl(CtrlCmd::OpenEditor))
    }

    pub fn close_editor(&self) {
        let _ = self.ctrl_tx.send(CtrlCmd::CloseEditor);
    }
}

/// Weak registry for editor/status lookup. Each build creates independent workers;
/// the chain owns them, and dropping its final block disconnects its helper.
pub struct PluginPool {
    enabled: Arc<AtomicBool>,
    offline: bool,
    helper: Option<PathBuf>,
    workers: Mutex<HashMap<PluginInstance, (PluginSpec, Weak<PluginWorker>)>>,
}

impl Default for PluginPool {
    fn default() -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            offline: false,
            helper: None,
            workers: Mutex::new(HashMap::new()),
        }
    }
}

impl PluginPool {
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    /// Explicit helper location for deployments and integration tests.
    pub fn with_helper(mut self, helper: PathBuf) -> Self {
        self.helper = Some(helper);
        self
    }

    pub fn for_offline(&self) -> Self {
        Self {
            enabled: self.enabled.clone(),
            offline: true,
            helper: self.helper.clone(),
            workers: Mutex::new(HashMap::new()),
        }
    }

    /// Always creates an instance; plugin path and preset never identify an instance.
    pub fn load(
        &self,
        instance: Option<PluginInstance>,
        spec: &PluginSpec,
        sample_rate: f32,
    ) -> Result<Arc<PluginWorker>, String> {
        if !self.enabled() {
            return Err("Third-party plugins are switched off. Switch them on to use this block — your own plugins run as third-party code.".into());
        }
        if !Path::new(&spec.path).exists() {
            return Err(format!(
                "This plugin is not installed ({}). Install it, then it plays again.",
                friendly(&spec.path)
            ));
        }
        let worker = self.spawn(spec, sample_rate)?;
        if let Some(instance) = instance {
            let mut workers = self.workers.lock().unwrap();
            workers.retain(|_, (_, worker)| worker.strong_count() > 0);
            workers.insert(instance, (spec.clone(), Arc::downgrade(&worker)));
        }
        Ok(worker)
    }

    pub fn find(&self, instance: PluginInstance, spec: &PluginSpec) -> Option<Arc<PluginWorker>> {
        self.workers
            .lock()
            .unwrap()
            .get(&instance)
            .and_then(|(loaded, worker)| {
                (loaded.format == spec.format && loaded.path == spec.path)
                    .then(|| worker.upgrade())
                    .flatten()
            })
    }

    fn spawn(&self, spec: &PluginSpec, sample_rate: f32) -> Result<Arc<PluginWorker>, String> {
        let helper = self
            .helper
            .clone()
            .or_else(helper_path)
            .ok_or_else(|| "The plugin helper is missing from the installation".to_string())?;
        let (ctrl_tx, ctrl_rx) = mpsc::channel::<CtrlCmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let worker = Arc::new(PluginWorker {
            enabled: self.enabled.clone(),
            sequence: AtomicU64::new(0),
            offline: self.offline,
            ctrl_tx,
            in_slot: Arc::new(Mutex::new(AudioSlot::new())),
            out_slot: Arc::new(Mutex::new(AudioSlot::new())),
            status: Mutex::new(WorkerStatus {
                latency: 0,
                alive: false,
                error: String::new(),
            }),
            state: Mutex::new(spec.state.clone()),
            rate: Mutex::new(sample_rate),
        });
        // Some platforms lazily allocate the native mutex on first use.
        // Initialize both handover mutexes before any audio callback sees them.
        drop(worker.in_slot.lock().unwrap());
        drop(worker.out_slot.lock().unwrap());
        let weak = Arc::downgrade(&worker);
        let spec = spec.clone();
        let plugin_name = friendly(&spec.path);
        std::thread::Builder::new()
            .name(format!("plugin-{plugin_name}"))
            .spawn(move || {
                run_worker(weak, &helper, &spec, sample_rate, ctrl_rx, ready_tx);
            })
            .map_err(|e| format!("A plugin thread cannot start: {e}"))?;
        let latency = ready_rx
            .recv_timeout(SLOW_TIMEOUT + Duration::from_secs(5))
            .map_err(|_| format!("{plugin_name} timed out while loading"))??;
        worker.status.lock().unwrap().latency = latency;
        Ok(worker)
    }
}

/// The worker thread: owns the helper connection, processes audio blocks off
/// the audio thread, and answers control commands.
fn run_worker(
    weak: Weak<PluginWorker>,
    helper: &Path,
    spec: &PluginSpec,
    sample_rate: f32,
    ctrl_rx: mpsc::Receiver<CtrlCmd>,
    ready_tx: mpsc::Sender<Result<u32, String>>,
) {
    let Some(worker) = weak.upgrade() else {
        return;
    };
    let mut backend = match Backend::load(helper, spec.format, &spec.path, &spec.state, sample_rate)
    {
        Ok(backend) => backend,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    let latency = backend.latency();
    worker.set_status(true, String::new());
    {
        let mut status = worker.status.lock().unwrap();
        status.latency = latency;
    }
    let _ = ready_tx.send(Ok(latency));
    // Do not keep the initialization Arc alive across the loop.
    drop(worker);
    let mut last_seq = 0u64;
    let mut rate = sample_rate;
    loop {
        let Some(worker) = weak.upgrade() else {
            break;
        };
        // Controls cannot be starved by a continuous stream of audio.
        match ctrl_rx.try_recv() {
            Ok(CtrlCmd::Process(left, right, reply)) => {
                let _ = reply.send(backend.process(&left, &right, rate));
            }
            Ok(CtrlCmd::Reconfigure(new_rate, reply)) => {
                let current = worker.state.lock().unwrap().clone();
                let result = backend.reconfigure(new_rate, &current);
                if let Ok(latency) = result.as_ref() {
                    rate = new_rate;
                    worker.status.lock().unwrap().latency = *latency;
                }
                let _ = reply.send(result);
            }
            Ok(CtrlCmd::LoadState(state, reply)) => {
                let result = if state.is_empty() {
                    // Empty means the plugin's default preset, not its current settings.
                    backend.recover(helper, spec.format, &spec.path, &state, rate)
                } else {
                    backend.load_state(&state)
                };
                if result.is_ok() {
                    worker.status.lock().unwrap().latency = backend.latency();
                }
                let _ = reply.send(result);
            }
            Ok(CtrlCmd::SaveState(reply)) => {
                let _ = reply.send(backend.save_state());
            }
            Ok(CtrlCmd::OpenEditor(reply)) => {
                let _ = reply.send(backend.open_editor());
            }
            Ok(CtrlCmd::CloseEditor) => backend.close_editor(),
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if !worker.enabled.load(Ordering::Acquire) {
            last_seq = worker.in_seq().unwrap_or(last_seq);
            std::thread::sleep(Duration::from_micros(250));
            continue;
        }
        let job = worker.in_slot.lock().ok().and_then(|slot| {
            if slot.seq > last_seq {
                last_seq = slot.seq;
                Some((
                    slot.left[..slot.frames].to_vec(),
                    slot.right[..slot.frames].to_vec(),
                ))
            } else {
                None
            }
        });
        if let Some((left, right)) = job {
            match backend.process(&left, &right, rate) {
                Ok((out_l, out_r)) => {
                    let mut out = worker.out_slot.lock().unwrap();
                    out.frames = out_l.len();
                    out.left[..out_l.len()].copy_from_slice(&out_l);
                    out.right[..out_r.len()].copy_from_slice(&out_r);
                    out.seq = last_seq;
                    worker.set_status(true, String::new());
                }
                Err(e) => {
                    worker.set_status(false, e);
                    let current = worker.state.lock().unwrap().clone();
                    // Use the accepted rate after reconfiguration, not the original rate.
                    match backend.recover(helper, spec.format, &spec.path, &current, rate) {
                        Ok(()) => {
                            worker.status.lock().unwrap().latency = backend.latency();
                            worker.set_status(true, String::new());
                            last_seq = worker.in_seq().unwrap_or(last_seq);
                        }
                        Err(e) => worker.set_status(false, e),
                    }
                }
            }
        } else {
            std::thread::sleep(Duration::from_micros(250));
        }
    }
}

/// Both formats use the same helper and mapped audio transport.
struct Backend {
    // Drop the process before unmapping/removing its audio file.
    process: HelperProcess,
    audio: SharedAudio,
    _file: tempfile::NamedTempFile,
}

impl Backend {
    fn load(
        helper: &Path,
        _format: PluginFormat,
        path: &str,
        state: &[u8],
        sample_rate: f32,
    ) -> Result<Self, String> {
        let (file, audio) = SharedAudio::create()?;
        let process = HelperProcess::new(helper)?;
        let mut backend = Self {
            process,
            audio,
            _file: file,
        };
        let response = backend.process.send(
            Command::Audio(AudioCommand::AttachAudio {
                path: backend._file.path().to_path_buf(),
                version: AUDIO_PROTOCOL_VERSION,
            }),
            PROCESS_TIMEOUT,
        )?;
        expect_success(Ok(response), "plugin", "attach audio")?;
        match backend.send(
            HostCommand::LoadPlugin {
                path: path.into(),
                sample_rate: f64::from(sample_rate),
                block_size: MAX_AUDIO_FRAMES as u32,
                tempo: 120.0,
                time_sig_numerator: 4,
                time_sig_denominator: 4,
                class_id: None,
            },
            SLOW_TIMEOUT,
        )? {
            HostResponse::PluginInfo { .. } => {}
            HostResponse::Error { message } => return Err(message),
            _ => return Err("The plugin gave no loading response".into()),
        }
        if !state.is_empty() {
            backend.load_state(state)?;
        }
        let response = backend.send(HostCommand::StartProcessing, SLOW_TIMEOUT);
        expect_success(response, "plugin", "start")?;
        Ok(backend)
    }

    fn send(&mut self, command: HostCommand, timeout: Duration) -> Result<HostResponse, String> {
        self.process.send(Command::Host(command), timeout)
    }

    fn latency(&mut self) -> u32 {
        match self.send(HostCommand::LatencySamples, PROCESS_TIMEOUT) {
            Ok(HostResponse::LatencySamples { samples }) => samples,
            _ => 0,
        }
    }

    fn process(
        &mut self,
        left: &[f32],
        right: &[f32],
        _rate: f32,
    ) -> Result<(Vec<f32>, Vec<f32>), String> {
        self.audio.write(false, left, right)?;
        let response = self.process.send(
            Command::Audio(AudioCommand::ProcessShared { frames: left.len() }),
            PROCESS_TIMEOUT,
        );
        expect_success(response, "plugin", "process")?;
        self.audio.read(true, left.len())
    }

    fn reconfigure(&mut self, rate: f32, state: &[u8]) -> Result<u32, String> {
        let response = self.send(HostCommand::StopProcessing, SLOW_TIMEOUT);
        expect_success(response, "plugin", "stop")?;
        let response = self.send(
            HostCommand::Reconfigure {
                sample_rate: f64::from(rate),
                block_size: MAX_AUDIO_FRAMES as u32,
            },
            SLOW_TIMEOUT,
        );
        expect_success(response, "plugin", "reconfigure")?;
        if !state.is_empty() {
            self.load_state(state)?;
        }
        let response = self.send(HostCommand::StartProcessing, SLOW_TIMEOUT);
        expect_success(response, "plugin", "start")?;
        Ok(self.latency())
    }

    fn load_state(&mut self, state: &[u8]) -> Result<(), String> {
        if state.is_empty() {
            return Ok(());
        }
        let response = self.send(
            HostCommand::LoadState {
                data: state.to_vec(),
                context: Default::default(),
            },
            SLOW_TIMEOUT,
        );
        expect_success(response, "plugin", "restore settings")
    }

    fn save_state(&mut self) -> Result<Vec<u8>, String> {
        match self.send(HostCommand::SaveState, SLOW_TIMEOUT)? {
            HostResponse::State { data } => Ok(data),
            HostResponse::Error { message } => Err(message),
            _ => Err("The plugin gave no settings".into()),
        }
    }

    fn open_editor(&mut self) -> Result<(i32, i32), String> {
        match self.send(HostCommand::CreateGui, SLOW_TIMEOUT)? {
            HostResponse::GuiCreated { width, height } => Ok((width, height)),
            HostResponse::Error { message } => Err(message),
            _ => Err("The editor cannot open".into()),
        }
    }

    fn close_editor(&mut self) {
        let _ = self.send(HostCommand::CloseGui, PROCESS_TIMEOUT);
    }

    fn recover(
        &mut self,
        helper: &Path,
        format: PluginFormat,
        path: &str,
        state: &[u8],
        rate: f32,
    ) -> Result<(), String> {
        *self = Self::load(helper, format, path, state, rate)?;
        Ok(())
    }
}

fn expect_success(
    response: Result<vst3_host::process_isolation::HostResponse, String>,
    name: &str,
    what: &str,
) -> Result<(), String> {
    use vst3_host::process_isolation::HostResponse;
    match response {
        Ok(HostResponse::Success { .. }) => Ok(()),
        Ok(HostResponse::Error { message }) => Err(format!("{name} cannot {what}: {message}")),
        Ok(_) => Err(format!("{name} cannot {what}")),
        Err(e) => Err(format!("{name} cannot {what}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_follows_the_path() {
        assert_eq!(
            PluginFormat::of("/Library/Audio/Plug-Ins/VST3/Amp.vst3"),
            PluginFormat::Vst3
        );
        assert_eq!(
            PluginFormat::of("/Library/Audio/Plug-Ins/CLAP/Amp.clap"),
            PluginFormat::Clap
        );
        assert_eq!(
            PluginFormat::of("/Library/Audio/Plug-Ins/CLAP/Amp.clap/Contents/MacOS/Amp"),
            PluginFormat::Clap
        );
    }

    #[test]
    fn disabled_pool_refuses_to_load() {
        let pool = PluginPool::default();
        assert!(!pool.enabled());
        let spec = PluginSpec {
            format: PluginFormat::Vst3,
            path: "/nonexistent.vst3".into(),
            state: Vec::new(),
        };
        let err = pool.load(None, &spec, 48_000.0).unwrap_err();
        assert!(err.contains("switched off"), "{err}");
    }

    #[test]
    fn missing_plugin_is_reported_not_fatal() {
        let pool = PluginPool::default();
        pool.set_enabled(true);
        let spec = PluginSpec {
            format: PluginFormat::Vst3,
            path: "/nonexistent-plugin.vst3".into(),
            state: Vec::new(),
        };
        let err = pool.load(None, &spec, 48_000.0).unwrap_err();
        assert!(err.contains("not installed"), "{err}");
    }

    /// Handover slots without a helper: push/take/reset are synchronous and
    /// allocation-free on the calling side.
    #[test]
    fn slots_hand_blocks_over_without_a_helper() {
        let (ctrl_tx, _ctrl_rx) = mpsc::channel::<CtrlCmd>();
        let worker = PluginWorker {
            enabled: Arc::new(AtomicBool::new(true)),
            sequence: AtomicU64::new(0),
            offline: false,
            ctrl_tx,
            in_slot: Arc::new(Mutex::new(AudioSlot::new())),
            out_slot: Arc::new(Mutex::new(AudioSlot::new())),
            status: Mutex::new(WorkerStatus {
                latency: 0,
                alive: false,
                error: String::new(),
            }),
            state: Mutex::new(Vec::new()),
            rate: Mutex::new(48_000.0),
        };
        // Nothing finished: no output, input still recorded.
        worker.push(&[0.5, 0.25], &[0.5, 0.25]);
        let (mut left, mut right) = (vec![0.0; 2], vec![0.0; 2]);
        assert_eq!(worker.take_into(0, &mut left, &mut right), None);
        assert_eq!(worker.in_seq(), Some(1));
        // A finished block is picked up exactly once.
        worker.out_slot.lock().unwrap().left[..2].copy_from_slice(&[1.0, 2.0]);
        worker.out_slot.lock().unwrap().right[..2].copy_from_slice(&[3.0, 4.0]);
        worker.out_slot.lock().unwrap().frames = 2;
        worker.out_slot.lock().unwrap().seq = 1;
        worker.push(&[0.0, 0.0], &[0.0, 0.0]);
        assert_eq!(worker.take_into(0, &mut left, &mut right), Some(1));
        assert_eq!((left, right), (vec![1.0, 2.0], vec![3.0, 4.0]));
        assert_eq!(worker.take_into(1, &mut [0.0; 2], &mut [0.0; 2]), None);
        // An answer that misses its scheduled next block must never play later.
        worker.push(&[0.0; 2], &[0.0; 2]);
        let mut late_left = [9.0; 2];
        let mut late_right = [8.0; 2];
        assert_eq!(worker.take_into(0, &mut late_left, &mut late_right), None);
        assert_eq!(late_left, [9.0; 2]);
        assert_eq!(late_right, [8.0; 2]);
    }

    /// End to end through the real helper and TONE3000 (VST3 and CLAP): load,
    /// process, latency, state round-trip. Needs the plugin installed; run with
    /// `cargo test -- --ignored`. Skips quietly anywhere else (e.g. CI).
    #[test]
    #[ignore]
    fn real_plugins_process_audio_out_of_process() {
        for (format, path) in [
            (
                PluginFormat::Vst3,
                "/Library/Audio/Plug-Ins/VST3/TONE3000.vst3",
            ),
            (
                PluginFormat::Clap,
                "/Library/Audio/Plug-Ins/CLAP/TONE3000.clap",
            ),
        ] {
            if !Path::new(path).exists() {
                eprintln!("skipped: {path} is not installed");
                continue;
            }
            let pool = PluginPool::default();
            pool.set_enabled(true);
            let spec = PluginSpec {
                format,
                path: path.into(),
                state: Vec::new(),
            };
            let worker = pool.load(None, &spec, 48_000.0).unwrap();
            assert!(worker.alive(), "{path}: {}", worker.error());
            // A 220 Hz probe tone through the amp.
            let input: Vec<f32> = (0..64)
                .map(|i| 0.5 * (std::f32::consts::TAU * 220.0 * i as f32 / 48_000.0).sin())
                .collect();
            for _ in 0..30 {
                worker.push(&input, &input);
                std::thread::sleep(Duration::from_millis(2));
            }
            let (mut left, mut right) = (vec![0.0; 64], vec![0.0; 64]);
            let mut seq = 0;
            for _ in 0..200 {
                worker.push(&input, &input);
                if let Some(next) = worker.take_into(seq, &mut left, &mut right) {
                    seq = next;
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(seq > 0, "{path}: no audio came back");
            assert!(left.iter().all(|s| s.is_finite()));
            let peak: f32 = left.iter().map(|s| s.abs()).fold(0.0, f32::max);
            assert!(peak > 0.01, "{path}: silent (peak {peak})");
            // State round-trips.
            let saved = worker.save_state().unwrap();
            assert!(!saved.is_empty(), "{path}: empty state");
            worker.apply_state(&saved).unwrap();
            eprintln!("{path}: latency {} samples", worker.latency_samples());
            // A new sample rate reconfigures the running worker (same
            // helper, settings kept) instead of reloading it.
            worker.ensure_rate(44_100.0).unwrap();
            worker.push(&input, &input);
            let mut seq3 = seq;
            for _ in 0..200 {
                worker.push(&input, &input);
                if let Some(next) = worker.take_into(seq3, &mut left, &mut right) {
                    seq3 = next;
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(seq3 > seq, "{path}: no audio after reconfigure");
            worker.ensure_rate(48_000.0).unwrap();
        }
    }

    /// The scan finds both TONE3000 formats and skips nothing on this machine.
    /// Same opt-in as above: skips quietly without the plugins.
    #[test]
    #[ignore]
    fn scan_finds_installed_plugins() {
        if !Path::new("/Library/Audio/Plug-Ins/VST3/TONE3000.vst3").exists() {
            eprintln!("skipped: TONE3000 is not installed");
            return;
        }
        let report = scan().unwrap();
        for expected in [
            "/Library/Audio/Plug-Ins/VST3/TONE3000.vst3",
            "/Library/Audio/Plug-Ins/CLAP/TONE3000.clap",
        ] {
            assert!(
                report.plugins.iter().any(|p| p.path == expected),
                "{expected} missing from {:?}",
                report.plugins.iter().map(|p| &p.path).collect::<Vec<_>>()
            );
        }
        let tone = report
            .plugins
            .iter()
            .find(|p| p.path.ends_with("TONE3000.vst3"))
            .unwrap();
        assert_eq!(tone.name, "TONE3000");
        assert!(tone.has_gui);
    }
}
