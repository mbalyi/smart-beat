//! Large-file transfers shared by the three providers (stem files, #186): an upload read from
//! disk chunk by chunk, a download streamed to disk, and the rules both follow. A chunk that
//! fails for a network reason is retried, a stop request is honoured between chunks, and a
//! stopped or failed download leaves no partial file.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::{STOPPED, http_error};
use crate::error::{CommandError, ErrorKind};

/// How many times one chunk is sent again after a network failure before the upload fails.
pub const RETRIES: u32 = 2;

/// The pause before a chunk is sent again (none in tests).
const RETRY_PAUSE: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    Duration::from_millis(750)
};

/// The most of an answer's body that is kept (chunk answers are small JSON or empty).
const REPLY_LIMIT: u64 = 1024 * 1024;

/// The error a stopped transfer ends with.
pub fn stopped() -> CommandError {
    CommandError::new(ErrorKind::Io, STOPPED)
}

/// Whether `error` is the one a stopped transfer ends with.
pub fn is_stopped(error: &CommandError) -> bool {
    error.kind == ErrorKind::Io && error.message == STOPPED
}

/// Ends the transfer with [`stopped`] when a stop was asked for.
pub fn check_cancel(cancel: &AtomicBool) -> Result<(), CommandError> {
    if cancel.load(Ordering::Relaxed) {
        Err(stopped())
    } else {
        Ok(())
    }
}

/// An agent for transfers. Statuses are read by the caller (a 308 "resume incomplete" is an
/// answer here, not an error), and a redirect is followed only when `follow_redirects` is set,
/// never with the `Authorization` header (`ureq`'s default, made explicit): a download that the
/// provider hands to another host must not carry the token there. `limit` bounds one request.
pub fn agent(limit: Duration, follow_redirects: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_global(Some(limit))
        .http_status_as_error(false)
        .max_redirects(if follow_redirects { 5 } else { 0 })
        .redirect_auth_headers(ureq::config::RedirectAuthHeaders::Never)
        .build()
        .into()
}

/// How long one chunk request may take.
pub const CHUNK_LIMIT: Duration = Duration::from_secs(10 * 60);
/// How long a whole download may take.
pub const DOWNLOAD_LIMIT: Duration = Duration::from_secs(3 * 60 * 60);

/// A provider's answer to one request: status, headers and the (small) body.
pub struct Reply {
    pub status: u16,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// A status worth sending the same chunk again for.
    pub fn is_transient(&self) -> bool {
        self.status >= 500 || self.status == 408 || self.status == 429
    }

    /// The error for a status that is neither success nor an answer the upload understands:
    /// a network error when it is transient (so the chunk is sent again), otherwise the
    /// provider-independent mapping of `http_error`.
    pub fn into_error(&self, what: &str) -> CommandError {
        if self.is_transient() {
            return CommandError::new(
                ErrorKind::Network,
                format!("The cloud service did not answer well ({}).", self.status),
            );
        }
        http_error(ureq::Error::StatusCode(self.status), what)
    }
}

/// Reads the head of an answer and its (small) body.
pub fn read_reply(mut response: ureq::http::Response<ureq::Body>) -> Result<Reply, CommandError> {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(key, value)| Some((key.as_str().to_owned(), value.to_str().ok()?.to_owned())))
        .collect();
    let body = response
        .body_mut()
        .with_config()
        .limit(REPLY_LIMIT)
        .read_to_vec()
        .map_err(|e| http_error(e, "The file"))?;
    Ok(Reply {
        status,
        headers,
        body,
    })
}

/// Sends `body` with `request` and reads the answer. A request that never got an answer is a
/// network error, as everywhere else.
pub fn send_body(
    request: ureq::RequestBuilder<ureq::typestate::WithBody>,
    body: &[u8],
) -> Result<Reply, CommandError> {
    read_reply(request.send(body).map_err(|e| http_error(e, "The file"))?)
}

/// A file read in pieces from any offset.
pub struct Source {
    file: File,
    total: u64,
}

impl Source {
    pub fn open(path: &Path) -> Result<Self, CommandError> {
        let io = |e: std::io::Error| {
            CommandError::new(
                ErrorKind::Io,
                format!("The file to upload could not be read: {e}"),
            )
        };
        let file = File::open(path).map_err(io)?;
        let total = file.metadata().map_err(io)?.len();
        Ok(Self { file, total })
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    /// Up to `max` bytes from `offset` (fewer at the end of the file).
    pub fn read_at(&mut self, offset: u64, max: usize) -> Result<Vec<u8>, CommandError> {
        let io = |e: std::io::Error| {
            CommandError::new(
                ErrorKind::Io,
                format!("The file to upload could not be read: {e}"),
            )
        };
        let len =
            usize::try_from((self.total.saturating_sub(offset)).min(max as u64)).unwrap_or(max);
        let mut chunk = vec![0u8; len];
        self.file.seek(SeekFrom::Start(offset)).map_err(io)?;
        self.file.read_exact(&mut chunk).map_err(io)?;
        Ok(chunk)
    }
}

/// What the provider said about the chunk it was sent.
pub enum Sent<T> {
    /// The upload goes on from this offset (the first byte the provider does not have yet).
    Continue { next: u64 },
    /// The provider has the whole file; this is what it answered with.
    Done(T),
}

/// Sends a file in chunks of `chunk` bytes. `send(offset, data, total)` sends one chunk and
/// says where the upload stands. When it fails with a network error, `resync(offset, total)` asks
/// the provider what it has (the chunk may have arrived although its answer did not) and the
/// upload goes on from there, up to [`RETRIES`] times in a row. `progress` gets the fraction
/// sent after each chunk, and 1 at the end; `cancel` is checked before every chunk.
pub fn upload_in_chunks<T>(
    source: &mut Source,
    chunk: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
    mut send: impl FnMut(u64, &[u8], u64) -> Result<Sent<T>, CommandError>,
    mut resync: impl FnMut(u64, u64) -> Result<Sent<T>, CommandError>,
) -> Result<T, CommandError> {
    let total = source.total();
    let mut offset = 0u64;
    let mut failures = 0;
    let mut stalls = 0;
    loop {
        check_cancel(cancel)?;
        let data = source.read_at(offset, chunk)?;
        let (sent, resynced) = match send(offset, &data, total) {
            Err(e) if e.kind == ErrorKind::Network && failures < RETRIES => {
                failures += 1;
                std::thread::sleep(RETRY_PAUSE * failures);
                check_cancel(cancel)?;
                match resync(offset, total) {
                    Err(e) if e.kind == ErrorKind::Network => continue,
                    other => (other?, true),
                }
            }
            other => (other?, false),
        };
        match sent {
            Sent::Done(done) => {
                progress(1.0);
                return Ok(done);
            }
            Sent::Continue { next } => {
                if next > total || (next >= total && total > 0) {
                    return Err(CommandError::new(
                        ErrorKind::Network,
                        "The cloud service did not finish the upload.",
                    ));
                }
                if next != offset {
                    failures = 0;
                    stalls = 0;
                } else if !resynced {
                    // An answer that takes nothing in must not loop for ever.
                    stalls += 1;
                    if stalls > RETRIES {
                        return Err(CommandError::new(
                            ErrorKind::Network,
                            "The cloud service did not take the file.",
                        ));
                    }
                }
                offset = next;
                progress(if total == 0 {
                    0.0
                } else {
                    (offset as f64 / total as f64) as f32
                });
            }
        }
    }
}

/// `<dest>.part`, where a download is written before it is renamed to `dest`.
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Streams `reader` into `dest`, going through `<dest>.part` so that no half file is ever at
/// `dest`. `total` is the expected size (0 when unknown) for `progress`. `cancel` is checked
/// before every read. A stop or a failure removes the partial file.
pub fn download_to(
    dest: &Path,
    total: u64,
    reader: &mut dyn Read,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), CommandError> {
    let part = part_path(dest);
    let result = write_part(&part, total, reader, cancel, progress).and_then(|()| {
        // Windows will not rename onto a file that is there.
        let _ = fs::remove_file(dest);
        fs::rename(&part, dest).map_err(|e| {
            CommandError::new(
                ErrorKind::Io,
                format!("The downloaded file could not be put in place: {e}"),
            )
        })
    });
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

fn write_part(
    part: &Path,
    total: u64,
    reader: &mut dyn Read,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), CommandError> {
    let io = |e: std::io::Error| {
        CommandError::new(
            ErrorKind::Io,
            format!("The downloaded file could not be written: {e}"),
        )
    };
    let mut out = File::create(part).map_err(io)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    let mut reported = 0.0f32;
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut buffer).map_err(|e| {
            CommandError::new(
                ErrorKind::Network,
                format!("The download was interrupted: {e}"),
            )
        })?;
        if n == 0 {
            break;
        }
        out.write_all(&buffer[..n]).map_err(io)?;
        written += n as u64;
        if total > 0 {
            let fraction = (written as f64 / total as f64).min(1.0) as f32;
            // About every half percent, so a big file does not send thousands of events.
            if fraction - reported >= 0.005 {
                reported = fraction;
                progress(fraction);
            }
        }
    }
    out.flush().map_err(io)?;
    if total > 0 && written < total {
        return Err(CommandError::new(
            ErrorKind::Network,
            "The download was interrupted: the file is shorter than it should be.",
        ));
    }
    progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn file_with(len: usize) -> (tempfile::TempDir, PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        fs::write(&path, &bytes).unwrap();
        (dir, path, bytes)
    }

    #[test]
    fn a_file_is_read_in_pieces_from_any_offset() {
        let (_dir, path, bytes) = file_with(10);
        let mut source = Source::open(&path).unwrap();
        assert_eq!(source.total(), 10);
        assert_eq!(source.read_at(0, 4).unwrap(), bytes[..4]);
        assert_eq!(source.read_at(8, 4).unwrap(), bytes[8..]);
        assert_eq!(source.read_at(3, 4).unwrap(), bytes[3..7]);
    }

    #[test]
    fn chunks_go_out_in_order_with_progress_up_to_one() {
        let (_dir, path, bytes) = file_with(10);
        let mut source = Source::open(&path).unwrap();
        let seen = RefCell::new(Vec::new());
        let mut fractions = Vec::new();
        let done = upload_in_chunks(
            &mut source,
            4,
            &AtomicBool::new(false),
            &mut |f| fractions.push(f),
            |offset, data, total| {
                assert_eq!(total, 10);
                seen.borrow_mut().extend_from_slice(data);
                let next = offset + data.len() as u64;
                Ok(if next == total {
                    Sent::Done("ok")
                } else {
                    Sent::Continue { next }
                })
            },
            |_, _| unreachable!("nothing failed"),
        )
        .unwrap();
        assert_eq!(done, "ok");
        assert_eq!(*seen.borrow(), bytes);
        assert_eq!(fractions, vec![0.4, 0.8, 1.0]);
    }

    #[test]
    fn a_failed_chunk_asks_where_the_provider_is_and_goes_on_from_there() {
        let (_dir, path, _) = file_with(10);
        let mut source = Source::open(&path).unwrap();
        let mut sends = Vec::new();
        let done = upload_in_chunks(
            &mut source,
            4,
            &AtomicBool::new(false),
            &mut |_| {},
            |offset, data, total| {
                sends.push(offset);
                if sends.len() == 2 {
                    // The chunk arrived, the answer did not.
                    return Err(CommandError::new(ErrorKind::Network, "lost"));
                }
                let next = offset + data.len() as u64;
                Ok(if next == total {
                    Sent::Done(())
                } else {
                    Sent::Continue { next }
                })
            },
            // It has the second chunk already.
            |_, _| Ok(Sent::Continue { next: 8 }),
        );
        assert!(done.is_ok());
        assert_eq!(sends, vec![0, 4, 8]);
    }

    #[test]
    fn a_chunk_that_keeps_failing_ends_the_upload_after_the_retries() {
        let (_dir, path, _) = file_with(10);
        let mut source = Source::open(&path).unwrap();
        let mut attempts = 0;
        let error = upload_in_chunks::<()>(
            &mut source,
            4,
            &AtomicBool::new(false),
            &mut |_| {},
            |_, _, _| {
                attempts += 1;
                Err(CommandError::new(ErrorKind::Network, "down"))
            },
            |offset, _| Ok(Sent::Continue { next: offset }),
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Network);
        assert_eq!(attempts, 1 + RETRIES as usize);
    }

    #[test]
    fn a_stop_between_chunks_ends_with_the_stopped_error() {
        let (_dir, path, _) = file_with(10);
        let mut source = Source::open(&path).unwrap();
        let cancel = AtomicBool::new(false);
        let error = upload_in_chunks::<()>(
            &mut source,
            4,
            &cancel,
            &mut |f| {
                if f > 0.0 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
            |offset, data, _| {
                Ok(Sent::Continue {
                    next: offset + data.len() as u64,
                })
            },
            |_, _| unreachable!(),
        )
        .unwrap_err();
        assert!(is_stopped(&error));
    }

    #[test]
    fn a_download_is_renamed_into_place_with_no_part_file_left() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.sbstems");
        let bytes = vec![7u8; 200_000];
        let mut fractions = Vec::new();
        download_to(
            &dest,
            bytes.len() as u64,
            &mut &bytes[..],
            &AtomicBool::new(false),
            &mut |f| fractions.push(f),
        )
        .unwrap();
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert!(!part_path(&dest).exists());
        assert_eq!(fractions.last(), Some(&1.0));
    }

    #[test]
    fn a_stopped_download_leaves_no_file_and_keeps_an_older_one() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.sbstems");
        fs::write(&dest, b"older").unwrap();
        let cancel = AtomicBool::new(false);
        let bytes = vec![1u8; 500_000];
        let error = download_to(
            &dest,
            bytes.len() as u64,
            &mut &bytes[..],
            &cancel,
            &mut |f| {
                if f > 0.0 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        )
        .unwrap_err();
        assert!(is_stopped(&error));
        assert!(!part_path(&dest).exists());
        assert_eq!(fs::read(&dest).unwrap(), b"older");
    }

    #[test]
    fn a_download_cut_short_is_an_error_and_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.sbstems");
        let error = download_to(
            &dest,
            100,
            &mut &[0u8; 40][..],
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Network);
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }
}
