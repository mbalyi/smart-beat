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
    mirelo_api_key();

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

/// Import from Audio compiles in Smart Beat's Mirelo key (`option_env!` in src/mirelo.rs).
/// Release builds get it from the environment (the GitHub secret). Locally, an exported
/// variable wins, else the repository's `.env` provides it.
fn mirelo_api_key() {
    const KEY: &str = "MIRELO_AI_API_KEY";
    println!("cargo:rerun-if-env-changed={KEY}");
    if env::var(KEY).is_ok_and(|key| !key.trim().is_empty()) {
        return;
    }
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
    let dotenv = Path::new(&manifest_dir).join("../.env");
    let Ok(text) = std::fs::read_to_string(&dotenv) else {
        return;
    };
    println!("cargo:rerun-if-changed={}", dotenv.display());
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some(value) = line
            .strip_prefix(KEY)
            .and_then(|v| v.trim_start().strip_prefix('='))
        {
            let value = value.trim().trim_matches(['"', '\'']);
            if !value.is_empty() {
                println!("cargo:rustc-env={KEY}={value}");
            }
        }
    }
}
