//! Google Drive over the REST API v3 with the `drive.file` scope only: Smart Beat sees just the
//! files the user opened or created with it (#187).

use std::path::Path;

use serde::Deserialize;

use super::oauth::OAuthConfig;
use super::{Provider, ProviderKind, RemoteFile, agent, encode, http_error};
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

pub fn oauth_config(client_id: &str) -> OAuthConfig {
    OAuthConfig {
        client_id: client_id.to_owned(),
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
}

impl Default for GoogleDrive {
    fn default() -> Self {
        Self {
            api_base: "https://www.googleapis.com/drive/v3".into(),
            upload_base: "https://www.googleapis.com/upload/drive/v3".into(),
            about_base: "https://www.googleapis.com/drive/v3/about".into(),
            revoke_url: "https://oauth2.googleapis.com/revoke".into(),
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
        }
    }

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
                    .filter(|f| has_supported_extension(Path::new(&f.name)))
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
        let current = self.metadata(token, id)?;
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
        let mut response = agent()
            .patch(&url)
            .header("Authorization", bearer(token))
            .header("Content-Type", "application/octet-stream")
            .send(bytes)
            .map_err(|e| http_error(e, "The file"))?;
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

    fn mock(answers: Vec<(u16, Vec<u8>)>) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let handle = std::thread::spawn(move || {
            for (status, body) in answers {
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
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
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
            {"id":"b","name":"notes.docx","size":"5","modifiedTime":"2024-04-01T00:00:00Z","headRevisionId":"r2"}]}"#;
        let m = mock(vec![(200, list.as_bytes().to_vec())]);
        let files = GoogleDrive::with_base(&m.base).list("tok").unwrap();
        let requests = m.finish();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "a");
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
}
