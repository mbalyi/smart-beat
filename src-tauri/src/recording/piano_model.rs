//! The Transkun piano model files: where they are, whether they are all there, and the one-time
//! download. They are 55 MB, so they stay out of the installer. They are fetched on first use
//! from the Smart Beat release `piano-model-1`, checked against the sizes and SHA-256 sums below,
//! and kept in the app's data folder. Nothing else is ever sent or fetched, and the recording
//! never leaves the computer.
//!
//! The files come from `research/record-to-tab/piano/export_transkun.py` (Transkun 2.0, MIT).

use super::error;
use crate::error::CommandError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Where the files are published.
const BASE_URL: &str = "https://github.com/mbalyi/smart-beat/releases/download/piano-model-1/";
const FOLDER: &str = "models/transkun";
const TIMEOUT: Duration = Duration::from_secs(300);
const PROGRESS_EVENT: &str = "piano-model-download-progress";

/// A file of the model: its name, size in bytes and SHA-256.
pub struct ModelFile {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const FILES: [ModelFile; 3] = [
    ModelFile {
        name: "transkun-net.onnx",
        bytes: 51_395_136,
        sha256: "5f8abad68406dd2576978c6331000a0855a6b89bd2e34e1f36aafd9d6055d7b8",
    },
    ModelFile {
        name: "transkun-heads.onnx",
        bytes: 3_429_097,
        sha256: "60fba89ee774563bc4d56794337d54b5b8f57bf40ae4c8d36c9293a757043cdc",
    },
    ModelFile {
        name: "transkun-front.bin",
        bytes: 1_975_188,
        sha256: "f8119fcaa44ed0675e0af48c5ee61c7ef91d44c2fca34ab633c7e62cf48d1eb0",
    },
];

fn total_bytes() -> u64 {
    FILES.iter().map(|f| f.bytes).sum()
}

/// The folder the model lives in.
pub fn dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| error(format!("Could not find the app's data folder: {e}")))?;
    Ok(base.join(FOLDER))
}

/// All files are there with the right size. The sums were checked when they were downloaded.
pub fn is_installed(dir: &Path) -> bool {
    FILES.iter().all(|file| {
        std::fs::metadata(dir.join(file.name)).is_ok_and(|m| m.is_file() && m.len() == file.bytes)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PianoModelStatus {
    pub installed: bool,
    /// What the download is, in bytes.
    pub bytes: u64,
}

#[tauri::command]
pub fn piano_model_status<R: Runtime>(app: AppHandle<R>) -> Result<PianoModelStatus, CommandError> {
    Ok(PianoModelStatus {
        installed: is_installed(&dir(&app)?),
        bytes: total_bytes(),
    })
}

#[derive(Clone, Copy, Serialize)]
struct Progress {
    fraction: f32,
}

/// Downloads `url` to `dest`, checking size and SHA-256. The file appears under its name only
/// when it is complete and right. `on_bytes` gets the bytes read so far.
pub fn download_file(
    url: &str,
    dest: &Path,
    bytes: u64,
    sha256: &str,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), CommandError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| error(format!("Could not download the piano model: {e}")))?;
    let partial = dest.with_extension("part");
    let result = (|| -> Result<(), CommandError> {
        let io = |e: std::io::Error| error(format!("Could not save the piano model: {e}"));
        let mut file = std::fs::File::create(&partial).map_err(io)?;
        let mut reader = response.body_mut().as_reader();
        let (mut hasher, mut done) = (Sha256::new(), 0u64);
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            let n = reader
                .read(&mut chunk)
                .map_err(|e| error(format!("Could not download the piano model: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&chunk[..n]);
            file.write_all(&chunk[..n]).map_err(io)?;
            done += n as u64;
            if done > bytes {
                break;
            }
            on_bytes(done);
        }
        file.flush().map_err(io)?;
        let sum: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if done != bytes || sum != sha256 {
            return Err(error(
                "The downloaded piano model is not the expected file. Try again later.",
            ));
        }
        std::fs::rename(&partial, dest).map_err(io)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// Downloads the model files that are missing. Emits `piano-model-download-progress`.
#[tauri::command]
pub async fn download_piano_model<R: Runtime>(app: AppHandle<R>) -> Result<(), CommandError> {
    let folder = dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&folder)
            .map_err(|e| error(format!("Could not make a folder for the piano model: {e}")))?;
        let total = total_bytes() as f32;
        let mut before = 0u64;
        let mut last = -1.0f32;
        for file in &FILES {
            let dest = folder.join(file.name);
            let have = std::fs::metadata(&dest).is_ok_and(|m| m.len() == file.bytes);
            if !have {
                let url = format!("{BASE_URL}{}", file.name);
                download_file(&url, &dest, file.bytes, file.sha256, &mut |done| {
                    let fraction = (before + done) as f32 / total;
                    if fraction - last >= 0.01 {
                        last = fraction;
                        let _ = app.emit(PROGRESS_EVENT, Progress { fraction });
                    }
                })?;
            }
            before += file.bytes;
        }
        let _ = app.emit(PROGRESS_EVENT, Progress { fraction: 1.0 });
        Ok(())
    })
    .await
    .map_err(|_| error("Could not download the piano model."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A one-shot HTTP server that answers the next request with `body`.
    fn serve(body: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        });
        format!("http://{address}/file")
    }

    const HELLO: &[u8] = b"hello piano";

    fn sum_of(data: &[u8]) -> String {
        Sha256::digest(data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn the_listed_files_add_up_to_about_55_megabytes() {
        assert_eq!(total_bytes(), 56_799_421);
        assert!(FILES.iter().all(|f| f.sha256.len() == 64));
    }

    #[test]
    fn a_missing_or_short_file_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_installed(dir.path()));
        for file in &FILES {
            std::fs::write(dir.path().join(file.name), vec![0u8; file.bytes as usize]).unwrap();
        }
        assert!(is_installed(dir.path()));
        std::fs::write(dir.path().join(FILES[2].name), b"short").unwrap();
        assert!(!is_installed(dir.path()));
    }

    #[test]
    fn a_good_download_appears_under_its_name_with_progress() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let mut seen = Vec::new();
        download_file(
            &serve(HELLO),
            &dest,
            HELLO.len() as u64,
            &sum_of(HELLO),
            &mut |done| seen.push(done),
        )
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), HELLO);
        assert_eq!(seen.last(), Some(&(HELLO.len() as u64)));
        assert!(!dest.with_extension("part").exists());
    }

    #[test]
    fn a_wrong_sum_or_size_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let wrong = download_file(
            &serve(HELLO),
            &dest,
            HELLO.len() as u64,
            &sum_of(b"something else"),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(wrong.message.contains("not the expected file"));
        let short =
            download_file(&serve(HELLO), &dest, 99, &sum_of(HELLO), &mut |_| {}).unwrap_err();
        assert!(short.message.contains("not the expected file"));
        assert!(!dest.exists() && !dest.with_extension("part").exists());
    }

    #[test]
    fn a_server_that_is_not_there_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let error = download_file(
            "http://127.0.0.1:9/none",
            &dir.path().join("a.bin"),
            1,
            "0",
            &mut |_| {},
        )
        .unwrap_err();
        assert!(
            error
                .message
                .starts_with("Could not download the piano model")
        );
    }
}
