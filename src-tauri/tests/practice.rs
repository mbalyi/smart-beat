//! Practice together (#158): two links talking over loopback, the way two apps would on a LAN.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use smart_beat_lib::practice::{
    Event, JoinError, Link, LinkState, MAX_FRAME, Room, Sink, read_frame, write_frame,
};

const WAIT: Duration = Duration::from_secs(5);

fn sink() -> (Sink, Receiver<Event>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let sink: Sink = Arc::new(move |event| {
        let _ = tx.lock().unwrap().send(event);
    });
    (sink, rx)
}

/// Waits for an event the test cares about, skipping the others.
fn wait_for(rx: &Receiver<Event>, what: &str, mut want: impl FnMut(&Event) -> bool) -> Event {
    let deadline = Instant::now() + WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(event) if want(&event) => return event,
            Ok(_) => {}
            Err(_) => panic!("timed out waiting for {what}"),
        }
    }
}

fn state(rx: &Receiver<Event>, want: LinkState) -> Event {
    wait_for(
        rx,
        &format!("{want:?}"),
        |e| matches!(e, Event::State { state, .. } if *state == want),
    )
}

fn frame(rx: &Receiver<Event>) -> String {
    frame_from(rx).1
}

/// A frame and the connection it came on.
fn frame_from(rx: &Receiver<Event>) -> (u64, String) {
    match wait_for(rx, "a frame", |e| matches!(e, Event::Frame { .. })) {
        Event::Frame { conn, text } => (conn, text),
        _ => unreachable!(),
    }
}

/// The connection of the next guest to open on a host.
fn opened(rx: &Receiver<Event>) -> (u64, Option<String>) {
    match wait_for(
        rx,
        "a connection to open",
        |e| matches!(e, Event::State { conn, state, .. } if *conn != 0 && *state == LinkState::Open),
    ) {
        Event::State { conn, detail, .. } => (conn, detail),
        _ => unreachable!(),
    }
}

struct Pair {
    /// The host's connection to the guest.
    conn: u64,
    host: Arc<Link>,
    host_rx: Receiver<Event>,
    guest: Arc<Link>,
    guest_rx: Receiver<Event>,
}

fn pair() -> Pair {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).expect("host");
    let (guest_sink, guest_rx) = sink();
    let guest = Link::join(&host.code(), guest_sink).expect("join");
    let (conn, _) = opened(&host_rx);
    state(&guest_rx, LinkState::Open);
    Pair {
        conn,
        host,
        host_rx,
        guest,
        guest_rx,
    }
}

#[test]
fn two_apps_exchange_frames_both_ways() {
    let p = pair();
    assert!(p.guest.send(None, r#"{"hello":"from the guest"}"#));
    assert_eq!(frame(&p.host_rx), r#"{"hello":"from the guest"}"#);
    assert!(p.host.send(Some(p.conn), "welcome, ünïcode ✓"));
    assert_eq!(frame(&p.guest_rx), "welcome, ünïcode ✓");
    p.guest.leave();
    p.host.leave();
}

#[test]
fn frames_keep_their_order() {
    let p = pair();
    for i in 0..200 {
        assert!(p.guest.send(None, &format!("{i}")));
    }
    for i in 0..200 {
        assert_eq!(frame(&p.host_rx), format!("{i}"));
    }
}

#[test]
fn a_ping_round_trip_on_loopback_is_fast() {
    let p = pair();
    let mut best = Duration::MAX;
    for _ in 0..20 {
        let t = Instant::now();
        p.guest.send(None, "ping");
        assert_eq!(frame(&p.host_rx), "ping");
        p.host.send(Some(p.conn), "pong");
        assert_eq!(frame(&p.guest_rx), "pong");
        best = best.min(t.elapsed());
    }
    assert!(best < Duration::from_millis(20), "best round trip {best:?}");
}

#[test]
fn a_wrong_code_is_refused_and_the_host_goes_on() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut room = Room::parse(&host.code()).unwrap();
    room.token[0] ^= 0xFF;
    let (guest_sink, _guest_rx) = sink();
    assert_eq!(
        Link::join(&room.code(), guest_sink).err(),
        Some(JoinError::Denied)
    );
    // The right code still works afterwards.
    let (guest_sink, guest_rx) = sink();
    let guest = Link::join(&host.code(), guest_sink).unwrap();
    state(&guest_rx, LinkState::Open);
    opened(&host_rx);
    guest.leave();
}

#[test]
fn a_bad_or_unreachable_code_fails_cleanly() {
    let (s, _rx) = sink();
    assert_eq!(Link::join("nope", s).err(), Some(JoinError::BadCode));
    // A port nobody listens on.
    let room = Room {
        addr: std::net::SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1),
        token: [9; 6],
    };
    let (s, _rx) = sink();
    assert!(matches!(
        Link::join(&room.code(), s).err(),
        Some(JoinError::Unreachable(_))
    ));
}

#[test]
fn many_wrong_codes_do_not_end_the_session() {
    let p = pair();
    let mut room = Room::parse(&p.host.code()).unwrap();
    room.token[1] ^= 0x55;
    for _ in 0..30 {
        let (s, _rx) = sink();
        let _ = Link::join(&room.code(), s);
    }
    // The guest that was let in is still in, and the host still listens.
    assert!(p.guest.send(None, "still here"));
    assert_eq!(frame(&p.host_rx), "still here");
    assert!(p.host.send(Some(p.conn), "and so am I"));
    assert_eq!(frame(&p.guest_rx), "and so am I");
    let closed = p
        .host_rx
        .try_iter()
        .any(|e| matches!(e, Event::State { conn: 0, state, .. } if state == LinkState::Closed));
    assert!(!closed, "the host must not close because of strangers");
}

#[test]
fn an_address_that_keeps_guessing_is_turned_away() {
    let (host_sink, _host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut wrong = Room::parse(&host.code()).unwrap();
    wrong.token[2] ^= 0x33;
    let mut last = None;
    for _ in 0..12 {
        let (s, _rx) = sink();
        last = Link::join(&wrong.code(), s).err();
    }
    assert_eq!(last, Some(JoinError::Denied));
    // Turned away from now on, even with the right code: it is the address that is blocked.
    let (s, _rx) = sink();
    assert_eq!(
        Link::join(&host.code(), s).err(),
        Some(JoinError::Denied),
        "a blocked address stays out for a while"
    );
}

/// A raw connection that has not said anything.
fn knock(port: u16) -> TcpStream {
    TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect")
}

/// True when the other end has closed this connection (within `wait`).
fn closed_by_peer(stream: &mut TcpStream, wait: Duration) -> bool {
    stream.set_read_timeout(Some(wait)).unwrap();
    let mut byte = [0u8; 1];
    match stream.read(&mut byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => !matches!(
            e.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ),
    }
}

#[test]
fn a_handshake_has_one_deadline_so_a_slow_sender_is_cut_off() {
    let (host_sink, _host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut stream = knock(host.port());
    let started = Instant::now();
    // One byte of the frame every 0.8 s: every read arrives in time, the whole never does.
    let mut sender = stream.try_clone().unwrap();
    let drip = std::thread::spawn(move || {
        for byte in [0u8, 0, 0, 6, 1, 2, 3, 4, 5, 6] {
            if sender.write_all(&[byte]).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(800));
        }
    });
    assert!(
        closed_by_peer(&mut stream, Duration::from_secs(6)),
        "the host must hang up on a handshake that takes too long"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cut off after {:?}",
        started.elapsed()
    );
    let _ = drip.join();
}

#[test]
fn idle_connections_cannot_tie_up_the_host() {
    let p = pair();
    // A stranger opens a lot of connections and says nothing.
    let mut strangers: Vec<TcpStream> = (0..60).map(|_| knock(p.host.port())).collect();
    std::thread::sleep(Duration::from_millis(300));
    let held = strangers
        .iter_mut()
        .filter_map(|s| (!closed_by_peer(s, Duration::from_millis(20))).then_some(()))
        .count();
    assert!(
        held <= 3,
        "{held} idle connections are being waited for; one address may have three"
    );
    // The session goes on meanwhile.
    assert!(p.guest.send(None, "hello"));
    assert_eq!(frame(&p.host_rx), "hello");
}

#[test]
fn leaving_while_reconnecting_leaves_no_ghost_connection() {
    use std::net::{SocketAddrV4, TcpListener};
    use std::sync::mpsc;

    // A host by hand: it lets the guest in, drops it, then takes the reconnect slowly.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let room = Room {
        addr: SocketAddrV4::new(Ipv4Addr::LOCALHOST, port),
        token: [7, 7, 7, 7, 7, 7],
    };
    let (asked_tx, asked_rx) = mpsc::channel();
    let (seen_tx, seen_rx) = mpsc::channel();
    let fake = std::thread::spawn(move || {
        let (mut first, _) = listener.accept().unwrap();
        let _ = read_frame(&mut first);
        write_frame(&mut first, b"ok").unwrap();
        drop(first);
        let (mut second, _) = listener.accept().unwrap();
        let _ = read_frame(&mut second);
        asked_tx.send(()).unwrap();
        // The guest is told to leave while it waits for this answer.
        std::thread::sleep(Duration::from_millis(1500));
        let _ = write_frame(&mut second, b"ok");
        // A ghost would keep this open and keep sending keep-alives.
        second
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let ended = loop {
            match read_frame(&mut second) {
                Ok(body) if body.is_empty() => continue,
                Ok(_) => continue,
                Err(e) => {
                    break !matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    );
                }
            }
        };
        seen_tx.send(ended).unwrap();
    });

    let (guest_sink, guest_rx) = sink();
    let guest = Link::join(&room.code(), guest_sink).unwrap();
    state(&guest_rx, LinkState::Reconnecting);
    asked_rx.recv_timeout(WAIT).expect("the guest came back");
    guest.leave();
    state(&guest_rx, LinkState::Closed);
    // Nothing more is said for a link that has been left, even when the host answers now.
    std::thread::sleep(Duration::from_millis(2000));
    let later: Vec<Event> = guest_rx.try_iter().collect();
    assert!(
        later.is_empty(),
        "a left link must stay quiet, but said {later:?}"
    );
    assert!(
        seen_rx.recv_timeout(Duration::from_secs(6)).unwrap(),
        "the connection made after leaving must be closed, not kept alive"
    );
    fake.join().unwrap();
}

#[test]
fn the_host_sees_a_guest_leave_and_the_guest_can_come_back() {
    let p = pair();
    let code = p.host.code();
    p.guest.leave();
    wait_for(
        &p.host_rx,
        "the guest to be gone",
        |e| matches!(e, Event::State { conn, state, .. } if *conn == p.conn && *state == LinkState::Closed),
    );
    assert!(!p.host.send(Some(p.conn), "anyone?"), "no one to send to");
    let (guest_sink, guest_rx) = sink();
    let again = Link::join(&code, guest_sink).expect("the same code works again");
    state(&guest_rx, LinkState::Open);
    let (back, _) = opened(&p.host_rx);
    assert_ne!(back, p.conn, "a new connection has a new id");
    assert!(again.send(None, "back"));
    assert_eq!(frame_from(&p.host_rx), (back, "back".into()));
}

#[test]
fn the_guest_sees_the_host_vanish_and_ends_when_it_leaves() {
    let p = pair();
    p.host.leave();
    state(&p.guest_rx, LinkState::Reconnecting);
    p.guest.leave();
    state(&p.guest_rx, LinkState::Closed);
}

#[test]
fn a_host_keeps_one_connection_per_guest_and_tells_them_apart() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut guests = Vec::new();
    let mut ids = Vec::new();
    for _ in 0..3 {
        let (guest_sink, guest_rx) = sink();
        guests.push((Link::join(&host.code(), guest_sink).unwrap(), guest_rx));
        let (conn, address) = opened(&host_rx);
        assert_eq!(
            address.as_deref(),
            Some("127.0.0.1"),
            "the host knows where from"
        );
        ids.push(conn);
    }
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 3, "three different connections");
    for (i, (guest, _)) in guests.iter().enumerate() {
        assert!(guest.send(None, &format!("from {i}")));
    }
    let mut heard = Vec::new();
    for _ in 0..3 {
        heard.push(frame_from(&host_rx));
    }
    heard.sort();
    for (i, (conn, text)) in heard.iter().enumerate() {
        assert!(ids.contains(conn));
        assert_eq!(text, &format!("from {i}"));
    }
    // Each guest gets only what is sent to its own connection.
    for (i, id) in ids.iter().enumerate() {
        assert!(host.send(Some(*id), &format!("to {id} #{i}")));
    }
    let mut got: Vec<String> = guests.iter().map(|(_, rx)| frame(rx)).collect();
    got.sort();
    for (i, text) in got.iter().enumerate() {
        assert!(text.starts_with(&format!("to {}", ids[i])), "{text}");
    }
    assert!(!host.send(Some(9999), "nobody"), "no such guest");
}

#[test]
fn the_host_can_drop_one_guest_and_the_others_stay() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let (a_sink, a_rx) = sink();
    let a = Link::join(&host.code(), a_sink).unwrap();
    let (a_conn, _) = opened(&host_rx);
    let (b_sink, b_rx) = sink();
    let b = Link::join(&host.code(), b_sink).unwrap();
    let (b_conn, _) = opened(&host_rx);
    host.drop_connection(a_conn);
    wait_for(
        &host_rx,
        "the dropped guest to be gone",
        |e| matches!(e, Event::State { conn, state, .. } if *conn == a_conn && *state == LinkState::Closed),
    );
    state(&a_rx, LinkState::Reconnecting);
    assert!(host.send(Some(b_conn), "still here"));
    assert_eq!(frame(&b_rx), "still here");
    assert!(b.send(None, "me too"));
    assert_eq!(frame_from(&host_rx), (b_conn, "me too".into()));
    a.leave();
    b.leave();
}

#[test]
fn a_banned_address_is_turned_away() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let (a_sink, _a_rx) = sink();
    let a = Link::join(&host.code(), a_sink).unwrap();
    let (conn, _) = opened(&host_rx);
    let ip = host.address_of(conn).expect("the guest's address");
    host.ban_address(ip);
    host.drop_connection(conn);
    a.leave();
    let (s, _rx) = sink();
    assert_eq!(
        Link::join(&host.code(), s).err(),
        Some(JoinError::Banned),
        "the same address cannot come back"
    );
}

#[test]
fn a_host_has_room_for_a_limited_number_of_connections() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut kept = Vec::new();
    for _ in 0..smart_beat_lib::practice::MAX_CONNECTIONS {
        let (s, _rx) = sink();
        kept.push((Link::join(&host.code(), s).unwrap(), _rx));
        opened(&host_rx);
    }
    let (s, _rx) = sink();
    assert_eq!(Link::join(&host.code(), s).err(), Some(JoinError::Full));
    drop(kept);
}

#[test]
fn an_oversized_frame_ends_the_connection() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let room = Room::parse(&host.code()).unwrap();
    let mut raw = TcpStream::connect(room.addr).unwrap();
    write_frame(&mut raw, &room.token).unwrap();
    assert_eq!(read_frame(&mut raw).unwrap(), b"ok");
    opened(&host_rx);
    raw.write_all(&((MAX_FRAME as u32) + 1).to_be_bytes())
        .unwrap();
    state(&host_rx, LinkState::Closed);
}

#[test]
fn text_that_is_not_utf8_ends_the_connection() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let room = Room::parse(&host.code()).unwrap();
    let mut raw = TcpStream::connect(room.addr).unwrap();
    write_frame(&mut raw, &room.token).unwrap();
    assert_eq!(read_frame(&mut raw).unwrap(), b"ok");
    opened(&host_rx);
    write_frame(&mut raw, &[0xFF, 0xFE, 0xFD]).unwrap();
    state(&host_rx, LinkState::Closed);
}

#[test]
fn a_quiet_link_stays_open_thanks_to_keep_alives() {
    let p = pair();
    std::thread::sleep(Duration::from_secs(5));
    assert!(p.guest.send(None, "still here"));
    assert_eq!(frame(&p.host_rx), "still here");
    // Keep-alives are never passed on to the page.
    assert!(p.host_rx.try_recv().is_err());
}

/// Editing the tab together (#216): guests send bursts of small edit frames, the host sends them
/// on to everyone, and every guest hears the host's frames in the order the host sent them.
#[test]
fn edit_bursts_from_several_guests_keep_their_order_and_reach_everyone() {
    const GUESTS: usize = 4;
    const EDITS: usize = 120;
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut guests = Vec::new();
    let mut conns = Vec::new();
    for _ in 0..GUESTS {
        let (guest_sink, guest_rx) = sink();
        guests.push((Link::join(&host.code(), guest_sink).unwrap(), guest_rx));
        conns.push(opened(&host_rx).0);
    }

    // Every guest sends its edits at once, from its own thread.
    let senders: Vec<_> = guests
        .iter()
        .enumerate()
        .map(|(g, (link, _))| {
            let link = Arc::clone(link);
            std::thread::spawn(move || {
                for n in 0..EDITS {
                    // A frame near the size an edit takes, with its sender and number.
                    let text = format!("{g}:{n}:{}", "x".repeat(9_000));
                    assert!(link.send(None, &text));
                }
            })
        })
        .collect();
    for sender in senders {
        sender.join().unwrap();
    }

    // The host hears each guest's frames in that guest's order, and numbers them as it goes.
    let mut next = [0usize; GUESTS];
    let mut order = Vec::new();
    for _ in 0..GUESTS * EDITS {
        let (_, text) = frame_from(&host_rx);
        let mut parts = text.splitn(3, ':');
        let g: usize = parts.next().unwrap().parse().unwrap();
        let n: usize = parts.next().unwrap().parse().unwrap();
        assert_eq!(n, next[g], "guest {g}'s edits arrive in order");
        next[g] += 1;
        order.push((g, n));
    }

    // It sends them all on, in that order, to every guest.
    for (seq, (g, n)) in order.iter().enumerate() {
        for conn in &conns {
            assert!(host.send(Some(*conn), &format!("{seq}:{g}:{n}")));
        }
    }
    for (_, rx) in &guests {
        for (seq, (g, n)) in order.iter().enumerate() {
            assert_eq!(frame(rx), format!("{seq}:{g}:{n}"));
        }
    }
}
