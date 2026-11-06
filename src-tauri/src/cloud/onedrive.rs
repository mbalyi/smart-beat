//! OneDrive over Microsoft Graph (#187, phase 2).
//!
//! Smart Beat only sees its own app folder (`/me/drive/special/approot`, scope
//! `Files.ReadWrite.AppFolder`). Items are addressed by id under `/me/drive/items/{id}`; the
//! revision is the item's `eTag`.

use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde::Deserialize;

use super::oauth::OAuthConfig;
use super::transfer::{self, Sent, Source};
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
/// The size of one piece of a file uploaded from disk: a multiple of 320 KiB, as OneDrive asks.
const TRANSFER_CHUNK: usize = 30 * 320 * 1024;
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
    chunk_size: usize,
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
            chunk_size: TRANSFER_CHUNK,
        }
    }

    /// Smaller pieces for an upload from disk, so a test needs only a few bytes.
    #[cfg(test)]
    fn with_chunk_size(mut self, chunk_size: usize) -> Self {
        self.chunk_size = chunk_size;
        self
    }

    /// Opens an upload session for a new file called `name` in the app folder (an existing file
    /// of that name makes it fail, as `create` does); the answer's address carries its own
    /// authorization.
    fn start_session(&self, token: &str, name: &str) -> Result<String, CommandError> {
        // The app folder only exists once it has been asked for.
        let _: serde_json::Value = self.get_json(
            token,
            &self.url("/me/drive/special/approot?$select=id"),
            "The Smart Beat folder",
        )?;
        let url = self.url(&format!(
            "/me/drive/special/approot:/{}:/createUploadSession",
            encode(name)
        ));
        let request = transfer::agent(transfer::CHUNK_LIMIT, false)
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json");
        let body = serde_json::json!({
            "item": { "@microsoft.graph.conflictBehavior": "fail" }
        })
        .to_string();
        let reply = transfer::send_body(request, body.as_bytes())?;
        if !reply.is_success() {
            return Err(reply.into_error("The file"));
        }
        let session: UploadSession = serde_json::from_slice(&reply.body).map_err(|e| {
            CommandError::new(
                ErrorKind::Network,
                format!("Unexpected answer from OneDrive: {e}"),
            )
        })?;
        Ok(session.upload_url)
    }

    /// One piece of the upload. 202 says which bytes are still missing; 200 or 201 is the item.
    fn put_chunk(
        &self,
        upload_url: &str,
        offset: u64,
        data: &[u8],
        total: u64,
    ) -> Result<Sent<Item>, CommandError> {
        // The upload URL carries its own authorization: no bearer token here.
        let request = transfer::agent(transfer::CHUNK_LIMIT, false)
            .put(upload_url)
            .header(
                "Content-Range",
                format!("bytes {offset}-{}/{total}", offset + data.len() as u64 - 1),
            )
            .header("Content-Type", "application/octet-stream");
        let reply = transfer::send_body(request, data)?;
        match reply.status {
            200 | 201 => Ok(Sent::Done(parse_item(&reply.body)?)),
            202 => Ok(Sent::Continue {
                next: next_expected(&reply.body),
            }),
            _ => Err(reply.into_error("The file")),
        }
    }

    /// What the session still wants (a `GET` of its address), after a piece got no answer.
    fn session_state(&self, upload_url: &str, total: u64) -> Result<Sent<Item>, CommandError> {
        let reply = transfer::read_reply(
            transfer::agent(std::time::Duration::from_secs(60), false)
                .get(upload_url)
                .call()
                .map_err(|e| http_error(e, "The file"))?,
        )?;
        if !reply.is_success() {
            return Err(reply.into_error("The file"));
        }
        let next = next_expected(&reply.body);
        // Everything is there but the session was not closed by an answer: ask again for it.
        Ok(if next >= total {
            Sent::Continue { next: total }
        } else {
            Sent::Continue { next }
        })
    }

    /// Ends an upload that was stopped (best effort: the session would expire anyway).
    fn cancel_session(&self, upload_url: &str) {
        let _ = transfer::agent(std::time::Duration::from_secs(30), false)
            .delete(upload_url)
            .call();
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

/// The first byte an upload session still wants, from `nextExpectedRanges` (`["26-"]`).
fn next_expected(body: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v["nextExpectedRanges"][0]
                .as_str()
                .and_then(|range| range.split('-').next())
                .and_then(|start| start.parse::<u64>().ok())
        })
        .unwrap_or(0)
}

fn parse_item(body: &[u8]) -> Result<Item, CommandError> {
    serde_json::from_slice(body).map_err(|e| {
        CommandError::new(
            ErrorKind::Network,
            format!("Unexpected answer from OneDrive: {e}"),
        )
    })
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
                    .filter(|i| {
                        i.file.is_some()
                            && (has_supported_extension(Path::new(&i.name))
                                || super::is_stems_name(&i.name))
                    })
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
        // OneDrive creates the app folder (`Apps/<app name>`) the first time something asks for
        // it. Writing a file into it before that answers "not found", so ask first.
        let _: serde_json::Value = self.get_json(
            token,
            &self.url("/me/drive/special/approot?$select=id"),
            "The Smart Beat folder",
        )?;
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
        if total == 0 {
            // An upload session cannot take an empty file.
            let file = self.create(token, name, &[])?;
            progress(1.0);
            return Ok(file);
        }
        let upload_url = self.start_session(token, name)?;
        let result = transfer::upload_in_chunks(
            &mut source,
            self.chunk_size,
            cancel,
            progress,
            |offset, data, total| self.put_chunk(&upload_url, offset, data, total),
            |_, total| self.session_state(&upload_url, total),
        );
        if let Err(error) = &result
            && transfer::is_stopped(error)
        {
            self.cancel_session(&upload_url);
        }
        result.map(Item::into_remote)
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
        // The content address answers with a redirect to a pre-authenticated host: follow it,
        // without the bearer token.
        let mut response = transfer::agent(transfer::DOWNLOAD_LIMIT, true)
            .get(&self.url(&format!("/me/drive/items/{}/content", encode(id))))
            .header("Authorization", format!("Bearer {token}"))
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
    /// The same with extra response headers.
    type HeaderReply = (u16, Vec<(&'static str, String)>, String);

    /// Starts a mock HTTP server; `handler` maps a request to (status, JSON/body text).
    fn serve(
        handler: impl Fn(&Req, &str) -> Reply + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<Req>>>) {
        serve_with_headers(move |req, origin| {
            let (status, text) = handler(req, origin);
            (status, vec![], text)
        })
    }

    fn serve_with_headers(
        handler: impl Fn(&Req, &str) -> HeaderReply + Send + Sync + 'static,
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
                    let (status, extra, text) = handler(&req, &origin);
                    let mut head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                        text.len()
                    );
                    for (key, value) in extra {
                        head.push_str(&format!("{key}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(text.as_bytes());
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
                    r#"{{"value":[{},{newer},{folder},{other},{}]}}"#,
                    item_json("1", "a.gp5", "e1", 5),
                    item_json("4", "set.sbstems", "e4", 5)
                ),
            )
        });
        let files = OneDrive::with_base(base).list("tok").unwrap();
        assert_eq!(
            files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            ["2", "1", "4"]
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
        assert_eq!(log[1].method, "PUT");
        assert_eq!(
            log[1].path,
            "/v1.0/me/drive/special/approot:/new%20tab.gp5:/content?@microsoft.graph.conflictBehavior=fail"
        );
        assert_eq!(log[1].body, b"abc");
    }

    /// Regression: the first save into a brand-new app folder answered "not found" because the
    /// folder only exists once it has been asked for.
    #[test]
    fn the_app_folder_is_asked_for_before_the_first_file_is_written() {
        let (base, log) = serve(|req, _| {
            if req.method == "GET" && req.path.starts_with("/v1.0/me/drive/special/approot") {
                (200, r#"{"id":"folder"}"#.into())
            } else {
                (201, item_json("7", "first.gp5", "e7", 3))
            }
        });
        OneDrive::with_base(base)
            .create("tok", "first.gp5", b"abc")
            .unwrap();
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].method, "GET");
        assert_eq!(log[0].path, "/v1.0/me/drive/special/approot?$select=id");
        assert_eq!(log[1].method, "PUT");
    }

    #[test]
    fn an_app_folder_that_cannot_be_reached_is_reported_before_any_upload() {
        let (base, log) = serve(|_, _| (404, "{}".into()));
        let err = OneDrive::with_base(base)
            .create("tok", "a.gp5", b"abc")
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        assert!(err.message.contains("Smart Beat folder"), "{}", err.message);
        assert_eq!(log.lock().unwrap().len(), 1);
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

    fn file_with(len: usize) -> (tempfile::TempDir, std::path::PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Song.sbstems");
        let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        (dir, path, bytes)
    }

    fn range_of(req: &Req) -> Option<&str> {
        req.header("content-range")
    }

    /// A OneDrive that opens a session, takes pieces as `step` says and closes with the item.
    /// `step(range)` answers a piece: `None` is the normal answer, `Some` replaces it.
    fn session_server(
        step: impl Fn(&str) -> Option<HeaderReply> + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<Req>>>) {
        serve_with_headers(move |req, origin| {
            if req.method == "GET" && req.path.starts_with("/v1.0/me/drive/special/approot") {
                return (200, vec![], r#"{"id":"folder"}"#.into());
            }
            if req.path.ends_with("/createUploadSession") {
                return (
                    200,
                    vec![],
                    format!(r#"{{"uploadUrl":"{origin}/upload/u1"}}"#),
                );
            }
            if req.method == "GET" && req.path == "/upload/u1" {
                return (200, vec![], r#"{"nextExpectedRanges":["4-"]}"#.into());
            }
            if req.method == "DELETE" {
                return (204, vec![], String::new());
            }
            let range = range_of(req).unwrap_or_default().to_owned();
            if let Some(answer) = step(&range) {
                return answer;
            }
            match range.as_str() {
                "bytes 0-3/10" => (202, vec![], r#"{"nextExpectedRanges":["4-"]}"#.into()),
                "bytes 4-7/10" => (202, vec![], r#"{"nextExpectedRanges":["8-"]}"#.into()),
                _ => (201, vec![], item_json("n1", "Song.sbstems", "e1", 10)),
            }
        })
    }

    #[test]
    fn uploads_a_file_through_a_session_in_chunks_with_progress() {
        let (_dir, path, bytes) = file_with(10);
        let (base, log) = session_server(|_| None);
        let drive = OneDrive::with_base(base).with_chunk_size(4);
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
        assert_eq!((file.id.as_str(), file.revision.as_str()), ("n1", "e1"));
        assert_eq!(fractions, vec![0.4, 0.8, 1.0]);
        let log = log.lock().unwrap();
        let session = log
            .iter()
            .find(|r| r.path.ends_with("/createUploadSession"))
            .unwrap();
        assert_eq!(
            session.path,
            "/v1.0/me/drive/special/approot:/Song.sbstems:/createUploadSession"
        );
        assert_eq!(session.header("authorization"), Some("Bearer tok"));
        assert!(String::from_utf8_lossy(&session.body).contains("\"fail\""));
        let pieces: Vec<&Req> = log.iter().filter(|r| r.path == "/upload/u1").collect();
        assert_eq!(
            pieces
                .iter()
                .map(|r| range_of(r).unwrap())
                .collect::<Vec<_>>(),
            ["bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"]
        );
        // The upload address has its own authorization: the token does not go there.
        assert!(pieces.iter().all(|r| r.header("authorization").is_none()));
        let sent: Vec<u8> = pieces.iter().flat_map(|r| r.body.clone()).collect();
        assert_eq!(sent, bytes);
    }

    #[test]
    fn a_chunk_that_fails_is_resumed_from_what_the_session_wants() {
        let (_dir, path, bytes) = file_with(10);
        let failed = std::sync::atomic::AtomicBool::new(false);
        let (base, log) = session_server(move |range| {
            // The second piece fails once; the session says it still wants it (from 4).
            (range == "bytes 4-7/10" && !failed.swap(true, std::sync::atomic::Ordering::SeqCst))
                .then(|| (503, vec![], "busy".to_owned()))
        });
        OneDrive::with_base(base)
            .with_chunk_size(4)
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        let log = log.lock().unwrap();
        let steps: Vec<String> = log
            .iter()
            .filter(|r| r.path == "/upload/u1")
            .map(|r| format!("{} {}", r.method, range_of(r).unwrap_or("-")))
            .collect();
        assert_eq!(
            steps,
            [
                "PUT bytes 0-3/10",
                "PUT bytes 4-7/10",
                "GET -",
                "PUT bytes 4-7/10",
                "PUT bytes 8-9/10"
            ]
        );
        let delivered: Vec<u8> = log
            .iter()
            .filter(|r| r.method == "PUT" && r.path == "/upload/u1")
            .flat_map(|r| r.body.clone())
            .collect();
        // The failed piece went out twice; the rest once.
        assert_eq!(delivered.len(), 14);
        assert_eq!(delivered[..8], bytes[..8]);
    }

    #[test]
    fn a_stop_ends_the_upload_and_deletes_the_session() {
        let (_dir, path, _) = file_with(10);
        let (base, log) = session_server(|_| None);
        let cancel = AtomicBool::new(false);
        let error = OneDrive::with_base(base)
            .with_chunk_size(4)
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
        assert!(transfer::is_stopped(&error));
        let log = log.lock().unwrap();
        let pieces = log
            .iter()
            .filter(|r| r.method == "PUT" && r.path == "/upload/u1")
            .count();
        assert_eq!(pieces, 1);
        assert!(
            log.iter()
                .any(|r| r.method == "DELETE" && r.path == "/upload/u1")
        );
    }

    #[test]
    fn an_empty_file_is_created_without_a_session() {
        let (_dir, path, _) = file_with(0);
        let (base, log) = serve(|_, _| (201, item_json("7", "Song.sbstems", "e7", 0)));
        let file = OneDrive::with_base(base)
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(file.id, "7");
        assert!(
            !log.lock()
                .unwrap()
                .iter()
                .any(|r| r.path.ends_with("/createUploadSession"))
        );
    }

    #[test]
    fn downloads_through_the_redirect_without_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Song.sbstems");
        let content: Vec<u8> = (0..30u8).collect();
        // The host the content address sends the download to.
        let served = content.clone();
        let (cdn, cdn_log) =
            serve(move |_, _| (200, String::from_utf8_lossy(&served).into_owned()));
        let cdn_origin = cdn.trim_end_matches("/v1.0").to_owned();
        let (base, log) = serve_with_headers(move |req, _| {
            if req.path.ends_with("/content") {
                (
                    302,
                    vec![("Location", format!("{cdn_origin}/blob/1"))],
                    String::new(),
                )
            } else {
                (200, vec![], item_json("1", "Song.sbstems", "e1", 30))
            }
        });
        let mut fractions = Vec::new();
        let file = OneDrive::with_base(base)
            .download_file(
                "tok",
                "1",
                &dest,
                &mut |f| fractions.push(f),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(file.revision, "e1");
        // Same text as bytes only for ASCII: compare lengths and the file's presence.
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 30);
        assert!(!dir.path().join("Song.sbstems.part").exists());
        assert_eq!(fractions.last(), Some(&1.0));
        let log = log.lock().unwrap();
        let content_request = log.iter().find(|r| r.path.ends_with("/content")).unwrap();
        assert_eq!(content_request.header("authorization"), Some("Bearer tok"));
        let cdn_log = cdn_log.lock().unwrap();
        assert_eq!(cdn_log.len(), 1);
        assert_eq!(cdn_log[0].path, "/blob/1");
        assert!(cdn_log[0].header("authorization").is_none());
    }

    #[test]
    fn a_failed_or_stopped_download_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Song.sbstems");
        let (base, _) = serve(|req, _| {
            if req.path.ends_with("/content") {
                (404, "{}".into())
            } else {
                (200, item_json("1", "Song.sbstems", "e1", 30))
            }
        });
        let error = OneDrive::with_base(base.clone())
            .download_file("tok", "1", &dest, &mut |_| {}, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(!dest.exists());

        let error = OneDrive::with_base(base)
            .download_file("tok", "1", &dest, &mut |_| {}, &AtomicBool::new(true))
            .unwrap_err();
        assert!(transfer::is_stopped(&error));
        assert!(!dest.exists());
        assert!(!dir.path().join("Song.sbstems.part").exists());
    }
}
