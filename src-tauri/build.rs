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
    native_muscriptor();
    ensure_helper_placeholder();

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

/// Builds the vendored muscriptor.cpp (native/, MIT) with ggml and links it statically. Needs
/// CMake 3.24 or newer, a C++23 compiler and git with network access: ggml is fetched at the
/// commit pinned in native/muscriptor/CMakeLists.txt. Metal shaders are compiled at run time, so
/// no extra file ships next to the app.
fn native_muscriptor() {
    println!("cargo:rerun-if-changed=native");
    let mut config = cmake::Config::new("native");
    config
        .profile("Release")
        .define("MUSCRIPTOR_METAL_PRECOMPILED", "OFF")
        .define("BUILD_TESTING", "OFF")
        .build_target("sb_muscriptor");
    let out = config.build();
    let build = out.join("build");
    link_static_libraries(&build);
    match env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => {
            println!("cargo:rustc-link-lib=c++");
            for framework in ["Metal", "MetalKit", "Foundation", "CoreFoundation"] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
        }
        Ok("linux") => println!("cargo:rustc-link-lib=stdc++"),
        _ => {}
    }
}

/// Links every static library CMake produced below `dir`.
fn link_static_libraries(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            link_static_libraries(&path);
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let stem = name
            .strip_prefix("lib")
            .and_then(|n| n.strip_suffix(".a"))
            .or_else(|| name.strip_suffix(".lib"));
        if let (Some(stem), Some(parent)) = (stem, path.parent()) {
            println!("cargo:rustc-link-search=native={}", parent.display());
            println!("cargo:rustc-link-lib=static={stem}");
        }
    }
}

/// The plugin helper sidecar (`externalBin` in tauri.conf.json) is staged by
/// `scripts/stage-plugin-helper.mjs` before bundles. Plain `cargo` runs
/// (tests, clippy, dev) only need the path to *exist* for tauri-build's
/// compile-time validation, so an empty placeholder stands in until staging
/// overwrites it with the real binary. Without this, a fresh checkout cannot
/// even `cargo check`.
fn ensure_helper_placeholder() {
    let target = env::var("TARGET").unwrap_or_default();
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo");
    let staged = Path::new(&manifest_dir)
        .join("binaries")
        .join(format!("smart-beat-plugin-helper-{target}{suffix}"));
    if !staged.exists()
        && let Some(parent) = staged.parent()
        && std::fs::create_dir_all(parent).is_ok()
    {
        let _ = std::fs::write(&staged, []);
    }
}
