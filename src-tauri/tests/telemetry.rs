//! Integration tests for the usage counters: what one upload carries, and how
//! the leftovers of a failed final flush reach the server on the next launch.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use smart_beat_lib::telemetry::{Event, Outcome, Telemetry};

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

/// The event names in one uploaded batch, sorted, with their counts.
fn events_in(body: &str) -> Vec<(String, u64)> {
    let batch: Value = serde_json::from_str(body).expect("upload is JSON");
    let mut events: Vec<(String, u64)> = batch["counts"]
        .as_array()
        .expect("counts is an array")
        .iter()
        .map(|e| {
            (
                e["event"].as_str().unwrap().to_owned(),
                e["count"].as_u64().unwrap(),
            )
        })
        .collect();
    events.sort();
    events
}

fn expected_session() -> Vec<(String, u64)> {
    vec![
        ("app_start".to_owned(), 1),
        ("play".to_owned(), 1),
        ("stop".to_owned(), 1),
    ]
}

fn record_session(t: &Telemetry) {
    t.record(Event::AppStart, None).unwrap();
    t.record(Event::Play, None).unwrap();
    t.record(Event::Stop, None).unwrap();
}

#[test]
fn final_flush_sends_the_whole_session_in_one_request() {
    let (url, server) = mock_server(vec![200]);
    let dir = tempfile::tempdir().unwrap();
    let t = Telemetry::new(dir.path().join("usage"), Some(url.as_str()), "1.0.1");

    record_session(&t);
    assert_eq!(t.flush_final(), Outcome::Sent);
    assert!(t.pending().is_empty());

    let bodies = server.join().unwrap();
    assert_eq!(bodies.len(), 1, "exactly one request");
    assert_eq!(events_in(&bodies[0]), expected_session());
}

#[test]
fn leftovers_of_a_failed_final_flush_arrive_at_the_next_launch() {
    let (url, server) = mock_server(vec![500, 200]);
    let dir = tempfile::tempdir().unwrap();
    let usage = dir.path().join("usage");

    let first = Telemetry::new(usage.clone(), Some(url.as_str()), "1.0.1");
    record_session(&first);
    assert_eq!(first.flush_final(), Outcome::Failed("HTTP 500".into()));
    assert_eq!(first.pending().len(), 3, "failed batch stays queued");
    drop(first);

    // The next launch uses a fresh instance on the same folder.
    let second = Arc::new(Telemetry::new(usage, Some(url.as_str()), "1.0.1"));
    second.flush_at_launch();

    let deadline = Instant::now() + Duration::from_secs(10);
    while !second.pending().is_empty() {
        assert!(Instant::now() < deadline, "launch upload did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }

    let bodies = server.join().unwrap();
    assert_eq!(bodies.len(), 2, "one failed and one successful request");
    assert_eq!(events_in(&bodies[0]), expected_session());
    assert_eq!(events_in(&bodies[1]), expected_session());
}
