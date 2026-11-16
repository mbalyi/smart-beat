//! Opt-in crash reports for the Rust core (docs/crash-reports.md).
//!
//! **Errors only.** A panic becomes one Sentry event with a scrubbed stack trace
//! ([`crate::crash_scrub`]). There is no session replay, no screen capture, no screenshot, no
//! attachment, no user feedback, no tracing, no performance data, no logs, no profiling and no
//! breadcrumbs: none of those integrations is compiled in or configured (the `sentry` crate is
//! built without its default features, and a test checks this).
//!
//! **Off by default.** Nothing is created, initialised or sent until the user switches "Send
//! crash reports" on, and only when this build has an address ([`DSN`], baked in by the release
//! pipeline from `SMART_BEAT_SENTRY_DSN_CORE`). Switching it off drops the client at once:
//! a gate in front of the network request also stops anything that was already queued.
//!
//! The panic hook of this module talks to the client directly, not through Sentry's hub, so it
//! works on every thread and can be switched on and off any number of times.

use std::fs;
use std::io::{self, Write};
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once, RwLock};
use std::time::Duration;

use sentry::integrations::backtrace::current_stacktrace;
use sentry::protocol::{Event, Exception, Frame, Level, Stacktrace};
use sentry::transports::UreqHttpTransportOptions;
use sentry::types::Dsn;
use sentry::{Client, ClientOptions, Transport, TransportFactory, TransportOptions};
use serde::{Deserialize, Serialize};
use ureq::http::{Request, Response};
use ureq::middleware::{Middleware, MiddlewareNext};
use ureq::{Body, SendBody};

use crate::crash_scrub::{app_location, environment, os_name, scrub_event};
use crate::error::{CommandError, ErrorKind};

/// File name inside the app data folder. Separate from `settings.json` (the usage counters).
pub const SETTINGS_FILE: &str = "crash-reports.json";

/// The Sentry project of the Rust core. Set when the release pipeline builds the app; builds
/// without it (development, pull requests, forks) never create a client.
pub const DSN: Option<&str> = option_env!("SMART_BEAT_SENTRY_DSN_CORE");

/// How long a panic waits for its report to leave before the process goes on.
const PANIC_FLUSH: Duration = Duration::from_secs(2);
/// Network timeout of one report.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Most reports one run sends: a crash loop in a thread must not flood the project.
pub const MAX_REPORTS_PER_RUN: u32 = 10;

/// What the Settings dialog shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSettings {
    /// The user switched crash reports on (off until they say otherwise).
    pub enabled: bool,
    /// This build can send crash reports at all (the core address was compiled in).
    pub available: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    enabled: bool,
}

/// The client the panic hook reports to. `None` while crash reports are off.
static CURRENT: RwLock<Option<Arc<Client>>> = RwLock::new(None);
static HOOK: Once = Once::new();

/// A running client and the gate in front of its network requests.
struct Active {
    client: Arc<Client>,
    open: Arc<AtomicBool>,
}

/// The crash report settings and the client. Stored as Tauri state.
pub struct CrashReports {
    dir: PathBuf,
    dsn: Option<Dsn>,
    version: String,
    /// `None` sends with ureq.
    transport: Option<Arc<dyn TransportFactory>>,
    active: Mutex<Option<Active>>,
}

impl CrashReports {
    /// `dir` is created on the first save. `dsn` is `None` in builds without an address, which
    /// makes every method a no-op. A value that is not a valid address counts as none.
    pub fn new(dir: impl Into<PathBuf>, dsn: Option<&str>, version: &str) -> Self {
        Self::build(dir, dsn, version, None)
    }

    /// Like [`CrashReports::new`] with another way to send (tests).
    pub fn with_transport(
        dir: impl Into<PathBuf>,
        dsn: Option<&str>,
        version: &str,
        transport: Arc<dyn TransportFactory>,
    ) -> Self {
        Self::build(dir, dsn, version, Some(transport))
    }

    fn build(
        dir: impl Into<PathBuf>,
        dsn: Option<&str>,
        version: &str,
        transport: Option<Arc<dyn TransportFactory>>,
    ) -> Self {
        Self {
            dir: dir.into(),
            dsn: dsn
                .map(str::trim)
                .filter(|dsn| !dsn.is_empty())
                .and_then(|dsn| dsn.parse().ok()),
            version: version.to_owned(),
            transport,
            active: Mutex::new(None),
        }
    }

    fn settings_path(&self) -> PathBuf {
        self.dir.join(SETTINGS_FILE)
    }

    fn stored(&self) -> Stored {
        fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn settings(&self) -> CrashReportSettings {
        CrashReportSettings {
            enabled: self.stored().enabled,
            available: self.dsn.is_some(),
        }
    }

    /// Whether a client is running (and so a panic would be reported).
    pub fn running(&self) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// Saves the choice and starts or stops the client to match it.
    pub fn set_enabled(&self, enabled: bool) -> Result<CrashReportSettings, CommandError> {
        write_json(&self.settings_path(), &Stored { enabled })?;
        if enabled {
            self.start();
        } else {
            self.stop();
        }
        Ok(self.settings())
    }

    /// Starts the client at launch when the user switched crash reports on earlier.
    pub fn start_if_enabled(&self) {
        if self.stored().enabled {
            self.start();
        }
    }

    /// Starts the client. Does nothing without an address or when it already runs.
    fn start(&self) {
        let Some(dsn) = self.dsn.clone() else {
            return;
        };
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return;
        }
        let open = Arc::new(AtomicBool::new(true));
        let gated: Arc<dyn TransportFactory> = Arc::new(Gated {
            inner: self.transport.clone(),
            open: Arc::clone(&open),
        });
        let client = Arc::new(Client::from(client_options(dsn, &self.version, gated)));
        install_panic_hook();
        *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&client));
        *active = Some(Active { client, open });
    }

    /// Stops sending at once: the gate closes first, so nothing queued goes out later.
    pub fn stop(&self) {
        let taken = self.active.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(active) = taken else {
            return;
        };
        active.open.store(false, Ordering::SeqCst);
        *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = None;
        // No waiting: the gate already refuses every request.
        active.client.close(Some(Duration::ZERO));
    }
}

/// The client options: errors only, nothing from the machine, everything through the scrubber.
pub fn client_options(
    dsn: Dsn,
    version: &str,
    transport: Arc<dyn TransportFactory>,
) -> ClientOptions {
    let release = version.to_owned();
    let environment = environment();
    let os = os_name();
    let sent = std::sync::atomic::AtomicU32::new(0);
    let mut options = ClientOptions::new();
    options.dsn = Some(dsn);
    options.release = Some(release.clone().into());
    options.environment = Some(environment.into());
    // The machine's name never leaves the device.
    options.server_name = Some("".into());
    options.send_default_pii = false;
    // No default integrations: no contexts, debug images or stack trace attachment. Panics are
    // caught by this module's hook, so the list stays empty.
    options.default_integrations = false;
    options.integrations = Vec::new();
    options.max_breadcrumbs = 0;
    options.attach_stacktrace = false;
    options.shutdown_timeout = PANIC_FLUSH;
    options.transport = Some(transport);
    options.before_send = Some(Arc::new(move |event| {
        let scrubbed = scrub_event(event, &release, environment, os)?;
        // The cap counts what would be sent; a count that is not kept goes unsent.
        (sent.fetch_add(1, Ordering::SeqCst) < MAX_REPORTS_PER_RUN).then_some(scrubbed)
    }));
    options
}

/// Chains this module's hook in front of the existing one, once per process. While crash
/// reports are off the hook finds no client and does nothing.
fn install_panic_hook() {
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| report_panic(info)));
            previous(info);
        }));
    });
}

fn report_panic(info: &PanicHookInfo<'_>) {
    // `try_read`: a panic while the client is being replaced must not wait for it.
    let client = match CURRENT.try_read() {
        Ok(current) => current.clone(),
        Err(_) => None,
    };
    let Some(client) = client else {
        return;
    };
    // Only the place of the panic is read, never its message or payload.
    let location = info
        .location()
        .map(|at| (at.file(), at.line(), at.column()));
    let frames = current_stacktrace()
        .map(|trace| trace.frames)
        .unwrap_or_default();
    client.capture_event(panic_event(location, frames), None);
    client.flush(Some(PANIC_FLUSH));
}

/// The event of a panic: the exception type `panic` and the frames of the backtrace, which has
/// no names in a stripped release build. The place of the panic (`std::panic::Location`) is baked
/// into the program as constants, so it survives stripping: it becomes the last frame (Sentry
/// lists frames oldest first and shows the last one on top) named `panic`, with its line and
/// column. It is only added when the file is part of Smart Beat (`src/...` or
/// `src-tauri/src/...`); a panic in a dependency or in the standard library has none. The
/// message is never read, so it cannot end up in the event.
pub fn panic_event(location: Option<(&str, u32, u32)>, mut frames: Vec<Frame>) -> Event<'static> {
    if let Some((file, line, column)) = location
        && let Some(filename) = app_location(file)
    {
        frames.push(Frame {
            function: Some("panic".to_owned()),
            filename: Some(filename),
            lineno: Some(line.into()),
            colno: Some(column.into()),
            ..Frame::default()
        });
    }
    Event {
        level: Level::Fatal,
        exception: vec![Exception {
            ty: "panic".to_owned(),
            stacktrace: Some(Stacktrace {
                frames,
                ..Stacktrace::default()
            }),
            ..Exception::default()
        }]
        .into(),
        ..Event::default()
    }
}

fn build_ureq(general: TransportOptions, open: Arc<AtomicBool>) -> Arc<dyn Transport> {
    let agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::Rustls)
                .build(),
        )
        .timeout_global(Some(REQUEST_TIMEOUT))
        .middleware(GateMiddleware(open))
        .build()
        .new_agent();
    Arc::new(
        UreqHttpTransportOptions::from(general)
            .with_agent(agent)
            .build(),
    )
}

/// Refuses a request while the gate is closed, at the moment it would leave.
struct GateMiddleware(Arc<AtomicBool>);

impl Middleware for GateMiddleware {
    fn handle(
        &self,
        request: Request<SendBody>,
        next: MiddlewareNext,
    ) -> Result<Response<Body>, ureq::Error> {
        if !self.0.load(Ordering::SeqCst) {
            return Err(ureq::Error::Io(io::Error::other("crash reports are off")));
        }
        next.handle(request)
    }
}

/// Builds the transport of a client (ureq unless another one was given) and wraps it in the gate.
struct Gated {
    inner: Option<Arc<dyn TransportFactory>>,
    open: Arc<AtomicBool>,
}

impl TransportFactory for Gated {
    fn create_transport_with_options(&self, options: TransportOptions) -> Arc<dyn Transport> {
        // The default sender gets the same gate in front of its request; another one (tests)
        // is gated when it is handed an envelope.
        let inner = match &self.inner {
            None => build_ureq(options, Arc::clone(&self.open)),
            Some(other) => other.create_transport_with_options(options),
        };
        Arc::new(GatedTransport {
            inner,
            open: Arc::clone(&self.open),
        })
    }
}

struct GatedTransport {
    inner: Arc<dyn Transport>,
    open: Arc<AtomicBool>,
}

impl Transport for GatedTransport {
    fn send_envelope(&self, envelope: sentry::Envelope) {
        if self.open.load(Ordering::SeqCst) {
            self.inner.send_envelope(envelope);
        }
    }

    fn flush(&self, timeout: Duration) -> bool {
        self.inner.flush(timeout)
    }

    fn shutdown(&self, timeout: Duration) -> bool {
        self.inner.shutdown(timeout)
    }
}

/// Saves atomically: a crash mid-write never leaves a torn file.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    let io_error = |e: &io::Error| {
        CommandError::new(
            ErrorKind::Io,
            format!("The crash report setting could not be saved: {e}"),
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
    use sentry::Envelope;
    use std::net::TcpListener;
    use std::sync::Mutex as StdMutex;

    /// A fake address: nothing here ever connects to it, the tests collect envelopes instead.
    const FAKE_DSN: &str = "https://public@o0.ingest.de.sentry.io/1";

    /// The panic hook and its client are process-wide, so the tests that start a client take turns.
    static ONE_AT_A_TIME: StdMutex<()> = StdMutex::new(());

    /// Collects what would be sent.
    #[derive(Clone, Default)]
    struct Collector(Arc<StdMutex<Vec<String>>>);

    impl Collector {
        fn sent(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
        fn factory(&self) -> Arc<dyn TransportFactory> {
            Arc::new(self.clone())
        }
    }

    impl Transport for Collector {
        fn send_envelope(&self, envelope: Envelope) {
            let mut body = Vec::new();
            envelope.to_writer(&mut body).unwrap();
            self.0
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&body).into_owned());
        }
    }

    impl TransportFactory for Collector {
        fn create_transport_with_options(&self, _: TransportOptions) -> Arc<dyn Transport> {
            Arc::new(self.clone())
        }
    }

    fn reports(dir: &Path, dsn: Option<&str>, collector: &Collector) -> CrashReports {
        CrashReports::with_transport(dir, dsn, "9.9.9", collector.factory())
    }

    /// Panics in a thread of its own, with a message that must never be sent.
    fn crash_in_a_thread() {
        let outcome = std::thread::spawn(|| {
            let name = "/Users/jane/My Secret Song.gp5";
            panic!("could not open {name} for jane@example.com");
        })
        .join();
        assert!(outcome.is_err());
    }

    /// A backtrace frame as a stripped build has it: an address and nothing else.
    fn nameless() -> Frame {
        Frame {
            instruction_addr: Some(0xdead_beef_u64.into()),
            ..Frame::default()
        }
    }

    fn scrubbed(event: Event<'static>) -> Option<Event<'static>> {
        scrub_event(event, "9.9.9", "production", Some("macos"))
    }

    fn frames_of(event: &Event<'static>) -> Vec<Frame> {
        event.exception.values[0]
            .stacktrace
            .as_ref()
            .unwrap()
            .frames
            .clone()
    }

    #[test]
    fn a_stripped_build_still_reports_the_place_of_the_panic() {
        // Nothing usable in the backtrace: only the location frame is left, and the event lives.
        let event = panic_event(
            Some((
                "/Users/jane/work/smart-beat/src-tauri/src/audio/mod.rs",
                12,
                34,
            )),
            vec![nameless(), nameless()],
        );
        let sent = scrubbed(event).expect("the location keeps the event alive");
        let frames = frames_of(&sent);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0].function.as_deref(), Some("panic"));
        assert_eq!(
            frames[0].filename.as_deref(),
            Some("src-tauri/src/audio/mod.rs")
        );
        assert_eq!((frames[0].lineno, frames[0].colno), (Some(12), Some(34)));
        assert_eq!(sent.exception.values[0].ty, "panic");
        let body = serde_json::to_string(&sent).unwrap();
        assert!(!body.contains("jane") && !body.contains("/Users"), "{body}");

        // The path the compiler bakes in is relative: the same result.
        let relative = scrubbed(panic_event(Some(("src/stems/mod.rs", 1, 2)), vec![])).unwrap();
        assert_eq!(frames_of(&relative).len(), 1);

        // With named frames the place of the panic comes last (the top of Sentry's list).
        let named = Frame {
            function: Some("smart_beat_lib::audio::render".to_owned()),
            ..Frame::default()
        };
        let both = scrubbed(panic_event(
            Some(("src/audio/mod.rs", 5, 6)),
            vec![nameless(), named],
        ))
        .unwrap();
        let frames = frames_of(&both);
        assert_eq!(frames.len(), 2);
        assert_eq!(
            frames[0].function.as_deref(),
            Some("smart_beat_lib::audio::render")
        );
        assert_eq!(frames[1].function.as_deref(), Some("panic"));
    }

    #[test]
    fn a_panic_outside_the_app_has_no_location_frame() {
        for file in [
            "/Users/jane/.cargo/registry/src/index.crates.io-1/foo-1.0.0/src/lib.rs",
            "C:\\Users\\jane\\.cargo\\registry\\src\\x\\foo\\src\\lib.rs",
            "/rustc/0123abc/library/core/src/option.rs",
            "library/std/src/thread/mod.rs",
            "/Users/jane/My Secret Song.gp5",
            "https://x.test/src/a.rs?token=abc123",
            "",
        ] {
            let event = panic_event(Some((file, 9, 9)), vec![]);
            assert!(
                frames_of(&event).is_empty(),
                "{file}: {:?}",
                frames_of(&event)
            );
            // Nothing valid is left, so the event is not sent at all.
            assert!(scrubbed(event).is_none(), "{file}");
        }
        // No location at all (possible for some panics) behaves the same.
        assert!(frames_of(&panic_event(None, vec![])).is_empty());
        // A nameless backtrace and a foreign location: the event is dropped, nothing leaks.
        let foreign = panic_event(
            Some(("/rustc/0123abc/library/core/src/option.rs", 1, 1)),
            vec![nameless()],
        );
        assert!(scrubbed(foreign).is_none());
    }

    #[test]
    fn the_panic_event_never_holds_the_message() {
        let event = panic_event(Some(("src/audio/mod.rs", 1, 1)), vec![]);
        let raw = serde_json::to_string(&event).unwrap();
        assert!(event.exception.values[0].value.is_none(), "{raw}");
        assert!(event.message.is_none() && event.logentry.is_none(), "{raw}");
    }

    #[test]
    fn crash_reports_are_off_by_default_and_without_an_address() {
        let dir = tempfile::tempdir().unwrap();
        let collector = Collector::default();
        let with_address = reports(dir.path(), Some(FAKE_DSN), &collector);
        assert_eq!(
            with_address.settings(),
            CrashReportSettings {
                enabled: false,
                available: true
            }
        );
        with_address.start_if_enabled();
        assert!(!with_address.running());
        // Reading the settings creates nothing on disk.
        assert!(!dir.path().join(SETTINGS_FILE).exists());

        for dsn in [None, Some(""), Some("   "), Some("not a dsn")] {
            let none = reports(dir.path(), dsn, &collector);
            assert!(!none.settings().available, "{dsn:?}");
            // The choice is saved, but there is nothing to start.
            let saved = none.set_enabled(true).unwrap();
            assert_eq!(
                saved,
                CrashReportSettings {
                    enabled: true,
                    available: false
                }
            );
            assert!(!none.running(), "{dsn:?}");
            none.start_if_enabled();
            assert!(!none.running(), "{dsn:?}");
        }
        assert!(collector.sent().is_empty());
    }

    #[test]
    fn switching_on_starts_the_client_and_switching_off_stops_it() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let collector = Collector::default();
        let app = reports(dir.path(), Some(FAKE_DSN), &collector);

        let on = app.set_enabled(true).unwrap();
        assert_eq!(
            on,
            CrashReportSettings {
                enabled: true,
                available: true
            }
        );
        assert!(app.running());
        // The choice survives a restart: a new instance starts the client by itself.
        app.stop();
        assert!(!app.running());
        let again = reports(dir.path(), Some(FAKE_DSN), &collector);
        assert!(again.settings().enabled);
        again.start_if_enabled();
        assert!(again.running());

        let off = again.set_enabled(false).unwrap();
        assert_eq!(
            off,
            CrashReportSettings {
                enabled: false,
                available: true
            }
        );
        assert!(!again.running());
        let restarted = reports(dir.path(), Some(FAKE_DSN), &collector);
        restarted.start_if_enabled();
        assert!(!restarted.running());
    }

    #[test]
    fn a_panic_sends_one_scrubbed_report_and_nothing_after_switching_off() {
        let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let collector = Collector::default();
        let app = reports(dir.path(), Some(FAKE_DSN), &collector);

        // Off: a panic sends nothing.
        crash_in_a_thread();
        assert!(collector.sent().is_empty());

        app.set_enabled(true).unwrap();
        crash_in_a_thread();
        let sent = collector.sent();
        assert_eq!(sent.len(), 1, "{sent:?}");
        let body = &sent[0];
        assert!(body.contains("\"type\":\"panic\""), "{body}");
        assert!(body.contains("crash_in_a_thread"), "{body}");
        assert!(body.contains("\"release\":\"9.9.9\""), "{body}");
        assert!(body.contains("\"server_name\":\"\""), "{body}");
        for forbidden in [
            "jane",
            "My Secret Song",
            ".gp5",
            "/Users",
            "example.com",
            "could not open",
            "\"value\"",
            "breadcrumbs",
            "\"user\"",
            "\"request\"",
            "\"contexts\"",
            "\"extra\"",
            "\"modules\"",
            "\"threads\"",
            "\"message\"",
            "attachment",
            "replay",
            "screenshot",
        ] {
            assert!(!body.contains(forbidden), "{forbidden} in {body}");
        }
        // Frames carry an app-relative location only.
        assert!(body.contains("src/crash_reports.rs\""), "{body}");
        // The place of the panic is the last frame.
        assert!(body.contains("\"function\":\"panic\""), "{body}");

        app.set_enabled(false).unwrap();
        crash_in_a_thread();
        assert_eq!(
            collector.sent().len(),
            1,
            "nothing is sent after switching off"
        );

        // Switching on again works, and does not report one panic twice.
        app.set_enabled(true).unwrap();
        crash_in_a_thread();
        assert_eq!(collector.sent().len(), 2);
        app.stop();
    }

    #[test]
    fn the_gate_drops_what_is_handed_over_after_it_closes() {
        let collector = Collector::default();
        let open = Arc::new(AtomicBool::new(true));
        let factory = Gated {
            inner: Some(collector.factory()),
            open: Arc::clone(&open),
        };
        let options = TransportOptions::try_from_client_options(&{
            let mut o = ClientOptions::new();
            o.dsn = Some(FAKE_DSN.parse().unwrap());
            o
        })
        .unwrap();
        let transport = factory.create_transport_with_options(options);
        transport.send_envelope(Envelope::new());
        assert_eq!(collector.sent().len(), 1);
        open.store(false, Ordering::SeqCst);
        transport.send_envelope(Envelope::new());
        assert_eq!(collector.sent().len(), 1);
    }

    #[test]
    fn a_closed_gate_stops_the_request_before_it_leaves() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        let open = Arc::new(AtomicBool::new(false));
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(300)))
            .middleware(GateMiddleware(Arc::clone(&open)))
            .build()
            .new_agent();
        let refused = agent.post(&url).send("{}");
        assert!(matches!(refused, Err(ureq::Error::Io(_))), "{refused:?}");
        assert!(
            listener.accept().is_err(),
            "a request left although the gate was closed"
        );
        // Open, the same agent does connect (and times out waiting for an answer).
        open.store(true, Ordering::SeqCst);
        let _ = agent.post(&url).send("{}");
        assert!(
            listener.accept().is_ok(),
            "an open gate must let it through"
        );
    }

    #[test]
    fn the_client_is_set_up_for_errors_only() {
        let options = client_options(
            FAKE_DSN.parse().unwrap(),
            "9.9.9",
            Collector::default().factory(),
        );
        // No replay, screenshots, attachments, feedback, tracing, logs, metrics, profiling or
        // breadcrumbs, and no personal data by default.
        assert!(!options.default_integrations);
        assert!(options.integrations.is_empty());
        assert_eq!(options.max_breadcrumbs, 0);
        assert!(!options.send_default_pii);
        assert!(!options.attach_stacktrace);
        assert!(!options.auto_session_tracking);
        assert!(matches!(
            options.traces_sampling_strategy,
            sentry::TracesSamplingStrategy::Disabled
        ));
        assert!(options.before_send.is_some());
        assert_eq!(options.server_name.as_deref(), Some(""));
        assert_eq!(options.release.as_deref(), Some("9.9.9"));
        assert!(matches!(
            options.environment.as_deref(),
            Some("production" | "development")
        ));
    }

    #[test]
    fn the_sentry_crate_is_built_with_only_the_error_features() {
        let manifest =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
        let line = manifest
            .lines()
            .find(|line| line.starts_with("sentry = "))
            .expect("the sentry dependency");
        assert!(line.contains("default-features = false"), "{line}");
        let features = line
            .split("features = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap();
        let mut listed: Vec<&str> = features
            .split(',')
            .map(|f| f.trim().trim_matches('"'))
            .filter(|f| !f.is_empty())
            .collect();
        listed.sort_unstable();
        // Backtrace and panic helpers and the ureq sender. Anything else (tracing, logs, metrics,
        // contexts, debug-images, release-health, reqwest, profiling, a replay or feedback
        // integration) fails here.
        assert_eq!(listed, ["backtrace", "panic", "ureq"], "{line}");
        // The code does not reach for another integration either.
        for file in ["crash_reports.rs", "crash_scrub.rs"] {
            let code =
                std::fs::read_to_string(format!("{}/src/{file}", env!("CARGO_MANIFEST_DIR")))
                    .unwrap();
            let code = code.split("#[cfg(test)]").next().unwrap();
            for forbidden in [
                "integrations::tracing",
                "integrations::log",
                "integrations::contexts",
                "integrations::debug_images",
                "start_session",
                "add_breadcrumb",
                "add_attachment",
                "capture_message",
                "set_user",
            ] {
                assert!(!code.contains(forbidden), "{forbidden} in {file}");
            }
        }
    }
}
