//! What the optional neural model downloads have in common (issue #186): the pinned file table,
//! the record of the user's acceptance and the checked download into the app's data folder.
//! Used by the Open-Unmix download (`umx_model`) and by the SCNet and HTDemucs downloads
//! (`models`). Nothing here knows an address: the caller passes the base URL, and every file is
//! checked against its exact size and SHA-256 before it is kept.

use crate::error::{CommandError, ErrorKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub const TERMS_FILE: &str = "terms.json";
pub const STOPPED: &str = "Download stopped.";

/// One model file: its name at the source, exact size and SHA-256.
#[derive(Debug, Clone, Copy)]
pub struct Spec<'a> {
    pub name: &'a str,
    pub bytes: u64,
    pub sha256: &'a str,
}

pub fn error(kind: ErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::new(kind, message)
}
pub fn io_error(what: &str, e: std::io::Error) -> CommandError {
    error(ErrorKind::Io, format!("{what}: {e}"))
}

/// Every file is there with the right size. The sum was checked when it was downloaded.
pub fn files_present(dir: &Path, files: &[Spec]) -> bool {
    files.iter().all(|f| {
        std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.is_file() && m.len() == f.bytes)
    })
}

/// What the user accepted and when. Only the fixed fields, no free text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terms {
    pub version: u32,
    pub rights_confirmed: bool,
    /// Seconds since the Unix epoch.
    pub accepted_at: u64,
}

/// The saved acceptance, if it is of `version` and confirms the user's rights.
pub fn read_terms(dir: &Path, version: u32) -> Option<Terms> {
    let text = std::fs::read_to_string(dir.join(TERMS_FILE)).ok()?;
    let terms: Terms = serde_json::from_str(&text).ok()?;
    (terms.version == version && terms.rights_confirmed).then_some(terms)
}
pub fn terms_accepted(dir: &Path, version: u32) -> bool {
    read_terms(dir, version).is_some()
}
pub fn require_terms(dir: &Path, version: u32, message: &str) -> Result<(), CommandError> {
    if terms_accepted(dir, version) {
        Ok(())
    } else {
        Err(error(ErrorKind::Io, message))
    }
}
pub fn write_terms(dir: &Path, version: u32) -> Result<(), CommandError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| io_error("Could not make a folder for the model", e))?;
    let terms = Terms {
        version,
        rights_confirmed: true,
        accepted_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    };
    let text = serde_json::to_string(&terms).expect("terms serialize");
    std::fs::write(dir.join(TERMS_FILE), text)
        .map_err(|e| io_error("Could not save your acceptance", e))
}

/// One download at a time, for the whole app.
static DOWNLOADING: Mutex<()> = Mutex::new(());

pub fn sum_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn part_of(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Downloads one file to `dest` through a `.part` file. The file appears under its name only when
/// it has exactly `spec.bytes` bytes and the right SHA-256; a wrong file is deleted. `on_bytes`
/// gets the bytes of this file saved so far. Stopping deletes the `.part` file. `label` names the
/// model in messages ("Open-Unmix", "SCNet").
fn download_file(
    url: &str,
    dest: &Path,
    spec: &Spec,
    label: &str,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let partial = part_of(dest);
    let result = fetch(url, &partial, spec, label, on_bytes, cancelled);
    match result {
        Ok(()) => std::fs::rename(&partial, dest).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            io_error(&format!("Could not save the {label} model"), e)
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

fn fetch(
    url: &str,
    partial: &Path,
    spec: &Spec,
    label: &str,
    on_bytes: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let network = |why: String| {
        error(
            ErrorKind::Network,
            format!("Could not download the {label} model: {why}. Try again."),
        )
    };
    let save = |e: std::io::Error| io_error(&format!("Could not save the {label} model"), e);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(Duration::from_secs(60)))
        .build()
        .into();
    if cancelled() {
        return Err(error(ErrorKind::Io, STOPPED));
    }
    let mut response = agent.get(url).call().map_err(|e| network(e.to_string()))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(network(format!("the server answered {status}")));
    }
    let mut file = std::fs::File::create(partial).map_err(save)?;
    let mut reader = response.body_mut().as_reader();
    let (mut hasher, mut done) = (Sha256::new(), 0u64);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err(error(ErrorKind::Io, STOPPED));
        }
        let n = reader
            .read(&mut chunk)
            .map_err(|e| network(e.to_string()))?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > spec.bytes {
            break;
        }
        hasher.update(&chunk[..n]);
        file.write_all(&chunk[..n]).map_err(save)?;
        on_bytes(done);
    }
    file.flush().map_err(save)?;
    if done != spec.bytes || sum_hex(hasher) != spec.sha256 {
        return Err(error(
            ErrorKind::Io,
            format!(
                "A downloaded {label} file is not the expected file, so it was deleted. Try again later."
            ),
        ));
    }
    Ok(())
}

/// Downloads every file of `files` into `dir` that is not there yet, from `base` + name + `query`.
/// The caller has checked the terms. `on_progress` gets (bytes of the whole download so far,
/// bytes in total). A second call waits for the first.
pub fn download_all(
    dir: &Path,
    base: &str,
    query: &str,
    files: &[Spec],
    label: &str,
    on_progress: &mut dyn FnMut(u64, u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), CommandError> {
    let _only_one = DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir)
        .map_err(|e| io_error("Could not make a folder for the model", e))?;
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    let mut before = 0u64;
    for spec in files {
        let dest = dir.join(spec.name);
        let present = std::fs::metadata(&dest).is_ok_and(|m| m.is_file() && m.len() == spec.bytes);
        if !present {
            let url = format!("{base}{}{query}", spec.name);
            let offset = before;
            download_file(
                &url,
                &dest,
                spec,
                label,
                &mut |done| on_progress(offset + done, total),
                cancelled,
            )?;
        }
        before += spec.bytes;
        on_progress(before, total);
    }
    Ok(())
}

/// Deletes the model files and any part of them. The accepted terms stay on file.
pub fn remove_files(dir: &Path, files: &[Spec]) -> Result<(), CommandError> {
    for spec in files {
        let file = dir.join(spec.name);
        for path in [part_of(&file), file] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_error("Could not delete the model", e)),
            }
        }
    }
    Ok(())
}
