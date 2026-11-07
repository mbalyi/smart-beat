//! A panic is counted by area, sent at once when online, and never leaks its message (#164).
//!
//! The panic hook is process-wide, so this file is its own test binary and holds one test.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;
use smart_beat_lib::telemetry::{Telemetry, install_panic_hook};

/// Serves one `200` and returns the request body it received.
fn mock_server() -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/batch", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).unwrap();
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data).into_owned();
            if let Some(split) = text.find("\r\n\r\n") {
                let length = text
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if data.len() >= split + 4 + length || n == 0 {
                    write!(
                        stream,
                        "HTTP/1.1 200 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                    return text[split + 4..].to_string();
                }
            }
            assert!(n > 0, "request ended early");
        }
    });
    (url, handle)
}

#[test]
fn a_panic_is_counted_by_area_sent_at_once_and_keeps_its_message_private() {
    let (url, server) = mock_server();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let telemetry = Arc::new(Telemetry::new(&data, Some(url.as_str()), "1.1.0"));

    // The previous hook still runs, so the default report is kept.
    let previous_ran = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&previous_ran);
    std::panic::set_hook(Box::new(move |_| seen.store(true, Ordering::SeqCst)));
    install_panic_hook(Arc::clone(&telemetry));

    // This file is not under `src/`, so the area is `other`; the message holds private data.
    let worker = std::thread::spawn(|| {
        panic!("could not open /Users/jane/Songs/My Secret Song.gp5 (jane@example.com)");
    });
    assert!(worker.join().is_err());
    assert!(
        previous_ran.load(Ordering::SeqCst),
        "the default hook was dropped"
    );

    // Recorded in usage.json by area only.
    let deadline = Instant::now() + Duration::from_secs(10);
    let body = loop {
        if server.is_finished() {
            break server.join().unwrap();
        }
        assert!(Instant::now() < deadline, "the panic was not sent");
        std::thread::sleep(Duration::from_millis(20));
    };
    let batch: Value = serde_json::from_str(&body).expect("upload is JSON");
    let counts = batch["counts"].as_array().unwrap();
    assert_eq!(counts.len(), 1, "{body}");
    assert_eq!(counts[0]["event"], "panic");
    assert_eq!(counts[0]["format"], "other");
    assert_eq!(counts[0]["count"], 1);
    for private in [
        "Jane",
        "jane",
        "Secret",
        "Songs",
        ".gp5",
        "example.com",
        "panicked",
        ".rs",
    ] {
        assert!(!body.contains(private), "{private} leaked into {body}");
    }

    // The acknowledged counter is gone from the file; the file never held the message either.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !telemetry.pending().is_empty() {
        assert!(Instant::now() < deadline, "the sent panic stayed queued");
        std::thread::sleep(Duration::from_millis(20));
    }
    let stored = std::fs::read_to_string(data.join("usage.json")).unwrap();
    assert!(
        !stored.contains("Secret") && !stored.contains("jane"),
        "{stored}"
    );
}
