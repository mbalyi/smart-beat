//! One canonical version (docs/release.md): package.json. The app reports
//! `CARGO_PKG_VERSION` nowhere else, but Cargo.toml must still agree, and the
//! bundle metadata must read its version from package.json.

use serde_json::Value;

fn json(path: &str) -> Value {
    let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .unwrap_or_else(|error| panic!("{path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[test]
fn cargo_version_matches_package_json() {
    let package = json("../package.json");
    assert_eq!(
        package["version"].as_str(),
        Some(env!("CARGO_PKG_VERSION")),
        "run `pnpm release:patch` (or minor/major) instead of editing versions by hand"
    );
}

#[test]
fn bundle_takes_its_version_and_identity_from_one_place() {
    let config = json("tauri.conf.json");
    assert_eq!(config["version"], "../package.json");
    assert_eq!(config["productName"], "Smart Beat");
    assert_eq!(config["identifier"], "com.mbalyi.smartbeat");
    assert_eq!(config["bundle"]["publisher"], "Mark Balyi");
    assert_eq!(
        config["bundle"]["homepage"],
        json("../src/lib/project-info.json")["repository"]
    );
}
