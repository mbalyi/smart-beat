//! Third-party plugins (VST3 and CLAP) as pedalboard blocks (#80).
//!
//! The plugin itself always runs in the out-of-process helper
//! (`src/bin/vst3-host-helper.rs`), one helper process per loaded plugin, so
//! a crashing plugin can never take down the audio engine or the app. The
//! audio thread never talks to the helper: it drops input blocks into a ring
//! and takes finished blocks from another ring, both with `try_lock`. When
//! the helper is behind, crashed or gone, the block passes audio through dry
//! and the worker thread reloads or recovers it in the background.
//!
//! Blocks cross the boundary in order. The audio thread takes the oldest
//! finished block, so the helper may run a whole render callback behind
//! without losing one, and the delay that builds up is what the UI reports as
//! added latency ([`PluginWorker::added_latency_samples`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
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
    /// What the block adds: the plugin's own latency plus the handover.
    pub latency_samples: u32,
    /// The same value in milliseconds, so the UI needs no sample rate.
    pub latency_ms: f64,
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
/// Frames one handover slot holds: exactly one engine block. The engine renders
/// its callbacks in `BLOCK`-sized chunks and hands over one at a time, so a
/// larger block cannot be handed over and passes dry instead of being split.
const HANDOVER_FRAMES: usize = super::engine::BLOCK;
/// How many blocks the two handover rings carry. Steady state needs one lap for
/// the delay the audio thread builds up, which is about one render callback: a
/// device callback is at most `MAX_FRAMES` / `BLOCK` blocks in the engine, so
/// 256 blocks cover every device the app can open and leave room for a stall.
/// Past a full lap the helper's input is overwritten and that block plays dry.
const HANDOVER_SLOTS: usize = 256;

/// Which ring slot a block belongs to.
fn slot_index(seq: u64) -> usize {
    (seq % HANDOVER_SLOTS as u64) as usize
}

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
        if is_helper(&beside) {
            return Some(beside);
        }
        if dir.file_name().is_some_and(|n| n == "deps") {
            let sibling = dir.parent()?.join(&name);
            if is_helper(&sibling) {
                return Some(sibling);
            }
        }
    }
    None
}

/// Whether a file can be the helper. `build.rs` writes an empty placeholder so
/// tauri-build's compile-time check passes on a fresh checkout; running that
/// would fail with a confusing spawn error instead of "the helper is missing".
fn is_helper(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
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

/// One block in a handover ring. Only `try_lock` touches these from the audio
/// thread. `seq` is 0 until the slot has been written, which cannot collide
/// with a real sequence number (the first block is 1).
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
            left: vec![0.0; HANDOVER_FRAMES],
            right: vec![0.0; HANDOVER_FRAMES],
        }
    }
}

fn ring() -> Box<[Mutex<AudioSlot>]> {
    (0..HANDOVER_SLOTS)
        .map(|_| Mutex::new(AudioSlot::new()))
        .collect()
}

#[derive(Debug)]
struct WorkerStatus {
    latency: u32,
    alive: bool,
    error: String,
    preset_error: String,
}

type AudioResult = Result<(Vec<f32>, Vec<f32>), String>;

enum CtrlCmd {
    Process(Vec<f32>, Vec<f32>, mpsc::Sender<AudioResult>),
    /// Applies a preset and answers nobody: `Chain::update` runs under the
    /// engine lock and must not wait for the helper. Failures reach the UI
    /// through the block status.
    ApplyState(Vec<u8>),
    SaveState(mpsc::Sender<Result<Vec<u8>, String>>),
    OpenEditor(mpsc::Sender<Result<(i32, i32), String>>),
    CloseEditor,
}

/// One loaded plugin: a helper process plus the background thread driving it.
/// Owned by one chain block. Different blocks never share a handover ring or
/// mutable plugin state, even when they load the same file.
#[derive(Debug)]
pub struct PluginWorker {
    enabled: Arc<AtomicBool>,
    sequence: AtomicU64,
    /// Input publication follows the write (or drop), so the worker can safely
    /// skip holes without racing a producer that has only reserved a sequence.
    submitted: AtomicU64,
    /// Every sequence through this point was answered or deliberately skipped.
    completed: AtomicU64,
    offline: bool,
    ctrl_tx: mpsc::Sender<CtrlCmd>,
    in_ring: Box<[Mutex<AudioSlot>]>,
    out_ring: Box<[Mutex<AudioSlot>]>,
    status: Mutex<WorkerStatus>,
    state: Mutex<Vec<u8>>,
    /// Blocks between the newest pushed block and the finished block the audio
    /// thread last took: the handover's own latency, written by the audio
    /// thread and read by the UI.
    lag_blocks: AtomicU32,
}

/// Plugin destination over IPC: a score track number or the live monitor bus.
/// A null destination still means the master bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginTarget {
    Track(usize),
    Bus(PluginBus),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginBus {
    Monitor,
}

pub const MONITOR_TARGET: Option<PluginTarget> = Some(PluginTarget::Bus(PluginBus::Monitor));

/// Address of one live block. Export workers use a separate pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PluginInstance {
    pub track: Option<PluginTarget>,
    pub sound: usize,
    pub index: usize,
}

/// Most preset bytes one block stores. A song's mixer settings carry the
/// preset inline as base64, and the UI sends the chain back on every change, so
/// a plugin with a huge preset would make both heavy. Four megabytes covers amp
/// sims and pedals with room to spare.
pub const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;

impl PluginWorker {
    /// Hands one stereo block to the worker (drops it when the worker is
    /// behind: the audio thread never waits).
    pub fn push(&self, left: &[f32], right: &[f32]) {
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        if self.enabled.load(Ordering::Acquire)
            && left.len() == right.len()
            && !left.is_empty()
            && left.len() <= HANDOVER_FRAMES
            && let Ok(mut slot) = self.in_ring[slot_index(seq)].try_lock()
        {
            slot.frames = left.len();
            slot.left[..left.len()].copy_from_slice(left);
            slot.right[..right.len()].copy_from_slice(right);
            slot.seq = seq;
        }
        self.submitted.store(seq, Ordering::Release);
    }

    /// Worker-side read: publication makes missing inputs final, so a dropped
    /// push cannot strand later blocks. At most one ring is inspected.
    fn next_input(&self, next: &mut u64) -> Option<(Vec<f32>, Vec<f32>)> {
        let newest = self.submitted.load(Ordering::Acquire);
        *next = (*next).max(newest.saturating_sub(HANDOVER_SLOTS as u64 - 1));
        self.completed.store(*next - 1, Ordering::Release);
        while *next <= newest {
            let slot = self.in_ring[slot_index(*next)].lock().unwrap();
            if slot.seq == *next {
                return Some((
                    slot.left[..slot.frames].to_vec(),
                    slot.right[..slot.frames].to_vec(),
                ));
            }
            *next += 1;
            self.completed.store(*next - 1, Ordering::Release);
        }
        None
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

    /// The oldest finished block, in order. Copies it into `left`/`right` and
    /// advances `seen` when it is there; passes dry otherwise. The worker's
    /// completion watermark identifies missing answers that can never arrive.
    /// Those and wrong-sized results are skipped so later answers can play.
    /// Allocates nothing: the audio thread must never
    /// wait on the worker.
    pub fn take_into(&self, seen: &mut u64, left: &mut [f32], right: &mut [f32]) -> bool {
        if !self.enabled.load(Ordering::Acquire) {
            return false;
        }
        let completed = self.completed.load(Ordering::Acquire);
        // Earlier answers have already been overwritten. Inspect at most one
        // ring, and never skip a block the worker could still answer.
        *seen = (*seen).max(completed.saturating_sub(HANDOVER_SLOTS as u64));
        while *seen < completed {
            let expected = *seen + 1;
            let Ok(slot) = self.out_ring[slot_index(expected)].try_lock() else {
                return false;
            };
            *seen = expected;
            if slot.seq != expected || slot.frames != left.len() || slot.frames != right.len() {
                continue;
            }
            left.copy_from_slice(&slot.left[..slot.frames]);
            right.copy_from_slice(&slot.right[..slot.frames]);
            self.lag_blocks.store(
                self.sequence
                    .load(Ordering::Relaxed)
                    .saturating_sub(expected) as u32,
                Ordering::Relaxed,
            );
            return true;
        }
        false
    }

    /// The newest input sequence handed over (to drop stale output after a seek).
    pub fn in_seq(&self) -> u64 {
        self.sequence.load(Ordering::Relaxed)
    }

    /// The plugin's own latency in samples.
    pub fn latency_samples(&self) -> u32 {
        self.status.lock().unwrap().latency
    }

    /// The latency the block adds: the plugin's own plus the delay the
    /// handover builds up, which is one render callback in steady state.
    pub fn added_latency_samples(&self) -> u32 {
        self.latency_samples() + self.lag_blocks() * super::engine::BLOCK as u32
    }

    /// Blocks between the newest input and the finished block last taken.
    pub fn lag_blocks(&self) -> u32 {
        self.lag_blocks.load(Ordering::Relaxed)
    }

    pub fn alive(&self) -> bool {
        self.status.lock().unwrap().alive
    }

    pub fn error(&self) -> String {
        let status = self.status.lock().unwrap();
        if status.error.is_empty() {
            status.preset_error.clone()
        } else {
            status.error.clone()
        }
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

    /// Queues a preset without waiting for it. `Chain::update` runs under the
    /// engine lock, so it must not block on the helper; the worker applies the
    /// state and reports a failure through the block status. An empty state
    /// means the plugin's default preset, not its current settings.
    pub fn queue_state(&self, state: Vec<u8>) -> Result<(), String> {
        self.ctrl_tx
            .send(CtrlCmd::ApplyState(state))
            .map_err(|_| "The plugin stopped responding".to_string())
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
            submitted: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            offline: self.offline,
            ctrl_tx,
            in_ring: ring(),
            out_ring: ring(),
            status: Mutex::new(WorkerStatus {
                latency: 0,
                alive: false,
                error: String::new(),
                preset_error: String::new(),
            }),
            state: Mutex::new(spec.state.clone()),
            lag_blocks: AtomicU32::new(0),
        });
        // Some platforms lazily allocate the native mutex on first use.
        // Initialize every handover mutex before any audio callback sees them.
        for slots in [&worker.in_ring, &worker.out_ring] {
            for slot in slots.iter() {
                drop(slot.lock().unwrap());
            }
        }
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
    let mut next_seq = 1u64;
    loop {
        let Some(worker) = weak.upgrade() else {
            break;
        };
        // Controls cannot be starved by a continuous stream of audio.
        match ctrl_rx.try_recv() {
            Ok(CtrlCmd::Process(left, right, reply)) => {
                let _ = reply.send(backend.process(&left, &right));
            }
            Ok(CtrlCmd::ApplyState(state)) => {
                let result = if state.is_empty() {
                    // Empty means the plugin's default preset, not its current settings.
                    backend.recover(helper, spec.format, &spec.path, &state, sample_rate)
                } else {
                    backend.load_state(&state)
                };
                match result {
                    Ok(()) => {
                        *worker.state.lock().unwrap() = state;
                        let mut status = worker.status.lock().unwrap();
                        status.latency = backend.latency();
                        status.preset_error.clear();
                    }
                    Err(e) => worker.status.lock().unwrap().preset_error = e,
                }
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
            std::thread::sleep(Duration::from_micros(250));
            continue;
        }
        let job = worker.next_input(&mut next_seq);
        let Some((left, right)) = job else {
            std::thread::sleep(Duration::from_micros(250));
            continue;
        };
        let answered = next_seq;
        next_seq += 1;
        match backend.process(&left, &right) {
            Ok((out_l, out_r)) => {
                let mut out = worker.out_ring[slot_index(answered)].lock().unwrap();
                out.frames = out_l.len();
                out.left[..out_l.len()].copy_from_slice(&out_l);
                out.right[..out_r.len()].copy_from_slice(&out_r);
                out.seq = answered;
                drop(out);
                worker.set_status(true, String::new());
            }
            Err(e) => {
                worker.set_status(false, e);
                let current = worker.state.lock().unwrap().clone();
                match backend.recover(helper, spec.format, &spec.path, &current, sample_rate) {
                    Ok(()) => {
                        worker.status.lock().unwrap().latency = backend.latency();
                        worker.set_status(true, String::new());
                        // Resume at the newest block, not the one that failed.
                        next_seq = worker.submitted.load(Ordering::Acquire) + 1;
                    }
                    Err(e) => worker.set_status(false, e),
                }
            }
        }
        worker.completed.store(next_seq - 1, Ordering::Release);
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

    fn process(&mut self, left: &[f32], right: &[f32]) -> Result<(Vec<f32>, Vec<f32>), String> {
        self.audio.write(false, left, right)?;
        let response = self.process.send(
            Command::Audio(AudioCommand::ProcessShared { frames: left.len() }),
            PROCESS_TIMEOUT,
        );
        expect_success(response, "plugin", "process")?;
        self.audio.read(true, left.len())
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

    /// A worker with no helper behind it: the rings are driven by hand.
    fn worker_without_a_helper() -> PluginWorker {
        let (ctrl_tx, _ctrl_rx) = mpsc::channel::<CtrlCmd>();
        PluginWorker {
            enabled: Arc::new(AtomicBool::new(true)),
            sequence: AtomicU64::new(0),
            submitted: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            offline: false,
            ctrl_tx,
            in_ring: ring(),
            out_ring: ring(),
            status: Mutex::new(WorkerStatus {
                latency: 0,
                alive: false,
                error: String::new(),
                preset_error: String::new(),
            }),
            state: Mutex::new(Vec::new()),
            lag_blocks: AtomicU32::new(0),
        }
    }

    impl PluginWorker {
        /// Writes a finished block into the output ring, the way the worker
        /// thread does when the helper answers.
        fn finish(&self, seq: u64, left: &[f32], right: &[f32]) {
            let mut out = self.out_ring[slot_index(seq)].lock().unwrap();
            out.frames = left.len();
            out.left[..left.len()].copy_from_slice(left);
            out.right[..right.len()].copy_from_slice(right);
            out.seq = seq;
            drop(out);
            self.completed.store(seq, Ordering::Release);
        }
    }

    /// Handover rings without a helper: push and take are synchronous, in
    /// order, and allocation-free on the calling side.
    #[test]
    fn the_handover_rings_carry_blocks_in_order() {
        let worker = worker_without_a_helper();
        let (mut left, mut right) = (vec![0.0; 2], vec![0.0; 2]);
        let mut seen = 0;
        // Nothing finished yet: dry, but the input goes into the ring in order.
        worker.push(&[0.5, 0.25], &[0.5, 0.25]);
        assert!(!worker.take_into(&mut seen, &mut left, &mut right));
        assert_eq!(worker.in_seq(), 1);
        assert_eq!(worker.in_ring[slot_index(1)].lock().unwrap().seq, 1);
        // A finished block is taken once, exactly when its turn comes.
        worker.finish(1, &[1.0, 2.0], &[3.0, 4.0]);
        worker.push(&[0.0; 2], &[0.0; 2]);
        worker.push(&[0.0; 2], &[0.0; 2]);
        assert!(worker.take_into(&mut seen, &mut left, &mut right));
        assert_eq!(
            (seen, &left[..], &right[..]),
            (1, &[1.0, 2.0][..], &[3.0, 4.0][..])
        );
        // The helper is two blocks behind, and the block says so.
        assert_eq!(worker.lag_blocks(), 2);
        assert_eq!(
            worker.added_latency_samples(),
            2 * super::super::engine::BLOCK as u32
        );
        assert!(
            !worker.take_into(&mut seen, &mut left, &mut right),
            "a taken block must not play twice"
        );
        // A block the helper never answered is skipped, not waited for. After
        // one lap of the ring, the slot `seen` wants holds a later block.
        let last = 2 + HANDOVER_SLOTS as u64;
        while worker.in_seq() < last {
            worker.push(&[0.0; 2], &[0.0; 2]);
        }
        assert_eq!(slot_index(last), slot_index(2));
        worker.finish(last, &[5.0, 6.0], &[7.0, 8.0]);
        let mut skipped = [9.0; 2];
        assert!(worker.take_into(&mut seen, &mut skipped, &mut [0.0; 2]));
        assert_eq!(skipped, [5.0, 6.0], "the next available answer plays");
        assert_eq!(seen, last, "the hole is skipped, not waited for");
        // The next block, in order, plays normally again.
        worker.push(&[0.0; 2], &[0.0; 2]);
        worker.finish(last + 1, &[5.0, 6.0], &[7.0, 8.0]);
        assert!(worker.take_into(&mut seen, &mut left, &mut right));
        assert_eq!(&left[..], &[5.0, 6.0]);
    }

    #[test]
    fn missing_and_wrong_sized_answers_do_not_strand_finished_audio() {
        for first_frames in [0, 32] {
            let worker = worker_without_a_helper();
            worker.push(&[1.0; 64], &[1.0; 64]);
            worker.push(&[2.0; 64], &[2.0; 64]);
            if first_frames != 0 {
                worker.finish(1, &[1.0; 32], &[1.0; 32]);
            }
            worker.finish(2, &[2.0; 64], &[2.0; 64]);
            let mut seen = 0;
            let mut left = [0.0; 64];
            assert!(worker.take_into(&mut seen, &mut left, &mut [0.0; 64]));
            assert_eq!(seen, 2);
            assert_eq!(left, [2.0; 64]);
        }
    }

    #[test]
    fn queued_preset_revert_is_not_deduplicated_against_applied_state() {
        let mut worker = worker_without_a_helper();
        let (tx, rx) = mpsc::channel();
        worker.ctrl_tx = tx;
        worker.queue_state(vec![1]).unwrap();
        worker.queue_state(Vec::new()).unwrap();
        assert!(matches!(rx.try_recv(), Ok(CtrlCmd::ApplyState(s)) if s == vec![1]));
        assert!(matches!(rx.try_recv(), Ok(CtrlCmd::ApplyState(s)) if s.is_empty()));
    }

    #[test]
    fn dropped_inputs_are_skipped_after_publication() {
        let worker = worker_without_a_helper();
        // A contended slot drops the input without blocking the callback.
        let held = worker.in_ring[slot_index(1)].lock().unwrap();
        worker.push(&[1.0; 64], &[1.0; 64]);
        drop(held);
        worker.push(&[2.0; 64], &[2.0; 64]);
        let mut next = 1;
        let (left, _) = worker.next_input(&mut next).unwrap();
        assert_eq!(next, 2);
        assert_eq!(left, [2.0; 64]);
        assert_eq!(worker.completed.load(Ordering::Acquire), 1);
    }

    #[test]
    fn a_maximum_device_callback_fits_before_the_worker_runs() {
        let worker = worker_without_a_helper();
        // audio/output.rs accepts up to 8192 frames in a single callback.
        let blocks = 8192 / super::super::engine::BLOCK;
        assert!(HANDOVER_SLOTS >= blocks);
        for seq in 1..=blocks {
            worker.push(&[seq as f32; 64], &[seq as f32; 64]);
        }
        let mut next = 1;
        for seq in 1..=blocks {
            let (left, _) = worker.next_input(&mut next).unwrap();
            assert_eq!(next, seq as u64);
            assert_eq!(left, [seq as f32; 64]);
            next += 1;
        }
    }

    /// A block too large for the ring is dropped, never truncated: the audio
    /// thread would otherwise play half a block at the wrong position.
    #[test]
    fn oversized_blocks_are_dropped() {
        let worker = worker_without_a_helper();
        let big = vec![0.0; HANDOVER_FRAMES + 1];
        worker.push(&big, &big);
        assert_eq!(worker.in_seq(), 1, "the sequence still advances");
        assert_eq!(worker.in_ring[slot_index(1)].lock().unwrap().seq, 0);
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
                if worker.take_into(&mut seq, &mut left, &mut right) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(seq > 0, "{path}: no audio came back");
            assert!(left.iter().all(|s| s.is_finite()));
            let peak: f32 = left.iter().map(|s| s.abs()).fold(0.0, f32::max);
            assert!(peak > 0.01, "{path}: silent (peak {peak})");
            // State round-trips: the preset saved from the plugin is applied to
            // the running worker without a reload.
            let saved = worker.save_state().unwrap();
            assert!(!saved.is_empty(), "{path}: empty state");
            assert!(worker.alive(), "{path}: {}", worker.error());
            worker.queue_state(saved).unwrap();
            // Queued, not waited for: give the helper a moment to apply it.
            std::thread::sleep(Duration::from_millis(200));
            assert!(worker.alive(), "{path}: {}", worker.error());
            eprintln!(
                "{path}: plugin latency {} samples, handover {} blocks",
                worker.latency_samples(),
                worker.lag_blocks()
            );
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
