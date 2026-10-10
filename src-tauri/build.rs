use std::env;
use std::path::Path;

/// Windows application manifest selecting Common Controls v6. Shared by the
/// app binary (via tauri-build) and the test executables (below).
const WINDOWS_MANIFEST: &str = "windows-app-manifest.xml";

fn main() {
    // Set by the release pipeline (docs/analytics.md); without them the usage counters are off.
    println!("cargo:rerun-if-env-changed=SMART_BEAT_ANALYTICS_URL");
    println!("cargo:rerun-if-env-changed=SMART_BEAT_INSTALLER");
    embed_windows_manifest_in_tests();
    transcription_service();

    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}

/// The native menu code (muda) imports Common Controls v6 functions such as
/// `SetWindowSubclass` by name, which only exist when the executable's manifest
/// selects v6. tauri-build embeds the manifest into binaries only, so test
/// executables that exercise the menu would fail to start with
/// STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Embed it into tests too.
fn embed_windows_manifest_in_tests() {
    let is_windows_msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !is_windows_msvc {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
    let manifest = Path::new(&manifest_dir).join(WINDOWS_MANIFEST);
    println!("cargo:rerun-if-changed={WINDOWS_MANIFEST}");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}

/// Import from Audio's server: Smart Beat's self-hosted MuScriptor (`option_env!` in
/// src/transcription.rs). Release builds get `TRANSCRIPTION_SERVICE_URL` from a GitHub
/// variable. Locally, an exported variable wins, else the repository's `.env` provides it.
/// Without one, transcription is off.
fn transcription_service() {
    const NAME: &str = "TRANSCRIPTION_SERVICE_URL";
    println!("cargo:rerun-if-env-changed={NAME}");
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
    let dotenv = Path::new(&manifest_dir).join("../.env");
    let dotenv_text = std::fs::read_to_string(&dotenv).ok();
    if dotenv_text.is_some() {
        println!("cargo:rerun-if-changed={}", dotenv.display());
    }
    let url = env::var(NAME)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            dotenv_text
                .as_deref()
                .and_then(|text| dotenv_value(text, NAME))
        });
    let Some(url) = url else {
        return;
    };
    let url = url.trim_end_matches('/');
    let local = ["http://localhost:", "http://127.0.0.1:"]
        .iter()
        .any(|prefix| url.starts_with(prefix));
    assert!(
        url.starts_with("https://") || local,
        "{NAME} must be an https:// URL, or http://localhost:<port> for a local server"
    );
    println!("cargo:rustc-env={NAME}={url}");
}

/// `NAME=value` from a `.env` file. Accepts `export`, quotes and a trailing ` # comment`.
fn dotenv_value(text: &str, name: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let value = line
            .strip_prefix(name)?
            .trim_start()
            .strip_prefix('=')?
            .trim();
        let value = match value.chars().next() {
            Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().unwrap_or(""),
            _ => value.split(" #").next().unwrap_or("").trim(),
        };
        (!value.is_empty()).then(|| value.to_owned())
    })
}
