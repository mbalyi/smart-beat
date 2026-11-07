//! Practice together (#158): two links talking over loopback, the way two apps would on a LAN.

use std::io::Write;
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
fn too_many_wrong_codes_close_the_host() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let mut room = Room::parse(&host.code()).unwrap();
    room.token[1] ^= 0x55;
    for _ in 0..25 {
        let (s, _rx) = sink();
        let _ = Link::join(&room.code(), s);
    }
    let event = wait_for(
        &host_rx,
        "the host to close",
        |e| matches!(e, Event::State { conn: 0, state, .. } if *state == LinkState::Closed),
    );
    assert!(matches!(event, Event::State { detail: Some(d), .. } if d.contains("wrong codes")));
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
