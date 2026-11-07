//! Dropbox (#187, phase 2) through the HTTP API v2 with an "App folder" access type: every path
//! is relative to the app's own folder. Files are addressed by their `id` (`id:abc`), revisions
//! are Dropbox's `rev`. Uploads over 150 MB would need upload sessions and are out of scope
//! ([`crate::score_file::MAX_SIZE`] is 100 MB).

use std::cell::RefCell;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde::Deserialize;
use serde_json::{Value, json};

use super::oauth::OAuthConfig;
use super::transfer::{self, Sent, Source};
use super::{Provider, ProviderKind, RemoteFile, ShareLevel, http_error};
use crate::error::{CommandError, ErrorKind};
use crate::score_file::{MAX_SIZE, ScoreFormat, has_supported_extension};

/// The app registration's key, baked in at build time.
pub const CLIENT_ID: Option<&str> = option_env!("SMARTBEAT_DROPBOX_CLIENT_ID");

const API_BASE: &str = "https://api.dropboxapi.com/2";
const CONTENT_BASE: &str = "https://content.dropboxapi.com/2";

/// The size of one piece of an upload session (a request body may not pass 150 MB).
const UPLOAD_CHUNK: usize = 8 * 1024 * 1024;

/// Dropbox compares the redirect address exactly, port and path included, so sign-in listens on
/// one of these ports. Each must be registered in the Dropbox app console as
/// `http://127.0.0.1:<port>/` (see [`REDIRECT_URIS`]).
pub const REDIRECT_PORTS: [u16; 5] = [53682, 53683, 53684, 53685, 53686];

/// The redirect URIs to register in the Dropbox app console.
pub fn redirect_uris() -> Vec<String> {
    REDIRECT_PORTS
        .iter()
        .map(|port| format!("http://127.0.0.1:{port}/"))
        .collect()
}

pub fn oauth_config(client_id: &str) -> OAuthConfig {
    OAuthConfig {
        client_id: client_id.to_owned(),
        client_secret: None,
        redirect_ports: REDIRECT_PORTS.to_vec(),
        redirect_host: "127.0.0.1".into(),
        auth_url: "https://www.dropbox.com/oauth2/authorize".into(),
        token_url: "https://api.dropboxapi.com/oauth2/token".into(),
        scopes: [
            "files.content.read",
            "files.content.write",
            "files.metadata.read",
            "account_info.read",
            // Share links (#201). Connections made before this need to be made again.
            "sharing.read",
            "sharing.write",
        ]
        .map(String::from)
        .to_vec(),
        extra_auth_params: vec![("token_access_type".into(), "offline".into())],
    }
}

pub struct Dropbox {
    api_base: String,
    content_base: String,
    chunk_size: usize,
}

impl Default for Dropbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Dropbox {
    pub fn new() -> Self {
        Self {
            api_base: API_BASE.into(),
            content_base: CONTENT_BASE.into(),
            chunk_size: UPLOAD_CHUNK,
        }
    }

    /// Both the API and the content host at `base` (tests).
    pub fn with_base(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        Self {
            api_base: base.into(),
            content_base: base.into(),
            chunk_size: UPLOAD_CHUNK,
        }
    }

    /// Smaller pieces for an upload session, so a test needs only a few bytes.
    #[cfg(test)]
    fn with_chunk_size(mut self, chunk_size: usize) -> Self {
        self.chunk_size = chunk_size;
        self
    }

    /// One request of an upload session to a content endpoint (`start`, `append_v2`, `finish`).
    fn session_call(
        &self,
        token: &str,
        endpoint: &str,
        arg: &Value,
        data: &[u8],
    ) -> Result<transfer::Reply, CommandError> {
        let request = transfer::agent(transfer::CHUNK_LIMIT, false)
            .post(&format!("{}{endpoint}", self.content_base))
            .header("Content-Type", "application/octet-stream")
            .header("Dropbox-API-Arg", &api_arg(arg))
            .header("Authorization", &format!("Bearer {token}"));
        transfer::send_body(request, data)
    }

    /// One piece of the upload: the first opens the session, the last closes it with the file's
    /// path, the ones between are appended. A piece sent at the wrong offset is answered with
    /// the right one (a 409 `incorrect_offset`), which is where the upload goes on.
    fn send_piece(
        &self,
        token: &str,
        session: &RefCell<Option<String>>,
        commit: &Value,
        offset: u64,
        data: &[u8],
        total: u64,
    ) -> Result<Sent<RemoteFile>, CommandError> {
        let end = offset + data.len() as u64;
        let last = end >= total;
        let known = session.borrow().clone();
        let Some(id) = known else {
            // The first piece opens the session, even for a file that fits in one piece.
            let reply = self.session_call(
                token,
                "/files/upload_session/start",
                &json!({"close": false}),
                data,
            )?;
            if !reply.is_success() {
                return Err(upload_error(&reply));
            }
            let started: Value = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
            let id = started["session_id"].as_str().ok_or_else(|| {
                CommandError::new(ErrorKind::Network, "Unexpected answer from Dropbox.")
            })?;
            *session.borrow_mut() = Some(id.to_owned());
            // Everything went with the start: close it with nothing more to add.
            return if last {
                self.finish(token, id, commit, end, &[])
            } else {
                Ok(Sent::Continue { next: end })
            };
        };
        if last {
            return self.finish(token, &id, commit, offset, data);
        }
        let reply = self.session_call(
            token,
            "/files/upload_session/append_v2",
            &json!({"cursor": {"session_id": id, "offset": offset}, "close": false}),
            data,
        )?;
        if reply.is_success() {
            Ok(Sent::Continue { next: end })
        } else {
            wrong_offset(&reply).map_or_else(
                || Err(upload_error(&reply)),
                |next| Ok(Sent::Continue { next }),
            )
        }
    }

    /// Closes the session: `data` is the last piece, `offset` where it starts.
    fn finish(
        &self,
        token: &str,
        id: &str,
        commit: &Value,
        offset: u64,
        data: &[u8],
    ) -> Result<Sent<RemoteFile>, CommandError> {
        let reply = self.session_call(
            token,
            "/files/upload_session/finish",
            &json!({"cursor": {"session_id": id, "offset": offset}, "commit": commit}),
            data,
        )?;
        if reply.is_success() {
            return Ok(Sent::Done(parse_entry(&reply.body)?));
        }
        wrong_offset(&reply).map_or_else(
            || Err(upload_error(&reply)),
            |next| Ok(Sent::Continue { next }),
        )
    }
}

/// The error for an answer that is not a success.
fn upload_error(reply: &transfer::Reply) -> CommandError {
    if reply.is_transient() {
        return reply.into_error("The file");
    }
    status_error(reply.status, &reply.body, "The file")
}

/// Where Dropbox says the upload should go on, from a 409 `incorrect_offset`.
fn wrong_offset(reply: &transfer::Reply) -> Option<u64> {
    if reply.status != 409 {
        return None;
    }
    // `append_v2` says it at `error`, `finish` one level deeper (`error.lookup_failed`).
    let value: Value = serde_json::from_slice(&reply.body).ok()?;
    let error = &value["error"];
    error["correct_offset"]
        .as_u64()
        .or_else(|| error["lookup_failed"]["correct_offset"].as_u64())
}

/// A raw answer: status, `Dropbox-API-Result` header and body.
struct Answer {
    result: Option<String>,
    body: Vec<u8>,
}

fn http_agent() -> ureq::Agent {
    // Errors carry a JSON body that tells a conflict from a missing file: read it ourselves.
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn send(
    request: ureq::RequestBuilder<ureq::typestate::WithBody>,
    token: &str,
    body: &[u8],
    what: &str,
) -> Result<Answer, CommandError> {
    let mut response = request
        .header("Authorization", &format!("Bearer {token}"))
        .send(body)
        .map_err(|e| http_error(e, what))?;
    let status = response.status().as_u16();
    let result = response
        .headers()
        .get("dropbox-api-result")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
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
    if status >= 400 {
        return Err(status_error(status, &bytes, what));
    }
    Ok(Answer {
        result,
        body: bytes,
    })
}

/// The first link of a `list_shared_links` answer: its address and, when Dropbox says, its
/// level (`viewer` or `editor`).
fn first_link(body: &[u8]) -> Option<(String, Option<String>)> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let link = value.get("links")?.get(0)?;
    let url = link.get("url")?.as_str()?.to_owned();
    let level = link
        .pointer("/link_permissions/link_access_level/.tag")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some((url, level))
}

/// Dropbox answers a link it will not make (an account without that kind of link) with a 409 that
/// the generic mapping reports as a network problem; for a share it is a refusal.
fn share_refused(error: CommandError) -> CommandError {
    if error.kind == ErrorKind::Network && error.message.contains("(409)") {
        CommandError::new(
            ErrorKind::Io,
            "Dropbox did not allow that kind of link for this file. Try a view link.",
        )
    } else {
        error
    }
}

fn status_error(status: u16, body: &[u8], what: &str) -> CommandError {
    if status == 409 {
        let text = String::from_utf8_lossy(body);
        if text.contains("not_found") {
            return http_error(ureq::Error::StatusCode(404), what);
        }
        if text.contains("conflict") {
            return http_error(ureq::Error::StatusCode(409), what);
        }
        return CommandError::new(
            ErrorKind::Network,
            "The cloud service refused the request (409).",
        );
    }
    http_error(ureq::Error::StatusCode(status), what)
}

/// JSON for a `Dropbox-API-Arg` header: HTTP header values must be ASCII.
fn api_arg(value: &Value) -> String {
    let mut out = String::new();
    for c in value.to_string().chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct Entry {
    #[serde(rename = ".tag")]
    tag: Option<String>,
    id: Option<String>,
    name: String,
    rev: Option<String>,
    #[serde(default)]
    size: u64,
    server_modified: Option<String>,
}

impl Entry {
    fn into_file(self) -> Option<RemoteFile> {
        if self.tag.as_deref().is_some_and(|t| t != "file") {
            return None;
        }
        Some(RemoteFile {
            id: self.id?,
            revision: self.rev?,
            size: self.size,
            modified_ms: self.server_modified.as_deref().map_or(0, parse_time_ms),
            name: self.name,
        })
    }
}

/// `2026-10-27T12:30:00Z` to milliseconds since the Unix epoch, 0 when unreadable.
fn parse_time_ms(text: &str) -> u64 {
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let parse = || {
        let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
        let (h, min, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
        // Days from civil (Howard Hinnant).
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        u64::try_from(((days * 24 + h) * 60 + min) * 60 + s).ok()
    };
    parse().map_or(0, |secs| secs * 1000)
}

fn parse_entry(bytes: &[u8]) -> Result<RemoteFile, CommandError> {
    serde_json::from_slice::<Entry>(bytes)
        .ok()
        .and_then(Entry::into_file)
        .ok_or_else(|| CommandError::new(ErrorKind::Network, "Unexpected answer from Dropbox."))
}

/// Whether the content fits a tab file named `name`.
fn validate(name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    let path = Path::new(name);
    if !has_supported_extension(path) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("{name} is not a file type Smart Beat opens."),
        ));
    }
    if bytes.len() as u64 > MAX_SIZE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!("{name} is too large to open."),
        ));
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let head = &bytes[..bytes.len().min(4096)];
    let xml_root = |tag: &[u8]| {
        let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
        head.trim_ascii_start().starts_with(b"<") && head.windows(tag.len()).any(|w| w == tag)
    };
    let ok = match extension.as_str() {
        "atex" | "txt" => !bytes.is_empty() && !head.contains(&0),
        "mscx" => xml_root(b"<museScore"),
        "mscz" | "capx" | "mxl" => bytes.starts_with(b"PK\x03\x04"),
        _ => ScoreFormat::detect(bytes).is_some(),
    };
    if ok {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorKind::NotAScore,
            format!("{name} is not a valid tab file."),
        ))
    }
}

impl Dropbox {
    fn rpc(
        &self,
        token: &str,
        endpoint: &str,
        body: &Value,
        what: &str,
    ) -> Result<Answer, CommandError> {
        let request = http_agent()
            .post(&format!("{}{endpoint}", self.api_base))
            .header("Content-Type", "application/json");
        send(request, token, body.to_string().as_bytes(), what)
    }

    fn upload(&self, token: &str, arg: &Value, bytes: &[u8]) -> Result<RemoteFile, CommandError> {
        if bytes.len() as u64 > MAX_SIZE {
            return Err(CommandError::new(
                ErrorKind::TooLarge,
                "The file is too large to save.",
            ));
        }
        let request = http_agent()
            .post(&format!("{}/files/upload", self.content_base))
            .header("Content-Type", "application/octet-stream")
            .header("Dropbox-API-Arg", &api_arg(arg));
        let answer = send(request, token, bytes, "The file")?;
        parse_entry(&answer.body)
    }
}

impl Provider for Dropbox {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Dropbox
    }

    fn account_name(&self, token: &str) -> Result<String, CommandError> {
        // The endpoint takes no body at all.
        let request = http_agent().post(&format!("{}/users/get_current_account", self.api_base));
        let answer = send(request, token, b"", "The account")?;
        let value: Value = serde_json::from_slice(&answer.body).unwrap_or(Value::Null);
        value["name"]["display_name"]
            .as_str()
            .or_else(|| value["email"].as_str())
            .map(str::to_owned)
            .ok_or_else(|| CommandError::new(ErrorKind::Network, "Unexpected answer from Dropbox."))
    }

    fn list(&self, token: &str) -> Result<Vec<RemoteFile>, CommandError> {
        let mut files = Vec::new();
        let mut answer = self.rpc(
            token,
            "/files/list_folder",
            &json!({"path": "", "recursive": false, "limit": 2000}),
            "The folder",
        )?;
        loop {
            let page: Value = serde_json::from_slice(&answer.body).map_err(|_| {
                CommandError::new(ErrorKind::Network, "Unexpected answer from Dropbox.")
            })?;
            for entry in page["entries"].as_array().into_iter().flatten() {
                if let Ok(entry) = serde_json::from_value::<Entry>(entry.clone())
                    && let Some(file) = entry.into_file()
                    && (has_supported_extension(Path::new(&file.name))
                        || super::is_stems_name(&file.name))
                {
                    files.push(file);
                }
            }
            match (page["has_more"].as_bool(), page["cursor"].as_str()) {
                (Some(true), Some(cursor)) => {
                    answer = self.rpc(
                        token,
                        "/files/list_folder/continue",
                        &json!({"cursor": cursor}),
                        "The folder",
                    )?;
                }
                _ => break,
            }
        }
        files.sort_by(|a, b| {
            b.modified_ms
                .cmp(&a.modified_ms)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(files)
    }

    fn metadata(&self, token: &str, id: &str) -> Result<RemoteFile, CommandError> {
        let answer = self.rpc(
            token,
            "/files/get_metadata",
            &json!({"path": id}),
            "The file",
        )?;
        parse_entry(&answer.body)
    }

    fn read(&self, token: &str, id: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
        let request = http_agent()
            .post(&format!("{}/files/download", self.content_base))
            .header("Dropbox-API-Arg", &api_arg(&json!({"path": id})));
        let answer = send(request, token, b"", "The file")?;
        let file = answer
            .result
            .as_deref()
            .map(|r| parse_entry(r.as_bytes()))
            .transpose()?
            .ok_or_else(|| {
                CommandError::new(ErrorKind::Network, "Unexpected answer from Dropbox.")
            })?;
        validate(&file.name, &answer.body)?;
        Ok((answer.body, file))
    }

    fn write_if_revision(
        &self,
        token: &str,
        id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, CommandError> {
        self.upload(
            token,
            &json!({
                "path": id,
                "mode": {".tag": "update", "update": revision},
                "autorename": false,
                "mute": true,
            }),
            bytes,
        )
    }

    fn create(&self, token: &str, name: &str, bytes: &[u8]) -> Result<RemoteFile, CommandError> {
        self.upload(
            token,
            &json!({
                "path": format!("/{name}"),
                "mode": "add",
                "autorename": false,
                "mute": true,
            }),
            bytes,
        )
    }

    fn revoke(&self, token: &str) -> Result<(), CommandError> {
        let request = http_agent().post(&format!("{}/auth/token/revoke", self.api_base));
        send(request, token, b"", "The sign-in").map(|_| ())
    }

    fn share_link(&self, token: &str, id: &str, level: ShareLevel) -> Result<String, CommandError> {
        let want = match level {
            ShareLevel::View => "viewer",
            ShareLevel::Edit => "editor",
        };
        // A file that was shared before has a link already, and Dropbox refuses a second one.
        let existing = self.rpc(
            token,
            "/sharing/list_shared_links",
            &json!({"path": id, "direct_only": true}),
            "The file",
        )?;
        let answer = if let Some((url, current)) = first_link(&existing.body) {
            // An old link with the level that is asked for is the answer; one with another
            // level is changed to it (a link made here before has no level of its own to read).
            if current
                .as_deref()
                .map_or(level == ShareLevel::View, |c| c == want)
            {
                return Ok(url);
            }
            self.rpc(
                token,
                "/sharing/modify_shared_link_settings",
                &json!({"url": url, "settings": {"access": want}, "remove_expiration": false}),
                "The file",
            )
        } else {
            self.rpc(
                token,
                "/sharing/create_shared_link_with_settings",
                &json!({"path": id, "settings": {"audience": "public", "access": want}}),
                "The file",
            )
        }
        .map_err(share_refused)?;
        serde_json::from_slice::<Value>(&answer.body)
            .ok()
            .and_then(|v| v.get("url")?.as_str().map(str::to_owned))
            .ok_or_else(|| {
                CommandError::new(
                    ErrorKind::Network,
                    "Unexpected answer from Dropbox: no link for the file",
                )
            })
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
        // Where the file goes: the app folder's root, as for `create`.
        let commit = json!({
            "path": format!("/{name}"),
            "mode": "add",
            "autorename": false,
            "mute": true,
        });
        let session = RefCell::new(None);
        // Dropbox has no way to stop a session: an unfinished one expires by itself.
        transfer::upload_in_chunks(
            &mut source,
            self.chunk_size,
            cancel,
            progress,
            |offset, data, total| self.send_piece(token, &session, &commit, offset, data, total),
            // What does Dropbox have? An empty piece at the offset is answered with the right one.
            |offset, _| {
                let known = session.borrow().clone();
                let Some(id) = known else {
                    return Ok(Sent::Continue { next: 0 });
                };
                let reply = self.session_call(
                    token,
                    "/files/upload_session/append_v2",
                    &json!({"cursor": {"session_id": id, "offset": offset}, "close": false}),
                    &[],
                )?;
                if reply.is_success() {
                    Ok(Sent::Continue { next: offset })
                } else {
                    wrong_offset(&reply).map_or_else(
                        || Err(upload_error(&reply)),
                        |next| Ok(Sent::Continue { next }),
                    )
                }
            },
        )
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
        let mut response = transfer::agent(transfer::DOWNLOAD_LIMIT, false)
            .post(&format!("{}/files/download", self.content_base))
            .header("Dropbox-API-Arg", &api_arg(&json!({"path": id})))
            .header("Authorization", &format!("Bearer {token}"))
            .send_empty()
            .map_err(|e| http_error(e, "The file"))?;
        let status = response.status().as_u16();
        let result = response
            .headers()
            .get("dropbox-api-result")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if status >= 400 {
            let mut body = Vec::new();
            let _ = response
                .body_mut()
                .as_reader()
                .take(64 * 1024)
                .read_to_end(&mut body);
            return Err(status_error(status, &body, "The file"));
        }
        let file = result
            .as_deref()
            .map(|r| parse_entry(r.as_bytes()))
            .transpose()?
            .ok_or_else(|| {
                CommandError::new(ErrorKind::Network, "Unexpected answer from Dropbox.")
            })?;
        transfer::download_to(
            dest,
            file.size,
            &mut response.body_mut().as_reader(),
            cancel,
            progress,
        )?;
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    struct Req {
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

    /// (status, extra headers, body)
    type Canned = (u16, Vec<(&'static str, String)>, Vec<u8>);

    /// Answers one canned response per connection, in order.
    fn mock(responses: Vec<Canned>) -> (String, Arc<Mutex<Vec<Req>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (status, headers, body) in responses {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                let mut req_headers = Vec::new();
                let mut length = 0usize;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.split_once(':') {
                        if k.eq_ignore_ascii_case("content-length") {
                            length = v.trim().parse().unwrap_or(0);
                        }
                        req_headers.push((k.to_owned(), v.trim().to_owned()));
                    }
                }
                let mut req_body = vec![0u8; length];
                reader.read_exact(&mut req_body).unwrap();
                log.lock().unwrap().push(Req {
                    path,
                    headers: req_headers,
                    body: req_body,
                });
                let mut stream = reader.into_inner();
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                for (k, v) in headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                head.push_str("\r\n");
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (url, seen)
    }

    fn ok(body: Value) -> Canned {
        (200, vec![], body.to_string().into_bytes())
    }

    fn file_json(id: &str, name: &str, rev: &str, time: &str) -> Value {
        json!({".tag": "file", "id": id, "name": name, "rev": rev, "size": 4, "server_modified": time})
    }

    #[test]
    fn lists_with_pagination_filtering_and_newest_first() {
        let (url, seen) = mock(vec![
            ok(json!({
                "entries": [
                    file_json("id:1", "old.gp5", "r1", "2026-01-01T00:00:00Z"),
                    {".tag": "folder", "id": "id:f", "name": "sub"},
                    file_json("id:2", "notes.pdf", "r2", "2026-05-01T00:00:00Z"),
                    file_json("id:4", "set.sbstems", "r4", "2026-03-01T00:00:00Z"),
                ],
                "cursor": "c1",
                "has_more": true
            })),
            ok(json!({
                "entries": [file_json("id:3", "new.gp", "r3", "2026-06-01T10:00:00Z")],
                "cursor": "c2",
                "has_more": false
            })),
        ]);
        let files = Dropbox::with_base(&url).list("tok").unwrap();
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["new.gp", "set.sbstems", "old.gp5"]);
        assert_eq!(files[0].id, "id:3");
        assert_eq!(files[0].revision, "r3");
        assert_eq!(files[2].modified_ms, 1_767_225_600_000);
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, "/files/list_folder");
        assert_eq!(seen[1].path, "/files/list_folder/continue");
        assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
        assert!(String::from_utf8_lossy(&seen[1].body).contains("c1"));
    }

    #[test]
    fn reads_and_validates() {
        let meta = file_json("id:1", "a.mid", "r1", "2026-01-01T00:00:00Z").to_string();
        let (url, seen) = mock(vec![(
            200,
            vec![("Dropbox-API-Result", meta)],
            b"MThd1234".to_vec(),
        )]);
        let (bytes, file) = Dropbox::with_base(&url).read("t", "id:1").unwrap();
        assert_eq!(bytes, b"MThd1234");
        assert_eq!(file.revision, "r1");
        assert_eq!(
            seen.lock().unwrap()[0].header("dropbox-api-arg"),
            Some(r#"{"path":"id:1"}"#)
        );
    }

    #[test]
    fn rejects_invalid_content() {
        let meta = file_json("id:1", "a.gp5", "r1", "2026-01-01T00:00:00Z").to_string();
        let (url, _) = mock(vec![(
            200,
            vec![("Dropbox-API-Result", meta)],
            b"not a tab".to_vec(),
        )]);
        let err = Dropbox::with_base(&url).read("t", "id:1").unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAScore);
    }

    #[test]
    fn creates_with_escaped_non_ascii_name() {
        let (url, seen) = mock(vec![ok(file_json(
            "id:9",
            "Étude 🎸.gp",
            "r9",
            "2026-01-01T00:00:00Z",
        ))]);
        let file = Dropbox::with_base(&url)
            .create("t", "Étude 🎸.gp", b"PK\x03\x04")
            .unwrap();
        assert_eq!(file.id, "id:9");
        let seen = seen.lock().unwrap();
        let arg = seen[0].header("dropbox-api-arg").unwrap();
        assert!(arg.is_ascii());
        assert!(arg.contains(r"\u00c9tude \ud83c\udfb8.gp"));
        let parsed: Value = serde_json::from_str(arg).unwrap();
        assert_eq!(parsed["path"], "/Étude 🎸.gp");
        assert_eq!(parsed["mode"], "add");
        assert_eq!(parsed["autorename"], false);
        assert_eq!(seen[0].body, b"PK\x03\x04");
    }

    #[test]
    fn updates_with_revision() {
        let (url, seen) = mock(vec![ok(file_json(
            "id:1",
            "a.gp",
            "r2",
            "2026-01-01T00:00:00Z",
        ))]);
        let file = Dropbox::with_base(&url)
            .write_if_revision("t", "id:1", "r1", b"x")
            .unwrap();
        assert_eq!(file.revision, "r2");
        let arg: Value =
            serde_json::from_str(seen.lock().unwrap()[0].header("dropbox-api-arg").unwrap())
                .unwrap();
        assert_eq!(arg["mode"], json!({".tag": "update", "update": "r1"}));
        assert_eq!(arg["autorename"], false);
        assert_eq!(arg["path"], "id:1");
    }

    #[test]
    fn update_conflict_maps_to_conflict() {
        let body = json!({"error_summary": "path/conflict/file/..", "error": {".tag": "path"}});
        let (url, _) = mock(vec![(409, vec![], body.to_string().into_bytes())]);
        let err = Dropbox::with_base(&url)
            .write_if_revision("t", "id:1", "r1", b"x")
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
    }

    #[test]
    fn shares_with_a_new_view_link_or_the_one_that_exists() {
        let (url, seen) = mock(vec![
            ok(json!({"links": []})),
            ok(json!({"url": "https://www.dropbox.com/s/new/a.gp?dl=0"})),
            ok(json!({"links": [{"url": "https://www.dropbox.com/s/old/a.gp?dl=0"}]})),
        ]);
        let dropbox = Dropbox::with_base(&url);
        assert_eq!(
            dropbox.share_link("t", "id:1", ShareLevel::View).unwrap(),
            "https://www.dropbox.com/s/new/a.gp?dl=0"
        );
        assert_eq!(
            dropbox.share_link("t", "id:1", ShareLevel::View).unwrap(),
            "https://www.dropbox.com/s/old/a.gp?dl=0"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, "/sharing/list_shared_links");
        assert_eq!(seen[1].path, "/sharing/create_shared_link_with_settings");
        let body: Value = serde_json::from_slice(&seen[1].body).unwrap();
        assert_eq!(body["settings"]["access"], "viewer");
    }

    #[test]
    fn makes_a_new_edit_link_with_the_editor_level() {
        let (url, seen) = mock(vec![
            ok(json!({"links": []})),
            ok(json!({"url": "https://www.dropbox.com/s/new/a.gp?dl=0"})),
        ]);
        let link = Dropbox::with_base(&url)
            .share_link("t", "id:1", ShareLevel::Edit)
            .unwrap();
        assert_eq!(link, "https://www.dropbox.com/s/new/a.gp?dl=0");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[1].path, "/sharing/create_shared_link_with_settings");
        let body: Value = serde_json::from_slice(&seen[1].body).unwrap();
        assert_eq!(body["settings"]["access"], "editor");
    }

    #[test]
    fn an_old_link_with_another_level_is_changed_and_one_with_the_level_is_kept() {
        let viewer = json!({"links": [{
            "url": "https://www.dropbox.com/s/old/a.gp?dl=0",
            "link_permissions": {"link_access_level": {".tag": "viewer"}}
        }]});
        let editor = json!({"links": [{
            "url": "https://www.dropbox.com/s/old/a.gp?dl=0",
            "link_permissions": {"link_access_level": {".tag": "editor"}}
        }]});
        let (url, seen) = mock(vec![
            ok(viewer.clone()),
            ok(json!({"url": "https://www.dropbox.com/s/old/a.gp?dl=0"})),
            ok(editor.clone()),
            ok(viewer),
            ok(json!({"url": "https://www.dropbox.com/s/old/a.gp?dl=0"})),
            ok(editor),
        ]);
        let dropbox = Dropbox::with_base(&url);
        // Viewer to editor: changed.
        dropbox.share_link("t", "id:1", ShareLevel::Edit).unwrap();
        // Editor asked for as an editor: kept, nothing changed.
        dropbox.share_link("t", "id:1", ShareLevel::Edit).unwrap();
        // Viewer asked for as a viewer: kept.
        dropbox.share_link("t", "id:1", ShareLevel::View).unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[1].path, "/sharing/modify_shared_link_settings");
        let body: Value = serde_json::from_slice(&seen[1].body).unwrap();
        assert_eq!(body["settings"]["access"], "editor");
        assert_eq!(seen[2].path, "/sharing/list_shared_links");
        assert_eq!(seen[3].path, "/sharing/list_shared_links");
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn a_link_dropbox_refuses_is_explained_and_a_missing_permission_asks_to_connect_again() {
        let (url, _) = mock(vec![
            ok(json!({"links": []})),
            (
                409,
                vec![],
                br#"{"error_summary":"settings_error/.."}"#.to_vec(),
            ),
            (
                401,
                vec![],
                br#"{"error_summary":"missing_scope/.."}"#.to_vec(),
            ),
        ]);
        let dropbox = Dropbox::with_base(&url);
        let refused = dropbox
            .share_link("t", "id:1", ShareLevel::Edit)
            .unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Io);
        assert!(refused.message.contains("Try a view link"));
        assert_eq!(
            dropbox
                .share_link("t", "id:1", ShareLevel::View)
                .unwrap_err()
                .kind,
            ErrorKind::AuthExpired
        );
    }

    #[test]
    fn missing_file_and_expired_token() {
        let (url, _) = mock(vec![
            (
                409,
                vec![],
                br#"{"error_summary":"path/not_found/.."}"#.to_vec(),
            ),
            (
                401,
                vec![],
                br#"{"error_summary":"expired_access_token/"}"#.to_vec(),
            ),
        ]);
        let dropbox = Dropbox::with_base(&url);
        assert_eq!(
            dropbox.metadata("t", "id:1").unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(dropbox.list("t").unwrap_err().kind, ErrorKind::AuthExpired);
    }

    #[test]
    fn account_name_and_revoke() {
        let (url, seen) = mock(vec![
            ok(json!({"name": {"display_name": "Ada L"}, "email": "a@x.org"})),
            (200, vec![], b"null".to_vec()),
        ]);
        let dropbox = Dropbox::with_base(&url);
        assert_eq!(dropbox.account_name("t").unwrap(), "Ada L");
        dropbox.revoke("t").unwrap();
        assert_eq!(seen.lock().unwrap()[1].path, "/auth/token/revoke");
    }

    #[test]
    fn sign_in_listens_only_on_the_registered_loopback_addresses() {
        let config = oauth_config("id");
        assert_eq!(config.redirect_ports, REDIRECT_PORTS);
        // These exact strings are what is registered in the Dropbox app console: Dropbox
        // compares the redirect address exactly, port and trailing slash included.
        assert_eq!(
            redirect_uris(),
            [
                "http://127.0.0.1:53682/",
                "http://127.0.0.1:53683/",
                "http://127.0.0.1:53684/",
                "http://127.0.0.1:53685/",
                "http://127.0.0.1:53686/",
            ]
        );
        for port in REDIRECT_PORTS {
            let uri = crate::cloud::oauth::Loopback::redirect_uri_for("127.0.0.1", port);
            assert!(redirect_uris().contains(&uri), "{uri}");
        }
    }

    #[test]
    fn requests_the_listed_scopes() {
        let config = oauth_config("key");
        assert_eq!(
            config.scopes.join(" "),
            "files.content.read files.content.write files.metadata.read account_info.read sharing.read sharing.write"
        );
        assert!(
            config
                .extra_auth_params
                .contains(&("token_access_type".into(), "offline".into()))
        );
        assert_eq!(config.token_url, "https://api.dropboxapi.com/oauth2/token");
    }

    #[test]
    fn parses_server_times() {
        assert_eq!(parse_time_ms("1970-01-02T00:00:01Z"), 86_401_000);
        assert_eq!(parse_time_ms("junk"), 0);
    }

    fn file_with(len: usize) -> (tempfile::TempDir, std::path::PathBuf, Vec<u8>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Song.sbstems");
        let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        (dir, path, bytes)
    }

    fn arg_of(req: &Req) -> Value {
        serde_json::from_str(req.header("dropbox-api-arg").unwrap()).unwrap()
    }

    fn entry(len: usize) -> Value {
        json!({".tag": "file", "id": "id:n1", "name": "Song.sbstems", "rev": "r1", "size": len, "server_modified": "2026-06-01T10:00:00Z"})
    }

    #[test]
    fn uploads_a_file_through_a_session_in_chunks_with_progress() {
        let (_dir, path, bytes) = file_with(10);
        let (url, seen) = mock(vec![
            ok(json!({"session_id": "sid"})),
            (200, vec![], b"null".to_vec()),
            ok(entry(10)),
        ]);
        let mut fractions = Vec::new();
        let file = Dropbox::with_base(&url)
            .with_chunk_size(4)
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |f| fractions.push(f),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!((file.id.as_str(), file.revision.as_str()), ("id:n1", "r1"));
        assert_eq!(fractions, vec![0.4, 0.8, 1.0]);
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
            [
                "/files/upload_session/start",
                "/files/upload_session/append_v2",
                "/files/upload_session/finish"
            ]
        );
        assert!(
            seen.iter()
                .all(|r| r.header("authorization") == Some("Bearer tok"))
        );
        assert_eq!(
            arg_of(&seen[1])["cursor"],
            json!({"session_id": "sid", "offset": 4})
        );
        let finish = arg_of(&seen[2]);
        assert_eq!(finish["cursor"], json!({"session_id": "sid", "offset": 8}));
        assert_eq!(finish["commit"]["path"], "/Song.sbstems");
        assert_eq!(finish["commit"]["mode"], "add");
        assert_eq!(finish["commit"]["autorename"], false);
        let sent: Vec<u8> = seen.iter().flat_map(|r| r.body.clone()).collect();
        assert_eq!(sent, bytes);
    }

    #[test]
    fn a_file_that_fits_one_piece_is_started_then_finished() {
        let (_dir, path, bytes) = file_with(3);
        let (url, seen) = mock(vec![ok(json!({"session_id": "sid"})), ok(entry(3))]);
        Dropbox::with_base(&url)
            .with_chunk_size(4)
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].body, bytes);
        assert_eq!(arg_of(&seen[1])["cursor"]["offset"], 3);
        assert!(seen[1].body.is_empty());
    }

    #[test]
    fn a_chunk_that_fails_goes_on_from_the_offset_dropbox_names() {
        let (_dir, path, bytes) = file_with(10);
        let (url, seen) = mock(vec![
            ok(json!({"session_id": "sid"})),
            // The second piece fails although Dropbox took it ...
            (503, vec![], b"busy".to_vec()),
            // ... asking with nothing says where it is: 8.
            (
                409,
                vec![],
                json!({"error_summary": "incorrect_offset/..", "error": {".tag": "incorrect_offset", "correct_offset": 8}})
                    .to_string()
                    .into_bytes(),
            ),
            ok(entry(10)),
        ]);
        Dropbox::with_base(&url)
            .with_chunk_size(4)
            .upload_file(
                "tok",
                "Song.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        let seen = seen.lock().unwrap();
        let offsets: Vec<(String, Option<u64>)> = seen
            .iter()
            .map(|r| (r.path.clone(), arg_of(r)["cursor"]["offset"].as_u64()))
            .collect();
        assert_eq!(
            offsets,
            [
                ("/files/upload_session/start".to_owned(), None),
                ("/files/upload_session/append_v2".to_owned(), Some(4)),
                ("/files/upload_session/append_v2".to_owned(), Some(4)),
                ("/files/upload_session/finish".to_owned(), Some(8)),
            ]
        );
        assert!(seen[2].body.is_empty());
        assert_eq!(seen[3].body, bytes[8..]);
    }

    #[test]
    fn a_stop_ends_the_upload_between_pieces() {
        let (_dir, path, _) = file_with(10);
        let (url, seen) = mock(vec![ok(json!({"session_id": "sid"}))]);
        let cancel = AtomicBool::new(false);
        let error = Dropbox::with_base(&url)
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
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_expired_token_on_start_means_auth_expired() {
        let (_dir, path, _) = file_with(10);
        let (url, _) = mock(vec![(401, vec![], b"{}".to_vec())]);
        let error = Dropbox::with_base(&url)
            .upload_file(
                "old",
                "a.sbstems",
                &path,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
    }

    #[test]
    fn downloads_to_a_file_with_no_part_file_left() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Song.sbstems");
        let content: Vec<u8> = (0..12u8).collect();
        let (url, seen) = mock(vec![(
            200,
            vec![("Dropbox-API-Result", entry(12).to_string())],
            content.clone(),
        )]);
        let mut fractions = Vec::new();
        let file = Dropbox::with_base(&url)
            .download_file(
                "tok",
                "id:n1",
                &dest,
                &mut |f| fractions.push(f),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(file.revision, "r1");
        assert_eq!(std::fs::read(&dest).unwrap(), content);
        assert!(!dir.path().join("Song.sbstems.part").exists());
        assert_eq!(fractions.last(), Some(&1.0));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, "/files/download");
        assert_eq!(arg_of(&seen[0]), json!({"path": "id:n1"}));
        assert_eq!(seen[0].header("authorization"), Some("Bearer tok"));
    }

    #[test]
    fn a_failed_or_stopped_download_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Song.sbstems");
        let (url, _) = mock(vec![(
            409,
            vec![],
            br#"{"error_summary":"path/not_found/.."}"#.to_vec(),
        )]);
        let error = Dropbox::with_base(&url)
            .download_file("tok", "id:n1", &dest, &mut |_| {}, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(!dest.exists());

        let error = Dropbox::with_base("http://127.0.0.1:1")
            .download_file("tok", "id:n1", &dest, &mut |_| {}, &AtomicBool::new(true))
            .unwrap_err();
        assert!(transfer::is_stopped(&error));
        assert!(!dest.exists());
        assert!(!dir.path().join("Song.sbstems.part").exists());
    }
}
