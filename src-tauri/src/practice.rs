//! Practice together (#158): the link between two Smart Beat apps on the same network.
//!
//! This module only moves frames (short JSON texts). The session logic, the shared clock and
//! the playback all live in the page (`src/lib/practice-together`), so everything is timed on
//! one clock. The host listens on a TCP port; the guest connects with a room code that holds
//! the host's address and a secret token. The first frame a guest sends is the token; a wrong
//! one is refused and counted. Who may stay is then decided in the page: the host approves
//! each guest by name before any playback command is accepted.
//!
//! Frames are a 4-byte big-endian length and the UTF-8 text. A length of 0 is a keep-alive that
//! is never passed on, so a Wi-Fi drop without a goodbye is noticed within seconds.

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The longest frame accepted, in bytes.
pub const MAX_FRAME: usize = 64 * 1024;
/// How long a new connection has to present its token.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often each side sends a keep-alive.
const KEEPALIVE: Duration = Duration::from_secs(2);
/// A connection that has been silent this long is dead.
const DEAD_AFTER: Duration = Duration::from_secs(8);
/// A guest tries to get a dropped connection back for this long.
pub const RECONNECT_FOR: Duration = Duration::from_secs(20);
/// Wrong tokens tolerated before the host stops listening.
const MAX_FAILURES: u32 = 20;

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Where the link stands. Mirrored in `src/lib/tauri.ts` (`PracticeLinkState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkState {
    Connecting,
    Open,
    Reconnecting,
    Closed,
}

/// What the link tells the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// One frame from the other app.
    Frame(String),
    State {
        state: LinkState,
        detail: Option<String>,
    },
}

/// Where events go: the Tauri app emits them to the page; tests collect them.
pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// Why a room code could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinError {
    /// The code is not a room code.
    BadCode,
    /// The host could not be reached.
    Unreachable(String),
    /// The host does not know this code (wrong, or from an earlier session).
    Denied,
}

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadCode => f.write_str("That is not a room code."),
            Self::Unreachable(why) => write!(f, "Could not reach the host ({why})."),
            Self::Denied => f.write_str("The host did not accept this code."),
        }
    }
}

// ----- room codes ----------------------------------------------------------------------------

/// The 12 bytes of a room code: the host's IPv4 address, its port and a 48-bit token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Room {
    pub addr: SocketAddrV4,
    pub token: [u8; 6],
}

impl Room {
    /// `ABCD-EFGH-JKMN-PQRS-TVWX`: 20 letters and digits without look-alikes (Crockford base 32).
    pub fn code(&self) -> String {
        let mut bytes = [0u8; 12];
        bytes[..4].copy_from_slice(&self.addr.ip().octets());
        bytes[4..6].copy_from_slice(&self.addr.port().to_be_bytes());
        bytes[6..].copy_from_slice(&self.token);
        let mut bits: u128 = 0;
        for b in bytes {
            bits = (bits << 8) | u128::from(b);
        }
        // 96 bits in 20 characters of 5 bits (100 bits): the top 4 bits are zero.
        let mut out = String::with_capacity(24);
        for i in (0..20).rev() {
            let digit = ((bits >> (i * 5)) & 31) as usize;
            out.push(ALPHABET[digit] as char);
            if i % 4 == 0 && i != 0 {
                out.push('-');
            }
        }
        out
    }

    /// Reads a code typed by a person: case, dashes and spaces do not matter, and the look-alike
    /// letters I, L and O are read as 1, 1 and 0.
    pub fn parse(text: &str) -> Option<Self> {
        let mut bits: u128 = 0;
        let mut digits = 0;
        for c in text.chars() {
            if c == '-' || c.is_whitespace() {
                continue;
            }
            let c = match c.to_ascii_uppercase() {
                'I' | 'L' => '1',
                'O' => '0',
                other => other,
            };
            let digit = ALPHABET.iter().position(|&a| a as char == c)?;
            bits = (bits << 5) | digit as u128;
            digits += 1;
            if digits > 20 {
                return None;
            }
        }
        if digits != 20 || bits >> 96 != 0 {
            return None;
        }
        let mut bytes = [0u8; 12];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (bits >> ((11 - i) * 8)) as u8;
        }
        let ip = Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]);
        let port = u16::from_be_bytes([bytes[4], bytes[5]]);
        let mut token = [0u8; 6];
        token.copy_from_slice(&bytes[6..]);
        Some(Self {
            addr: SocketAddrV4::new(ip, port),
            token,
        })
    }
}

/// The address this computer has on the local network (the one a route to the internet would
/// use). Nothing is sent. Falls back to loopback when there is no network.
pub fn local_ipv4() -> Ipv4Addr {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.0.2.1:9")?;
            s.local_addr()
        })
        .ok()
        .and_then(|a| match a.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
            _ => None,
        })
        .unwrap_or(Ipv4Addr::LOCALHOST)
}

// ----- frames --------------------------------------------------------------------------------

/// Writes one frame (an empty text is the keep-alive).
pub fn write_frame(out: &mut impl Write, text: &[u8]) -> io::Result<()> {
    if text.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "frame too long",
        ));
    }
    let mut buf = Vec::with_capacity(4 + text.len());
    buf.extend_from_slice(&(text.len() as u32).to_be_bytes());
    buf.extend_from_slice(text);
    out.write_all(&buf)?;
    out.flush()
}

/// Reads one frame; an empty vector is a keep-alive.
pub fn read_frame(input: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    input.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too long"));
    }
    let mut body = vec![0u8; len];
    input.read_exact(&mut body)?;
    Ok(body)
}

fn same_token(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_token() -> [u8; 6] {
    let mut token = [0u8; 6];
    // A failure to read randomness is not recoverable; an all-zero token would be guessable.
    getrandom::fill(&mut token).expect("system random numbers");
    token
}

// ----- the link ------------------------------------------------------------------------------

/// One live TCP connection.
struct Conn {
    id: u64,
    write: Mutex<TcpStream>,
    shut: AtomicBool,
}

impl Conn {
    fn shutdown(&self) {
        self.shut.store(true, Ordering::SeqCst);
        if let Ok(stream) = self.write.lock() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// A host listening for a guest, or a guest connected to a host.
pub struct Link {
    sink: Sink,
    stop: AtomicBool,
    next_id: AtomicU64,
    current: Mutex<Option<Arc<Conn>>>,
    failures: AtomicU32,
    room: Room,
}

impl Link {
    fn new(sink: Sink, room: Room) -> Arc<Self> {
        Arc::new(Self {
            sink,
            stop: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            current: Mutex::new(None),
            failures: AtomicU32::new(0),
            room,
        })
    }

    fn emit_state(&self, state: LinkState, detail: Option<&str>) {
        (self.sink)(Event::State {
            state,
            detail: detail.map(str::to_owned),
        });
    }

    /// Starts listening on a free port. The code uses `advertise` as the host's address.
    pub fn host(advertise: Ipv4Addr, sink: Sink) -> io::Result<Arc<Self>> {
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let room = Room {
            addr: SocketAddrV4::new(advertise, port),
            token: random_token(),
        };
        let link = Self::new(sink, room);
        link.emit_state(LinkState::Connecting, None);
        let accept = Arc::clone(&link);
        thread::spawn(move || accept.accept_loop(listener));
        Ok(link)
    }

    /// The room code to give to the guest.
    pub fn code(&self) -> String {
        self.room.code()
    }

    pub fn port(&self) -> u16 {
        self.room.addr.port()
    }

    /// Connects to a host. Returns once the host has accepted the code.
    pub fn join(code: &str, sink: Sink) -> Result<Arc<Self>, JoinError> {
        let room = Room::parse(code).ok_or(JoinError::BadCode)?;
        let link = Self::new(sink, room);
        link.emit_state(LinkState::Connecting, None);
        let stream = establish(&room)?;
        let (conn, read) = link.install(stream);
        let reader = Arc::clone(&link);
        thread::spawn(move || reader.guest_loop(conn, read));
        Ok(link)
    }

    fn accept_loop(self: Arc<Self>, listener: TcpListener) {
        while !self.stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let link = Arc::clone(&self);
                    thread::spawn(move || link.admit(stream));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => thread::sleep(Duration::from_millis(200)),
            }
            if self.failures.load(Ordering::SeqCst) >= MAX_FAILURES {
                self.close(Some("too many wrong codes"));
            }
        }
    }

    /// The host checks the first frame of a new connection.
    fn admit(self: Arc<Self>, mut stream: TcpStream) {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
        let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
        let Ok(token) = read_frame(&mut stream) else {
            return;
        };
        if !same_token(&token, &self.room.token) {
            self.failures.fetch_add(1, Ordering::SeqCst);
            let _ = write_frame(&mut stream, b"denied");
            return;
        }
        if write_frame(&mut stream, b"ok").is_err() {
            return;
        }
        // The right code always wins over an older connection: the guest is coming back.
        if let Some(old) = self.current.lock().ok().and_then(|mut c| c.take()) {
            old.shutdown();
        }
        let (conn, read) = self.install(stream);
        let reader = Arc::clone(&self);
        thread::spawn(move || reader.host_loop(conn, read));
    }

    /// Makes `stream` the current connection. Returns it with a handle to read from.
    fn install(&self, stream: TcpStream) -> (Arc<Conn>, TcpStream) {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(DEAD_AFTER));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let read = stream.try_clone().expect("clone the stream");
        let conn = Arc::new(Conn {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            write: Mutex::new(stream),
            shut: AtomicBool::new(false),
        });
        if let Ok(mut current) = self.current.lock() {
            *current = Some(Arc::clone(&conn));
        }
        let keep = Arc::clone(&conn);
        thread::spawn(move || {
            while !keep.shut.load(Ordering::SeqCst) {
                thread::sleep(KEEPALIVE);
                let ok = keep
                    .write
                    .lock()
                    .map(|mut w| write_frame(&mut *w, b"").is_ok())
                    .unwrap_or(false);
                if !ok {
                    keep.shutdown();
                }
            }
        });
        self.emit_state(LinkState::Open, None);
        (conn, read)
    }

    /// Reads frames until the connection ends; true if this connection was still the current one.
    fn pump(&self, conn: &Arc<Conn>, mut read: TcpStream) -> bool {
        loop {
            match read_frame(&mut read) {
                Ok(body) if body.is_empty() => {}
                Ok(body) => match String::from_utf8(body) {
                    Ok(text) => (self.sink)(Event::Frame(text)),
                    Err(_) => break,
                },
                Err(_) => break,
            }
        }
        conn.shutdown();
        let mut current = match self.current.lock() {
            Ok(c) => c,
            Err(_) => return false,
        };
        if current.as_ref().is_some_and(|c| c.id == conn.id) {
            *current = None;
            true
        } else {
            false
        }
    }

    fn host_loop(self: Arc<Self>, conn: Arc<Conn>, read: TcpStream) {
        if self.pump(&conn, read) && !self.stop.load(Ordering::SeqCst) {
            self.emit_state(LinkState::Reconnecting, Some("the guest disconnected"));
        }
    }

    fn guest_loop(self: Arc<Self>, mut conn: Arc<Conn>, mut read: TcpStream) {
        loop {
            if !self.pump(&conn, read) || self.stop.load(Ordering::SeqCst) {
                return;
            }
            self.emit_state(LinkState::Reconnecting, Some("the connection dropped"));
            let started = Instant::now();
            let mut wait = Duration::from_millis(250);
            let stream = loop {
                if self.stop.load(Ordering::SeqCst) || started.elapsed() > RECONNECT_FOR {
                    self.close(Some("the host did not come back"));
                    return;
                }
                thread::sleep(wait);
                wait = (wait * 2).min(Duration::from_secs(2));
                match establish(&self.room) {
                    Ok(stream) => break stream,
                    Err(JoinError::Denied) => {
                        self.close(Some("the host no longer knows this session"));
                        return;
                    }
                    Err(_) => {}
                }
            };
            (conn, read) = self.install(stream);
        }
    }

    /// Sends one frame. False when there is no connection right now.
    pub fn send(&self, text: &str) -> bool {
        let Some(conn) = self.current.lock().ok().and_then(|c| c.clone()) else {
            return false;
        };
        let ok = conn
            .write
            .lock()
            .map(|mut w| write_frame(&mut *w, text.as_bytes()).is_ok())
            .unwrap_or(false);
        if !ok {
            conn.shutdown();
        }
        ok
    }

    /// Ends the link for good.
    pub fn leave(&self) {
        self.close(None);
    }

    fn close(&self, detail: Option<&str>) {
        if self.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(conn) = self.current.lock().ok().and_then(|mut c| c.take()) {
            conn.shutdown();
        }
        self.emit_state(LinkState::Closed, detail);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Connects to the host and presents the token.
fn establish(room: &Room) -> Result<TcpStream, JoinError> {
    let mut stream = TcpStream::connect_timeout(&SocketAddr::V4(room.addr), HANDSHAKE_TIMEOUT)
        .map_err(|e| JoinError::Unreachable(e.to_string()))?;
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    write_frame(&mut stream, &room.token).map_err(|e| JoinError::Unreachable(e.to_string()))?;
    match read_frame(&mut stream) {
        Ok(answer) if answer == b"ok" => Ok(stream),
        Ok(_) => Err(JoinError::Denied),
        Err(e) => Err(JoinError::Unreachable(e.to_string())),
    }
}

// ----- Tauri commands ------------------------------------------------------------------------

use tauri::{AppHandle, Emitter, Runtime, State};

use crate::error::{CommandError, ErrorKind};

/// Sent for each frame from the other app (payload: the text). Mirrored in `src/lib/tauri.ts`.
pub const FRAME_EVENT: &str = "practice-frame";
/// Sent when the link changes (payload: `{ state, detail }`). Mirrored in `src/lib/tauri.ts`.
pub const STATE_EVENT: &str = "practice-state";

/// The one session this app is in (a host or a guest), if any.
#[derive(Default)]
pub struct PracticeState(Mutex<Option<Arc<Link>>>);

impl PracticeState {
    fn set(&self, link: Option<Arc<Link>>) {
        let old = {
            let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::replace(&mut *slot, link)
        };
        if let Some(old) = old {
            old.leave();
        }
    }

    fn get(&self) -> Option<Arc<Link>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Ends the session, for when the app quits.
    pub fn leave(&self) {
        self.set(None);
    }
}

#[derive(Serialize, Clone)]
struct StatePayload {
    state: LinkState,
    detail: Option<String>,
}

fn emitter<R: Runtime>(app: AppHandle<R>) -> Sink {
    Arc::new(move |event| match event {
        Event::Frame(text) => {
            let _ = app.emit(FRAME_EVENT, text);
        }
        Event::State { state, detail } => {
            let _ = app.emit(STATE_EVENT, StatePayload { state, detail });
        }
    })
}

/// What the host shows: the code to read out and the address it stands for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub code: String,
    pub link: String,
    pub address: String,
}

#[tauri::command(async)]
pub fn practice_host<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PracticeState>,
) -> Result<HostInfo, CommandError> {
    let link = Link::host(local_ipv4(), emitter(app))
        .map_err(|e| CommandError::new(ErrorKind::Network, format!("Could not listen: {e}")))?;
    let code = link.code();
    let info = HostInfo {
        link: format!("smartbeat://join/{code}"),
        address: format!("{}:{}", link.room.addr.ip(), link.port()),
        code,
    };
    state.set(Some(link));
    Ok(info)
}

#[tauri::command(async)]
pub fn practice_join<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PracticeState>,
    code: String,
) -> Result<(), CommandError> {
    let link = Link::join(&code, emitter(app)).map_err(|e| {
        let kind = match e {
            JoinError::BadCode => ErrorKind::InvalidCode,
            JoinError::Unreachable(_) | JoinError::Denied => ErrorKind::Network,
        };
        CommandError::new(kind, e.to_string())
    })?;
    state.set(Some(link));
    Ok(())
}

#[tauri::command]
pub fn practice_send(state: State<'_, PracticeState>, text: String) -> bool {
    state.get().is_some_and(|link| link.send(&text))
}

#[tauri::command]
pub fn practice_leave(state: State<'_, PracticeState>) {
    state.leave();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn room() -> Room {
        Room {
            addr: SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 23), 51234),
            token: [1, 2, 3, 250, 251, 252],
        }
    }

    #[test]
    fn a_room_code_round_trips() {
        let code = room().code();
        assert_eq!(code.len(), 24, "{code}");
        assert_eq!(code.matches('-').count(), 4);
        assert_eq!(Room::parse(&code), Some(room()));
    }

    #[test]
    fn a_typed_code_may_be_sloppy() {
        let code = room().code();
        assert_eq!(Room::parse(&code.to_lowercase()), Some(room()));
        assert_eq!(Room::parse(&code.replace('-', " ")), Some(room()));
        assert_eq!(Room::parse(&code.replace('-', "")), Some(room()));
        // I, L and O are read as 1, 1 and 0.
        assert_eq!(
            Room::parse("0000-0000-0000-0000-0000").map(|r| r.token),
            Some([0; 6])
        );
        assert_eq!(
            Room::parse("oooo-oooo-oooo-oooo-oooo").map(|r| r.token),
            Some([0; 6])
        );
    }

    #[test]
    fn a_bad_code_is_refused() {
        assert_eq!(Room::parse(""), None);
        assert_eq!(Room::parse("ABCD"), None);
        assert_eq!(Room::parse("ABCD-EFGH-JKMN-PQRS-TVWXY"), None);
        assert_eq!(
            Room::parse("UUUU-UUUU-UUUU-UUUU-UUUU"),
            None,
            "U is not in the alphabet"
        );
        // Too big for 96 bits.
        assert_eq!(Room::parse("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ"), None);
    }

    #[test]
    fn tokens_are_random() {
        assert_ne!(random_token(), random_token());
    }

    #[test]
    fn frames_round_trip() {
        let mut wire = Vec::new();
        write_frame(&mut wire, "héllo".as_bytes()).unwrap();
        write_frame(&mut wire, b"").unwrap();
        let mut input = Cursor::new(wire);
        assert_eq!(read_frame(&mut input).unwrap(), "héllo".as_bytes());
        assert!(read_frame(&mut input).unwrap().is_empty());
        assert!(read_frame(&mut input).is_err(), "end of stream");
    }

    #[test]
    fn long_frames_are_refused_both_ways() {
        let mut wire = Vec::new();
        assert!(write_frame(&mut wire, &vec![0; MAX_FRAME + 1]).is_err());
        let mut input = Cursor::new(((MAX_FRAME + 1) as u32).to_be_bytes().to_vec());
        assert_eq!(
            read_frame(&mut input).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn a_cut_frame_is_an_error() {
        let mut input = Cursor::new(vec![0, 0, 0, 5, b'a', b'b']);
        assert!(read_frame(&mut input).is_err());
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(same_token(b"abc", b"abc"));
        assert!(!same_token(b"abc", b"abd"));
        assert!(!same_token(b"abc", b"ab"));
    }

    #[test]
    fn the_local_address_is_an_ipv4_address() {
        let ip = local_ipv4();
        assert!(!ip.is_unspecified());
    }
}
