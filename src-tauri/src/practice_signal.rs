//! Practice together over the internet (#158): the page's end of the signaling Worker.
//!
//! Two apps that are not on the same network need a place to meet before they can open a direct
//! WebRTC connection. The Worker (`signaling/`) is that place: a room with two mailboxes that
//! carries a few short setup messages (offer, answer, network candidates) and nothing else. The
//! tab, the playback commands and the clock exchange never pass through it.
//!
//! The requests are made from here, not from the page, so the page's content security policy
//! stays closed to every other address. The page hands over the setup messages with
//! `practice_signal_send` and hears the other app's through the `practice-signal` event.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::error::{CommandError, ErrorKind};

/// The signaling Worker's address, set by the release build (`SMART_BEAT_SIGNALING_URL`). Without
/// it the app only offers Practice together on the same network.
pub const URL: Option<&str> = option_env!("SMART_BEAT_SIGNALING_URL");

/// Sent for each setup message from the other app (payload: the text). Mirrored in `src/lib/tauri.ts`.
pub const SIGNAL_EVENT: &str = "practice-signal";
/// Sent when the room is gone or unreachable (payload: a short reason). Mirrored in `src/lib/tauri.ts`.
pub const SIGNAL_FAILED_EVENT: &str = "practice-signal-failed";

const POLL_FAILURES: u32 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalError {
    /// The room does not exist (a wrong or an old code).
    NotFound,
    /// The room already has its guest.
    Full,
    /// The Worker could not be reached or answered something unexpected.
    Network(String),
}

impl std::fmt::Display for SignalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("There is no room with that code. It may have expired."),
            Self::Full => f.write_str("That room already has two players."),
            Self::Network(why) => write!(f, "Could not reach the meeting service ({why})."),
        }
    }
}

impl From<ureq::Error> for SignalError {
    fn from(error: ureq::Error) -> Self {
        match error {
            ureq::Error::StatusCode(404) => Self::NotFound,
            ureq::Error::StatusCode(409) => Self::Full,
            other => Self::Network(other.to_string()),
        }
    }
}

/// What the room says to the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalEvent {
    Message(String),
    Failed(String),
}

pub type SignalSink = Arc<dyn Fn(SignalEvent) + Send + Sync>;

#[derive(Deserialize)]
struct Created {
    code: String,
    token: String,
}

#[derive(Deserialize)]
struct Joined {
    token: String,
}

#[derive(Deserialize)]
struct Polled {
    #[serde(default)]
    messages: Vec<String>,
    #[serde(default)]
    next: u64,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into()
}

/// One end of a room: a host that made it, or a guest that joined it.
pub struct Signal {
    base: String,
    code: String,
    role: &'static str,
    token: String,
    stop: AtomicBool,
    agent: ureq::Agent,
}

impl Signal {
    fn new(base: &str, code: String, role: &'static str, token: String) -> Arc<Self> {
        Arc::new(Self {
            base: base.trim_end_matches('/').to_owned(),
            code,
            role,
            token,
            stop: AtomicBool::new(false),
            agent: agent(),
        })
    }

    /// Makes a room. The host shares `code()` with the guest.
    pub fn create(base: &str, sink: SignalSink) -> Result<Arc<Self>, SignalError> {
        let url = format!("{}/v1/rooms", base.trim_end_matches('/'));
        let created: Created = agent()
            .post(&url)
            .send_empty()?
            .body_mut()
            .read_json()
            .map_err(|e| SignalError::Network(e.to_string()))?;
        let signal = Self::new(base, created.code, "host", created.token);
        signal.listen(sink);
        Ok(signal)
    }

    /// Joins a room by its code (any case, with or without a dash).
    pub fn join(base: &str, code: &str, sink: SignalSink) -> Result<Arc<Self>, SignalError> {
        let code = normalize(code);
        let url = format!("{}/v1/rooms/{code}/join", base.trim_end_matches('/'));
        let joined: Joined = agent()
            .post(&url)
            .send_empty()?
            .body_mut()
            .read_json()
            .map_err(|e| SignalError::Network(e.to_string()))?;
        let signal = Self::new(base, code, "guest", joined.token);
        signal.listen(sink);
        Ok(signal)
    }

    /// The room code, `ABCD-EFGH`.
    pub fn code(&self) -> String {
        match (self.code.get(..4), self.code.get(4..)) {
            (Some(a), Some(b)) => format!("{a}-{b}"),
            _ => self.code.clone(),
        }
    }

    fn listen(self: &Arc<Self>, sink: SignalSink) {
        let me = Arc::clone(self);
        thread::spawn(move || {
            let mut after = 0u64;
            let mut failures = 0u32;
            while !me.stop.load(Ordering::SeqCst) {
                let url = format!(
                    "{}/v1/rooms/{}/poll?role={}&token={}&after={after}",
                    me.base, me.code, me.role, me.token
                );
                let result = me
                    .agent
                    .get(&url)
                    .call()
                    .map_err(SignalError::from)
                    .and_then(|mut r| {
                        r.body_mut()
                            .read_json::<Polled>()
                            .map_err(|e| SignalError::Network(e.to_string()))
                    });
                if me.stop.load(Ordering::SeqCst) {
                    return;
                }
                match result {
                    Ok(polled) => {
                        failures = 0;
                        after = polled.next.max(after);
                        for message in polled.messages {
                            sink(SignalEvent::Message(message));
                        }
                    }
                    Err(SignalError::NotFound) => {
                        sink(SignalEvent::Failed("The room has closed.".into()));
                        return;
                    }
                    Err(error) => {
                        failures += 1;
                        if failures >= POLL_FAILURES {
                            sink(SignalEvent::Failed(error.to_string()));
                            return;
                        }
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        });
    }

    /// Hands one setup message to the other app.
    pub fn send(&self, text: &str) -> Result<(), SignalError> {
        let url = format!("{}/v1/rooms/{}/send", self.base, self.code);
        self.agent.post(&url).send_json(serde_json::json!({
            "role": self.role,
            "token": self.token,
            "msg": text,
        }))?;
        Ok(())
    }

    /// Stops listening. The room itself expires on its own.
    pub fn leave(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// What a person typed, as a room code: case, dashes and spaces do not matter.
pub fn normalize(text: &str) -> String {
    text.to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect()
}

// ----- Tauri commands ------------------------------------------------------------------------

/// The room this app is in, if any.
#[derive(Default)]
pub struct SignalState(Mutex<Option<Arc<Signal>>>);

impl SignalState {
    fn set(&self, signal: Option<Arc<Signal>>) {
        let old = {
            let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::replace(&mut *slot, signal)
        };
        if let Some(old) = old {
            old.leave();
        }
    }

    fn get(&self) -> Option<Arc<Signal>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn leave(&self) {
        self.set(None);
    }
}

fn emitter<R: Runtime>(app: AppHandle<R>) -> SignalSink {
    Arc::new(move |event| match event {
        SignalEvent::Message(text) => {
            let _ = app.emit(SIGNAL_EVENT, text);
        }
        SignalEvent::Failed(why) => {
            let _ = app.emit(SIGNAL_FAILED_EVENT, why);
        }
    })
}

fn base() -> Result<&'static str, CommandError> {
    URL.filter(|u| !u.is_empty()).ok_or_else(|| {
        CommandError::new(
            ErrorKind::Network,
            "Practice together over the internet is not in this build.",
        )
    })
}

fn failure(error: SignalError) -> CommandError {
    let kind = match error {
        SignalError::NotFound => ErrorKind::InvalidCode,
        SignalError::Full | SignalError::Network(_) => ErrorKind::Network,
    };
    CommandError::new(kind, error.to_string())
}

/// Whether this build knows a signaling Worker (otherwise only the same network is offered).
#[tauri::command]
pub fn practice_signal_available() -> bool {
    URL.is_some_and(|u| !u.is_empty())
}

/// Makes a room and returns its code.
#[tauri::command(async)]
pub fn practice_signal_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SignalState>,
) -> Result<String, CommandError> {
    let signal = Signal::create(base()?, emitter(app)).map_err(failure)?;
    let code = signal.code();
    state.set(Some(signal));
    Ok(code)
}

/// Joins a room by its code.
#[tauri::command(async)]
pub fn practice_signal_join<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SignalState>,
    code: String,
) -> Result<(), CommandError> {
    let signal = Signal::join(base()?, &code, emitter(app)).map_err(failure)?;
    state.set(Some(signal));
    Ok(())
}

/// Sends a setup message to the other app.
#[tauri::command(async)]
pub fn practice_signal_send(
    state: State<'_, SignalState>,
    text: String,
) -> Result<(), CommandError> {
    let signal = state
        .get()
        .ok_or_else(|| CommandError::new(ErrorKind::Network, "There is no room."))?;
    signal.send(&text).map_err(failure)
}

/// Leaves the room.
#[tauri::command]
pub fn practice_signal_leave(state: State<'_, SignalState>) {
    state.leave();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{Receiver, channel};

    /// The (path, body) of every request the fake Worker saw.
    type Requests = Arc<Mutex<Vec<(String, String)>>>;

    /// A thread that answers like the Worker: each scripted answer is used once, for the first
    /// request whose path contains its text; anything else is a 404.
    fn fake_worker(mut script: Vec<(&'static str, u16, &'static str)>) -> (String, Requests) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                let path = request_line.split_whitespace().nth(1).unwrap().to_owned();
                log.lock()
                    .unwrap()
                    .push((path.clone(), String::from_utf8_lossy(&body).into_owned()));
                let (status, answer) = match script.iter().position(|(p, _, _)| path.contains(p)) {
                    Some(i) => {
                        let (_, status, body) = script.remove(i);
                        (status, body)
                    }
                    None => (404, "{}"),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}",
                    answer.len()
                );
            }
        });
        (base, seen)
    }

    fn collect() -> (SignalSink, Receiver<SignalEvent>) {
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        (
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
            rx,
        )
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn codes_are_read_loosely() {
        assert_eq!(normalize("abcd-efgh"), "ABCDEFGH");
        assert_eq!(normalize(" ab cd  ef-gh "), "ABCDEFGH");
        assert_eq!(normalize("o1il"), "0111");
    }

    #[test]
    fn a_host_creates_a_room_sends_and_hears_back() {
        let (base, seen) = fake_worker(vec![
            ("/v1/rooms", 200, r#"{"code":"ABCDEFGH","token":"tok"}"#),
            ("/send", 200, r#"{"ok":true}"#),
            ("/poll", 200, r#"{"messages":["answer","cand"],"next":2}"#),
        ]);
        let (sink, rx) = collect();
        let signal = Signal::create(&base, sink).unwrap();
        assert_eq!(signal.code(), "ABCD-EFGH");
        signal.send("offer \"quoted\"").unwrap();
        assert_eq!(
            rx.recv_timeout(WAIT).unwrap(),
            SignalEvent::Message("answer".into())
        );
        assert_eq!(
            rx.recv_timeout(WAIT).unwrap(),
            SignalEvent::Message("cand".into())
        );
        signal.leave();
        let seen = seen.lock().unwrap();
        let sent = seen.iter().find(|(p, _)| p.ends_with("/send")).unwrap();
        let body: serde_json::Value = serde_json::from_str(&sent.1).unwrap();
        assert_eq!(body["role"], "host");
        assert_eq!(body["token"], "tok");
        assert_eq!(body["msg"], "offer \"quoted\"");
        assert!(
            seen.iter()
                .any(|(p, _)| p.contains("/poll?role=host&token=tok&after=0"))
        );
    }

    #[test]
    fn a_guest_joins_with_a_typed_code_and_hears_the_room_close() {
        let (base, seen) = fake_worker(vec![("/join", 200, r#"{"token":"gt"}"#)]);
        let (sink, rx) = collect();
        let signal = Signal::join(&base, "abcd-efgh", sink).unwrap();
        assert_eq!(signal.code(), "ABCD-EFGH");
        // The fake has no poll answer, so it says 404: the room has closed.
        assert_eq!(
            rx.recv_timeout(WAIT).unwrap(),
            SignalEvent::Failed("The room has closed.".into())
        );
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(p, _)| p == "/v1/rooms/ABCDEFGH/join")
        );
    }

    #[test]
    fn joining_explains_a_missing_or_full_room() {
        let (base, _) = fake_worker(vec![("/join", 404, "{}"), ("/join", 409, "{}")]);
        let (sink, _rx) = collect();
        assert_eq!(
            Signal::join(&base, "ABCDEFGH", Arc::clone(&sink)).err(),
            Some(SignalError::NotFound)
        );
        assert_eq!(
            Signal::join(&base, "ABCDEFGH", sink).err(),
            Some(SignalError::Full)
        );
    }

    #[test]
    fn an_unreachable_worker_is_a_network_error() {
        let (sink, _rx) = collect();
        assert!(matches!(
            Signal::create("http://127.0.0.1:1", sink).err(),
            Some(SignalError::Network(_))
        ));
    }

    #[test]
    fn without_a_build_address_the_internet_option_is_off() {
        // Pull-request and local builds have no SMART_BEAT_SIGNALING_URL.
        if URL.is_none() {
            assert!(!practice_signal_available());
            assert!(base().is_err());
        }
    }
}
