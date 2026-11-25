//! The sample browser's commands (#232): folders are linked, copied or unpacked, listed from
//! a cache, and resolved to paths only inside their folder. No audio engine runs.

use std::io::Write;

use smart_beat_lib::audio::AudioState;
use smart_beat_lib::samples::commands::{
    samples_cancel, samples_import_archive, samples_import_files, samples_import_folder,
    samples_inspect_archive, samples_link_folder, samples_list_files, samples_list_folders,
    samples_preview_start, samples_preview_stop, samples_probe_files, samples_relink_folder,
    samples_remove_folder, samples_resolve, samples_scan_folder,
};
use smart_beat_lib::samples::{FolderKind, SamplesState};
use tauri::Manager;

/// A 440 Hz tone, mono, 16-bit, `seconds` long.
fn tone_wav(seconds: f64) -> Vec<u8> {
    let rate = 22_050u32;
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).unwrap();
        for i in 0..(seconds * f64::from(rate)) as usize {
            let t = i as f64 / f64::from(rate);
            let s = (std::f64::consts::TAU * 440.0 * t).sin() * 12_000.0;
            writer.write_sample(s as i16).unwrap();
        }
        writer.finalize().unwrap();
    }
    cursor.into_inner()
}

fn app(dir: &std::path::Path) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(SamplesState::new(dir.join("samples")));
    app.manage(AudioState::new(dir.join("library")));
    app
}

fn make_folder(dir: &std::path::Path) -> std::path::PathBuf {
    let src = dir.join("My Drums");
    std::fs::create_dir_all(src.join("kits")).unwrap();
    std::fs::write(src.join("kick.wav"), tone_wav(0.4)).unwrap();
    std::fs::write(src.join("kits/snare.wav"), tone_wav(0.6)).unwrap();
    std::fs::write(src.join("notes.txt"), "not audio").unwrap();
    src
}

#[test]
fn a_linked_folder_is_listed_probed_resolved_and_remembered() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let app = app(dir.path());

    let scan = samples_scan_folder(src.to_string_lossy().into_owned()).unwrap();
    assert_eq!((scan.file_count, scan.skipped, scan.subfolders), (2, 1, 1));

    let folder = samples_link_folder(src.to_string_lossy().into_owned(), app.state()).unwrap();
    assert_eq!(folder.kind, FolderKind::Linked);
    assert_eq!(folder.name, "My Drums");
    assert_eq!(folder.file_count, Some(2));
    // Linking the same folder again gives the same entry.
    let again = samples_link_folder(src.to_string_lossy().into_owned(), app.state()).unwrap();
    assert_eq!(again.id, folder.id);
    assert_eq!(samples_list_folders(app.state()).len(), 1);

    let files = samples_list_files(folder.id.clone(), app.state()).unwrap();
    let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
    assert_eq!(rels, ["kick.wav", "kits/snare.wav"]);
    assert!(
        files.iter().all(|f| f.duration_ms.is_none()),
        "not probed yet"
    );

    let probed = samples_probe_files(
        folder.id.clone(),
        files.iter().map(|f| f.rel.clone()).collect(),
        app.state(),
    )
    .unwrap();
    assert!(probed[0].duration_ms.unwrap().abs_diff(400) <= 5);
    assert_eq!(probed[0].peaks.as_ref().unwrap().len(), 96);
    let cached = samples_list_files(folder.id.clone(), app.state()).unwrap();
    assert!(
        cached.iter().all(|f| f.duration_ms.is_some()),
        "read from the index"
    );

    let path = samples_resolve(folder.id.clone(), "kits/snare.wav".into(), app.state()).unwrap();
    // Compare by path components: Windows joins with a backslash.
    assert!(std::path::Path::new(&path).ends_with("kits/snare.wav"));
    for bad in ["../secret.wav", "/etc/passwd", "kits/../../x.wav"] {
        assert!(
            samples_resolve(folder.id.clone(), bad.into(), app.state()).is_err(),
            "{bad}"
        );
    }
    assert!(samples_resolve("../../etc".into(), "x".into(), app.state()).is_err());

    // A second session sees the same folder.
    drop(app);
    let next = self::app(dir.path());
    assert_eq!(samples_list_folders(next.state())[0].id, folder.id);
}

#[test]
fn removing_a_linked_folder_never_deletes_its_files() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let app = app(dir.path());
    let folder = samples_link_folder(src.to_string_lossy().into_owned(), app.state()).unwrap();
    samples_remove_folder(folder.id.clone(), true, app.state()).unwrap();
    assert!(src.join("kick.wav").is_file());
    assert!(samples_list_folders(app.state()).is_empty());
}

#[test]
fn a_missing_linked_folder_can_be_pointed_somewhere_else() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let app = app(dir.path());
    let folder = samples_link_folder(src.to_string_lossy().into_owned(), app.state()).unwrap();
    let moved = dir.path().join("Moved Drums");
    std::fs::rename(&src, &moved).unwrap();
    let list = samples_list_folders(app.state());
    assert!(!list[0].available, "the drive is unplugged");
    assert!(samples_list_files(folder.id.clone(), app.state()).is_err());
    let relinked = samples_relink_folder(
        folder.id.clone(),
        moved.to_string_lossy().into_owned(),
        app.state(),
    )
    .unwrap();
    assert!(relinked.available);
    assert_eq!(samples_list_files(folder.id, app.state()).unwrap().len(), 2);
}

#[test]
fn an_imported_folder_is_an_independent_copy() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let app = app(dir.path());
    let folder = samples_import_folder(
        src.to_string_lossy().into_owned(),
        "job-1".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap();
    assert_eq!(folder.kind, FolderKind::Imported);
    assert_eq!(folder.path, None);
    assert_eq!(folder.file_count, Some(2));
    std::fs::remove_dir_all(&src).unwrap();
    let files = samples_list_files(folder.id.clone(), app.state()).unwrap();
    assert_eq!(files.len(), 2, "the copy outlives the original");
    assert!(samples_resolve(folder.id.clone(), "kick.wav".into(), app.state()).is_ok());
    let copy = dir.path().join("samples").join(&folder.id);
    assert!(copy.join("files/kits/snare.wav").is_file());
    assert!(!copy.join("files/notes.txt").exists());
    samples_remove_folder(folder.id, true, app.state()).unwrap();
    assert!(!copy.exists(), "removing an import deletes the copy");
}

#[test]
fn chosen_files_become_an_imported_folder_of_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let other = dir.path().join("Other");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("kick.wav"), tone_wav(0.3)).unwrap();
    let app = app(dir.path());
    let paths = [
        src.join("kick.wav"),
        src.join("kits/snare.wav"),
        other.join("kick.wav"),
        src.join("notes.txt"),
    ];
    let folder = samples_import_files(
        paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        "  My picks  ".into(),
        "job-files".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap();
    assert_eq!(folder.kind, FolderKind::Imported);
    assert_eq!(folder.name, "My picks");
    assert_eq!(folder.path, None);
    assert_eq!(folder.file_count, Some(3));
    std::fs::remove_dir_all(&src).unwrap();
    let files = samples_list_files(folder.id.clone(), app.state()).unwrap();
    let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
    assert_eq!(rels, ["kick.wav", "kick (2).wav", "snare.wav"]);
    let copy = dir.path().join("samples").join(&folder.id);
    assert!(copy.join("files/snare.wav").is_file());
    assert!(!copy.join("files/notes.txt").exists());
    assert_eq!(samples_list_folders(app.state()).len(), 1);
    samples_remove_folder(folder.id, true, app.state()).unwrap();
    assert!(!copy.exists(), "removing an import deletes the copy");
}

#[test]
fn a_blank_name_gets_a_default_and_a_list_without_audio_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let app = app(dir.path());
    let named = samples_import_files(
        vec![src.join("kick.wav").to_string_lossy().into_owned()],
        "   ".into(),
        "job-files-2".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap();
    assert_eq!(named.name, "Imported samples");

    let err = samples_import_files(
        vec![src.join("notes.txt").to_string_lossy().into_owned()],
        "Nothing".into(),
        "job-files-3".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap_err();
    assert!(err.message.contains("audio"), "{}", err.message);
    assert_eq!(samples_list_folders(app.state()).len(), 1);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("samples"))
        .map(|d| d.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert_eq!(
        leftovers.len(),
        2,
        "the folder and the index, no staging: {leftovers:?}"
    );
}

fn zip_of(path: &std::path::Path, entries: &[(&str, Vec<u8>)]) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn an_archive_is_inspected_then_unpacked_into_a_folder_of_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("Loops Vol 2.zip");
    zip_of(
        &archive,
        &[
            ("Loops/amen.wav", tone_wav(0.5)),
            ("Loops/readme.txt", b"hi".to_vec()),
        ],
    );
    let app = app(dir.path());
    let report = samples_inspect_archive(archive.to_string_lossy().into_owned());
    assert!(report.safe, "{:?}", report.problem);
    assert_eq!((report.audio_files, report.skipped_files), (1, 1));
    let folder = samples_import_archive(
        archive.to_string_lossy().into_owned(),
        "job-2".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap();
    assert_eq!(folder.kind, FolderKind::Archive);
    assert_eq!(folder.name, "Loops Vol 2");
    let files = samples_list_files(folder.id, app.state()).unwrap();
    assert_eq!(files[0].rel, "Loops/amen.wav");
}

#[test]
fn an_unsafe_archive_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("evil.zip");
    zip_of(
        &archive,
        &[
            ("fine.wav", tone_wav(0.2)),
            ("../../../evil.wav", tone_wav(0.2)),
        ],
    );
    let app = app(dir.path());
    let err = samples_import_archive(
        archive.to_string_lossy().into_owned(),
        "job-3".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap_err();
    assert!(err.message.contains("outside"), "{}", err.message);
    assert!(samples_list_folders(app.state()).is_empty());
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("samples"))
        .map(|d| d.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "no staging folder is left: {leftovers:?}"
    );
    assert!(!dir.path().join("evil.wav").exists());
}

#[test]
fn a_failed_import_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(dir.path());
    // Cancelling a job that does not exist is harmless.
    samples_cancel("nothing".into(), app.state());
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    let err = samples_import_folder(
        empty.to_string_lossy().into_owned(),
        "job-4".into(),
        app.handle().clone(),
        app.state(),
    )
    .unwrap_err();
    assert!(err.message.contains("no audio"), "{}", err.message);
    assert!(samples_list_folders(app.state()).is_empty());
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("samples"))
        .map(|d| d.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "no staging folder is left: {leftovers:?}"
    );
}

#[test]
fn previewing_needs_a_running_engine_and_stopping_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let src = make_folder(dir.path());
    let app = app(dir.path());
    let folder = samples_link_folder(src.to_string_lossy().into_owned(), app.state()).unwrap();
    let err = samples_preview_start(
        folder.id,
        "kick.wav".into(),
        0.8,
        app.handle().clone(),
        app.state(),
        app.state(),
    )
    .unwrap_err();
    assert!(err.message.contains("not running"), "{}", err.message);
    samples_preview_stop(app.state(), app.state());
}
