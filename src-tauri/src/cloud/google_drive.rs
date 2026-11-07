//! Google Drive over the REST API v3 with the `drive.file` scope only: Smart Beat sees just the
//! files the user opened or created with it (#187).

use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde::Deserialize;

use super::oauth::OAuthConfig;
use super::transfer::{self, Reply, Sent, Source};
use super::{
    Provider, ProviderKind, RemoteFile, ShareLevel, agent, encode, http_error, share_http_error,
};
use crate::error::{CommandError, ErrorKind};
use crate::score_file::{MAX_SIZE, ScoreFormat, has_supported_extension};

/// OAuth client id baked in at build time; `None` hides the Google Drive option.
pub const CLIENT_ID: Option<&str> = option_env!("SMARTBEAT_GOOGLE_CLIENT_ID");
/// Google's Desktop app clients have a secret that the token endpoint asks for even with PKCE.
/// It is not confidential for an installed app (Google says so), but it is still read at build
/// time and never committed.
pub const CLIENT_SECRET: Option<&str> = option_env!("SMARTBEAT_GOOGLE_CLIENT_SECRET");

/// The only scope requested: files created or opened by this app.
pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

const FIELDS: &str = "id,name,size,modifiedTime,headRevisionId";

/// The size of one piece of a resumable upload: a multiple of 256 KiB, as Drive asks.
const UPLOAD_CHUNK: usize = 32 * 256 * 1024;

pub fn oauth_config(client_id: &str) -> OAuthConfig {
    OAuthConfig {
        client_id: client_id.to_owned(),
        redirect_ports: Vec::new(),
        redirect_host: "127.0.0.1".into(),
        client_secret: CLIENT_SECRET
            .filter(|secret| !secret.trim().is_empty())
            .map(str::to_owned),
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
        token_url: "https://oauth2.googleapis.com/token".into(),
        scopes: vec![SCOPE.into()],
        extra_auth_params: vec![
            ("access_type".into(), "offline".into()),
            ("prompt".into(), "select_account consent".into()),
        ],
    }
}

pub struct GoogleDrive {
    api_base: String,
    upload_base: String,
    about_base: String,
    revoke_url: String,
    chunk_size: usize,
}

impl Default for GoogleDrive {
    fn default() -> Self {
        Self {
            api_base: "https://www.googleapis.com/drive/v3".into(),
            upload_base: "https://www.googleapis.com/upload/drive/v3".into(),
            about_base: "https://www.googleapis.com/drive/v3/about".into(),
            revoke_url: "https://oauth2.googleapis.com/revoke".into(),
            chunk_size: UPLOAD_CHUNK,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    name: String,
    size: Option<String>,
    modified_time: Option<String>,
    head_revision_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedFile {
    web_view_link: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    #[serde(default)]
    files: Vec<DriveFile>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct About {
    user: Option<AboutUser>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AboutUser {
    display_name: Option<String>,
    email_address: Option<String>,
}

impl From<DriveFile> for RemoteFile {
    fn from(f: DriveFile) -> Self {
        RemoteFile {
            id: f.id,
            name: f.name,
            revision: f.head_revision_id.unwrap_or_default(),
            size: f.size.and_then(|s| s.parse().ok()).unwrap_or(0),
            modified_ms: f
                .modified_time
                .as_deref()
                .and_then(parse_rfc3339_ms)
                .unwrap_or(0),
        }
    }
}

/// `2024-05-01T12:30:45.123Z` (or with a `+hh:mm` offset) to milliseconds since the Unix epoch.
fn parse_rfc3339_ms(text: &str) -> Option<u64> {
    let (date, time) = text.split_once(['T', 't'])?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let split = time.find(['Z', 'z', '+', '-']).unwrap_or(time.len());
    let (clock, zone) = time.split_at(split);
    let mut c = clock.split(':');
    let h: i64 = c.next()?.parse().ok()?;
    let min: i64 = c.next()?.parse().ok()?;
    let sec_text = c.next().unwrap_or("0");
    let (sec, frac) = sec_text.split_once('.').unwrap_or((sec_text, ""));
    let sec: i64 = sec.parse().ok()?;
    let millis: i64 = format!("{frac:0<3}")[..3].parse().ok()?;
    let offset = match zone.as_bytes().first() {
        Some(&sign @ (b'+' | b'-')) => {
            let (oh, om) = zone[1..].split_once(':')?;
            let secs = oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60;
            if sign == b'+' { secs } else { -secs }
        }
        _ => 0,
    };
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = (days * 86_400 + h * 3600 + min * 60 + sec - offset) * 1000 + millis;
    u64::try_from(total).ok()
}

/// Same rules as the local reader: the content has to fit the extension.
fn validate(name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    if bytes.len() as u64 > MAX_SIZE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("“{name}” is too large to open."),
        ));
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let head = &bytes[..bytes.len().min(4096)];
    let ok = match extension.as_str() {
        "atex" | "txt" => !bytes.is_empty() && !head.contains(&0),
        "mscx" => head.trim_ascii_start().starts_with(b"<") && contains(head, b"<museScore"),
        "mscz" | "capx" | "mxl" => bytes.starts_with(b"PK\x03\x04"),
        _ => ScoreFormat::detect(bytes).is_some(),
    };
    if ok {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorKind::NotAScore,
            format!("“{name}” is not a tab file Smart Beat can open."),
        ))
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn parse_error(e: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorKind::Network,
        format!("Unexpected answer from Google Drive: {e}"),
    )
}

impl GoogleDrive {
    /// A provider whose every endpoint lives under `base` (tests).
    pub fn with_base(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        Self {
            api_base: format!("{base}/drive/v3"),
            upload_base: format!("{base}/upload/drive/v3"),
            about_base: format!("{base}/drive/v3/about"),
            revoke_url: format!("{base}/revoke"),
            chunk_size: UPLOAD_CHUNK,
        }
    }

    /// Smaller pieces for a resumable upload, so a test needs only a few bytes.
    #[cfg(test)]
    fn with_chunk_size(mut self, chunk_size: usize) -> Self {
        self.chunk_size = chunk_size;
        self
    }

    /// Starts a resumable upload of `total` bytes called `name`; the answer's `Location` is the
    /// session address, which carries its own authorization.
    fn start_session(&self, token: &str, name: &str, total: u64) -> Result<String, CommandError> {
        let url = format!(
            "{}/files?uploadType=resumable&fields={}",
            self.upload_base,
            encode(FIELDS)
        );
        let request = transfer::agent(transfer::CHUNK_LIMIT, false)
            .post(&url)
            .header("Authorization", bearer(token))
            .header("Content-Type", "application/json; charset=UTF-8")
            .header("X-Upload-Content-Type", "application/octet-stream")
            .header("X-Upload-Content-Length", total.to_string());
        let body = serde_json::json!({ "name": name }).to_string();
        let reply = transfer::send_body(request, body.as_bytes())?;
        if !reply.is_success() {
            return Err(reply.into_error("The file"));
        }
        reply.header("location").map(str::to_owned).ok_or_else(|| {
            CommandError::new(
                ErrorKind::Network,
                "Unexpected answer from Google Drive: no upload address.",
            )
        })
    }

    /// One piece of the upload. With no `data` it asks what the session has instead
    /// (`Content-Range: bytes */total`).
    fn put_chunk(
        &self,
        session: &str,
        offset: u64,
        data: &[u8],
        total: u64,
    ) -> Result<Sent<DriveFile>, CommandError> {
        let range = if data.is_empty() {
            format!("bytes */{total}")
        } else {
            format!("bytes {offset}-{}/{total}", offset + data.len() as u64 - 1)
        };
        // The session address carries its own authorization: no bearer token here.
        let request = transfer::agent(transfer::CHUNK_LIMIT, false)
            .put(session)
            .header("Content-Range", range)
            .header("Content-Type", "application/octet-stream");
        let reply = transfer::send_body(request, data)?;
        match reply.status {
            200 | 201 => {
                let file: DriveFile = serde_json::from_slice(&reply.body).map_err(parse_error)?;
                Ok(Sent::Done(file))
            }
            // Resume incomplete: `Range: bytes=0-N` is what Drive has (nothing without it).
            308 => Ok(Sent::Continue {
                next: received_up_to(&reply),
            }),
            _ => Err(reply.into_error("The file")),
        }
    }

    /// Ends a resumable upload that was stopped (best effort: the session would expire anyway).
    fn cancel_session(&self, session: &str) {
        let _ = transfer::agent(std::time::Duration::from_secs(30), false)
            .delete(session)
            .call();
    }
}

/// How many bytes a 308 answer says Drive has: the end of `Range: bytes=0-N`, plus one.
fn received_up_to(reply: &Reply) -> u64 {
    reply
        .header("range")
        .and_then(|range| range.rsplit('-').next())
        .and_then(|end| end.trim().parse::<u64>().ok())
        .map_or(0, |end| end + 1)
}

impl GoogleDrive {
    fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        url: &str,
        what: &str,
    ) -> Result<T, CommandError> {
        let mut response = agent()
            .get(url)
            .header("Authorization", bearer(token))
            .call()
            .map_err(|e| http_error(e, what))?;
        response.body_mut().read_json().map_err(parse_error)
    }

    /// The file's metadata and the ETag of that exact version (for `If-Match`).
    fn metadata_with_etag(
        &self,
        token: &str,
        id: &str,
    ) -> Result<(RemoteFile, Option<String>), CommandError> {
        let url = format!("{}?fields={}", self.file_url(id), encode(FIELDS));
        let mut response = agent()
            .get(&url)
            .header("Authorization", bearer(token))
            .call()
            .map_err(|e| http_error(e, "The file"))?;
        let etag = response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let file: DriveFile = response.body_mut().read_json().map_err(parse_error)?;
        Ok((file.into(), etag))
    }

    fn file_url(&self, id: &str) -> String {
        format!("{}/files/{}", self.api_base, encode(id))
    }
}

impl Provider for GoogleDrive {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Drive
    }

    fn account_name(&self, token: &str) -> Result<String, CommandError> {
        let url = format!(
            "{}?fields={}",
            self.about_base,
            encode("user(displayName,emailAddress)")
        );
        let about: About = self.get_json(token, &url, "The account")?;
        let user = about.user;
        Ok(user
            .as_ref()
            .and_then(|u| u.email_address.clone().or_else(|| u.display_name.clone()))
            .unwrap_or_else(|| "Google Drive".into()))
    }

    fn list(&self, token: &str) -> Result<Vec<RemoteFile>, CommandError> {
        let query = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = format!(
                "{}/files?q={}&orderBy={}&pageSize=1000&fields={}",
                self.api_base,
                encode(query),
                encode("modifiedTime desc"),
                encode(&format!("nextPageToken,files({FIELDS})")),
            );
            if let Some(p) = &page {
                url.push_str(&format!("&pageToken={}", encode(p)));
            }
            let list: FileList = self.get_json(token, &url, "The file list")?;
            out.extend(
                list.files
                    .into_iter()
                    .filter(|f| {
                        has_supported_extension(Path::new(&f.name)) || super::is_stems_name(&f.name)
                    })
                    .map(RemoteFile::from),
            );
            match list.next_page_token {
                Some(next) if !next.is_empty() => page = Some(next),
                _ => break,
            }
        }
        Ok(out)
    }

    fn metadata(&self, token: &str, id: &str) -> Result<RemoteFile, CommandError> {
        let url = format!("{}?fields={}", self.file_url(id), encode(FIELDS));
        let file: DriveFile = self.get_json(token, &url, "The file")?;
        Ok(file.into())
    }

    fn read(&self, token: &str, id: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
        let meta = self.metadata(token, id)?;
        if meta.size > MAX_SIZE {
            return Err(CommandError::new(
                ErrorKind::TooLarge,
                format!("“{}” is too large to open.", meta.name),
            ));
        }
        let url = format!("{}?alt=media", self.file_url(id));
        let mut response = agent()
            .get(&url)
            .header("Authorization", bearer(token))
            .call()
            .map_err(|e| http_error(e, "The file"))?;
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_SIZE + 1)
            .read_to_vec()
            .map_err(|e| match e {
                ureq::Error::BodyExceedsLimit(_) => CommandError::new(
                    ErrorKind::TooLarge,
                    format!("“{}” is too large to open.", meta.name),
                ),
                other => http_error(other, "The file"),
            })?;
        validate(&meta.name, &bytes)?;
        // The revision belongs to the metadata read first; a change in between shows up as a
        // conflict on the next save.
        Ok((bytes, meta))
    }

    fn write_if_revision(
        &self,
        token: &str,
        id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, CommandError> {
        let (current, etag) = self.metadata_with_etag(token, id)?;
        if current.revision != revision {
            return Err(CommandError::new(
                ErrorKind::Conflict,
                format!(
                    "“{}” changed in Google Drive since you opened it.",
                    current.name
                ),
            ));
        }
        let url = format!(
            "{}/files/{}?uploadType=media&fields={}",
            self.upload_base,
            encode(id),
            encode(FIELDS)
        );
        // The mutation itself is bound to the version checked above: if the file changed
        // between the check and this request, Drive answers 412, which is a Conflict.
        let mut request = agent()
            .patch(&url)
            .header("Authorization", bearer(token))
            .header("Content-Type", "application/octet-stream");
        if let Some(etag) = &etag {
            request = request.header("If-Match", etag);
        }
        let mut response = request.send(bytes).map_err(|e| http_error(e, "The file"))?;
        let file: DriveFile = response.body_mut().read_json().map_err(parse_error)?;
        Ok(file.into())
    }

    fn create(&self, token: &str, name: &str, bytes: &[u8]) -> Result<RemoteFile, CommandError> {
        let boundary = "smartbeat-multipart-boundary-7f3a9c";
        let metadata = serde_json::json!({ "name": name }).to_string();
        let mut body = Vec::with_capacity(bytes.len() + metadata.len() + 256);
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
        let url = format!(
            "{}/files?uploadType=multipart&fields={}",
            self.upload_base,
            encode(FIELDS)
        );
        let mut response = agent()
            .post(&url)
            .header("Authorization", bearer(token))
            .header(
                "Content-Type",
                format!("multipart/related; boundary={boundary}"),
            )
            .send(&body[..])
            .map_err(|e| http_error(e, "The file"))?;
        let file: DriveFile = response.body_mut().read_json().map_err(parse_error)?;
        Ok(file.into())
    }

    fn revoke(&self, token: &str) -> Result<(), CommandError> {
        agent()
            .post(&format!("{}?token={}", self.revoke_url, encode(token)))
            .send_empty()
            .map_err(|e| http_error(e, "The sign-in"))?;
        Ok(())
    }

    fn share_link(&self, token: &str, id: &str, level: ShareLevel) -> Result<String, CommandError> {
        let role = match level {
            ShareLevel::View => "reader",
            ShareLevel::Edit => "writer",
        };
        // "Anyone with the link" on a file the app made (`drive.file` is enough for these).
        let body = serde_json::json!({ "type": "anyone", "role": role }).to_string();
        agent()
            .post(&format!("{}/permissions?fields=id", self.file_url(id)))
            .header("Authorization", bearer(token))
            .header("Content-Type", "application/json")
            .send(body.as_bytes())
            .map_err(|e| share_http_error(e, "The file"))?;
        let file: SharedFile = self.get_json(
            token,
            &format!("{}?fields=webViewLink", self.file_url(id)),
            "The file",
        )?;
        file.web_view_link
            .ok_or_else(|| parse_error("no link for the file"))
    }

    fn upload_file(
        &self,
        token: &str,
        name: &str,
        path: &Path,
        progress: &mut dyn FnMut(f32),
        cancel: &AtomicBool,
    ) -> Result<RemoteFile, CommandError> {
        transfer::check_cancel(cancel)?;
        let mut source = Source::open(path)?;
        let total = source.total();
        let session = self.start_session(token, name, total)?;
        let result = transfer::upload_in_chunks(
            &mut source,
            self.chunk_size,
            cancel,
            progress,
            |offset, data, total| self.put_chunk(&session, offset, data, total),
            // What does Drive have? Asking is a piece with nothing in it.
            |offset, total| {
                if total == 0 {
                    return Ok(Sent::Continue { next: offset });
                }
                self.put_chunk(&session, offset, &[], total)
            },
        );
        if let Err(error) = &result
            && transfer::is_stopped(error)
        {
            self.cancel_session(&session);
        }
        result.map(RemoteFile::from)
    }

    fn download_file(
        &self,
        token: &str,
        id: &str,
        dest: &Path,
        progress: &mut dyn FnMut(f32),
        cancel: &AtomicBool,
    ) -> Result<RemoteFile, CommandError> {
        transfer::check_cancel(cancel)?;
        let meta = self.metadata(token, id)?;
        let mut response = transfer::agent(transfer::DOWNLOAD_LIMIT, false)
            .get(&format!("{}?alt=media", self.file_url(id)))
            .header("Authorization", bearer(token))
            .call()
            .map_err(|e| http_error(e, "The file"))?;
        let status = response.status().as_u16();
        if status >= 400 {
            return Err(http_error(ureq::Error::StatusCode(status), "The file"));
        }
        transfer::download_to(
            dest,
            meta.size,
            &mut response.body_mut().as_reader(),
            cancel,
            progress,
        )?;
        Ok(meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    struct Recorded {
        head: String,
        body: Vec<u8>,
    }

    /// Serves the canned `(status, body)` answers in order, one per connection, and records the
    /// requests.
    struct Mock {
        base: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
        handle: std::thread::JoinHandle<()>,
    }

    /// (status, extra headers, body)
    type Canned = (u16, Vec<(&'static str, String)>, Vec<u8>);

    fn mock(answers: Vec<(u16, Vec<u8>)>) -> Mock {
        mock_with_headers(
            answers
                .into_iter()
                .map(|(status, body)| (status, vec![], body))
                .collect(),
        )
    }

    fn mock_with_headers(answers: Vec<Canned>) -> Mock {
        mock_with(|_| answers)
    }

    /// `answers` is made knowing the server's own address (a session `Location` points to it).
    fn mock_with(answers: impl FnOnce(&str) -> Vec<Canned>) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let answers = answers(&base);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let handle = std::thread::spawn(move || {
            for (status, headers, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut data = Vec::new();
                let mut buf = [0u8; 8192];
                let (head_end, length) = loop {
                    let n = stream.read(&mut buf).unwrap();
                    data.extend_from_slice(&buf[..n]);
                    if let Some(pos) = contains_at(&data, b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&data[..pos]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (pos + 4, length);
                    }
                    assert!(n > 0, "connection closed early");
                };
                while data.len() < head_end + length {
                    let n = stream.read(&mut buf).unwrap();
                    data.extend_from_slice(&buf[..n]);
                }
                log.lock().unwrap().push(Recorded {
                    head: String::from_utf8_lossy(&data[..head_end]).into_owned(),
                    body: data[head_end..].to_vec(),
                });
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (key, value) in headers {
                    head.push_str(&format!("{key}: {value}\r\n"));
                }
                head.push_str("\r\n");
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        Mock {
            base,
            requests,
            handle,
        }
    }

    fn contains_at(data: &[u8], needle: &[u8]) -> Option<usize> {
        data.windows(needle.len()).position(|w| w == needle)
    }

    impl Mock {
        fn finish(self) -> Vec<Recorded> {
            self.handle.join().unwrap();
            std::mem::take(&mut *self.requests.lock().unwrap())
        }
    }

    fn meta_json(name: &str, rev: &str) -> Vec<u8> {
        format!(
            r#"{{"id":"f1","name":"{name}","size":"12","modifiedTime":"2024-05-01T12:30:45.500Z","headRevisionId":"{rev}"}}"#
        )
        .into_bytes()
    }

    const GP5: &[u8] = b"\x18FICHIER GUITAR PRO v5.00";

    #[test]
    fn lists_supported_tabs_newest_first() {
        let list = r#"{"files":[
            {"id":"a","name":"song.gp5","size":"10","modifiedTime":"2024-05-01T00:00:00Z","headRevisionId":"r1"},
            {"id":"b","name":"notes.docx","size":"5","modifiedTime":"2024-04-01T00:00:00Z","headRevisionId":"r2"},
            {"id":"c","name":"Set.SBSTEMS","size":"7","modifiedTime":"2024-03-01T00:00:00Z","headRevisionId":"r3"}]}"#;
        let m = mock(vec![(200, list.as_bytes().to_vec())]);
        let files = GoogleDrive::with_base(&m.base).list("tok").unwrap();
        let requests = m.finish();
        // The tab, and the stems file next to it (the commands keep the two apart).
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].id, "a");
        assert_eq!(files[1].name, "Set.SBSTEMS");
        assert_eq!(files[0].revision, "r1");
        assert_eq!(files[0].modified_ms, 1_714_521_600_000);
        let head = &requests[0].head;
        assert!(head.starts_with("GET /drive/v3/files?"));
        assert!(head.contains("trashed%20%3D%20false"));
        assert!(head.contains("orderBy=modifiedTime%20desc"));
        assert!(head.to_lowercase().contains("authorization: bearer tok"));
    }

    #[test]
    fn reads_content_and_revision() {
        let m = mock(vec![(200, meta_json("a.gp5", "r7")), (200, GP5.to_vec())]);
        let (bytes, file) = GoogleDrive::with_base(&m.base).read("tok", "f1").unwrap();
        let requests = m.finish();
        assert_eq!(bytes, GP5);
        assert_eq!(file.revision, "r7");
        assert_eq!(file.modified_ms, 1_714_566_645_500);
        assert!(
            requests[1]
                .head
                .starts_with("GET /drive/v3/files/f1?alt=media")
        );
    }

    #[test]
    fn rejects_content_that_is_not_a_score() {
        let m = mock(vec![
            (200, meta_json("a.gp5", "r7")),
            (200, b"hello world".to_vec()),
        ]);
        let error = GoogleDrive::with_base(&m.base)
            .read("tok", "f1")
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::NotAScore);
    }

    #[test]
    fn rejects_oversize_files_before_downloading() {
        let big = format!(
            r#"{{"id":"f1","name":"a.gp5","size":"{}","headRevisionId":"r"}}"#,
            MAX_SIZE + 1
        );
        let m = mock(vec![(200, big.into_bytes())]);
        let error = GoogleDrive::with_base(&m.base)
            .read("tok", "f1")
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::TooLarge);
        assert!(validate("a.gp5", &vec![0u8; MAX_SIZE as usize + 1]).is_err());
    }

    #[test]
    fn creates_with_multipart_upload() {
        let m = mock(vec![(200, meta_json("new.gp5", "r1"))]);
        let file = GoogleDrive::with_base(&m.base)
            .create("tok", "new.gp5", GP5)
            .unwrap();
        let requests = m.finish();
        assert_eq!(file.name, "new.gp5");
        let head = &requests[0].head;
        assert!(head.starts_with("POST /upload/drive/v3/files?uploadType=multipart"));
        assert!(head.to_lowercase().contains("multipart/related; boundary="));
        let body = String::from_utf8_lossy(&requests[0].body);
        assert!(body.contains(r#"{"name":"new.gp5"}"#));
        assert!(contains(&requests[0].body, GP5));
    }

    #[test]
    fn shares_with_anyone_who_has_the_link_for_viewing() {
        let m = mock(vec![
            (200, br#"{"id":"anyoneWithLink"}"#.to_vec()),
            (
                200,
                br#"{"webViewLink":"https://drive.google.com/file/d/f1/view"}"#.to_vec(),
            ),
        ]);
        let link = GoogleDrive::with_base(&m.base)
            .share_link("tok", "f1", ShareLevel::View)
            .unwrap();
        let requests = m.finish();
        assert_eq!(link, "https://drive.google.com/file/d/f1/view");
        assert!(
            requests[0]
                .head
                .starts_with("POST /drive/v3/files/f1/permissions")
        );
        let body = String::from_utf8_lossy(&requests[0].body);
        assert!(body.contains(r#""type":"anyone""#) && body.contains(r#""role":"reader""#));
        assert!(
            requests[1]
                .head
                .starts_with("GET /drive/v3/files/f1?fields=webViewLink")
        );
    }

    #[test]
    fn an_edit_link_gives_the_writer_role() {
        let m = mock(vec![
            (200, br#"{"id":"anyoneWithLink"}"#.to_vec()),
            (
                200,
                br#"{"webViewLink":"https://drive.google.com/x"}"#.to_vec(),
            ),
        ]);
        GoogleDrive::with_base(&m.base)
            .share_link("tok", "f1", ShareLevel::Edit)
            .unwrap();
        let requests = m.finish();
        assert!(String::from_utf8_lossy(&requests[0].body).contains(r#""role":"writer""#));
    }

    #[test]
    fn a_file_without_a_link_or_a_refused_share_is_an_error() {
        let m = mock(vec![(200, b"{}".to_vec()), (200, b"{}".to_vec())]);
        let error = GoogleDrive::with_base(&m.base)
            .share_link("tok", "f1", ShareLevel::View)
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::Network);

        let m = mock(vec![(403, b"{}".to_vec())]);
        let error = GoogleDrive::with_base(&m.base)
            .share_link("tok", "f1", ShareLevel::View)
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::Io);
        let m = mock(vec![(401, b"{}".to_vec())]);
        let error = GoogleDrive::with_base(&m.base)
            .share_link("tok", "f1", ShareLevel::View)
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
    }

    #[test]
    fn writes_when_the_revision_matches() {
        let m = mock(vec![
            (200, meta_json("a.gp5", "r1")),
            (200, meta_json("a.gp5", "r2")),
        ]);
        let file = GoogleDrive::with_base(&m.base)
            .write_if_revision("tok", "f1", "r1", GP5)
            .unwrap();
        let requests = m.finish();
        assert_eq!(file.revision, "r2");
        assert!(
            requests[1]
                .head
                .starts_with("PATCH /upload/drive/v3/files/f1?uploadType=media")
        );
        assert_eq!(requests[1].body, GP5);
    }

    #[test]
    fn a_stale_revision_is_a_conflict_and_nothing_is_uploaded() {
        let m = mock(vec![(200, meta_json("a.gp5", "r9"))]);
        let error = GoogleDrive::with_base(&m.base)
            .write_if_revision("tok", "f1", "r1", GP5)
            .unwrap_err();
        let requests = m.finish();
        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(requests.len(), 1);
    }

    #[test]
    fn unauthorized_means_auth_expired() {
        let m = mock(vec![(401, b"{}".to_vec())]);
        let error = GoogleDrive::with_base(&m.base).list("old").unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
    }

    #[test]
    fn account_name_prefers_the_email_and_revoke_posts_the_token() {
        let about = br#"{"user":{"displayName":"Ann","emailAddress":"ann@example.com"}}"#;
        let m = mock(vec![(200, about.to_vec()), (200, b"{}".to_vec())]);
        let drive = GoogleDrive::with_base(&m.base);
        assert_eq!(drive.account_name("tok").unwrap(), "ann@example.com");
        drive.revoke("a b").unwrap();
        let requests = m.finish();
        assert!(requests[0].head.starts_with("GET /drive/v3/about?fields="));
        assert!(requests[1].head.starts_with("POST /revoke?token=a%20b"));
    }

    #[test]
    fn requests_only_the_drive_file_scope() {
        let config = oauth_config("cid");
        assert_eq!(
            config.scopes,
            vec!["https://www.googleapis.com/auth/drive.file"]
        );
        assert!(
            config
                .extra_auth_params
                .contains(&("access_type".into(), "offline".into()))
        );
        assert!(
            config
                .extra_auth_params
                .contains(&("prompt".into(), "select_account consent".into()))
        );
    }

    /// A file of `len` bytes that is not a tab file (a stems file is not one either).
    fn file_with(len: usize) -> (tempfile::TempDir, std::path::PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Song.sbstems");
        let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        (dir, path, bytes)
    }

    fn session_headers(base: &str) -> Vec<(&'static str, String)> {
        vec![("Location", format!("{base}/upload/session/s1"))]
    }

    fn resume(upto: Option<u64>) -> Canned {
        let headers = upto
            .map(|n| vec![("Range", format!("bytes=0-{n}"))])
            .unwrap_or_default();
        (308, headers, Vec::new())
    }

    fn done_json() -> Canned {
        (
            200,
            vec![],
            br#"{"id":"n1","name":"Song.sbstems","size":"10","modifiedTime":"2024-05-01T12:30:45.500Z","headRevisionId":"r1"}"#.to_vec(),
        )
    }

    fn content_ranges(requests: &[Recorded]) -> Vec<String> {
        requests
            .iter()
            .filter_map(|r| {
                r.head
                    .lines()
                    .find(|l| l.to_lowercase().starts_with("content-range:"))
                    .map(|l| l.split_once(':').unwrap().1.trim().to_owned())
            })
            .collect()
    }

    /// A first answer that opens the session (its `Location` is the mock itself), then `rest`.
    fn session_mock(rest: Vec<Canned>) -> Mock {
        mock_with(|base| {
            let mut answers = vec![(200, session_headers(base), Vec::new())];
            answers.extend(rest);
            answers
        })
    }

    #[test]
    fn uploads_a_file_in_resumable_chunks_with_progress() {
        let (_dir, path, bytes) = file_with(10);
        let m = session_mock(vec![resume(Some(3)), resume(Some(7)), done_json()]);
        let drive = GoogleDrive::with_base(&m.base).with_chunk_size(4);
        let mut fractions = Vec::new();
        let file = drive
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |f| fractions.push(f),
                &AtomicBool::new(false),
            )
            .unwrap();
        let requests = m.finish();
        assert_eq!(
            (file.id.as_str(), file.name.as_str()),
            ("n1", "Song.sbstems")
        );
        assert_eq!(file.revision, "r1");
        assert_eq!(fractions, vec![0.4, 0.8, 1.0]);

        let init = &requests[0];
        assert!(
            init.head
                .starts_with("POST /upload/drive/v3/files?uploadType=resumable")
        );
        assert!(
            init.head
                .to_lowercase()
                .contains("authorization: bearer tok")
        );
        assert!(
            init.head
                .to_lowercase()
                .contains("x-upload-content-length: 10")
        );
        assert_eq!(init.body, br#"{"name":"Song.sbstems"}"#);
        assert_eq!(
            content_ranges(&requests),
            ["bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"]
        );
        let sent: Vec<u8> = requests[1..].iter().flat_map(|r| r.body.clone()).collect();
        assert_eq!(sent, bytes);
        // The session address has its own authorization: the token is not sent to it.
        assert!(
            requests[1..]
                .iter()
                .all(|r| !r.head.to_lowercase().contains("authorization"))
        );
    }

    #[test]
    fn a_chunk_that_fails_is_resumed_from_what_drive_has() {
        let (_dir, path, bytes) = file_with(10);
        // Chunk 2 fails with a 503 although Drive took it: asking says it has 8 bytes.
        let m = session_mock(vec![
            resume(Some(3)),
            (503, vec![], b"busy".to_vec()),
            resume(Some(7)),
            done_json(),
        ]);
        let drive = GoogleDrive::with_base(&m.base).with_chunk_size(4);
        drive
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        let requests = m.finish();
        assert_eq!(
            content_ranges(&requests),
            ["bytes 0-3/10", "bytes 4-7/10", "bytes */10", "bytes 8-9/10"]
        );
        // Nothing was sent twice or skipped.
        let sent: Vec<u8> = requests[1..]
            .iter()
            .filter(|r| !r.head.contains("bytes */"))
            .flat_map(|r| r.body.clone())
            .collect();
        assert_eq!(sent[..4], bytes[..4]);
        assert_eq!(sent[sent.len() - 2..], bytes[8..]);
    }

    #[test]
    fn a_stop_ends_the_upload_and_asks_drive_to_drop_the_session() {
        let (_dir, path, _) = file_with(10);
        let m = session_mock(vec![resume(Some(3)), (499, vec![], Vec::new())]);
        let drive = GoogleDrive::with_base(&m.base).with_chunk_size(4);
        let cancel = AtomicBool::new(false);
        let error = drive
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |f| {
                    if f > 0.0 {
                        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                },
                &cancel,
            )
            .unwrap_err();
        let requests = m.finish();
        assert!(transfer::is_stopped(&error));
        assert_eq!(error.message, crate::cloud::STOPPED);
        // Start, one chunk, then the DELETE of the session; no second chunk.
        assert_eq!(requests.len(), 3);
        assert!(requests[2].head.starts_with("DELETE /upload/session/s1"));
    }

    #[test]
    fn an_expired_token_on_start_means_auth_expired() {
        let (_dir, path, _) = file_with(10);
        let m = mock(vec![(401, b"{}".to_vec())]);
        let error = GoogleDrive::with_base(&m.base)
            .upload_file(
                "old",
                "a.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
    }

    #[test]
    fn downloads_to_a_file_with_no_part_file_left() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Song.sbstems");
        let content: Vec<u8> = (0..12u8).collect();
        let m = mock(vec![
            (200, meta_json("Song.sbstems", "r7")),
            (200, content.clone()),
        ]);
        let mut fractions = Vec::new();
        let file = GoogleDrive::with_base(&m.base)
            .download_file(
                "tok",
                "f1",
                &dest,
                &mut |f| fractions.push(f),
                &AtomicBool::new(false),
            )
            .unwrap();
        let requests = m.finish();
        assert_eq!(std::fs::read(&dest).unwrap(), content);
        assert!(!dir.path().join("Song.sbstems.part").exists());
        assert_eq!(file.revision, "r7");
        assert_eq!(fractions.last(), Some(&1.0));
        assert!(
            requests[1]
                .head
                .starts_with("GET /drive/v3/files/f1?alt=media")
        );
        assert!(
            requests[1]
                .head
                .to_lowercase()
                .contains("authorization: bearer tok")
        );
    }

    #[test]
    fn a_failed_or_stopped_download_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Song.sbstems");
        let m = mock(vec![
            (200, meta_json("Song.sbstems", "r7")),
            (404, b"{}".to_vec()),
        ]);
        let error = GoogleDrive::with_base(&m.base)
            .download_file("tok", "f1", &dest, &mut |_| {}, &AtomicBool::new(false))
            .unwrap_err();
        m.finish();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(!dest.exists());

        let cancel = AtomicBool::new(true);
        let error = GoogleDrive::with_base("http://127.0.0.1:1")
            .download_file("tok", "f1", &dest, &mut |_| {}, &cancel)
            .unwrap_err();
        assert!(transfer::is_stopped(&error));
        assert!(!dest.exists());
        assert!(!dir.path().join("Song.sbstems.part").exists());
    }
}
