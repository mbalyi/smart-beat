//! The linked cloud folder (#187): listing, stamping, byte-exact `.gp` round trips, conflict
//! detection through `write_score_file` and unreadable folders.

use std::io::{Cursor, Write};
use std::path::Path;

use serde_json::{Value, json};
use smart_beat_lib::cloud_folder::{self, CloudFolderStore};
use smart_beat_lib::error::ErrorKind;
use smart_beat_lib::menu::MAIN_WINDOW;
use smart_beat_lib::mixer::{MixerSettings, VERSION};
use smart_beat_lib::{project, score_write};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

fn app() -> App<MockRuntime> {
    smart_beat_lib::setup(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("failed to build app")
}

fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW, Default::default())
        .build()
        .expect("failed to create window")
}

/// A small `.gp` (ZIP) standing in for alphaTab's output.
fn gp_bytes() -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("Content/score.gpif", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"<GPIF/>").unwrap();
    writer.finish().unwrap().into_inner()
}

fn settings() -> MixerSettings {
    serde_json::from_value(json!({
        "version": VERSION,
        "master": 0.8,
        "tracks": [{ "volume": 0.5, "pan": 0.0, "mute": false, "solo": false }],
    }))
    .unwrap()
}

fn encode(path: &Path) -> String {
    path.to_string_lossy()
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Calls `write_score_file` with a raw body, the `path` header and an optional `expected-hash`.
fn write_request(
    window: &WebviewWindow<MockRuntime>,
    path: &Path,
    bytes: Vec<u8>,
    expected_hash: Option<&str>,
) -> Result<InvokeResponseBody, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let mut headers = tauri::http::HeaderMap::new();
    headers.insert("path", encode(path).parse().unwrap());
    if let Some(hash) = expected_hash {
        headers.insert("expected-hash", hash.parse().unwrap());
    }
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: "write_score_file".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::Raw(bytes),
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

#[test]
fn a_gp_file_with_settings_round_trips_byte_for_byte() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("song.gp");
    std::fs::write(&path, gp_bytes()).unwrap();
    project::write_settings(&path, &settings(), None).unwrap();
    let saved = std::fs::read(&path).unwrap();

    // The cloud list offers it, and its stamp hashes exactly those bytes.
    let scores = cloud_folder::list_scores(folder.path()).unwrap();
    assert_eq!(scores.len(), 1);
    assert_eq!(scores[0].name, "song.gp");
    assert_eq!(scores[0].size, saved.len() as u64);
    let stamp = cloud_folder::stamp(&path).unwrap().unwrap();
    assert_eq!(stamp.hash, cloud_folder::hash_hex(&saved));

    // Writing the same bytes back (what Save does with the opened file) changes nothing.
    score_write::write(&path, &saved).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), saved);
    assert!(!cloud_folder::changed_since(&path, &stamp).unwrap());
    assert_eq!(project::read_settings(&path).unwrap(), Some(settings()));
}

#[test]
fn saving_over_an_unchanged_file_works_and_over_a_changed_one_conflicts() {
    let app = app();
    let window = main_window(&app);
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("song.gp");
    std::fs::write(&path, gp_bytes()).unwrap();
    let opened = cloud_folder::stamp(&path).unwrap().unwrap();

    // Nothing changed on disk: the save goes through.
    write_request(&window, &path, b"mine".to_vec(), Some(&opened.hash)).expect("save failed");
    assert_eq!(std::fs::read(&path).unwrap(), b"mine");

    // The sync client brings in another version: the save is refused and the file is untouched.
    std::fs::write(&path, b"from another computer").unwrap();
    let error =
        write_request(&window, &path, b"mine again".to_vec(), Some(&opened.hash)).unwrap_err();
    assert_eq!(error["kind"], "conflict");
    assert_eq!(std::fs::read(&path).unwrap(), b"from another computer");

    // Saving with the fresh stamp (the user chose to overwrite) succeeds.
    let latest = cloud_folder::stamp(&path).unwrap().unwrap();
    write_request(&window, &path, b"mine again".to_vec(), Some(&latest.hash)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"mine again");
}

#[test]
fn a_touched_file_with_the_same_content_is_not_a_conflict() {
    let app = app();
    let window = main_window(&app);
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("song.gp");
    std::fs::write(&path, b"one").unwrap();
    let opened = cloud_folder::stamp(&path).unwrap().unwrap();
    std::fs::write(&path, b"one").unwrap();
    write_request(&window, &path, b"two".to_vec(), Some(&opened.hash)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"two");
}

#[test]
fn saving_without_an_expected_hash_or_to_a_new_file_never_conflicts() {
    let app = app();
    let window = main_window(&app);
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("song.gp");
    std::fs::write(&path, b"existing").unwrap();
    write_request(&window, &path, b"plain".to_vec(), None).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"plain");

    // The file was deleted in the cloud since opening: saving recreates it.
    std::fs::remove_file(&path).unwrap();
    write_request(
        &window,
        &path,
        b"again".to_vec(),
        Some("0".repeat(64).as_str()),
    )
    .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"again");
}

#[test]
fn the_score_file_stamp_command_reports_the_hash() {
    let app = app();
    let window = main_window(&app);
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("song.gp");
    std::fs::write(&path, b"abc").unwrap();
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let response = get_ipc_response(
        &window,
        InvokeRequest {
            cmd: "score_file_stamp".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::Json(json!({ "path": path })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .expect("stamp failed")
    .deserialize::<Value>()
    .unwrap();
    // SHA-256 of "abc".
    assert_eq!(
        response["hash"],
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn a_missing_cloud_folder_is_reported_as_not_found() {
    let parent = tempfile::tempdir().unwrap();
    let gone = parent.path().join("Google Drive");
    let error = cloud_folder::list_scores(&gone).unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);
}

#[test]
fn a_path_that_is_a_file_is_an_unreadable_folder() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("not-a-folder.gp");
    std::fs::write(&file, b"x").unwrap();
    let error = cloud_folder::list_scores(&file).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Io);
}

#[cfg(unix)]
#[test]
fn a_folder_without_read_permission_is_an_io_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let locked = dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("a.gp"), b"x").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = cloud_folder::list_scores(&locked);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Running as root can still read it.
    if let Err(error) = result {
        assert_eq!(error.kind, ErrorKind::Io);
    }
}

#[test]
fn a_linked_folder_that_disappears_still_loads_and_lists_as_not_found() {
    let data = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let store = CloudFolderStore::new(data.path());
    let linked = target.path().to_string_lossy().into_owned();
    store.set(Some(&linked)).unwrap();
    drop(target);
    assert_eq!(store.load().as_deref(), Some(linked.as_str()));
    let error = cloud_folder::list_scores(Path::new(&linked)).unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);
}
