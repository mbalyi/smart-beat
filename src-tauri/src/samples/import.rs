//! Bringing samples into Smart Beat: counting what a folder holds, copying a folder or a
//! handful of chosen files in, and unpacking a zip or 7z archive.
//!
//! An archive is untrusted input. Names that leave the target folder, links, and sizes that
//! do not add up are refused, only audio is written, and everything goes to a temporary folder
//! that is renamed into place when it is complete.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::files::{self, MAX_FILES, is_audio, is_hidden};
use crate::audio::backing::MAX_FILE_BYTES;

/// Most entries an archive may hold.
pub const MAX_ENTRIES: usize = 20_000;
/// Most audio an archive may unpack to.
pub const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// An archive that unpacks to more than this many times its own size is refused.
pub const MAX_RATIO: u64 = 100;
/// The ratio only matters above this size; small archives may compress well.
const RATIO_FLOOR: u64 = 64 * 1024 * 1024;

/// What a dry run over a folder found, for the review step of the dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScan {
    pub file_count: u32,
    pub skipped: u32,
    pub total_bytes: u64,
    pub subfolders: u32,
}

/// What an archive holds, found without writing anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    pub name: String,
    pub size_bytes: u64,
    pub audio_files: u32,
    pub skipped_files: u32,
    pub unpacked_bytes: u64,
    pub safe: bool,
    pub problem: Option<String>,
}

pub fn scan_folder(path: &Path) -> FolderScan {
    let walked = files::walk(path);
    FolderScan {
        file_count: u32::try_from(walked.files.len()).unwrap_or(u32::MAX),
        skipped: walked.skipped,
        total_bytes: walked.total_bytes,
        subfolders: walked.subfolders,
    }
}

/// Why a job stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum Stop {
    Cancelled,
    Failed(String),
}

impl From<io::Error> for Stop {
    fn from(e: io::Error) -> Self {
        Self::Failed(format!("A file could not be written: {e}"))
    }
}

type Progress<'a> = &'a mut dyn FnMut(u64, u64);

/// Copies the audio of `src` (keeping subfolders) into `dest`.
pub fn copy_folder(
    src: &Path,
    dest: &Path,
    cancel: &AtomicBool,
    progress: Progress,
) -> Result<u32, Stop> {
    let walked = files::walk(src);
    if walked.files.is_empty() {
        return Err(Stop::Failed("That folder has no audio files in it.".into()));
    }
    let mut done = 0u64;
    for file in &walked.files {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stop::Cancelled);
        }
        let target = dest.join(&file.rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src.join(&file.rel), &target)?;
        done += file.size;
        progress(done, walked.total_bytes);
    }
    // A cancel that arrived while the last file was being copied.
    if cancel.load(Ordering::Relaxed) {
        return Err(Stop::Cancelled);
    }
    Ok(u32::try_from(walked.files.len()).unwrap_or(u32::MAX))
}

/// One chosen file that will be copied, under the name it gets inside the new folder.
struct Chosen {
    from: PathBuf,
    name: String,
    size: u64,
}

/// A name that is not taken yet (compared without regard to case, as the common file systems
/// do): `kick.wav`, then `kick (2).wav`, `kick (3).wav`.
fn unique_name(name: &str, taken: &mut HashSet<String>) -> String {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map_or_else(|| name.to_owned(), |s| s.to_string_lossy().into_owned());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut candidate = name.to_owned();
    let mut n = 1u32;
    while !taken.insert(candidate.to_lowercase()) {
        n += 1;
        candidate = format!("{stem} ({n}){ext}");
    }
    candidate
}

/// Which of the chosen files can be copied: regular, visible audio files within the size cap
/// (links and folders are left out). Two files with the same name keep both, the second
/// renamed.
fn choose_files(files: &[PathBuf]) -> Vec<Chosen> {
    let mut seen = HashSet::new();
    let mut taken = HashSet::new();
    let mut chosen = Vec::new();
    for file in files {
        if !seen.insert(file.clone()) {
            continue;
        }
        let Some(name) = file.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let Ok(meta) = fs::symlink_metadata(file) else {
            continue;
        };
        if !meta.is_file()
            || is_hidden(&name)
            || !is_audio(file)
            || meta.len() > MAX_FILE_BYTES as u64
        {
            continue;
        }
        chosen.push(Chosen {
            from: file.clone(),
            name: unique_name(&name, &mut taken),
            size: meta.len(),
        });
    }
    chosen
}

/// Copies the audio files in `files` (a flat list the user picked) into `dest`, side by side.
/// Anything that is not a plain audio file is left out.
pub fn copy_files(
    files: &[PathBuf],
    dest: &Path,
    cancel: &AtomicBool,
    progress: Progress,
) -> Result<u32, Stop> {
    if files.len() > MAX_FILES {
        return Err(Stop::Failed("Too many files were chosen at once.".into()));
    }
    if files.is_empty() {
        return Err(Stop::Failed("No files were chosen.".into()));
    }
    let chosen = choose_files(files);
    if chosen.is_empty() {
        return Err(Stop::Failed(
            "None of those files is audio Smart Beat can open.".into(),
        ));
    }
    let total: u64 = chosen.iter().map(|c| c.size).sum();
    let mut done = 0u64;
    for file in &chosen {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stop::Cancelled);
        }
        fs::copy(&file.from, dest.join(&file.name))?;
        done += file.size;
        progress(done, total);
    }
    // A cancel that arrived while the last file was being copied.
    if cancel.load(Ordering::Relaxed) {
        return Err(Stop::Cancelled);
    }
    Ok(u32::try_from(chosen.len()).unwrap_or(u32::MAX))
}

/// An archive name made safe: forward slashes, no empty, `.` or `..` parts, no drive or root.
/// `Err` means the name tries to leave the folder.
fn clean_name(name: &str) -> Result<Vec<String>, ()> {
    if name.contains('\0') {
        return Err(());
    }
    let name = name.replace('\\', "/");
    if name.starts_with('/') {
        return Err(());
    }
    let mut parts = Vec::new();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(()),
            p if p.len() >= 2
                && p.as_bytes()[1] == b':'
                && p.as_bytes()[0].is_ascii_alphabetic() =>
            {
                return Err(());
            }
            p => parts.push(p.to_owned()),
        }
    }
    Ok(parts)
}

/// One entry of an archive, before anything is written.
#[derive(Debug, Clone)]
struct Listed {
    name: String,
    size: u64,
    is_dir: bool,
    is_symlink: bool,
}

/// What would be unpacked.
#[derive(Debug, Default)]
struct Plan {
    audio: u32,
    skipped: u32,
    unpacked: u64,
    problem: Option<String>,
}

fn is_link_mode(mode: u32) -> bool {
    mode & 0o170_000 == 0o120_000
}

/// Whether the entry's name says it is junk to leave out (hidden, or a macOS resource fork).
fn is_junk(parts: &[String]) -> bool {
    parts
        .iter()
        .any(|p| is_hidden(p) || p.eq_ignore_ascii_case("__MACOSX"))
}

/// Decides which entries are audio to write, and whether the archive is safe at all.
fn plan(entries: &[Listed], archive_size: u64) -> Plan {
    let mut plan = Plan::default();
    let problem = |plan: &mut Plan, text: &str| {
        plan.problem.get_or_insert_with(|| text.to_owned());
    };
    if entries.len() > MAX_ENTRIES {
        problem(
            &mut plan,
            "The archive holds too many files to unpack safely.",
        );
        return plan;
    }
    for entry in entries {
        let Ok(parts) = clean_name(&entry.name) else {
            problem(
                &mut plan,
                "The archive has paths that point outside the target folder.",
            );
            continue;
        };
        if entry.is_symlink {
            problem(
                &mut plan,
                "The archive contains links, which are not unpacked.",
            );
            continue;
        }
        if entry.is_dir {
            continue;
        }
        let audio = parts.last().is_some_and(|p| is_audio(Path::new(p)));
        if is_junk(&parts) || !audio {
            plan.skipped += 1;
            continue;
        }
        if entry.size > MAX_FILE_BYTES as u64 {
            problem(&mut plan, "A file in the archive is too large.");
            continue;
        }
        plan.audio += 1;
        plan.unpacked += entry.size;
    }
    if plan.unpacked > MAX_UNPACKED_BYTES {
        problem(&mut plan, "The archive unpacks to more than 4 GB.");
    }
    if plan.unpacked > RATIO_FLOOR && plan.unpacked / archive_size.max(1) > MAX_RATIO {
        problem(&mut plan, "The archive unpacks to far more than its size.");
    }
    if plan.problem.is_none() && plan.audio == 0 {
        plan.problem = Some("The archive has no audio files in it.".into());
    }
    plan
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Zip,
    SevenZip,
}

fn kind_of(path: &Path) -> Option<Kind> {
    match files::extension_of(path)?.as_str() {
        "zip" => Some(Kind::Zip),
        "7z" => Some(Kind::SevenZip),
        _ => None,
    }
}

fn list_archive(path: &Path, kind: Kind) -> Result<Vec<Listed>, String> {
    let unreadable = |e: &dyn std::fmt::Display| format!("The archive cannot be read: {e}");
    let file = fs::File::open(path).map_err(|e| unreadable(&e))?;
    match kind {
        Kind::Zip => {
            let mut zip = zip::ZipArchive::new(file).map_err(|e| unreadable(&e))?;
            if zip.len() > MAX_ENTRIES {
                return Err("The archive holds too many files to unpack safely.".into());
            }
            let mut out = Vec::with_capacity(zip.len());
            for i in 0..zip.len() {
                let entry = zip.by_index_raw(i).map_err(|e| unreadable(&e))?;
                out.push(Listed {
                    name: entry.name().map(|n| n.into_owned()).unwrap_or_default(),
                    size: entry.size(),
                    is_dir: entry.is_dir(),
                    is_symlink: entry.is_symlink() || entry.unix_mode().is_some_and(is_link_mode),
                });
            }
            Ok(out)
        }
        Kind::SevenZip => {
            let reader = sevenz_rust2::ArchiveReader::new(file, sevenz_rust2::Password::empty())
                .map_err(|e| unreadable(&e))?;
            Ok(reader
                .archive()
                .files
                .iter()
                .map(|e| {
                    let attrs = e.windows_attributes();
                    Listed {
                        name: e.name().to_owned(),
                        size: e.size(),
                        is_dir: e.is_directory(),
                        // The high half holds Unix permissions when bit 15 is set.
                        is_symlink: attrs & 0x8000 != 0 && is_link_mode(attrs >> 16),
                    }
                })
                .collect())
        }
    }
}

/// Looks inside an archive without writing anything.
pub fn inspect_archive(path: &Path) -> ArchiveReport {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let size_bytes = fs::metadata(path).map_or(0, |m| m.len());
    let refused = |problem: String| ArchiveReport {
        name: name.clone(),
        size_bytes,
        audio_files: 0,
        skipped_files: 0,
        unpacked_bytes: 0,
        safe: false,
        problem: Some(problem),
    };
    let Some(kind) = kind_of(path) else {
        return refused("Choose a .zip or .7z archive.".into());
    };
    let listed = match list_archive(path, kind) {
        Ok(listed) => listed,
        Err(problem) => return refused(problem),
    };
    let plan = plan(&listed, size_bytes);
    ArchiveReport {
        name,
        size_bytes,
        audio_files: plan.audio,
        skipped_files: plan.skipped,
        unpacked_bytes: plan.unpacked,
        safe: plan.problem.is_none(),
        problem: plan.problem,
    }
}

/// Writes one archive entry, counting what really arrives (a header can lie about its size).
fn write_entry(
    reader: &mut dyn Read,
    target: &Path,
    written: &mut u64,
    total: u64,
    cancel: &AtomicBool,
    progress: Progress,
) -> Result<(), Stop> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = fs::File::create(target)?;
    let mut reader = reader.take(MAX_FILE_BYTES as u64 + 1);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut file_bytes = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stop::Cancelled);
        }
        let n = reader
            .read(&mut buffer)
            .map_err(|e| Stop::Failed(format!("The archive is damaged: {e}")))?;
        if n == 0 {
            break;
        }
        file_bytes += n as u64;
        *written += n as u64;
        if file_bytes > MAX_FILE_BYTES as u64 || *written > MAX_UNPACKED_BYTES {
            return Err(Stop::Failed(
                "The archive holds more data than it says.".into(),
            ));
        }
        out.write_all(&buffer[..n])?;
        progress(*written, total);
    }
    out.flush()?;
    Ok(())
}

/// Unpacks the audio of the archive at `path` into `dest`. Nothing is written when the
/// archive is not safe.
pub fn unpack_archive(
    path: &Path,
    dest: &Path,
    cancel: &AtomicBool,
    progress: Progress,
) -> Result<u32, Stop> {
    let kind = kind_of(path).ok_or_else(|| Stop::Failed("Choose a .zip or .7z archive.".into()))?;
    let size = fs::metadata(path)?.len();
    let listed = list_archive(path, kind).map_err(Stop::Failed)?;
    let planned = plan(&listed, size);
    if let Some(problem) = planned.problem {
        return Err(Stop::Failed(problem));
    }
    let total = planned.unpacked;
    let mut written = 0u64;
    let mut count = 0u32;
    // The target of an entry, when it is audio to write.
    let target_of = |name: &str| -> Option<PathBuf> {
        let parts = clean_name(name).ok()?;
        if is_junk(&parts) || !parts.last().is_some_and(|p| is_audio(Path::new(p))) {
            return None;
        }
        Some(
            parts
                .iter()
                .fold(dest.to_path_buf(), |p, part| p.join(part)),
        )
    };
    let file = fs::File::open(path)?;
    match kind {
        Kind::Zip => {
            let mut zip = zip::ZipArchive::new(file)
                .map_err(|e| Stop::Failed(format!("The archive cannot be read: {e}")))?;
            for i in 0..zip.len() {
                let mut entry = zip
                    .by_index(i)
                    .map_err(|e| Stop::Failed(format!("The archive cannot be read: {e}")))?;
                if entry.is_dir() {
                    continue;
                }
                let name = entry.name().map(|n| n.into_owned()).unwrap_or_default();
                let Some(target) = target_of(&name) else {
                    continue;
                };
                write_entry(&mut entry, &target, &mut written, total, cancel, progress)?;
                count += 1;
            }
        }
        Kind::SevenZip => {
            let mut reader =
                sevenz_rust2::ArchiveReader::new(file, sevenz_rust2::Password::empty())
                    .map_err(|e| Stop::Failed(format!("The archive cannot be read: {e}")))?;
            let mut stopped: Option<Stop> = None;
            reader
                .for_each_entries(|entry, data| {
                    if entry.is_directory() {
                        return Ok(true);
                    }
                    let Some(target) = target_of(entry.name()) else {
                        return Ok(true);
                    };
                    match write_entry(data, &target, &mut written, total, cancel, progress) {
                        Ok(()) => {
                            count += 1;
                            Ok(true)
                        }
                        Err(stop) => {
                            stopped = Some(stop);
                            Ok(false)
                        }
                    }
                })
                .map_err(|e| Stop::Failed(format!("The archive is damaged: {e}")))?;
            if let Some(stop) = stopped {
                return Err(stop);
            }
        }
    }
    if count == 0 {
        return Err(Stop::Failed("The archive has no audio files in it.".into()));
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::super::files::test_support::*;
    use super::*;
    use zip::write::SimpleFileOptions;

    fn zip_with(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let file = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        file
    }

    fn idle() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn unpack(file: &Path, dest: &Path) -> Result<u32, Stop> {
        unpack_archive(file, dest, &idle(), &mut |_, _| {})
    }

    #[test]
    fn names_that_leave_the_folder_are_refused() {
        for bad in [
            "../evil.wav",
            "a/../../evil.wav",
            "/etc/evil.wav",
            "C:\\evil.wav",
            "c:/evil.wav",
            "a\\..\\..\\evil.wav",
            "nul\0.wav",
        ] {
            assert!(clean_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(clean_name("a/./b//c.wav").unwrap(), ["a", "b", "c.wav"]);
        assert_eq!(clean_name("kits\\kick.wav").unwrap(), ["kits", "kick.wav"]);
    }

    #[test]
    fn a_zip_unpacks_audio_only_and_keeps_subfolders() {
        let tone = tone_wav(0.3, 22_050);
        let file = zip_with(&[
            ("Pack/kick.wav", &tone),
            ("Pack/deep/snare.wav", &tone),
            ("Pack/readme.txt", b"hello"),
            ("__MACOSX/Pack/._kick.wav", b"junk"),
            ("Pack/.hidden.wav", &tone),
            ("Pack/nested.zip", b"PK"),
        ]);
        let report = inspect_archive(file.path());
        assert!(report.safe, "{:?}", report.problem);
        assert_eq!((report.audio_files, report.skipped_files), (2, 4));
        let dest = tempfile::tempdir().unwrap();
        assert_eq!(unpack(file.path(), dest.path()).unwrap(), 2);
        assert!(dest.path().join("Pack/kick.wav").is_file());
        assert!(dest.path().join("Pack/deep/snare.wav").is_file());
        assert!(!dest.path().join("Pack/readme.txt").exists());
        assert!(
            !dest.path().join("Pack/nested.zip").exists(),
            "no nested archives"
        );
    }

    #[test]
    fn a_zip_slip_archive_writes_nothing() {
        let tone = tone_wav(0.3, 22_050);
        let file = zip_with(&[("ok.wav", &tone), ("../../evil.wav", &tone)]);
        assert!(!inspect_archive(file.path()).safe);
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("a/b");
        fs::create_dir_all(&dest).unwrap();
        assert!(matches!(unpack(file.path(), &dest), Err(Stop::Failed(_))));
        assert!(!base.path().join("evil.wav").exists());
        assert!(
            fs::read_dir(&dest).unwrap().next().is_none(),
            "even the harmless file waits for a safe archive"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_entry_makes_the_archive_unsafe() {
        let file = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
        zip.add_symlink("link.wav", "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        let report = inspect_archive(file.path());
        assert!(!report.safe);
        assert!(report.problem.unwrap().contains("links"));
    }

    fn entry(name: &str, size: u64) -> Listed {
        Listed {
            name: name.into(),
            size,
            is_dir: false,
            is_symlink: false,
        }
    }

    #[test]
    fn too_many_entries_and_oversized_totals_are_refused() {
        let many: Vec<Listed> = (0..=MAX_ENTRIES)
            .map(|i| entry(&format!("{i}.wav"), 1))
            .collect();
        assert!(plan(&many, 1_000_000).problem.is_some());
        let big = [
            entry("a.wav", 400 * 1024 * 1024),
            entry("b.wav", 400 * 1024 * 1024),
        ];
        assert!(
            plan(&big, 1024 * 1024)
                .problem
                .unwrap()
                .contains("far more"),
            "800 MB from a 1 MB archive is a bomb"
        );
        assert!(plan(&big, 600 * 1024 * 1024).problem.is_none());
        let huge: Vec<Listed> = (0..9)
            .map(|i| entry(&format!("{i}.wav"), MAX_FILE_BYTES as u64))
            .collect();
        assert!(plan(&huge, u64::MAX).problem.unwrap().contains("4 GB"));
    }

    #[test]
    fn an_archive_without_audio_or_of_another_type_is_not_accepted() {
        let file = zip_with(&[("readme.txt", b"hi")]);
        assert!(
            inspect_archive(file.path())
                .problem
                .unwrap()
                .contains("no audio")
        );
        let other = tempfile::Builder::new().suffix(".rar").tempfile().unwrap();
        assert!(!inspect_archive(other.path()).safe);
        let junk = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        fs::write(junk.path(), b"this is not a zip").unwrap();
        assert!(!inspect_archive(junk.path()).safe);
    }

    #[test]
    fn unpacking_can_be_cancelled() {
        let tone = tone_wav(0.3, 22_050);
        let file = zip_with(&[("a.wav", &tone), ("b.wav", &tone)]);
        let dest = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(true);
        let result = unpack_archive(file.path(), dest.path(), &cancel, &mut |_, _| {});
        assert_eq!(result, Err(Stop::Cancelled));
    }

    #[test]
    fn progress_reaches_the_total() {
        let tone = tone_wav(0.5, 22_050);
        let file = zip_with(&[("a.wav", &tone)]);
        let dest = tempfile::tempdir().unwrap();
        let mut last = (0, 0);
        unpack_archive(file.path(), dest.path(), &idle(), &mut |d, t| last = (d, t)).unwrap();
        assert_eq!(last.0, last.1);
        assert!(last.1 > 0);
    }

    #[test]
    fn a_folder_is_copied_with_its_subfolders_and_only_its_audio() {
        let src = tempfile::tempdir().unwrap();
        write_tone(src.path(), "kick.wav", 0.2);
        write_tone(src.path(), "kits/snare.wav", 0.2);
        fs::write(src.path().join("notes.txt"), "x").unwrap();
        let scan = scan_folder(src.path());
        assert_eq!((scan.file_count, scan.skipped, scan.subfolders), (2, 1, 1));
        let dest = tempfile::tempdir().unwrap();
        let mut last = (0, 0);
        let n = copy_folder(src.path(), dest.path(), &idle(), &mut |d, t| last = (d, t)).unwrap();
        assert_eq!(n, 2);
        assert!(dest.path().join("kits/snare.wav").is_file());
        assert!(!dest.path().join("notes.txt").exists());
        assert_eq!(last.0, last.1);
    }

    #[test]
    fn copying_an_empty_folder_says_so_and_can_be_cancelled() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        assert!(matches!(
            copy_folder(src.path(), dest.path(), &idle(), &mut |_, _| {}),
            Err(Stop::Failed(_))
        ));
        write_tone(src.path(), "a.wav", 0.2);
        let cancel = AtomicBool::new(true);
        assert_eq!(
            copy_folder(src.path(), dest.path(), &cancel, &mut |_, _| {}),
            Err(Stop::Cancelled)
        );
    }

    #[test]
    fn a_cancel_during_the_last_file_still_cancels_the_copy() {
        let src = tempfile::tempdir().unwrap();
        write_tone(src.path(), "only.wav", 0.2);
        let dest = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        // The flag is raised while the single file is being copied, as the report comes in.
        let result = copy_folder(src.path(), dest.path(), &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed);
        });
        assert_eq!(result, Err(Stop::Cancelled));
    }

    fn files_in(dir: &Path, names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|n| {
                write_tone(dir, n, 0.2);
                dir.join(n)
            })
            .collect()
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn chosen_files_are_copied_flat_and_only_audio_is_kept() {
        let src = tempfile::tempdir().unwrap();
        let mut files = files_in(src.path(), &["kick.wav", "deep/snare.wav"]);
        fs::write(src.path().join("notes.txt"), "x").unwrap();
        fs::write(src.path().join(".hidden.wav"), "x").unwrap();
        fs::create_dir(src.path().join("folder.wav")).unwrap();
        files.push(src.path().join("notes.txt"));
        files.push(src.path().join(".hidden.wav"));
        files.push(src.path().join("folder.wav"));
        files.push(src.path().join("missing.wav"));
        let dest = tempfile::tempdir().unwrap();
        let mut last = (0, 0);
        let n = copy_files(&files, dest.path(), &idle(), &mut |d, t| last = (d, t)).unwrap();
        assert_eq!(n, 2);
        assert_eq!(names_in(dest.path()), ["kick.wav", "snare.wav"]);
        assert_eq!(last.0, last.1);
        assert!(last.1 > 0);
    }

    #[test]
    fn files_with_the_same_name_keep_both_and_a_repeated_path_counts_once() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = files_in(a.path(), &["kick.wav", "Snare.WAV"]);
        let second = files_in(b.path(), &["kick.wav", "snare.wav"]);
        let files = vec![
            first[0].clone(),
            second[0].clone(),
            first[1].clone(),
            second[1].clone(),
            first[0].clone(),
        ];
        let dest = tempfile::tempdir().unwrap();
        assert_eq!(
            copy_files(&files, dest.path(), &idle(), &mut |_, _| {}).unwrap(),
            4
        );
        assert_eq!(
            names_in(dest.path()),
            ["Snare.WAV", "kick (2).wav", "kick.wav", "snare (2).wav"]
        );
    }

    #[test]
    fn a_name_cannot_carry_a_path_into_the_folder() {
        let src = tempfile::tempdir().unwrap();
        let files = files_in(src.path(), &["a.wav"]);
        let dest = tempfile::tempdir().unwrap();
        copy_files(&files, dest.path(), &idle(), &mut |_, _| {}).unwrap();
        for name in names_in(dest.path()) {
            assert!(!name.contains(['/', '\\']), "{name}");
        }
        // A path ending in `..` has no file name, so nothing is chosen from it.
        let up = vec![src.path().join("..")];
        assert!(matches!(
            copy_files(&up, dest.path(), &idle(), &mut |_, _| {}),
            Err(Stop::Failed(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_is_not_copied() {
        let src = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let real = files_in(outside.path(), &["secret.wav"]);
        let link = src.path().join("link.wav");
        std::os::unix::fs::symlink(&real[0], &link).unwrap();
        let dest = tempfile::tempdir().unwrap();
        assert!(matches!(
            copy_files(&[link], dest.path(), &idle(), &mut |_, _| {}),
            Err(Stop::Failed(_))
        ));
        assert!(names_in(dest.path()).is_empty());
    }

    #[test]
    fn an_empty_or_unsupported_list_says_so_and_writes_nothing() {
        let src = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let Err(Stop::Failed(none)) = copy_files(&[], dest.path(), &idle(), &mut |_, _| {}) else {
            panic!("an empty list is refused");
        };
        assert!(none.contains("No files"), "{none}");
        fs::write(src.path().join("notes.txt"), "x").unwrap();
        fs::write(src.path().join("pack.zip"), "x").unwrap();
        let other = [src.path().join("notes.txt"), src.path().join("pack.zip")];
        let Err(Stop::Failed(text)) = copy_files(&other, dest.path(), &idle(), &mut |_, _| {})
        else {
            panic!("unsupported files are refused");
        };
        assert!(text.contains("audio"), "{text}");
        assert!(names_in(dest.path()).is_empty());
    }

    #[test]
    fn copying_files_can_be_cancelled_before_between_and_after_the_last_one() {
        let src = tempfile::tempdir().unwrap();
        let files = files_in(src.path(), &["a.wav", "b.wav", "c.wav"]);
        // Before the first file.
        let dest = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(true);
        assert_eq!(
            copy_files(&files, dest.path(), &cancel, &mut |_, _| {}),
            Err(Stop::Cancelled)
        );
        assert!(names_in(dest.path()).is_empty());
        // Between two files: raised after the first has been reported.
        let dest = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let result = copy_files(&files, dest.path(), &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed);
        });
        assert_eq!(result, Err(Stop::Cancelled));
        assert_eq!(names_in(dest.path()), ["a.wav"], "the rest were not copied");
        // While the last (only) file is copied.
        let dest = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let result = copy_files(&files[..1], dest.path(), &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed);
        });
        assert_eq!(result, Err(Stop::Cancelled));
    }
}
