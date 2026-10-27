//! OneDrive over Microsoft Graph (#187, phase 2).
//!
//! Smart Beat only sees its own app folder (`/me/drive/special/approot`, scope
//! `Files.ReadWrite.AppFolder`). Items are addressed by id under `/me/drive/items/{id}`; the
//! revision is the item's `eTag`.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use super::oauth::OAuthConfig;
use super::{Provider, ProviderKind, RemoteFile, agent, encode, http_error};
use crate::error::{CommandError, ErrorKind};
use crate::score_file::{MAX_SIZE, ScoreFormat, has_supported_extension};

/// Application (client) id of the Azure app registration, baked in at build time.
pub const CLIENT_ID: Option<&str> = option_env!("SMARTBEAT_MICROSOFT_CLIENT_ID");

const DEFAULT_BASE: &str = "https://graph.microsoft.com/v1.0";
const AUTH_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
/// Only the app folder, plus a refresh token and the account name.
const SCOPES: &str = "Files.ReadWrite.AppFolder offline_access User.Read";

/// Largest body for a single `PUT .../content`; bigger files need an upload session.
const SIMPLE_UPLOAD_MAX: usize = 4 * 1024 * 1024;
/// Upload session chunks must be multiples of 320 KiB.
const CHUNK: usize = 10 * 320 * 1024;
const ITEM_FIELDS: &str = "id,name,eTag,size,lastModifiedDateTime,file";

pub fn oauth_config(client_id: &str) -> OAuthConfig {
    OAuthConfig {
        client_id: client_id.to_string(),
        client_secret: None,
        redirect_ports: Vec::new(),
        // Registered in the Entra app as `http://localhost` (the port is ignored for loopback).
        redirect_host: "localhost".into(),
        auth_url: AUTH_URL.to_string(),
        token_url: TOKEN_URL.to_string(),
        scopes: SCOPES.split(' ').map(str::to_string).collect(),
        // Always show the account chooser instead of silently reusing the browser session.
        extra_auth_params: vec![("prompt".into(), "select_account".into())],
    }
}

pub struct OneDrive {
    graph_base: String,
}

impl Default for OneDrive {
    fn default() -> Self {
        Self::with_base(DEFAULT_BASE)
    }
}

impl OneDrive {
    pub fn new() -> Self {
        Self::default()
    }

    /// Points the provider at another Graph endpoint (tests).
    pub fn with_base(url: impl Into<String>) -> Self {
        Self {
            graph_base: url.into().trim_end_matches('/').to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.graph_base)
    }

    fn get_json<T: for<'de> Deserialize<'de>>(
        &self,
        token: &str,
        url: &str,
        what: &str,
    ) -> Result<T, CommandError> {
        agent()
            .get(url)
            .header("Authorization", format!("Bearer {token}"))
            .call()
            .map_err(|e| http_error(e, what))?
            .body_mut()
            .read_json::<T>()
            .map_err(|e| http_error(e, what))
    }

    fn put_content(
        &self,
        token: &str,
        url: &str,
        if_match: Option<&str>,
        bytes: &[u8],
        what: &str,
    ) -> Result<RemoteFile, CommandError> {
        let mut request = agent()
            .put(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/octet-stream");
        if let Some(etag) = if_match {
            request = request.header("If-Match", etag);
        }
        let item: Item = request
            .send(bytes)
            .map_err(|e| http_error(e, what))?
            .body_mut()
            .read_json()
            .map_err(|e| http_error(e, what))?;
        Ok(item.into_remote())
    }

    /// Uploads `bytes` through an upload session: `POST {session_path}` (with `If-Match` when
    /// replacing), then chunked PUTs to the pre-authenticated upload URL.
    fn upload_session(
        &self,
        token: &str,
        session_url: &str,
        if_match: Option<&str>,
        behavior: &str,
        bytes: &[u8],
        what: &str,
    ) -> Result<RemoteFile, CommandError> {
        let mut request = agent()
            .post(session_url)
            .header("Authorization", format!("Bearer {token}"));
        if let Some(etag) = if_match {
            request = request.header("If-Match", etag);
        }
        let session: UploadSession = request
            .send_json(serde_json::json!({
                "item": { "@microsoft.graph.conflictBehavior": behavior }
            }))
            .map_err(|e| http_error(e, what))?
            .body_mut()
            .read_json()
            .map_err(|e| http_error(e, what))?;

        let total = bytes.len();
        let mut start = 0;
        loop {
            let end = (start + CHUNK).min(total);
            // The upload URL carries its own authorization: no bearer token here.
            let mut response = agent()
                .put(&session.upload_url)
                .header(
                    "Content-Range",
                    format!("bytes {start}-{}/{total}", end - 1),
                )
                .header("Content-Type", "application/octet-stream")
                .send(&bytes[start..end])
                .map_err(|e| http_error(e, what))?;
            if end == total {
                let item: Item = response
                    .body_mut()
                    .read_json()
                    .map_err(|e| http_error(e, what))?;
                return Ok(item.into_remote());
            }
            start = end;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "eTag")]
    etag: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    last_modified_date_time: String,
    /// Present for files, absent for folders.
    file: Option<serde_json::Value>,
}

impl Item {
    fn into_remote(self) -> RemoteFile {
        RemoteFile {
            id: self.id,
            name: self.name,
            revision: self.etag,
            size: self.size,
            modified_ms: parse_time_ms(&self.last_modified_date_time),
        }
    }
}

#[derive(Deserialize)]
struct Children {
    #[serde(default)]
    value: Vec<Item>,
    #[serde(default, rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    upload_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Me {
    display_name: Option<String>,
    user_principal_name: Option<String>,
    mail: Option<String>,
}

/// `2024-05-01T12:34:56.789Z` to milliseconds since the Unix epoch, 0 when unparsable.
fn parse_time_ms(text: &str) -> u64 {
    fn parse(text: &str) -> Option<u64> {
        let (date, time) = text.split_once('T')?;
        let mut d = date.split('-');
        let (y, m, day): (i64, i64, i64) = (
            d.next()?.parse().ok()?,
            d.next()?.parse().ok()?,
            d.next()?.parse().ok()?,
        );
        let time = time.trim_end_matches('Z');
        let time = time.split(['+', '-']).next()?;
        let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
        let mut t = hms.split(':');
        let (h, mi, s): (i64, i64, i64) = (
            t.next()?.parse().ok()?,
            t.next()?.parse().ok()?,
            t.next().unwrap_or("0").parse().ok()?,
        );
        let millis: i64 = format!("{frac:0<3}")[..3].parse().ok()?;
        // Days from civil date (Howard Hinnant's algorithm).
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        let ms = ((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + millis;
        u64::try_from(ms).ok()
    }
    parse(text).unwrap_or(0)
}

/// Rejects downloads that are too big or not a music file for their extension.
fn validate(name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    if bytes.len() as u64 > MAX_SIZE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("“{name}” is larger than {} MB.", MAX_SIZE / (1024 * 1024)),
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
        "mscx" => head.windows(9).any(|w| w == b"<museScor"),
        "mscz" | "capx" | "mxl" => bytes.starts_with(b"PK\x03\x04"),
        _ => ScoreFormat::detect(bytes).is_some(),
    };
    if ok {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorKind::NotAScore,
            format!("“{name}” is not a supported music file, or it is damaged."),
        ))
    }
}

impl Provider for OneDrive {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Onedrive
    }

    fn account_name(&self, token: &str) -> Result<String, CommandError> {
        let me: Me = self.get_json(
            token,
            &self.url("/me?$select=displayName,userPrincipalName,mail"),
            "The account",
        )?;
        Ok([me.display_name, me.user_principal_name, me.mail]
            .into_iter()
            .flatten()
            .find(|v| !v.is_empty())
            .unwrap_or_else(|| "OneDrive".to_string()))
    }

    fn list(&self, token: &str) -> Result<Vec<RemoteFile>, CommandError> {
        let mut url = self.url(&format!(
            "/me/drive/special/approot/children?$select={ITEM_FIELDS}&$top=200"
        ));
        let mut files = Vec::new();
        loop {
            let page: Children = self.get_json(token, &url, "The Smart Beat folder")?;
            files.extend(
                page.value
                    .into_iter()
                    .filter(|i| i.file.is_some() && has_supported_extension(Path::new(&i.name)))
                    .map(Item::into_remote),
            );
            match page.next_link {
                Some(next) => url = next,
                None => break,
            }
        }
        files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then(a.name.cmp(&b.name)));
        Ok(files)
    }

    fn metadata(&self, token: &str, id: &str) -> Result<RemoteFile, CommandError> {
        let item: Item = self.get_json(
            token,
            &self.url(&format!(
                "/me/drive/items/{}?$select={ITEM_FIELDS}",
                encode(id)
            )),
            "The file",
        )?;
        Ok(item.into_remote())
    }

    fn read(&self, token: &str, id: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
        // Metadata first would race with a save; the eTag must belong to the bytes we got, so
        // fetch the content, then the metadata, and retry once if the revision moved between.
        let item_url = self.url(&format!("/me/drive/items/{}", encode(id)));
        let mut attempt = 0;
        loop {
            let before = self.metadata(token, id)?;
            let mut response = agent()
                .get(&format!("{item_url}/content"))
                .header("Authorization", format!("Bearer {token}"))
                .call()
                .map_err(|e| http_error(e, "The file"))?;
            let mut bytes = Vec::new();
            response
                .body_mut()
                .as_reader()
                .take(MAX_SIZE + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| {
                    CommandError::new(
                        ErrorKind::Network,
                        format!("The download was interrupted: {e}"),
                    )
                })?;
            let after = self.metadata(token, id)?;
            if before.revision == after.revision || attempt >= 1 {
                validate(&after.name, &bytes)?;
                return Ok((bytes, after));
            }
            attempt += 1;
        }
    }

    fn write_if_revision(
        &self,
        token: &str,
        id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, CommandError> {
        let base = format!("/me/drive/items/{}", encode(id));
        if bytes.len() <= SIMPLE_UPLOAD_MAX {
            self.put_content(
                token,
                &self.url(&format!("{base}/content")),
                Some(revision),
                bytes,
                "The file",
            )
        } else {
            self.upload_session(
                token,
                &self.url(&format!("{base}/createUploadSession")),
                Some(revision),
                "replace",
                bytes,
                "The file",
            )
        }
    }

    fn create(&self, token: &str, name: &str, bytes: &[u8]) -> Result<RemoteFile, CommandError> {
        let base = format!("/me/drive/special/approot:/{}:", encode(name));
        if bytes.len() <= SIMPLE_UPLOAD_MAX {
            self.put_content(
                token,
                &self.url(&format!(
                    "{base}/content?@microsoft.graph.conflictBehavior=fail"
                )),
                None,
                bytes,
                "The file",
            )
        } else {
            self.upload_session(
                token,
                &self.url(&format!("{base}/createUploadSession")),
                None,
                "fail",
                bytes,
                "The file",
            )
        }
    }

    /// Microsoft has no token revocation endpoint for public clients; the tokens are dropped
    /// from the keychain by the caller and the user can remove the app at
    /// account.microsoft.com. Nothing to do here.
    fn revoke(&self, _token: &str) -> Result<(), CommandError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    struct Req {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Req {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    type Reply = (u16, String);

    /// Starts a mock HTTP server; `handler` maps a request to (status, JSON/body text).
    fn serve(
        handler: impl Fn(&Req, &str) -> Reply + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<Req>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(handler);
        let (log2, origin2) = (log.clone(), origin.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (log, handler, origin) = (log2.clone(), handler.clone(), origin2.clone());
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_string();
                    let path = parts.next().unwrap_or_default().to_string();
                    let mut headers = Vec::new();
                    loop {
                        let mut h = String::new();
                        reader.read_line(&mut h).unwrap();
                        let h = h.trim_end();
                        if h.is_empty() {
                            break;
                        }
                        if let Some((k, v)) = h.split_once(':') {
                            headers.push((k.trim().to_string(), v.trim().to_string()));
                        }
                    }
                    let len = headers
                        .iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.parse().ok())
                        .unwrap_or(0);
                    let mut body = vec![0u8; len];
                    reader.read_exact(&mut body).unwrap();
                    let req = Req {
                        method,
                        path,
                        headers,
                        body,
                    };
                    log.lock().unwrap().push(req.clone());
                    let (status, text) = handler(&req, &origin);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                        text.len()
                    );
                });
            }
        });
        (format!("{origin}/v1.0"), log)
    }

    fn item_json(id: &str, name: &str, etag: &str, size: u64) -> String {
        format!(
            r#"{{"id":"{id}","name":"{name}","eTag":"{etag}","size":{size},"lastModifiedDateTime":"2024-05-01T12:00:00Z","file":{{}}}}"#
        )
    }

    const GP5: &[u8] = b"\x18FICHIER GUITAR PRO v5.00....";

    #[test]
    fn parses_graph_timestamps() {
        assert_eq!(parse_time_ms("1970-01-01T00:00:00Z"), 0);
        assert_eq!(parse_time_ms("2024-05-01T12:00:00.5Z"), 1_714_564_800_500);
        assert_eq!(parse_time_ms("garbage"), 0);
    }

    #[test]
    fn lists_tabs_newest_first() {
        let (base, log) = serve(|_, _| {
            let newer = item_json("2", "b.gp5", "e2", 5).replace("12:00:00", "13:00:00");
            let folder = r#"{"id":"9","name":"sub.gp5","folder":{}}"#;
            let other = item_json("3", "notes.pdf", "e3", 5);
            (
                200,
                format!(
                    r#"{{"value":[{},{newer},{folder},{other}]}}"#,
                    item_json("1", "a.gp5", "e1", 5)
                ),
            )
        });
        let files = OneDrive::with_base(base).list("tok").unwrap();
        assert_eq!(
            files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            ["2", "1"]
        );
        assert_eq!(files[1].revision, "e1");
        let log = log.lock().unwrap();
        assert!(
            log[0]
                .path
                .starts_with("/v1.0/me/drive/special/approot/children")
        );
        assert_eq!(log[0].header("authorization"), Some("Bearer tok"));
    }

    #[test]
    fn reads_content_and_metadata() {
        let (base, _) = serve(|req, _| {
            if req.path.contains("/content") {
                (200, String::from_utf8_lossy(GP5).into_owned())
            } else {
                (200, item_json("1", "a.gp5", "e1", GP5.len() as u64))
            }
        });
        let (bytes, file) = OneDrive::with_base(base).read("tok", "1").unwrap();
        assert_eq!(bytes, GP5);
        assert_eq!(file.revision, "e1");
    }

    #[test]
    fn rejects_invalid_content() {
        let (base, _) = serve(|req, _| {
            if req.path.contains("/content") {
                (200, "just some text".into())
            } else {
                (200, item_json("1", "a.gp5", "e1", 14))
            }
        });
        let err = OneDrive::with_base(base).read("tok", "1").unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAScore);
    }

    #[test]
    fn creates_without_overwriting() {
        let (base, log) = serve(|_, _| (201, item_json("7", "new tab.gp5", "e7", 3)));
        let file = OneDrive::with_base(base)
            .create("tok", "new tab.gp5", b"abc")
            .unwrap();
        assert_eq!(file.id, "7");
        let log = log.lock().unwrap();
        assert_eq!(log[0].method, "PUT");
        assert_eq!(
            log[0].path,
            "/v1.0/me/drive/special/approot:/new%20tab.gp5:/content?@microsoft.graph.conflictBehavior=fail"
        );
        assert_eq!(log[0].body, b"abc");
    }

    #[test]
    fn small_write_sends_if_match() {
        let (base, log) = serve(|_, _| (200, item_json("1", "a.gp5", "e2", 3)));
        let file = OneDrive::with_base(base)
            .write_if_revision("tok", "1", "e1", b"abc")
            .unwrap();
        assert_eq!(file.revision, "e2");
        let log = log.lock().unwrap();
        assert_eq!(log[0].method, "PUT");
        assert_eq!(log[0].path, "/v1.0/me/drive/items/1/content");
        assert_eq!(log[0].header("if-match"), Some("e1"));
    }

    #[test]
    fn write_conflict_maps_to_conflict() {
        let (base, _) = serve(|_, _| (412, "{}".into()));
        let err = OneDrive::with_base(base)
            .write_if_revision("tok", "1", "old", b"abc")
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
    }

    #[test]
    fn large_write_uses_an_upload_session() {
        let size = SIMPLE_UPLOAD_MAX + 1;
        let data = vec![7u8; size];
        let (base, log) = serve(move |req, origin| {
            if req.path.ends_with("/createUploadSession") {
                (200, format!(r#"{{"uploadUrl":"{origin}/upload/abc"}}"#))
            } else if req.path.starts_with("/upload/abc") {
                let range = req.header("content-range").unwrap();
                if range.ends_with(&format!("-{}/{size}", size - 1)) {
                    (200, item_json("1", "a.gp5", "e9", size as u64))
                } else {
                    (202, r#"{"nextExpectedRanges":[]}"#.into())
                }
            } else {
                (500, "{}".into())
            }
        });
        let file = OneDrive::with_base(base)
            .write_if_revision("tok", "1", "e1", &data)
            .unwrap();
        assert_eq!(file.revision, "e9");
        let log = log.lock().unwrap();
        assert_eq!(log[0].path, "/v1.0/me/drive/items/1/createUploadSession");
        assert_eq!(log[0].header("if-match"), Some("e1"));
        let chunks: Vec<_> = log
            .iter()
            .filter(|r| r.path.starts_with("/upload"))
            .collect();
        assert_eq!(chunks.len(), size.div_ceil(CHUNK));
        assert_eq!(chunks.iter().map(|c| c.body.len()).sum::<usize>(), size);
        assert!(chunks.iter().all(|c| c.header("authorization").is_none()));
        assert_eq!(CHUNK % (320 * 1024), 0);
    }

    #[test]
    fn unauthorized_means_auth_expired() {
        let (base, _) = serve(|_, _| (401, "{}".into()));
        let provider = OneDrive::with_base(base);
        assert_eq!(provider.list("t").unwrap_err().kind, ErrorKind::AuthExpired);
        assert_eq!(
            provider.account_name("t").unwrap_err().kind,
            ErrorKind::AuthExpired
        );
    }

    #[test]
    fn account_name_prefers_display_name() {
        let (base, _) = serve(|_, _| {
            (
                200,
                r#"{"displayName":"Ada","userPrincipalName":"ada@x.com"}"#.into(),
            )
        });
        assert_eq!(OneDrive::with_base(base).account_name("t").unwrap(), "Ada");
    }

    #[test]
    fn the_redirect_host_matches_the_entra_registration() {
        // The Entra app is registered for `http://localhost` (the loopback port is ignored).
        assert_eq!(oauth_config("id").redirect_host, "localhost");
        assert!(oauth_config("id").redirect_ports.is_empty());
    }

    #[test]
    fn requests_only_the_app_folder_scope() {
        let config = oauth_config("client");
        assert_eq!(
            config.scopes,
            ["Files.ReadWrite.AppFolder", "offline_access", "User.Read"]
        );
        assert!(
            !config
                .scopes
                .iter()
                .any(|s| s == "Files.ReadWrite" || s == "Files.ReadWrite.All")
        );
        assert!(config.auth_url.contains("login.microsoftonline.com/common"));
        assert!(
            config
                .extra_auth_params
                .contains(&("prompt".into(), "select_account".into()))
        );
    }

    #[test]
    fn revoke_is_a_no_op() {
        assert!(OneDrive::new().revoke("t").is_ok());
    }
}
