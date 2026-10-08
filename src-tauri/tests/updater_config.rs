//! The in-app updater is configured in files, not code: a wrong endpoint, a missing public key or a
//! missing permission only shows up when a user clicks "Check for Updates…" in a released build.
//! These checks catch that in CI instead (docs/release.md).

use std::path::Path;

use base64::Engine;
use serde_json::Value;

fn read_json(relative: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn updater_reads_latest_json_from_this_repositorys_latest_release() {
    let config = read_json("tauri.conf.json");
    let endpoints = config["plugins"]["updater"]["endpoints"]
        .as_array()
        .expect("plugins.updater.endpoints is a list");
    assert_eq!(
        endpoints,
        &[Value::from(
            "https://github.com/mbalyi/smart-beat/releases/latest/download/latest.json"
        )]
    );
}

#[test]
fn updater_public_key_is_a_minisign_key() {
    let config = read_json("tauri.conf.json");
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("plugins.updater.pubkey is a string");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key)
        .expect("the public key is base64");
    let text = String::from_utf8(decoded).expect("the public key file is text");
    let mut lines = text.lines();

    assert!(
        lines
            .next()
            .is_some_and(|l| l.starts_with("untrusted comment: minisign public key")),
        "not a minisign public key: {text:?}"
    );
    // An Ed25519 minisign key: base64 of 'Ed' + key id + 32 key bytes, which always starts "RW".
    assert!(
        lines
            .next()
            .is_some_and(|l| l.starts_with("RW") && l.len() == 56),
        "the key line is malformed: {text:?}"
    );
}

#[test]
fn updater_bundles_are_only_built_with_the_release_overlay() {
    // The base config must build without the private key (local builds, pull requests, forks).
    let base = read_json("tauri.conf.json");
    assert!(base["bundle"]["createUpdaterArtifacts"].is_null());

    let overlay = read_json("tauri.updater.conf.json");
    assert_eq!(
        overlay["bundle"]["createUpdaterArtifacts"],
        Value::Bool(true)
    );
}

#[test]
fn main_window_may_check_install_and_restart_but_nothing_more() {
    let capability = read_json("capabilities/default.json");
    let permissions: Vec<&str> = capability["permissions"]
        .as_array()
        .expect("permissions is a list")
        .iter()
        .filter_map(Value::as_str)
        .collect();

    for needed in [
        "updater:allow-check",
        "updater:allow-download-and-install",
        "process:allow-restart",
    ] {
        assert!(permissions.contains(&needed), "{needed} is missing");
    }
    // Not the whole plugins: the page may not exit the app or read the update server's raw data.
    assert!(!permissions.contains(&"process:default"));
    assert!(!permissions.contains(&"process:allow-exit"));
    assert!(!permissions.contains(&"updater:default"));
}

#[test]
fn bundle_licence_matches_the_repository() {
    let config = read_json("tauri.conf.json");
    let copyright = config["bundle"]["copyright"].as_str().unwrap();
    assert!(
        copyright.contains("PolyForm Noncommercial 1.0.0"),
        "{copyright}"
    );
}
