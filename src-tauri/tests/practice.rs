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
    match wait_for(rx, "a frame", |e| matches!(e, Event::Frame(_))) {
        Event::Frame(text) => text,
        _ => unreachable!(),
    }
}

struct Pair {
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
    state(&host_rx, LinkState::Open);
    state(&guest_rx, LinkState::Open);
    Pair {
        host,
        host_rx,
        guest,
        guest_rx,
    }
}

#[test]
fn two_apps_exchange_frames_both_ways() {
    let p = pair();
    assert!(p.guest.send(r#"{"hello":"from the guest"}"#));
    assert_eq!(frame(&p.host_rx), r#"{"hello":"from the guest"}"#);
    assert!(p.host.send("welcome, ünïcode ✓"));
    assert_eq!(frame(&p.guest_rx), "welcome, ünïcode ✓");
    p.guest.leave();
    p.host.leave();
}

#[test]
fn frames_keep_their_order() {
    let p = pair();
    for i in 0..200 {
        assert!(p.guest.send(&format!("{i}")));
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
        p.guest.send("ping");
        assert_eq!(frame(&p.host_rx), "ping");
        p.host.send("pong");
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
    state(&host_rx, LinkState::Open);
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
    let event = state(&host_rx, LinkState::Closed);
    assert!(matches!(event, Event::State { detail: Some(d), .. } if d.contains("wrong codes")));
}

#[test]
fn the_host_sees_a_guest_leave_and_the_guest_can_come_back() {
    let p = pair();
    let code = p.host.code();
    p.guest.leave();
    state(&p.host_rx, LinkState::Reconnecting);
    assert!(!p.host.send("anyone?"), "no one to send to");
    let (guest_sink, guest_rx) = sink();
    let again = Link::join(&code, guest_sink).expect("the same code works again");
    state(&guest_rx, LinkState::Open);
    state(&p.host_rx, LinkState::Open);
    assert!(again.send("back"));
    assert_eq!(frame(&p.host_rx), "back");
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
fn a_new_connection_with_the_right_code_replaces_a_stale_one() {
    let p = pair();
    let (guest_sink, guest_rx) = sink();
    let second = Link::join(&p.host.code(), guest_sink).unwrap();
    state(&guest_rx, LinkState::Open);
    assert!(second.send("from the new one"));
    assert_eq!(frame(&p.host_rx), "from the new one");
    assert!(p.host.send("to the new one"));
    assert_eq!(frame(&guest_rx), "to the new one");
}

#[test]
fn an_oversized_frame_ends_the_connection() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let room = Room::parse(&host.code()).unwrap();
    let mut raw = TcpStream::connect(room.addr).unwrap();
    write_frame(&mut raw, &room.token).unwrap();
    assert_eq!(read_frame(&mut raw).unwrap(), b"ok");
    state(&host_rx, LinkState::Open);
    raw.write_all(&((MAX_FRAME as u32) + 1).to_be_bytes())
        .unwrap();
    state(&host_rx, LinkState::Reconnecting);
}

#[test]
fn text_that_is_not_utf8_ends_the_connection() {
    let (host_sink, host_rx) = sink();
    let host = Link::host(Ipv4Addr::LOCALHOST, host_sink).unwrap();
    let room = Room::parse(&host.code()).unwrap();
    let mut raw = TcpStream::connect(room.addr).unwrap();
    write_frame(&mut raw, &room.token).unwrap();
    assert_eq!(read_frame(&mut raw).unwrap(), b"ok");
    state(&host_rx, LinkState::Open);
    write_frame(&mut raw, &[0xFF, 0xFE, 0xFD]).unwrap();
    state(&host_rx, LinkState::Reconnecting);
}

#[test]
fn a_quiet_link_stays_open_thanks_to_keep_alives() {
    let p = pair();
    std::thread::sleep(Duration::from_secs(5));
    assert!(p.guest.send("still here"));
    assert_eq!(frame(&p.host_rx), "still here");
    // Keep-alives are never passed on to the page.
    assert!(p.host_rx.try_recv().is_err());
}
