//! Anonymous usage counters (docs/analytics.md).
//!
//! The app counts how often a feature is used per day, keeps the counters in a small file in the
//! app data folder and sends them in one batch when it is online. There is no identifier of any
//! kind, no event log and no timestamp finer than a day. The counters are only recorded when the
//! build has an endpoint (`SMART_BEAT_ANALYTICS_URL`) and the user has not switched them off.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, ErrorKind};

/// File names inside the app data folder.
pub const USAGE_FILE: &str = "usage.json";
pub const SETTINGS_FILE: &str = "settings.json";

/// Counters older than this many days are dropped without being sent.
pub const MAX_DAYS: usize = 30;
/// Most entries in one request (the Worker enforces the same limit).
pub const MAX_ENTRIES: usize = 500;
/// Pause after a successful upload before the next background upload.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Pause after a failed upload before the next background attempt.
pub const RETRY_AFTER: Duration = Duration::from_secs(60);
/// Network timeout of one upload.
pub const TIMEOUT: Duration = Duration::from_secs(5);
/// Least time between two uploads that an error or a panic starts (#164). Errors in between wait
/// in the queue and go out with the next upload.
pub const URGENT_GAP: Duration = Duration::from_secs(10);

/// Where counters are sent. Set when the release pipeline builds the app; development and
/// pull-request builds have none, which turns the counters off completely.
pub const ENDPOINT: Option<&str> = option_env!("SMART_BEAT_ANALYTICS_URL");
/// Installer type baked into the build: `dmg`, `windows` or `linux`.
const BUILT_INSTALLER: Option<&str> = option_env!("SMART_BEAT_INSTALLER");

/// The features that are counted. A fixed list: the app never sends free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    AppStart,
    Play,
    Pause,
    Stop,
    LoopOn,
    SpeedTrainerStart,
    MetronomeOn,
    CountInOn,
    PracticeMix,
    SoundChange,
    OpenFile,
    Export,
    Save,
    SaveAs,
    MixerOpen,
    EffectPedal,
    SoundLibraryImport,
    Edit,
    Undo,
    Redo,
    NewSong,
    TrackAdd,
    TrackDelete,
    SoloTrack,
    MuteTrack,
    TempoChange,
    Transpose,
    CopyPaste,
    ChordInsert,
    NotationModeSwitch,
    Tuner,
    FretboardView,
    PianoView,
    UpdateCheck,
    UpdateInstalled,
    ThemeDark,
    ThemeLight,
    ShiftSelect,
    Copy,
    Cut,
    DeleteSelection,
    LoopSelection,
    PractiseSelection,
    PlaySelection,
    RestartOnStopOn,
    RestartOnStopOff,
    RestartOnStopUsed,
    RecordToTab,
    PedalAdd,
    PedalRemove,
    PedalMove,
    PluginsOn,
    PluginScan,
    PluginAdd,
    PluginEditorOpen,
    CopyToInstrument,
    AudioTranscribe,
    SettingsOpen,
    AudioInputChange,
    PianoModelDownload,
    /// The user picked a sound set (#153); detail: which one.
    SoundfontSelect,
    /// Playback started with this sound set (#153); detail: which one.
    PlaySoundfont,
    /// A recommended SoundFont was downloaded (#81); detail: which one.
    SoundfontDownload,
    /// A SoundFont file was imported from the user's computer (#81).
    SoundfontImport,
    /// A live Record to Tab take was started (#153); detail: the instrument.
    RecordToTabStart,
    /// Record to Tab was started from an audio file (#153); detail: the instrument.
    RecordToTabFile,
    DrumNormalize,
    TrackDuplicate,
    PracticeSpeed,
    PracticeRange,
    SpeedTrainerStop,
    SpeedTrainerHold,
    PracticeView,
    /// The score was switched to the continuous layout (#157).
    ContinuousView,
    /// Two or more tracks were stacked in the continuous view (#157).
    MultiTrackView,
    /// A guided tour (#84) began (#153); detail: which tour.
    TourStart,
    TourFinish,
    TourSkip,
    /// The tour was closed before its end.
    TourClose,
    /// A MuScriptor size finished downloading (the size is the detail).
    AiInstall,
    /// The user ticked "I only use music I have the rights to" when installing MuScriptor.
    AiRightsConfirmed,
    /// A live take went through the AI engine; the detail says whether the confirmation is on file.
    AiTranscribeStart,
    /// An audio file went through the AI engine (Record to tab or Import from Audio).
    AiTranscribeFile,
    /// A command failed (#164); detail: `<area>:<kind>` from fixed lists, never the message.
    Error,
    /// The Rust side panicked (#164); detail: the area, never the message or location.
    Panic,
}

impl Event {
    fn details(self) -> &'static [&'static str] {
        match self {
            Self::OpenFile | Self::Export | Self::Save | Self::SaveAs => FORMATS,
            Self::PedalAdd | Self::PedalRemove => &[
                "gate",
                "compressor",
                "eq",
                "drive",
                "amp_sim",
                "chorus",
                "phaser",
                "tremolo",
                "delay",
                "reverb",
                "limiter",
                "amp",
                "cab",
                "plugin",
            ],
            Self::PluginAdd | Self::PluginEditorOpen => &["vst3", "clap"],
            Self::CopyToInstrument => &[
                "guitar",
                "electric-guitar",
                "classical-guitar",
                "guitar-7",
                "guitar-8",
                "guitar-9",
                "bass-4",
                "bass-5",
                "bass-6",
                "banjo",
                "ukulele",
                "piano",
                "other",
            ],
            Self::RecordToTab | Self::RecordToTabStart | Self::RecordToTabFile => {
                &["guitar", "bass", "piano", "drums"]
            }
            Self::SoundLibraryImport => &["amp", "cab"],
            Self::SoundfontSelect | Self::PlaySoundfont => SOUNDFONT_IDS,
            Self::SoundfontDownload => &[
                "musescore-general",
                "generaluser-gs",
                "fluidr3-gm",
                "timbres-of-heaven",
                "arachno",
            ],
            Self::TourStart | Self::TourFinish | Self::TourSkip | Self::TourClose => TOURS,
            Self::AiInstall => &["small", "medium", "large"],
            Self::AiTranscribeStart | Self::AiTranscribeFile => {
                &["rights_confirmed", "rights_unconfirmed"]
            }
            Self::Error => ERROR_DETAILS.as_slice(),
            Self::Panic => &ERROR_AREAS,
            _ => &[],
        }
    }

    /// Events that are sent at once instead of waiting for the hourly upload (#164).
    pub fn is_urgent(self) -> bool {
        matches!(self, Self::Error | Self::Panic)
    }
}

/// The parts of the app a failure is filed under (`error` and `panic` details). Mirrors
/// `ERROR_AREAS` in `src/lib/error-counters.ts` and the Worker's `events.ts`.
pub const ERROR_AREAS: [&str; 10] = [
    "file", "export", "audio", "plugin", "import", "ai", "stems", "cloud", "settings", "other",
];

/// The kinds of a failed command: every [`ErrorKind`] in its wire spelling, plus `unknown` for a
/// rejection that carries no kind.
pub const ERROR_KINDS: [&str; 14] = [
    "not-found",
    "unsupported-type",
    "too-large",
    "not-a-score",
    "invalid-key",
    "invalid-settings",
    "invalid-menu-state",
    "audio",
    "conflict",
    "download-timeout",
    "network",
    "auth-expired",
    "io",
    "unknown",
];

/// Every `error` detail: each area with each kind, `area:kind`. Built once.
static ERROR_DETAILS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    ERROR_AREAS
        .iter()
        .flat_map(|area| {
            ERROR_KINDS.iter().map(move |kind| {
                let detail: &'static str = Box::leak(format!("{area}:{kind}").into_boxed_str());
                detail
            })
        })
        .collect()
});

/// The area a panic is filed under, from the source file of the panic location (`src/audio/x.rs`
/// or `src-tauri/src/audio/x.rs`). Only this area is kept: never the file, line or message. Code
/// outside Smart Beat (dependencies, the standard library) is `other`.
pub fn panic_area(file: &str) -> &'static str {
    let file = file.replace('\\', "/");
    if file.contains("/.cargo/") || file.contains("/registry/") || file.contains("/rustc/") {
        return "other";
    }
    let Some(inside) = file.rsplit_once("src/").map(|(_, rest)| rest) else {
        return "other";
    };
    let first = inside.split('/').next().unwrap_or("");
    let second = inside.split('/').nth(1).unwrap_or("");
    match first {
        "audio" if second.starts_with("plugin") => "plugin",
        "audio" | "audio.rs" => "audio",
        "stems" | "separation" => "stems",
        "recording" => "ai",
        "cloud" | "cloud.rs" | "cloud_commands.rs" | "cloud_folder.rs" => "cloud",
        "pdf.rs" | "m4a.rs" | "score_write.rs" | "export" => "export",
        "transcription.rs" => "import",
        "score_file.rs" | "recent.rs" | "open_file.rs" | "project.rs" => "file",
        "mixer.rs" | "menu.rs" | "menu_state.rs" | "telemetry.rs" | "zoom.rs" => "settings",
        _ => "other",
    }
}

/// The sound sets that may accompany `soundfont_select` and `play_soundfont`: the two bundled
/// ones, the recommended banks (`soundfonts.rs`), and `custom` for any file the user imported.
const SOUNDFONT_IDS: &[&str] = &[
    "sonivox",
    "fluidr3",
    "musescore-general",
    "generaluser-gs",
    "fluidr3-gm",
    "timbres-of-heaven",
    "arachno",
    "custom",
];

/// The guided tours (`TourId` in `src/lib/tour/feature-registry.ts`).
const TOURS: &[&str] = &[
    "main",
    "editing",
    "speed-trainer",
    "effects",
    "record-to-tab",
];

/// File formats that may accompany `open_file` and `export`.
const FORMATS: &[&str] = &[
    "gp3", "gp4", "gp5", "gpx", "gp", "mid", "midi", "pdf", "wav", "m4a", "mp3", "musicxml", "ogg",
    "flac", "txt", "png",
];

/// `event|format` (format empty when there is none) → count, per day.
type Day = BTreeMap<String, u32>;

#[derive(Debug, Default, Serialize, Deserialize)]
struct Counters {
    days: BTreeMap<String, Day>,
}

/// One row of the upload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub day: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub count: u32,
}

#[derive(Debug, Serialize)]
struct Batch<'a> {
    version: &'a str,
    os: &'a str,
    installer: &'a str,
    counts: &'a [Entry],
}

/// What the Settings dialog shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSettings {
    /// Counters are switched on (the user's choice; on until they say otherwise).
    pub enabled: bool,
    /// This build can send counters at all.
    pub available: bool,
    /// The one-time notice has been shown.
    pub notice_seen: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredSettings {
    #[serde(default)]
    usage_statistics: Option<bool>,
    #[serde(default)]
    notice_seen: bool,
}

/// Counters, settings and the upload logic. Stored as Tauri state.
pub struct Telemetry {
    dir: PathBuf,
    endpoint: Option<String>,
    installer: String,
    version: String,
    lock: Mutex<()>,
    /// When the last upload was accepted. Only a success starts the hourly pause.
    last_flush: Mutex<Option<Instant>>,
    /// When the last upload failed; a short back-off, not the hourly pause.
    last_failure: Mutex<Option<Instant>>,
    /// Serialises uploads so a final flush never sends what a running upload already carries.
    upload_lock: Mutex<()>,
    flushing: AtomicBool,
    /// When an error or a panic last started an upload (#164).
    last_urgent: Mutex<Option<Instant>>,
    /// Panics not yet written to `usage.json`, per [`ERROR_AREAS`] entry. The panic hook only
    /// touches these (lock-free) and tries the file afterwards; the next normal access drains them.
    panics: [AtomicU32; ERROR_AREAS.len()],
}

/// Which pauses an upload ignores.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pauses {
    /// Both the hourly pause and the short back-off apply (background uploads after tracking).
    Respect,
    /// None applies (launch).
    Ignore,
    /// An error or a panic: not the hourly pause, but the back-off (offline) and [`URGENT_GAP`].
    Urgent,
}

/// What one upload attempt did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing was sent: the counters are off, there is no endpoint or the queue is empty.
    Idle,
    /// The server accepted the batch.
    Sent,
    /// The batch stays queued. Holds the HTTP status or error kind, nothing else.
    Failed(String),
}

impl Telemetry {
    /// `dir` is created on the first save. `endpoint` is `None` in development builds.
    pub fn new(dir: impl Into<PathBuf>, endpoint: Option<&str>, version: &str) -> Self {
        Self {
            dir: dir.into(),
            // An empty address (the variable is unset in CI) is no address.
            endpoint: endpoint.filter(|e| !e.is_empty()).map(str::to_owned),
            installer: installer(),
            version: version.to_owned(),
            lock: Mutex::new(()),
            last_flush: Mutex::new(None),
            last_failure: Mutex::new(None),
            upload_lock: Mutex::new(()),
            flushing: AtomicBool::new(false),
            last_urgent: Mutex::new(None),
            panics: std::array::from_fn(|_| AtomicU32::new(0)),
        }
    }

    fn usage_path(&self) -> PathBuf {
        self.dir.join(USAGE_FILE)
    }

    fn settings_path(&self) -> PathBuf {
        self.dir.join(SETTINGS_FILE)
    }

    pub fn settings(&self) -> UsageSettings {
        let stored = self.stored_settings();
        UsageSettings {
            enabled: stored.usage_statistics.unwrap_or(true),
            available: self.endpoint.is_some(),
            notice_seen: stored.notice_seen,
        }
    }

    /// Changes the given settings. Switching the counters off also forgets what was collected.
    pub fn update_settings(
        &self,
        enabled: Option<bool>,
        notice_seen: Option<bool>,
    ) -> Result<UsageSettings, CommandError> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut stored = self.stored_settings();
        if let Some(enabled) = enabled {
            stored.usage_statistics = Some(enabled);
        }
        if let Some(seen) = notice_seen {
            stored.notice_seen = seen;
        }
        write_json(&self.settings_path(), &stored)?;
        if enabled == Some(false) {
            let _ = fs::remove_file(self.usage_path());
        }
        drop(_guard);
        Ok(self.settings())
    }

    fn stored_settings(&self) -> StoredSettings {
        fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    /// Whether anything should be recorded or sent right now.
    pub fn active(&self) -> bool {
        self.endpoint.is_some() && self.settings().enabled
    }

    /// Counts one use of `event` today. Does nothing when the counters are off.
    pub fn record(&self, event: Event, format: Option<&str>) -> Result<(), CommandError> {
        self.record_on(&today(), event, format)
    }

    /// Like [`Telemetry::record`] for a given `YYYY-MM-DD` day (tests).
    pub fn record_on(
        &self,
        day: &str,
        event: Event,
        format: Option<&str>,
    ) -> Result<(), CommandError> {
        if !self.active() {
            return Ok(());
        }
        let format = match format {
            Some(f) => Some(
                event
                    .details()
                    .iter()
                    .find(|known| known.eq_ignore_ascii_case(f))
                    .ok_or_else(|| {
                        CommandError::new(ErrorKind::InvalidSettings, "Unknown event detail.")
                    })?,
            ),
            None => None,
        };
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut counters = self.load();
        self.drain_panics(&mut counters, day);
        let key = key(event, format.copied());
        let slot = counters
            .days
            .entry(day.to_owned())
            .or_default()
            .entry(key)
            .or_insert(0);
        *slot = slot.saturating_add(1);
        trim(&mut counters);
        write_json(&self.usage_path(), &counters)
    }

    fn load(&self) -> Counters {
        fs::read_to_string(self.usage_path())
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    /// The counters waiting to be sent, oldest day first, at most [`MAX_ENTRIES`].
    pub fn pending(&self) -> Vec<Entry> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut counters = self.load();
        if self.drain_panics(&mut counters, &today()) {
            let _ = write_json(&self.usage_path(), &counters);
        }
        entries(&counters)
    }

    /// Counts one panic in `area` (#164), for the panic hook: it never blocks, never panics and
    /// does no network. The count first goes into a lock-free counter, then into `usage.json` if
    /// the counter lock is free right now; otherwise the next normal access writes it.
    pub fn record_panic(&self, area: &str) {
        self.record_panic_on(&today(), area);
    }

    /// Like [`Telemetry::record_panic`] for a given `YYYY-MM-DD` day (tests).
    pub fn record_panic_on(&self, day: &str, area: &str) {
        let Some(slot) = ERROR_AREAS.iter().position(|known| *known == area) else {
            return;
        };
        if !self.active() {
            return;
        }
        self.panics[slot].fetch_add(1, Ordering::SeqCst);
        // `try_lock`: this may run on the audio thread, or while `record_on` holds the lock.
        if let Ok(_guard) = self.lock.try_lock() {
            let mut counters = self.load();
            if self.drain_panics(&mut counters, day) {
                let _ = write_json(&self.usage_path(), &counters);
            }
        }
    }

    /// Moves the panics counted by the hook into `counters`. Returns whether there were any.
    fn drain_panics(&self, counters: &mut Counters, day: &str) -> bool {
        let mut any = false;
        for (slot, area) in ERROR_AREAS.iter().enumerate() {
            let n = self.panics[slot].swap(0, Ordering::SeqCst);
            if n > 0 {
                any = true;
                let count = counters
                    .days
                    .entry(day.to_owned())
                    .or_default()
                    .entry(format!("panic|{area}"))
                    .or_insert(0);
                *count = count.saturating_add(n);
            }
        }
        if any {
            trim(counters);
        }
        any
    }

    /// Uploads the pending counters once. The local counters are reduced by exactly what the
    /// server acknowledged (2xx); anything recorded meanwhile, and everything after a failure,
    /// stays for the next attempt. Returns whether a batch was accepted.
    pub fn flush(&self) -> bool {
        self.attempt() == Outcome::Sent
    }

    /// One upload that ignores the pauses (used when the app quits). Takes at most
    /// [`TIMEOUT`] in total, including the wait for an upload that is already running.
    pub fn flush_final(&self) -> Outcome {
        self.flush_final_within(TIMEOUT)
    }

    /// Like [`Telemetry::flush_final`] with one budget for waiting on a running upload and for
    /// the final request together; the counters stay queued when it runs out.
    pub fn flush_final_within(&self, budget: Duration) -> Outcome {
        let deadline = Instant::now() + budget;
        self.attempt_until(Some(deadline))
    }

    /// Uploads whatever an earlier session left, on a background thread, ignoring the hourly
    /// pause. Called by the core at launch, so it does not depend on the page.
    pub fn flush_at_launch(self: &std::sync::Arc<Self>) {
        self.spawn_upload(Pauses::Ignore);
    }

    /// Starts an upload on a background thread unless the hourly pause (after a success) or the
    /// short back-off (after a failure) is running, or an upload is. Never blocks and never
    /// reports a failure to the caller.
    pub fn flush_in_background(self: &std::sync::Arc<Self>) {
        self.spawn_upload(Pauses::Respect);
    }

    /// Like [`Telemetry::flush_in_background`] for an error or a panic (#164): sent at once when
    /// the device is online, without waiting for the hourly pause. The short back-off after a
    /// failed upload (offline) and [`URGENT_GAP`] still apply, so a burst of errors is one
    /// request; whatever is skipped stays queued for the next upload or the next launch.
    pub fn flush_urgent_in_background(self: &std::sync::Arc<Self>) {
        self.spawn_upload(Pauses::Urgent);
    }

    fn spawn_upload(self: &std::sync::Arc<Self>, pauses: Pauses) {
        if !self.active() {
            return;
        }
        match pauses {
            Pauses::Respect if !self.due() => return,
            Pauses::Urgent if !self.urgent_due() => return,
            _ => {}
        }
        if self.flushing.swap(true, Ordering::SeqCst) {
            return;
        }
        if pauses == Pauses::Urgent {
            *self.last_urgent.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
        }
        let this = std::sync::Arc::clone(self);
        std::thread::spawn(move || {
            this.attempt();
            this.flushing.store(false, Ordering::SeqCst);
        });
    }

    fn due(&self) -> bool {
        let recent = |slot: &Mutex<Option<Instant>>, pause: Duration| {
            slot.lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some_and(|at| at.elapsed() < pause)
        };
        !recent(&self.last_flush, FLUSH_INTERVAL) && !recent(&self.last_failure, RETRY_AFTER)
    }

    /// Whether an error or a panic may start an upload now: not while offline (the back-off after
    /// a failure) and not within [`URGENT_GAP`] of the last one.
    fn urgent_due(&self) -> bool {
        let recent = |slot: &Mutex<Option<Instant>>, pause: Duration| {
            slot.lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some_and(|at| at.elapsed() < pause)
        };
        !recent(&self.last_failure, RETRY_AFTER) && !recent(&self.last_urgent, URGENT_GAP)
    }

    /// Runs one upload and updates the pauses: only a success starts the hourly pause, a failure
    /// only the short back-off, an empty queue neither.
    fn attempt(&self) -> Outcome {
        self.attempt_until(None)
    }

    fn attempt_until(&self, deadline: Option<Instant>) -> Outcome {
        let _upload = match deadline {
            None => self.upload_lock.lock().unwrap_or_else(|e| e.into_inner()),
            Some(deadline) => loop {
                match self.upload_lock.try_lock() {
                    Ok(guard) => break guard,
                    Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                    Err(std::sync::TryLockError::WouldBlock) => {
                        if Instant::now() >= deadline {
                            return Outcome::Failed("busy".into());
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            },
        };
        let timeout = match deadline {
            None => TIMEOUT,
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Outcome::Failed("busy".into());
                }
                left.min(TIMEOUT)
            }
        };
        let outcome = self.upload(timeout);
        let now = Some(Instant::now());
        match &outcome {
            Outcome::Sent => *self.last_flush.lock().unwrap_or_else(|e| e.into_inner()) = now,
            Outcome::Failed(kind) => {
                *self.last_failure.lock().unwrap_or_else(|e| e.into_inner()) = now;
                // Kind only: never counters, paths or the address.
                eprintln!("smart-beat: usage upload failed ({kind})");
            }
            Outcome::Idle => {}
        }
        outcome
    }

    fn upload(&self, timeout: Duration) -> Outcome {
        let Some(endpoint) = self.endpoint.as_deref() else {
            return Outcome::Idle;
        };
        if !self.settings().enabled {
            return Outcome::Idle;
        }
        let sent = self.pending();
        if sent.is_empty() {
            return Outcome::Idle;
        }
        let batch = Batch {
            version: &self.version,
            os: std::env::consts::OS,
            installer: &self.installer,
            counts: &sent,
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build()
            .into();
        match agent.post(endpoint).send_json(&batch) {
            Ok(r) if r.status().is_success() => {
                self.subtract(&sent);
                Outcome::Sent
            }
            Ok(r) => Outcome::Failed(format!("HTTP {}", r.status().as_u16())),
            Err(ureq::Error::StatusCode(code)) => Outcome::Failed(format!("HTTP {code}")),
            Err(ureq::Error::Timeout(_)) => Outcome::Failed("timeout".into()),
            Err(ureq::Error::Io(_)) => Outcome::Failed("network".into()),
            Err(_) => Outcome::Failed("other".into()),
        }
    }

    fn subtract(&self, sent: &[Entry]) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut counters = self.load();
        for entry in sent {
            let key = match &entry.format {
                Some(f) => format!("{}|{f}", entry.event),
                None => format!("{}|", entry.event),
            };
            if let Some(day) = counters.days.get_mut(&entry.day) {
                if let Some(count) = day.get_mut(&key) {
                    *count = count.saturating_sub(entry.count);
                    if *count == 0 {
                        day.remove(&key);
                    }
                }
                if day.is_empty() {
                    counters.days.remove(&entry.day);
                }
            }
        }
        let _ = write_json(&self.usage_path(), &counters);
    }
}

/// Counts every panic of the process under its area and sends it at once (#164). The hook keeps
/// the default behaviour (the previous hook still runs) and can neither panic nor wait: a panic
/// inside a panic hook aborts the process, so everything runs under `catch_unwind`, and only the
/// area is derived from the panic location. Message and location are dropped. Installed once.
pub fn install_panic_hook(telemetry: std::sync::Arc<Telemetry>) {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let area = info.location().map_or("other", |at| panic_area(at.file()));
                telemetry.record_panic(area);
                telemetry.flush_urgent_in_background();
            }));
            previous(info);
        }));
    });
}

fn key(event: Event, format: Option<&str>) -> String {
    let name = serde_json::to_value(event)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    format!("{name}|{}", format.unwrap_or(""))
}

/// Keeps the newest [`MAX_DAYS`] days.
fn trim(counters: &mut Counters) {
    while counters.days.len() > MAX_DAYS {
        counters.days.pop_first();
    }
}

fn entries(counters: &Counters) -> Vec<Entry> {
    let mut out = Vec::new();
    'days: for (day, counts) in &counters.days {
        for (key, count) in counts {
            if out.len() >= MAX_ENTRIES {
                break 'days;
            }
            let (event, format) = key.split_once('|').unwrap_or((key, ""));
            out.push(Entry {
                day: day.clone(),
                event: event.to_owned(),
                format: (!format.is_empty()).then(|| format.to_owned()),
                count: *count,
            });
        }
    }
    out
}

/// `dmg`, `windows`, `appimage`, `linux-pkg` or `dev`.
fn installer() -> String {
    match BUILT_INSTALLER.filter(|i| !i.is_empty()) {
        Some("linux") if std::env::var_os("APPIMAGE").is_some() => "appimage".into(),
        Some("linux") => "linux-pkg".into(),
        Some(other) => other.to_owned(),
        None => "dev".into(),
    }
}

/// Today's date (UTC) as `YYYY-MM-DD`.
pub fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    civil_date((secs / 86_400) as i64)
}

/// Days since 1970-01-01 → `YYYY-MM-DD` (Howard Hinnant's civil-from-days algorithm).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Saves atomically: a crash mid-write never leaves a torn file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    let io_error = |e: &io::Error| {
        CommandError::new(
            ErrorKind::Io,
            format!("The usage settings could not be saved: {e}"),
        )
    };
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|e| io_error(&e))?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e))?;
    serde_json::to_writer_pretty(&mut file, value)
        .map_err(io::Error::from)
        .and_then(|()| file.flush())
        .map_err(|e| io_error(&e))?;
    file.persist(path).map_err(|e| io_error(&e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    fn telemetry(endpoint: Option<&str>) -> (tempfile::TempDir, Telemetry) {
        let dir = tempfile::tempdir().unwrap();
        let t = Telemetry::new(dir.path().join("nested"), endpoint, "1.2.3");
        (dir, t)
    }

    /// Serves `statuses` one after another and returns the request bodies it received.
    fn mock_server(statuses: Vec<u16>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/batch", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for status in statuses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    data.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&data);
                    if let Some(split) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if data.len() >= split + 4 + length {
                            bodies.push(text[split + 4..].to_string());
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
            }
            bodies
        });
        (url, handle)
    }

    #[test]
    fn dates_are_formatted() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(19_723), "2024-01-01");
        assert_eq!(civil_date(20_513), "2026-03-01");
        assert_eq!(today().len(), 10);
    }

    #[test]
    fn counts_per_day_and_format() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        t.record_on("2026-01-01", Event::LoopOn, None).unwrap();
        t.record_on("2026-01-01", Event::LoopOn, None).unwrap();
        t.record_on("2026-01-01", Event::Export, Some("PDF"))
            .unwrap();
        t.record_on("2026-01-02", Event::Undo, None).unwrap();
        let pending = t.pending();
        assert_eq!(pending.len(), 3);
        assert!(pending.contains(&Entry {
            day: "2026-01-01".into(),
            event: "loop_on".into(),
            format: None,
            count: 2,
        }));
        assert!(pending.contains(&Entry {
            day: "2026-01-01".into(),
            event: "export".into(),
            format: Some("pdf".into()),
            count: 1,
        }));
    }

    #[test]
    fn event_details_are_fixed_and_event_specific() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        for name in [
            "pedal_add",
            "pedal_remove",
            "pedal_move",
            "plugins_on",
            "plugin_scan",
            "plugin_add",
            "plugin_editor_open",
            "copy_to_instrument",
            "audio_transcribe",
            "settings_open",
            "audio_input_change",
            "piano_model_download",
            "record_to_tab",
            "sound_library_import",
            "open_file",
            "export",
            "soundfont_select",
            "play_soundfont",
            "soundfont_download",
            "soundfont_import",
            "record_to_tab_start",
            "record_to_tab_file",
            "tour_start",
            "tour_finish",
            "tour_skip",
            "tour_close",
            "ai_install",
            "ai_rights_confirmed",
            "ai_transcribe_start",
            "ai_transcribe_file",
            "error",
            "panic",
        ] {
            let event: Event = serde_json::from_value(serde_json::json!(name)).unwrap();
            t.record_on("2026-01-01", event, None).unwrap();
            for detail in event.details() {
                t.record_on("2026-01-01", event, Some(detail)).unwrap();
            }
            assert!(
                t.record_on("2026-01-01", event, Some("private name or path"))
                    .is_err()
            );
        }
        for (event, detail) in [
            (Event::PedalAdd, "vst3"),
            (Event::PluginAdd, "amp"),
            (Event::RecordToTab, "gp5"),
            (Event::Play, "pdf"),
        ] {
            assert!(t.record_on("2026-01-01", event, Some(detail)).is_err());
        }
    }

    #[test]
    fn unknown_formats_are_rejected() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        let err = t
            .record_on("2026-01-01", Event::OpenFile, Some("my song.gp5"))
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidSettings);
        assert!(t.pending().is_empty());
    }

    #[test]
    fn nothing_is_written_without_an_endpoint() {
        let (dir, t) = telemetry(None);
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(!dir.path().join("nested").exists());
        assert!(!t.settings().available);
        assert!(!t.flush());
    }

    #[test]
    fn nothing_is_written_when_switched_off_and_old_counters_are_forgotten() {
        let (dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert_eq!(t.pending().len(), 1);
        let settings = t.update_settings(Some(false), None).unwrap();
        assert!(!settings.enabled);
        assert!(!dir.path().join("nested").join(USAGE_FILE).exists());
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(t.pending().is_empty());
        t.update_settings(Some(true), None).unwrap();
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert_eq!(t.pending().len(), 1);
    }

    #[test]
    fn notice_flag_is_remembered() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        assert!(!t.settings().notice_seen);
        assert!(t.settings().enabled);
        t.update_settings(None, Some(true)).unwrap();
        assert!(t.settings().notice_seen);
        assert!(t.settings().enabled);
    }

    #[test]
    fn keeps_only_the_newest_thirty_days() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        for n in 1..=35 {
            t.record_on(&format!("2026-02-{n:02}"), Event::Play, None)
                .unwrap();
        }
        let pending = t.pending();
        assert_eq!(pending.len(), MAX_DAYS);
        assert_eq!(pending[0].day, "2026-02-06");
    }

    #[test]
    fn upload_has_exactly_the_documented_shape_and_clears_counters() {
        let (url, server) = mock_server(vec![200]);
        let (_dir, t) = telemetry(Some(&url));
        t.record_on("2026-01-01", Event::LoopOn, None).unwrap();
        t.record_on("2026-01-01", Event::Export, Some("pdf"))
            .unwrap();
        assert!(t.flush());
        assert!(t.pending().is_empty());
        let bodies = server.join().unwrap();
        let body: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        let object = body.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["counts", "installer", "os", "version"]);
        assert_eq!(body["version"], "1.2.3");
        assert_eq!(body["installer"], "dev");
        assert_eq!(body["counts"].as_array().unwrap().len(), 2);
        for entry in body["counts"].as_array().unwrap() {
            let mut keys: Vec<&str> = entry
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert!(
                keys == ["count", "day", "event"] || keys == ["count", "day", "event", "format"]
            );
        }
    }

    #[test]
    fn failed_uploads_keep_the_counters_for_the_next_attempt() {
        let (url, server) = mock_server(vec![500, 200]);
        let (_dir, t) = telemetry(Some(&url));
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(!t.flush());
        assert_eq!(t.pending().len(), 1);
        assert!(t.flush());
        assert!(t.pending().is_empty());
        assert_eq!(server.join().unwrap().len(), 2);
    }

    #[test]
    fn a_failed_upload_only_starts_the_short_back_off() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:1/v1/batch"));
        let t = std::sync::Arc::new(t);
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(t.due());
        assert!(matches!(t.flush_final(), Outcome::Failed(_)));
        assert!(!t.due(), "back-off right after a failure");
        *t.last_failure.lock().unwrap() = Some(Instant::now() - RETRY_AFTER);
        assert!(t.due(), "a failure never waits for the hour");
        assert!(t.last_flush.lock().unwrap().is_none());
    }

    #[test]
    fn an_empty_queue_sets_no_pause() {
        let (url, _server) = mock_server(vec![]);
        let (_dir, t) = telemetry(Some(&url));
        assert_eq!(t.flush_final(), Outcome::Idle);
        assert!(t.due());
        assert!(t.last_flush.lock().unwrap().is_none());
    }

    #[test]
    fn a_success_starts_the_hourly_pause() {
        let (url, server) = mock_server(vec![200]);
        let (_dir, t) = telemetry(Some(&url));
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(t.flush());
        assert!(!t.due());
        *t.last_flush.lock().unwrap() = Some(Instant::now() - FLUSH_INTERVAL);
        assert!(t.due());
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn the_final_flush_ignores_the_pauses_and_keeps_counters_on_failure() {
        let (url, server) = mock_server(vec![500, 200]);
        let (_dir, t) = telemetry(Some(&url));
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        *t.last_flush.lock().unwrap() = Some(Instant::now());
        assert_eq!(t.flush_final(), Outcome::Failed("HTTP 500".into()));
        assert_eq!(t.pending().len(), 1);
        assert_eq!(t.flush_final(), Outcome::Sent);
        assert!(t.pending().is_empty());
        assert_eq!(server.join().unwrap().len(), 2);
    }

    #[test]
    fn counters_of_a_failed_final_flush_arrive_with_the_next_launch() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let offline = Telemetry::new(&data, Some("http://127.0.0.1:1/v1/batch"), "1.2.3");
        offline.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(matches!(offline.flush_final(), Outcome::Failed(_)));
        drop(offline);

        let (url, server) = mock_server(vec![200]);
        let next = std::sync::Arc::new(Telemetry::new(&data, Some(&url), "1.2.3"));
        next.record_on("2026-01-02", Event::AppStart, None).unwrap();
        next.flush_at_launch();
        let bodies = server.join().unwrap();
        assert!(bodies[0].contains("\"play\"") && bodies[0].contains("\"app_start\""));
    }

    #[test]
    fn a_short_session_is_delivered_by_the_final_flush() {
        let (url, server) = mock_server(vec![200]);
        let (_dir, t) = telemetry(Some(&url));
        for e in [Event::AppStart, Event::Play, Event::Stop] {
            t.record_on("2026-01-01", e, None).unwrap();
        }
        assert_eq!(t.flush_final(), Outcome::Sent);
        let body = &server.join().unwrap()[0];
        assert!(body.contains("app_start") && body.contains("play") && body.contains("stop"));
    }

    #[test]
    fn the_final_flush_shares_one_deadline_with_a_running_upload() {
        // A server that accepts and never answers: the running upload hangs until its timeout.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/batch", listener.local_addr().unwrap());
        let (_dir, t) = telemetry(Some(&url));
        let t = std::sync::Arc::new(t);
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        let running = std::sync::Arc::clone(&t);
        let hanging = std::thread::spawn(move || running.flush());
        let _held = listener.accept().unwrap();
        let started = Instant::now();
        let outcome = t.flush_final_within(Duration::from_millis(400));
        assert_eq!(outcome, Outcome::Failed("busy".into()));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(t.pending().len(), 1, "counters stay for the next launch");
        drop(_held);
        let _ = hanging.join();
    }

    #[test]
    fn unreachable_server_is_silent_and_keeps_counters() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:1/v1/batch"));
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert!(!t.flush());
        assert_eq!(t.pending().len(), 1);
    }

    #[test]
    fn nothing_is_sent_when_switched_off() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:1/v1/batch"));
        t.update_settings(Some(false), None).unwrap();
        assert!(!t.flush());
    }

    #[test]
    fn damaged_files_read_as_empty() {
        let (dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        let nested = dir.path().join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join(USAGE_FILE), "{not json").unwrap();
        fs::write(nested.join(SETTINGS_FILE), "{not json").unwrap();
        assert!(t.pending().is_empty());
        assert!(t.settings().enabled);
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        assert_eq!(t.pending().len(), 1);
    }

    #[test]
    fn event_names_are_snake_case() {
        assert_eq!(
            serde_json::to_value(Event::SpeedTrainerStart).unwrap(),
            "speed_trainer_start"
        );
        assert!(serde_json::from_value::<Event>("my_song".into()).is_err());
    }

    #[test]
    fn selection_and_restart_events_are_known() {
        for name in [
            "shift_select",
            "copy",
            "cut",
            "delete_selection",
            "loop_selection",
            "practise_selection",
            "play_selection",
            "restart_on_stop_on",
            "restart_on_stop_off",
            "restart_on_stop_used",
        ] {
            let event: Event = serde_json::from_value(name.into()).unwrap();
            assert_eq!(serde_json::to_value(event).unwrap(), name);
        }
    }

    #[test]
    fn the_1_0_1_counters_are_known_and_take_only_their_details() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        // Counters without a detail.
        for name in [
            "drum_normalize",
            "track_duplicate",
            "practice_speed",
            "practice_range",
            "speed_trainer_stop",
            "speed_trainer_hold",
            "practice_view",
            "continuous_view",
            "multi_track_view",
        ] {
            let event: Event = serde_json::from_value(name.into()).unwrap();
            assert_eq!(serde_json::to_value(event).unwrap(), name);
            t.record_on("2026-01-01", event, None).unwrap();
            assert!(t.record_on("2026-01-01", event, Some("pdf")).is_err());
        }
        // Sound sets: the two bundled, the five recommended banks, and "custom" for any file the
        // user imported. A file or bank name is never accepted.
        for set in [
            "sonivox",
            "fluidr3",
            "musescore-general",
            "generaluser-gs",
            "fluidr3-gm",
            "timbres-of-heaven",
            "arachno",
            "custom",
        ] {
            t.record_on("2026-01-01", Event::SoundfontSelect, Some(set))
                .unwrap();
            t.record_on("2026-01-01", Event::PlaySoundfont, Some(set))
                .unwrap();
        }
        for private in ["My Bank.sf2", "stored:my-bank", "my-bank"] {
            assert!(
                t.record_on("2026-01-01", Event::SoundfontSelect, Some(private))
                    .is_err()
            );
            assert!(
                t.record_on("2026-01-01", Event::PlaySoundfont, Some(private))
                    .is_err()
            );
        }
        // Only catalogue banks are counted as downloads; imports carry no name.
        t.record_on("2026-01-01", Event::SoundfontDownload, Some("arachno"))
            .unwrap();
        assert!(
            t.record_on("2026-01-01", Event::SoundfontDownload, Some("custom"))
                .is_err()
        );
        assert!(
            t.record_on("2026-01-01", Event::SoundfontImport, Some("custom"))
                .is_err()
        );
        // Record to Tab: live and from a file, per instrument.
        for event in [Event::RecordToTabStart, Event::RecordToTabFile] {
            for instrument in ["guitar", "bass", "piano", "drums"] {
                t.record_on("2026-01-01", event, Some(instrument)).unwrap();
            }
            assert!(t.record_on("2026-01-01", event, Some("violin")).is_err());
        }
        // The tours, each separately; a tour name that does not exist is refused.
        for event in [
            Event::TourStart,
            Event::TourFinish,
            Event::TourSkip,
            Event::TourClose,
        ] {
            for tour in [
                "main",
                "editing",
                "speed-trainer",
                "effects",
                "record-to-tab",
            ] {
                t.record_on("2026-01-01", event, Some(tour)).unwrap();
            }
            assert!(t.record_on("2026-01-01", event, Some("secret")).is_err());
        }
    }

    #[test]
    fn error_and_panic_details_are_fixed_lists() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        // Every area with every kind; 10 areas x 14 kinds, each once.
        assert_eq!(
            Event::Error.details().len(),
            ERROR_AREAS.len() * ERROR_KINDS.len()
        );
        for area in ERROR_AREAS {
            for kind in ERROR_KINDS {
                t.record_on("2026-01-01", Event::Error, Some(&format!("{area}:{kind}")))
                    .unwrap();
            }
            t.record_on("2026-01-01", Event::Panic, Some(area)).unwrap();
        }
        for bad in [
            "audio",
            "audio:",
            ":io",
            "foo:io",
            "audio:foo",
            "audio:io:extra",
            "audio io",
            "/Users/jane/My Song.gp5",
            "disk on fire",
        ] {
            assert!(
                t.record_on("2026-01-01", Event::Error, Some(bad)).is_err(),
                "{bad}"
            );
        }
        for bad in ["audio:io", "foo", "", "/Users/jane", "a|b"] {
            assert!(
                t.record_on("2026-01-01", Event::Panic, Some(bad)).is_err(),
                "{bad}"
            );
        }
        // Not allowed on other events, and neither event is a free-text channel.
        assert!(
            t.record_on("2026-01-01", Event::Play, Some("audio:io"))
                .is_err()
        );
        assert!(
            t.record_on("2026-01-01", Event::Export, Some("audio"))
                .is_err()
        );
        // The detail is kept in its canonical spelling.
        t.record_on("2026-01-02", Event::Error, Some("AUDIO:Not-Found"))
            .unwrap();
        assert!(t.pending().iter().any(|e| e.day == "2026-01-02"
            && e.event == "error"
            && e.format.as_deref() == Some("audio:not-found")));
    }

    #[test]
    fn error_kinds_match_the_command_error_kinds() {
        // Exhaustive on purpose: a new `ErrorKind` fails to compile here until it is counted.
        fn wire(kind: ErrorKind) -> &'static str {
            match kind {
                ErrorKind::NotFound => "not-found",
                ErrorKind::UnsupportedType => "unsupported-type",
                ErrorKind::TooLarge => "too-large",
                ErrorKind::NotAScore => "not-a-score",
                ErrorKind::InvalidKey => "invalid-key",
                ErrorKind::InvalidSettings => "invalid-settings",
                ErrorKind::InvalidMenuState => "invalid-menu-state",
                ErrorKind::Audio => "audio",
                ErrorKind::Conflict => "conflict",
                ErrorKind::DownloadTimeout => "download-timeout",
                ErrorKind::Network => "network",
                ErrorKind::AuthExpired => "auth-expired",
                ErrorKind::Io => "io",
            }
        }
        let all = [
            ErrorKind::NotFound,
            ErrorKind::UnsupportedType,
            ErrorKind::TooLarge,
            ErrorKind::NotAScore,
            ErrorKind::InvalidKey,
            ErrorKind::InvalidSettings,
            ErrorKind::InvalidMenuState,
            ErrorKind::Audio,
            ErrorKind::Conflict,
            ErrorKind::DownloadTimeout,
            ErrorKind::Network,
            ErrorKind::AuthExpired,
            ErrorKind::Io,
        ];
        for kind in all {
            assert_eq!(serde_json::to_value(kind).unwrap(), wire(kind));
            assert!(ERROR_KINDS.contains(&wire(kind)), "{kind:?}");
        }
        assert_eq!(
            ERROR_KINDS.len(),
            all.len() + 1,
            "the extra one is `unknown`"
        );
        assert_eq!(ERROR_KINDS.last(), Some(&"unknown"));
    }

    #[test]
    fn error_and_panic_are_urgent_and_nothing_else_is() {
        assert!(Event::Error.is_urgent() && Event::Panic.is_urgent());
        for event in [
            Event::Play,
            Event::Export,
            Event::AppStart,
            Event::AiInstall,
        ] {
            assert!(!event.is_urgent());
        }
    }

    #[test]
    fn panics_are_filed_under_an_area_never_a_file() {
        for (file, area) in [
            ("src/audio/engine.rs", "audio"),
            ("src-tauri/src/audio/engine.rs", "audio"),
            ("src/audio/plugin.rs", "plugin"),
            ("src/audio/plugin_process.rs", "plugin"),
            ("src/stems/mod.rs", "stems"),
            ("src/separation/pipeline.rs", "stems"),
            ("src/recording/muscriptor.rs", "ai"),
            ("src/transcription.rs", "import"),
            ("src/cloud/oauth.rs", "cloud"),
            ("src/cloud_commands.rs", "cloud"),
            ("src/pdf.rs", "export"),
            ("src/m4a.rs", "export"),
            ("src/score_file.rs", "file"),
            ("src/recent.rs", "file"),
            ("src/mixer.rs", "settings"),
            (r"src-tauri\src\audio\mod.rs", "audio"),
            ("src/startup.rs", "other"),
            ("src/lib.rs", "other"),
            ("", "other"),
            (
                "/Users/jane/.cargo/registry/src/index.crates.io-1/foo-1.0.0/src/audio/x.rs",
                "other",
            ),
            ("/rustc/abc/library/core/src/option.rs", "other"),
            ("nothing", "other"),
        ] {
            assert_eq!(panic_area(file), area, "{file}");
            assert!(ERROR_AREAS.contains(&panic_area(file)));
        }
    }

    #[test]
    fn a_panic_is_counted_under_its_area() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        t.record_panic_on("2026-01-01", "audio");
        t.record_panic_on("2026-01-01", "audio");
        t.record_panic_on("2026-01-01", "cloud");
        // An area that is not on the list is ignored, never stored.
        t.record_panic_on("2026-01-01", "/Users/jane/My Song.gp5");
        let pending = t.pending();
        assert_eq!(pending.len(), 2);
        assert!(pending.contains(&Entry {
            day: "2026-01-01".into(),
            event: "panic".into(),
            format: Some("audio".into()),
            count: 2,
        }));
    }

    #[test]
    fn a_panic_does_nothing_when_the_counters_are_off() {
        let (dir, t) = telemetry(None);
        t.record_panic("audio");
        assert!(!dir.path().join("nested").exists());
        assert!(t.pending().is_empty());
        let (dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        t.update_settings(Some(false), None).unwrap();
        t.record_panic("audio");
        assert!(!dir.path().join("nested").join(USAGE_FILE).exists());
    }

    #[test]
    fn recording_a_panic_never_waits_for_the_counter_lock() {
        let (dir, t) = telemetry(Some("http://127.0.0.1:9/x"));
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        let held = t.lock.lock().unwrap();
        // The hook may run while `record_on` holds the lock (a panic inside it): it must return.
        t.record_panic_on("2026-01-01", "audio");
        assert!(
            !fs::read_to_string(dir.path().join("nested").join(USAGE_FILE))
                .unwrap()
                .contains("panic")
        );
        drop(held);
        // Nothing was lost: the next normal access writes it.
        assert!(
            t.pending()
                .iter()
                .any(|e| e.event == "panic" && e.count == 1)
        );
        assert!(
            fs::read_to_string(dir.path().join("nested").join(USAGE_FILE))
                .unwrap()
                .contains("panic|audio")
        );
    }

    #[test]
    fn a_panic_with_an_unwritable_data_folder_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        // The data folder is a file, so nothing can be saved there.
        let blocker = dir.path().join("data");
        fs::write(&blocker, "x").unwrap();
        let t = Telemetry::new(&blocker, Some("http://127.0.0.1:9/x"), "1.2.3");
        t.record_panic_on("2026-01-01", "audio");
        t.record_panic_on("2026-01-01", "other");
    }

    #[test]
    fn an_urgent_upload_ignores_the_hourly_pause_but_not_the_back_off() {
        let (_dir, t) = telemetry(Some("http://127.0.0.1:1/v1/batch"));
        *t.last_flush.lock().unwrap() = Some(Instant::now());
        assert!(!t.due(), "the hourly pause is running");
        assert!(t.urgent_due(), "an error does not wait for it");
        // Offline: the failed upload is the back-off, errors do not retry in a loop.
        *t.last_failure.lock().unwrap() = Some(Instant::now());
        assert!(!t.urgent_due());
        *t.last_failure.lock().unwrap() = Some(Instant::now() - RETRY_AFTER);
        assert!(t.urgent_due());
        // A burst is one request: the gap since the last urgent upload.
        *t.last_urgent.lock().unwrap() = Some(Instant::now());
        assert!(!t.urgent_due());
        *t.last_urgent.lock().unwrap() = Some(Instant::now() - URGENT_GAP);
        assert!(t.urgent_due());
    }

    /// Waits until the queue is empty or `seconds` have passed.
    fn wait_until_sent(t: &Telemetry, seconds: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < deadline {
            if t.pending().is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn an_error_is_sent_at_once_during_the_hourly_pause() {
        let (url, server) = mock_server(vec![200]);
        let (_dir, t) = telemetry(Some(&url));
        let t = std::sync::Arc::new(t);
        t.record_on("2026-01-01", Event::Play, None).unwrap();
        *t.last_flush.lock().unwrap() = Some(Instant::now());
        t.flush_in_background();
        assert!(!t.pending().is_empty(), "a normal event waits for the hour");

        t.record_on("2026-01-01", Event::Error, Some("audio:io"))
            .unwrap();
        t.flush_urgent_in_background();
        assert!(wait_until_sent(&t, 5), "the error was not sent");
        let bodies = server.join().unwrap();
        assert_eq!(bodies.len(), 1);
        let sent: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        let events: Vec<(&str, Option<&str>)> = sent["counts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["event"].as_str().unwrap(), c["format"].as_str()))
            .collect();
        assert!(events.contains(&("error", Some("audio:io"))), "{events:?}");
        // The queued feature counter rides along.
        assert!(events.contains(&("play", None)), "{events:?}");
    }

    #[test]
    fn an_error_recorded_offline_waits_for_the_next_launch() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let offline = std::sync::Arc::new(Telemetry::new(
            &data,
            Some("http://127.0.0.1:1/v1/batch"),
            "1.2.3",
        ));
        offline
            .record_on("2026-01-01", Event::Error, Some("cloud:network"))
            .unwrap();
        offline.flush_urgent_in_background();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(offline.pending().len(), 1, "nothing was lost while offline");
        drop(offline);

        let (url, server) = mock_server(vec![200]);
        let online = std::sync::Arc::new(Telemetry::new(&data, Some(&url), "1.2.3"));
        online.flush_at_launch();
        assert!(wait_until_sent(&online, 5));
        let sent: serde_json::Value = serde_json::from_str(&server.join().unwrap()[0]).unwrap();
        assert_eq!(sent["counts"][0]["event"], "error");
        assert_eq!(sent["counts"][0]["format"], "cloud:network");
    }

    #[test]
    fn record_to_tab_is_known() {
        let event: Event = serde_json::from_value("record_to_tab".into()).unwrap();
        assert_eq!(serde_json::to_value(event).unwrap(), "record_to_tab");
    }
}
