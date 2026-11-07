//! Practice together (#158): the link between Smart Beat apps on the same network.
//!
//! This module only moves frames (short JSON texts). The session logic, the shared clock and
//! the playback all live in the page (`src/lib/practice-together`), so everything is timed on
//! one clock. The host listens on a TCP port and keeps one connection per guest; a guest
//! connects with a room code that holds the host's address and a secret token. The first frame
//! a guest sends is the token; a wrong one is refused and counted per address (an address that
//! sends too many is turned away for a while, and the session goes on). Who may stay is then decided
//! in the page: the host approves each guest by name before any playback command is accepted,
//! and may drop or ban one (a ban turns the guest's address away here as well).
//!
//! Frames are a 4-byte big-endian length and the UTF-8 text. A length of 0 is a keep-alive that
//! is never passed on, so a Wi-Fi drop without a goodbye is noticed within seconds.

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{
    IpAddr, Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket,
};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The longest frame accepted, in bytes.
pub const MAX_FRAME: usize = 64 * 1024;
/// How long a new connection has, in all, to present its token and be answered: one deadline
/// for the whole handshake, so a client that sends a byte every few seconds cannot hold it.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
/// The longest frame a handshake may carry (the token is 6 bytes, the answers fewer).
const MAX_HANDSHAKE_FRAME: usize = 64;
/// Handshakes a host has in progress at once; further connections are turned away at once,
/// before they cost a thread. Real guests join one by one, so a handful is plenty.
const MAX_HANDSHAKES: usize = 8;
/// Handshakes one address may have in progress at once, so one stranger cannot hold them all.
const MAX_HANDSHAKES_PER_ADDRESS: u32 = 3;
/// Wrong tokens (or handshakes that never finish) one address may cause within
/// [`FAILURE_WINDOW`] before it is turned away.
const MAX_FAILURES_PER_ADDRESS: u32 = 5;
/// The window in which wrong tokens of one address are counted.
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// How long an address that sent too many wrong tokens is turned away.
const BLOCK_FOR: Duration = Duration::from_secs(60);
/// Addresses the host remembers failures of; past this, the oldest are forgotten.
const MAX_TRACKED_ADDRESSES: usize = 256;
/// How often each side sends a keep-alive.
const KEEPALIVE: Duration = Duration::from_secs(2);
/// A connection that has been silent this long is dead.
const DEAD_AFTER: Duration = Duration::from_secs(8);
/// A guest tries to get a dropped connection back for this long.
pub const RECONNECT_FOR: Duration = Duration::from_secs(20);
/// Connections a host keeps at once. The page allows fewer guests; this bounds what a stranger
/// with the code can hold open.
pub const MAX_CONNECTIONS: usize = 16;

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

/// What the link tells the page. `conn` is the connection it is about: a host's guests are
/// told apart by it, and 0 is the link itself (listening, or gone for good).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// One frame from the other app.
    Frame { conn: u64, text: String },
    State {
        conn: u64,
        state: LinkState,
        /// For a host's new connection: the guest's address.
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
    /// The host has banned this computer from the session.
    Banned,
    /// The host has no room for another player.
    Full,
}

impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadCode => f.write_str("That is not a room code."),
            Self::Unreachable(why) => write!(f, "Could not reach the host ({why})."),
            Self::Denied => f.write_str("The host did not accept this code."),
            Self::Banned => f.write_str("The host has blocked you from this session."),
            Self::Full => f.write_str("The session is full."),
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

/// Fills `buf` from `stream`, giving up when `deadline` has passed. A read timeout only limits
/// one `read`, so a sender that dribbles a byte at a time would keep a plain `read_exact`
/// waiting for as long as it likes; this one has a single deadline for the whole of it.
fn read_exact_until(stream: &mut TcpStream, buf: &mut [u8], deadline: Instant) -> io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "too slow"));
        }
        stream.set_read_timeout(Some(left))?;
        match stream.read(&mut buf[filled..]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Reads one handshake frame: at most [`MAX_HANDSHAKE_FRAME`] bytes, all before `deadline`.
fn read_handshake_frame(stream: &mut TcpStream, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    read_exact_until(stream, &mut len, deadline)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_HANDSHAKE_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too long"));
    }
    let mut body = vec![0u8; len];
    read_exact_until(stream, &mut body, deadline)?;
    Ok(body)
}

/// Wrong tokens, counted per address. An address that sends too many is turned away for a while;
/// the guests already in the session are not touched, and nobody else is turned away.
#[derive(Default)]
struct Throttle {
    entries: HashMap<IpAddr, Strikes>,
    /// Handshakes in progress, per address.
    pending: HashMap<IpAddr, u32>,
}

struct Strikes {
    count: u32,
    since: Instant,
    blocked_until: Option<Instant>,
}

impl Throttle {
    /// True while `ip` is turned away.
    fn blocked(&mut self, ip: IpAddr, now: Instant) -> bool {
        match self.entries.get(&ip).and_then(|s| s.blocked_until) {
            Some(until) if until > now => true,
            Some(_) => {
                self.entries.remove(&ip);
                false
            }
            None => false,
        }
    }

    /// `ip` sent a wrong token.
    fn fail(&mut self, ip: IpAddr, now: Instant) {
        if !self.entries.contains_key(&ip) && self.entries.len() >= MAX_TRACKED_ADDRESSES {
            self.entries.retain(|_, s| match s.blocked_until {
                Some(until) => until > now,
                None => now.duration_since(s.since) <= FAILURE_WINDOW,
            });
            if self.entries.len() >= MAX_TRACKED_ADDRESSES
                && let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, s)| s.since)
                    .map(|(ip, _)| *ip)
            {
                self.entries.remove(&oldest);
            }
        }
        let s = self.entries.entry(ip).or_insert(Strikes {
            count: 0,
            since: now,
            blocked_until: None,
        });
        if now.duration_since(s.since) > FAILURE_WINDOW {
            s.count = 0;
            s.since = now;
        }
        s.count += 1;
        if s.count >= MAX_FAILURES_PER_ADDRESS {
            s.blocked_until = Some(now + BLOCK_FOR);
        }
    }

    /// `ip` starts a handshake; false when it already has [`MAX_HANDSHAKES_PER_ADDRESS`].
    fn enter(&mut self, ip: IpAddr) -> bool {
        let n = self.pending.entry(ip).or_insert(0);
        if *n >= MAX_HANDSHAKES_PER_ADDRESS {
            return false;
        }
        *n += 1;
        true
    }

    /// A handshake of `ip` has ended.
    fn leave(&mut self, ip: IpAddr) {
        if let Some(n) = self.pending.get_mut(&ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.pending.remove(&ip);
            }
        }
    }

    /// `ip` showed the right token: its earlier mistakes are forgotten.
    fn forgive(&mut self, ip: IpAddr) {
        self.entries.remove(&ip);
    }
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
    /// Where the other end connected from (a host knows its guests' addresses).
    peer: Option<IpAddr>,
}

impl Conn {
    fn shutdown(&self) {
        self.shut.store(true, Ordering::SeqCst);
        if let Ok(stream) = self.write.lock() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// Why a link would not take a connection.
enum Refused {
    /// The link has been left (or the connection could not be set up).
    Closed,
    /// The host has no room for another connection.
    Full,
}

/// One of the host's [`MAX_HANDSHAKES`] places (and one of its address's); given back when
/// dropped.
struct HandshakeSlot {
    link: Arc<Link>,
    peer: Option<IpAddr>,
}

impl Drop for HandshakeSlot {
    fn drop(&mut self) {
        self.link.handshakes.fetch_sub(1, Ordering::SeqCst);
        if let Some(ip) = self.peer {
            let _ = self.link.throttle.lock().map(|mut t| t.leave(ip));
        }
    }
}

/// A host listening for guests, or a guest connected to a host.
///
/// A host keeps one connection per guest (up to [`MAX_CONNECTIONS`]); a guest has one. Every
/// event says which connection it is about; 0 is the link itself.
pub struct Link {
    sink: Sink,
    stop: AtomicBool,
    next_id: AtomicU64,
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    /// Wrong tokens, per address.
    throttle: Mutex<Throttle>,
    /// Handshakes in progress (a host only).
    handshakes: AtomicUsize,
    room: Room,
    /// Addresses a host turns away (a banned guest).
    banned: Mutex<HashSet<IpAddr>>,
}

impl Link {
    fn new(sink: Sink, room: Room) -> Arc<Self> {
        Arc::new(Self {
            sink,
            stop: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            conns: Mutex::new(HashMap::new()),
            throttle: Mutex::new(Throttle::default()),
            handshakes: AtomicUsize::new(0),
            room,
            banned: Mutex::new(HashSet::new()),
        })
    }

    fn emit_state(&self, conn: u64, state: LinkState, detail: Option<&str>) {
        (self.sink)(Event::State {
            conn,
            state,
            detail: detail.map(str::to_owned),
        });
    }

    /// Starts listening on a free port. The code uses `advertise` as the host's address, and the
    /// host listens on that address only (not on every network the computer is on) when it can.
    pub fn host(advertise: Ipv4Addr, sink: Sink) -> io::Result<Arc<Self>> {
        let listener = TcpListener::bind((advertise, 0))
            .or_else(|_| TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let room = Room {
            addr: SocketAddrV4::new(advertise, port),
            token: random_token(),
        };
        let link = Self::new(sink, room);
        link.emit_state(0, LinkState::Connecting, None);
        let accept = Arc::clone(&link);
        thread::Builder::new()
            .name("practice-accept".into())
            .spawn(move || accept.accept_loop(listener))?;
        Ok(link)
    }

    /// The room code to give to the guests.
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
        link.emit_state(0, LinkState::Connecting, None);
        let stream = establish(&room)?;
        let closed = || JoinError::Unreachable("the link was closed".into());
        let (conn, read) = link.install(stream, usize::MAX).map_err(|_| closed())?;
        link.announce(&conn);
        let reader = Arc::clone(&link);
        if thread::Builder::new()
            .name("practice-guest".into())
            .spawn(move || reader.guest_loop(conn, read))
            .is_err()
        {
            link.close(None);
            return Err(closed());
        }
        Ok(link)
    }

    fn accept_loop(self: Arc<Self>, listener: TcpListener) {
        while !self.stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => self.begin_handshake(stream),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    /// A stranger knocks. Before it costs a thread: turn it away when the host already has
    /// [`MAX_HANDSHAKES`] handshakes going, or the address has [`MAX_HANDSHAKES_PER_ADDRESS`].
    fn begin_handshake(self: &Arc<Self>, stream: TcpStream) {
        let _ = stream.set_nonblocking(false);
        let peer = stream.peer_addr().ok().map(|a| a.ip());
        if self.handshakes.fetch_add(1, Ordering::SeqCst) >= MAX_HANDSHAKES {
            self.handshakes.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let allowed = peer.is_none_or(|ip| {
            self.throttle
                .lock()
                .map(|mut t| t.enter(ip))
                .unwrap_or(false)
        });
        if !allowed {
            self.handshakes.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        // The slot is given back when the closure ends, or is dropped because no thread started.
        let slot = HandshakeSlot {
            link: Arc::clone(self),
            peer,
        };
        let _ = thread::Builder::new()
            .name("practice-admit".into())
            .spawn(move || {
                let link = Arc::clone(&slot.link);
                link.admit(stream);
                drop(slot);
            });
    }

    /// The host checks the first frame of a new connection.
    fn admit(self: Arc<Self>, mut stream: TcpStream) {
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
        let peer = stream.peer_addr().ok().map(|a| a.ip());
        let token = match read_handshake_frame(&mut stream, deadline) {
            Ok(token) => token,
            Err(e) => {
                // A client that never finishes (or sends nonsense) counts like a wrong token;
                // one that connects and goes away does not.
                let stalled = matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::InvalidData
                );
                if stalled && let Some(ip) = peer {
                    let _ = self.throttle.lock().map(|mut t| t.fail(ip, Instant::now()));
                }
                return;
            }
        };
        // An address that sent too many wrong tokens is turned away, whatever it sends now. It
        // is answered after its frame was read, so the answer is not lost to a reset.
        let turned_away = peer.is_some_and(|ip| {
            self.throttle
                .lock()
                .map(|mut t| t.blocked(ip, Instant::now()))
                .unwrap_or(false)
        });
        if turned_away {
            let _ = write_frame(&mut stream, b"denied");
            return;
        }
        if !same_token(&token, &self.room.token) {
            if let Some(ip) = peer {
                let _ = self.throttle.lock().map(|mut t| t.fail(ip, Instant::now()));
            }
            let _ = write_frame(&mut stream, b"denied");
            return;
        }
        if let Some(ip) = peer {
            let _ = self.throttle.lock().map(|mut t| t.forgive(ip));
        }
        let blocked = peer.is_some_and(|ip| {
            self.banned
                .lock()
                .map(|set| set.contains(&ip))
                .unwrap_or(false)
        });
        if blocked {
            let _ = write_frame(&mut stream, b"banned");
            return;
        }
        let (conn, read) = match self.install(stream, MAX_CONNECTIONS) {
            Ok(installed) => installed,
            Err((Refused::Full, mut stream)) => {
                let _ = write_frame(&mut stream, b"full");
                return;
            }
            Err((Refused::Closed, _)) => return,
        };
        let told = conn
            .write
            .lock()
            .map(|mut w| write_frame(&mut *w, b"ok").is_ok())
            .unwrap_or(false);
        if !told {
            self.forget(&conn);
            return;
        }
        self.announce(&conn);
        let reader = Arc::clone(&self);
        let host_conn = Arc::clone(&conn);
        if thread::Builder::new()
            .name("practice-host".into())
            .spawn(move || reader.host_loop(host_conn, read))
            .is_err()
            && self.forget(&conn)
            && !self.stop.load(Ordering::SeqCst)
        {
            self.emit_state(conn.id, LinkState::Closed, Some("no thread for the guest"));
        }
    }

    /// Makes `stream` a connection of this link, unless the link is closed or already has `cap`
    /// connections: both are decided under the lock that `close` also takes, so a link that has
    /// been left never gets a connection afterwards. Returns it with a handle to read from; a
    /// refusal gives the stream back so the caller can still answer on it.
    fn install(
        &self,
        stream: TcpStream,
        cap: usize,
    ) -> Result<(Arc<Conn>, TcpStream), (Refused, TcpStream)> {
        let Ok(read) = stream.try_clone() else {
            return Err((Refused::Closed, stream));
        };
        let peer = stream.peer_addr().ok().map(|a| a.ip());
        let conn = {
            let mut conns = self.conns.lock().unwrap_or_else(|e| e.into_inner());
            if self.stop.load(Ordering::SeqCst) {
                return Err((Refused::Closed, stream));
            }
            if conns.len() >= cap {
                return Err((Refused::Full, stream));
            }
            let _ = stream.set_nodelay(true);
            let _ = stream.set_read_timeout(Some(DEAD_AFTER));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let conn = Arc::new(Conn {
                id: self.next_id.fetch_add(1, Ordering::SeqCst),
                write: Mutex::new(stream),
                shut: AtomicBool::new(false),
                peer,
            });
            conns.insert(conn.id, Arc::clone(&conn));
            conn
        };
        let keep = Arc::clone(&conn);
        let started = thread::Builder::new()
            .name("practice-keepalive".into())
            .spawn(move || {
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
        if started.is_err() {
            self.forget(&conn);
            return Err((Refused::Closed, read));
        }
        Ok((conn, read))
    }

    /// Ends `conn` and takes it out of the list; true if it was still in it.
    fn forget(&self, conn: &Arc<Conn>) -> bool {
        conn.shutdown();
        self.conns
            .lock()
            .map(|mut conns| conns.remove(&conn.id).is_some())
            .unwrap_or(false)
    }

    /// Tells the page a connection is open. A host also tells where the guest is (to show and
    /// to ban).
    fn announce(&self, conn: &Conn) {
        let detail = conn.peer.map(|ip| ip.to_string());
        self.emit_state(conn.id, LinkState::Open, detail.as_deref());
    }

    /// Reads frames until the connection ends; true if this connection was still registered.
    fn pump(&self, conn: &Arc<Conn>, mut read: TcpStream) -> bool {
        loop {
            match read_frame(&mut read) {
                Ok(body) if body.is_empty() => {}
                Ok(body) => match String::from_utf8(body) {
                    // Nothing more from a link that has been left: the page may already be
                    // talking to the next one.
                    Ok(_) if self.stop.load(Ordering::SeqCst) => break,
                    Ok(text) => (self.sink)(Event::Frame {
                        conn: conn.id,
                        text,
                    }),
                    Err(_) => break,
                },
                Err(_) => break,
            }
        }
        self.forget(conn)
    }

    fn host_loop(self: Arc<Self>, conn: Arc<Conn>, read: TcpStream) {
        if self.pump(&conn, read) && !self.stop.load(Ordering::SeqCst) {
            self.emit_state(conn.id, LinkState::Closed, Some("the guest disconnected"));
        }
    }

    fn guest_loop(self: Arc<Self>, mut conn: Arc<Conn>, mut read: TcpStream) {
        loop {
            if !self.pump(&conn, read) || self.stop.load(Ordering::SeqCst) {
                return;
            }
            self.emit_state(0, LinkState::Reconnecting, Some("the connection dropped"));
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
                    Err(JoinError::Banned) => {
                        self.close(Some("the host has blocked you from this session"));
                        return;
                    }
                    Err(JoinError::Full) => {
                        self.close(Some("the session is full"));
                        return;
                    }
                    Err(_) => {}
                }
            };
            // `install` refuses once the link was left while we were connecting.
            match self.install(stream, usize::MAX) {
                Ok(installed) => {
                    self.announce(&installed.0);
                    (conn, read) = installed;
                }
                Err(_) => {
                    self.close(Some("the link was closed"));
                    return;
                }
            }
        }
    }

    /// Sends one frame to connection `to` (a guest sends to its only one: pass `None`; a host
    /// names the guest). False when there is no such connection right now.
    pub fn send(&self, to: Option<u64>, text: &str) -> bool {
        let conn = self.conns.lock().ok().and_then(|conns| match to {
            Some(id) => conns.get(&id).cloned(),
            None => conns.values().next().cloned(),
        });
        let Some(conn) = conn else {
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

    /// A host ends one guest's connection (the guest may come back with the code).
    pub fn drop_connection(&self, id: u64) {
        let conn = self
            .conns
            .lock()
            .ok()
            .and_then(|conns| conns.get(&id).cloned());
        if let Some(conn) = conn {
            conn.shutdown();
        }
    }

    /// The address a host's connection came from.
    pub fn address_of(&self, id: u64) -> Option<IpAddr> {
        self.conns
            .lock()
            .ok()
            .and_then(|conns| conns.get(&id).and_then(|c| c.peer))
    }

    /// A host turns this address away from now on (new connections only; end the live one
    /// with [`Link::drop_connection`]).
    pub fn ban_address(&self, ip: IpAddr) {
        if let Ok(mut banned) = self.banned.lock() {
            banned.insert(ip);
        }
    }

    /// Ends the link for good.
    pub fn leave(&self) {
        self.close(None);
    }

    fn close(&self, detail: Option<&str>) {
        if self.stop.swap(true, Ordering::SeqCst) {
            return;
        }
        let all: Vec<Arc<Conn>> = self
            .conns
            .lock()
            .map(|mut conns| conns.drain().map(|(_, c)| c).collect())
            .unwrap_or_default();
        for conn in all {
            conn.shutdown();
        }
        self.emit_state(0, LinkState::Closed, detail);
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
    match read_handshake_frame(&mut stream, Instant::now() + HANDSHAKE_TIMEOUT) {
        Ok(answer) if answer == b"ok" => Ok(stream),
        Ok(answer) if answer == b"banned" => Err(JoinError::Banned),
        Ok(answer) if answer == b"full" => Err(JoinError::Full),
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
    conn: u64,
    state: LinkState,
    detail: Option<String>,
}

#[derive(Serialize, Clone)]
struct FramePayload {
    conn: u64,
    text: String,
}

fn emitter<R: Runtime>(app: AppHandle<R>) -> Sink {
    Arc::new(move |event| match event {
        Event::Frame { conn, text } => {
            let _ = app.emit(FRAME_EVENT, FramePayload { conn, text });
        }
        Event::State {
            conn,
            state,
            detail,
        } => {
            let _ = app.emit(
                STATE_EVENT,
                StatePayload {
                    conn,
                    state,
                    detail,
                },
            );
        }
    })
}

/// What the host shows: the code to read out and the address it stands for. `link` is the code as
/// a `smartbeat://join/…` link, kept for later: no such scheme is registered yet, so the page
/// shows the code and does not use the link.
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
    // The session this replaces ends first, so its last event reaches the page before the new
    // link's first one (and the page never takes the old link's "closed" for the new one's).
    state.leave();
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
    // As in `practice_host`: leave the old session before the new link says anything.
    state.leave();
    let link = Link::join(&code, emitter(app)).map_err(|e| {
        let kind = match e {
            JoinError::BadCode => ErrorKind::InvalidCode,
            JoinError::Unreachable(_) | JoinError::Denied | JoinError::Banned | JoinError::Full => {
                ErrorKind::Network
            }
        };
        CommandError::new(kind, e.to_string())
    })?;
    state.set(Some(link));
    Ok(())
}

/// Sends one frame. A host names the guest's connection (`conn`); a guest leaves it out.
#[tauri::command]
pub fn practice_send(state: State<'_, PracticeState>, text: String, conn: Option<u64>) -> bool {
    state.get().is_some_and(|link| link.send(conn, &text))
}

/// The host ends one guest's connection (kick). With `ban`, the guest's address is also turned
/// away from then on.
#[tauri::command]
pub fn practice_kick(state: State<'_, PracticeState>, conn: u64, ban: bool) {
    if let Some(link) = state.get() {
        if ban && let Some(ip) = link.address_of(conn) {
            link.ban_address(ip);
        }
        link.drop_connection(conn);
    }
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

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, last))
    }

    #[test]
    fn an_address_with_too_many_wrong_tokens_is_turned_away_for_a_while() {
        let mut t = Throttle::default();
        let start = Instant::now();
        for _ in 0..MAX_FAILURES_PER_ADDRESS - 1 {
            t.fail(ip(1), start);
        }
        assert!(!t.blocked(ip(1), start), "a few mistakes are forgiven");
        t.fail(ip(1), start);
        assert!(t.blocked(ip(1), start));
        assert!(!t.blocked(ip(2), start), "other addresses are not touched");
        assert!(t.blocked(ip(1), start + BLOCK_FOR - Duration::from_secs(1)));
        assert!(!t.blocked(ip(1), start + BLOCK_FOR + Duration::from_secs(1)));
        // And it starts from none again.
        t.fail(ip(1), start + BLOCK_FOR + Duration::from_secs(2));
        assert!(!t.blocked(ip(1), start + BLOCK_FOR + Duration::from_secs(2)));
    }

    #[test]
    fn mistakes_far_apart_do_not_add_up() {
        let mut t = Throttle::default();
        let mut now = Instant::now();
        for _ in 0..3 * MAX_FAILURES_PER_ADDRESS {
            t.fail(ip(1), now);
            now += FAILURE_WINDOW + Duration::from_secs(1);
        }
        assert!(!t.blocked(ip(1), now));
    }

    #[test]
    fn the_right_token_forgives_earlier_mistakes() {
        let mut t = Throttle::default();
        let now = Instant::now();
        for _ in 0..MAX_FAILURES_PER_ADDRESS - 1 {
            t.fail(ip(1), now);
        }
        t.forgive(ip(1));
        t.fail(ip(1), now);
        assert!(!t.blocked(ip(1), now));
    }

    #[test]
    fn one_address_has_a_few_handshakes_at_a_time() {
        let mut t = Throttle::default();
        for _ in 0..MAX_HANDSHAKES_PER_ADDRESS {
            assert!(t.enter(ip(1)));
        }
        assert!(!t.enter(ip(1)), "one stranger cannot hold every place");
        assert!(t.enter(ip(2)));
        t.leave(ip(1));
        assert!(t.enter(ip(1)), "a place is free again");
    }

    #[test]
    fn the_throttle_remembers_a_bounded_number_of_addresses() {
        let mut t = Throttle::default();
        let now = Instant::now();
        for i in 0..=255u8 {
            for j in 0..2u8 {
                t.fail(IpAddr::V4(Ipv4Addr::new(10, 1, j, i)), now);
            }
        }
        assert!(t.entries.len() <= MAX_TRACKED_ADDRESSES);
    }
}
