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
