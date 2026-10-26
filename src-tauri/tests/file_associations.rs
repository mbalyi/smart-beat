//! The file types Smart Beat registers with the operating system live in `tauri.conf.json`.
//! A missing extension or UTI only shows up as a greyed-out "Open With" in a released build,
//! so these checks catch it in CI instead (issue #190).

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;
use smart_beat_lib::score_file::EXTENSIONS;

/// Too generic to claim: registering them would take over every XML and text file.
const NOT_REGISTERED: [&str; 2] = ["xml", "txt"];

fn associations() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let config: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    config["bundle"]["fileAssociations"]
        .as_array()
        .expect("bundle.fileAssociations is a list")
        .clone()
}

#[test]
fn every_score_format_is_registered_except_the_generic_ones() {
    let registered: BTreeSet<String> = associations()
        .iter()
        .flat_map(|a| a["ext"].as_array().unwrap().iter())
        .map(|e| e.as_str().unwrap().to_owned())
        .collect();
    let expected: BTreeSet<String> = EXTENSIONS
        .iter()
        .filter(|e| !NOT_REGISTERED.contains(e))
        .map(|e| (*e).to_owned())
        .collect();
    assert_eq!(registered, expected);
}

#[test]
fn each_type_has_what_macos_linux_and_windows_need() {
    for association in associations() {
        let name = association["name"].as_str().unwrap_or_default();
        assert!(!name.is_empty(), "{association}: name");
        assert!(
            association["description"].is_string(),
            "{name}: description"
        );
        assert!(
            association["mimeType"].is_string(),
            "{name}: mimeType (Linux)"
        );
        // Without an exported type macOS has no UTI for the extension and greys the app out.
        let identifier = association["exportedType"]["identifier"].as_str();
        assert!(
            identifier.is_some_and(|id| id.starts_with("com.mbalyi.smartbeat.")),
            "{name}: exportedType.identifier"
        );
        assert_eq!(association["role"], "Editor", "{name}: role");
    }
}
