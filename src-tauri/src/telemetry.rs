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
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
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
/// Pause between two upload attempts.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Network timeout of one upload.
pub const TIMEOUT: Duration = Duration::from_secs(5);

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
            Self::RecordToTab => &["guitar", "bass", "piano", "drums"],
            Self::SoundLibraryImport => &["amp", "cab"],
            _ => &[],
        }
    }
}

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
    last_flush: Mutex<Option<Instant>>,
    flushing: AtomicBool,
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
            flushing: AtomicBool::new(false),
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
        entries(&self.load())
    }

    /// Uploads the pending counters once. The local counters are reduced by exactly what the
    /// server acknowledged (2xx); anything recorded meanwhile, and everything after a failure,
    /// stays for the next attempt. Returns whether a batch was accepted.
    pub fn flush(&self) -> bool {
        let Some(endpoint) = self.endpoint.as_deref() else {
            return false;
        };
        if !self.settings().enabled {
            return false;
        }
        let sent = self.pending();
        if sent.is_empty() {
            return false;
        }
        let os = std::env::consts::OS;
        let batch = Batch {
            version: &self.version,
            os,
            installer: &self.installer,
            counts: &sent,
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .build()
            .into();
        let response = agent.post(endpoint).send_json(&batch);
        let accepted = matches!(response, Ok(ref r) if r.status().is_success());
        if accepted {
            self.subtract(&sent);
        }
        accepted
    }

    /// Starts [`Telemetry::flush`] on a background thread unless one ran within the last hour
    /// or is running. Never blocks and never reports a failure.
    pub fn flush_in_background(self: &std::sync::Arc<Self>) {
        if !self.active() {
            return;
        }
        {
            let mut last = self.last_flush.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|at| at.elapsed() < FLUSH_INTERVAL) {
                return;
            }
            *last = Some(Instant::now());
        }
        if self.flushing.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = std::sync::Arc::clone(self);
        std::thread::spawn(move || {
            this.flush();
            this.flushing.store(false, Ordering::SeqCst);
        });
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
    fn record_to_tab_is_known() {
        let event: Event = serde_json::from_value("record_to_tab".into()).unwrap();
        assert_eq!(serde_json::to_value(event).unwrap(), "record_to_tab");
    }
}
