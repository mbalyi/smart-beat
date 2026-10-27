//! IPC commands for direct cloud access (#187, phase 2): connect, list, read, save and create
//! tabs in Google Drive, OneDrive and Dropbox, and the offline queue.
//!
//! Tokens stay in the [`TokenStore`] (the OS keychain): they are never returned to the webview,
//! logged or sent to telemetry. The webview only sees provider names, account labels and item
//! ids (`drive:<id>`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::cloud::keychain::{Keychain, TokenStore};
use crate::cloud::oauth::{self, OAuthConfig, Session};
use crate::cloud::pending::{PendingStore, PendingUpload};
use crate::cloud::{self, Provider, ProviderKind, RemoteFile, dropbox, google_drive, onedrive};
use crate::error::{CommandError, ErrorKind};
use crate::score_file::MAX_SIZE;
use crate::score_write;

/// How long the browser sign-in may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long the system keychain may take to store the sign-in. A Keychain access prompt that
/// nobody answers would otherwise block the sign-in forever.
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(30);
/// Added to the browser wait for the token exchange, the account lookup and the keychain
/// write: the whole sign-in never takes longer, so the Connect button cannot wait forever.
const AFTER_BROWSER_TIMEOUT: Duration = Duration::from_secs(90);

/// The registered client id of a provider, `None` in builds without one.
fn client_id(kind: ProviderKind) -> Option<&'static str> {
    let id = match kind {
        ProviderKind::Drive => google_drive::CLIENT_ID,
        ProviderKind::Onedrive => onedrive::CLIENT_ID,
        ProviderKind::Dropbox => dropbox::CLIENT_ID,
    };
    // A secret that is not set in the release pipeline arrives as an empty string.
    id.filter(|id| !id.trim().is_empty())
}

/// OAuth endpoints of a provider. Without a client id the config is only a placeholder: no
/// tokens can exist then, so it is never used to refresh.
fn config_for(kind: ProviderKind) -> OAuthConfig {
    let id = client_id(kind).unwrap_or_default();
    match kind {
        ProviderKind::Drive => google_drive::oauth_config(id),
        ProviderKind::Onedrive => onedrive::oauth_config(id),
        ProviderKind::Dropbox => dropbox::oauth_config(id),
    }
}

/// The one place that maps a provider kind to its implementation.
pub fn provider_for(kind: ProviderKind) -> Box<dyn Provider> {
    match kind {
        ProviderKind::Drive => Box::new(google_drive::GoogleDrive::default()),
        ProviderKind::Onedrive => Box::new(onedrive::OneDrive::default()),
        ProviderKind::Dropbox => Box::new(dropbox::Dropbox::default()),
    }
}

/// What the app remembers about an open cloud tab: the revision it started from (for the
/// conflict check) and its file name (for the extension check and the offline queue).
#[derive(Debug, Clone)]
struct Open {
    revision: String,
    name: String,
}

/// Managed state of the cloud commands.
pub struct CloudState {
    store: Arc<dyn TokenStore>,
    /// Bumped by every new sign-in and by Cancel: a sign-in whose number is no longer current
    /// stops waiting and may not store tokens.
    connect_epoch: Arc<AtomicU64>,
    pending: PendingStore,
    open: Mutex<HashMap<String, Open>>,
    make: fn(ProviderKind) -> Box<dyn Provider>,
}

impl CloudState {
    /// The real thing: OS keychain and real providers.
    pub fn new(pending_dir: impl Into<std::path::PathBuf>) -> Self {
        Self::with_parts(Box::new(Keychain), pending_dir, provider_for)
    }

    /// Custom token store and providers (tests).
    pub fn with_parts(
        store: Box<dyn TokenStore>,
        pending_dir: impl Into<std::path::PathBuf>,
        make: fn(ProviderKind) -> Box<dyn Provider>,
    ) -> Self {
        Self {
            store: Arc::from(store),
            connect_epoch: Arc::new(AtomicU64::new(0)),
            pending: PendingStore::new(pending_dir),
            open: Mutex::new(HashMap::new()),
            make,
        }
    }

    fn open_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Open>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn remember(&self, kind: ProviderKind, file: &RemoteFile) {
        self.open_map().insert(
            cloud::item_id(kind, &file.id),
            Open {
                revision: file.revision.clone(),
                name: file.name.clone(),
            },
        );
    }

    /// A valid access token (refreshed when needed).
    fn token(&self, kind: ProviderKind) -> Result<String, CommandError> {
        let config = config_for(kind);
        Session {
            kind,
            config: &config,
            store: self.store.as_ref(),
        }
        .token()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CloudAccount {
    pub provider: ProviderKind,
    pub label: String,
    /// This build has a registered client id for the provider.
    pub configured: bool,
    /// The signed-in account, if any.
    pub account: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FlushResult {
    pub name: String,
    /// `uploaded`, `conflict` or `waiting`.
    pub outcome: String,
}

fn parse_item(item: &str) -> Result<(ProviderKind, &str), CommandError> {
    cloud::parse_item_id(item)
        .ok_or_else(|| CommandError::new(ErrorKind::NotFound, "That is not a cloud file."))
}

fn not_set_up() -> CommandError {
    CommandError::new(
        ErrorKind::Io,
        "This cloud service is not set up in this build.",
    )
}

fn check_writable(name: &str, len: usize) -> Result<(), CommandError> {
    if !score_write::has_writable_extension(Path::new(name)) {
        return Err(CommandError::new(
            ErrorKind::UnsupportedType,
            format!("“{name}” has an extension Smart Beat does not save."),
        ));
    }
    if len as u64 > MAX_SIZE {
        return Err(CommandError::new(
            ErrorKind::TooLarge,
            format!(
                "“{name}” would be larger than {} MB.",
                MAX_SIZE / (1024 * 1024)
            ),
        ));
    }
    Ok(())
}

// ---- Logic (no Tauri types, so tests can drive it) ----

pub fn accounts(state: &CloudState) -> Vec<CloudAccount> {
    ProviderKind::ALL
        .into_iter()
        .map(|kind| CloudAccount {
            provider: kind,
            label: kind.label().to_owned(),
            configured: client_id(kind).is_some(),
            account: state
                .store
                .load(kind)
                .ok()
                .flatten()
                .map(|t| t.account)
                .filter(|a| !a.is_empty()),
        })
        .collect()
}

pub fn disconnect(state: &CloudState, kind: ProviderKind) -> Result<(), CommandError> {
    if let Ok(Some(tokens)) = state.store.load(kind) {
        let _ = (state.make)(kind).revoke(&tokens.access_token);
    }
    state.store.delete(kind)?;
    let prefix = format!("{}:", kind.prefix());
    state
        .open_map()
        .retain(|item, _| !item.starts_with(&prefix));
    Ok(())
}

pub fn list(state: &CloudState, kind: ProviderKind) -> Result<Vec<RemoteFile>, CommandError> {
    let token = state.token(kind)?;
    (state.make)(kind).list(&token)
}

pub fn read(state: &CloudState, item: &str) -> Result<Vec<u8>, CommandError> {
    let (kind, id) = parse_item(item)?;
    let token = state.token(kind)?;
    let (bytes, file) = (state.make)(kind).read(&token, id)?;
    state.remember(kind, &file);
    Ok(bytes)
}

/// Saves over the file opened earlier. Returns `"saved"` or, when the cloud is unreachable,
/// `"queued"` (the edit is kept and sent on reconnect).
pub fn save(state: &CloudState, item: &str, bytes: &[u8]) -> Result<&'static str, CommandError> {
    let (kind, id) = parse_item(item)?;
    let Some(open) = state.open_map().get(item).cloned() else {
        return Err(CommandError::new(
            ErrorKind::Conflict,
            "This file was not opened from the cloud in this session. Save a copy instead.",
        ));
    };
    check_writable(&open.name, bytes.len())?;
    let result = state
        .token(kind)
        .and_then(|token| (state.make)(kind).write_if_revision(&token, id, &open.revision, bytes));
    match result {
        Ok(file) => {
            state.remember(kind, &file);
            Ok("saved")
        }
        Err(e) if e.kind == ErrorKind::Network => {
            state.pending.enqueue(
                PendingUpload {
                    provider: kind,
                    id: id.to_owned(),
                    name: open.name,
                    revision: open.revision,
                    conflict: false,
                },
                bytes,
            )?;
            Ok("queued")
        }
        Err(e) => Err(e),
    }
}

pub fn create(
    state: &CloudState,
    kind: ProviderKind,
    name: &str,
    bytes: &[u8],
) -> Result<String, CommandError> {
    check_writable(name, bytes.len())?;
    let token = state.token(kind)?;
    let file = (state.make)(kind).create(&token, name, bytes)?;
    state.remember(kind, &file);
    Ok(cloud::item_id(kind, &file.id))
}

pub fn flush(state: &CloudState) -> Result<Vec<FlushResult>, CommandError> {
    let mut results = Vec::new();
    for kind in ProviderKind::ALL {
        if !matches!(state.store.load(kind), Ok(Some(_))) {
            continue;
        }
        let token = state.token(kind)?;
        let provider = (state.make)(kind);
        for (entry, outcome) in state.pending.flush(provider.as_ref(), &token)? {
            let item = cloud::item_id(kind, &entry.id);
            if outcome == cloud::pending::Outcome::Uploaded
                && let Ok(file) = provider.metadata(&token, &entry.id)
                && state.open_map().contains_key(&item)
            {
                // The open tab continues from the revision the upload produced.
                state.remember(kind, &file);
            }
            results.push(FlushResult {
                name: entry.name,
                outcome: serde_json::to_value(&outcome)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default(),
            });
        }
    }
    Ok(results)
}

pub fn discard_pending(state: &CloudState, item: &str) -> Result<(), CommandError> {
    let (kind, id) = parse_item(item)?;
    state.pending.discard(kind, id)
}

/// Limits of one sign-in; tests shorten them.
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// Waiting for the browser redirect.
    browser: Duration,
    /// Writing the tokens to the keychain.
    keychain: Duration,
    /// The whole sign-in.
    overall: Duration,
}

const STAGE_STARTED: u8 = 0;
const STAGE_BROWSER_OPENED: u8 = 1;
const STAGE_ACCOUNT_LOOKUP: u8 = 2;
const STAGE_KEYCHAIN_SAVE: u8 = 3;

/// One line per step on stderr (visible in a terminal run or Console.app) to see where a
/// sign-in stops. Never contains codes, tokens or secrets.
fn trace(kind: ProviderKind, step: &str) {
    eprintln!("[smart-beat] cloud sign-in {}: {step}", kind.prefix());
}

fn cancelled() -> CommandError {
    CommandError::new(ErrorKind::Io, "The sign-in was cancelled.")
}

/// Records how far the sign-in got: the provider is asked for the account name right after
/// the token exchange succeeded.
struct Traced {
    inner: Box<dyn Provider>,
    stage: Arc<AtomicU8>,
}

impl Provider for Traced {
    fn kind(&self) -> ProviderKind {
        self.inner.kind()
    }
    fn account_name(&self, token: &str) -> Result<String, CommandError> {
        self.stage
            .store(STAGE_ACCOUNT_LOOKUP, AtomicOrdering::SeqCst);
        trace(
            self.kind(),
            "code_received, token exchanged, looking up the account",
        );
        self.inner.account_name(token)
    }
    fn list(&self, token: &str) -> Result<Vec<RemoteFile>, CommandError> {
        self.inner.list(token)
    }
    fn metadata(&self, token: &str, id: &str) -> Result<RemoteFile, CommandError> {
        self.inner.metadata(token, id)
    }
    fn read(&self, token: &str, id: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
        self.inner.read(token, id)
    }
    fn write_if_revision(
        &self,
        token: &str,
        id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, CommandError> {
        self.inner.write_if_revision(token, id, revision, bytes)
    }
    fn create(&self, token: &str, name: &str, bytes: &[u8]) -> Result<RemoteFile, CommandError> {
        self.inner.create(token, name, bytes)
    }
    fn revoke(&self, token: &str) -> Result<(), CommandError> {
        self.inner.revoke(token)
    }
}

/// The token store as one sign-in sees it: a cancelled sign-in may not store tokens, and a
/// keychain that does not answer (an unanswered access prompt) becomes an error.
struct GuardedStore {
    inner: Arc<dyn TokenStore>,
    epoch: Arc<AtomicU64>,
    mine: u64,
    stage: Arc<AtomicU8>,
    timeout: Duration,
}

impl TokenStore for GuardedStore {
    fn load(&self, kind: ProviderKind) -> Result<Option<cloud::Tokens>, CommandError> {
        self.inner.load(kind)
    }
    fn save(&self, kind: ProviderKind, tokens: &cloud::Tokens) -> Result<(), CommandError> {
        if self.epoch.load(AtomicOrdering::SeqCst) != self.mine {
            return Err(cancelled());
        }
        self.stage
            .store(STAGE_KEYCHAIN_SAVE, AtomicOrdering::SeqCst);
        let (tx, rx) = mpsc::channel();
        let inner = Arc::clone(&self.inner);
        let tokens = tokens.clone();
        std::thread::spawn(move || {
            let _ = tx.send(inner.save(kind, &tokens));
        });
        rx.recv_timeout(self.timeout).unwrap_or_else(|_| {
            Err(CommandError::new(
                ErrorKind::Io,
                "The system keychain did not answer. Allow Smart Beat in the Keychain \
                 prompt (it may be behind other windows) and connect again.",
            ))
        })
    }
    fn delete(&self, kind: ProviderKind) -> Result<(), CommandError> {
        self.inner.delete(kind)
    }
}

/// Stops the sign-in that is waiting (the Cancel button): it returns at once and cannot store
/// tokens afterwards.
pub fn cancel_connect(state: &CloudState) {
    state.connect_epoch.fetch_add(1, AtomicOrdering::SeqCst);
}

/// Runs the browser sign-in and returns the account name. Always returns within the limits,
/// whatever the browser, the network or the keychain do.
pub fn connect(
    state: &CloudState,
    kind: ProviderKind,
    open_browser: impl FnOnce(&str) -> Result<(), CommandError> + Send + 'static,
    timeout: Duration,
) -> Result<String, CommandError> {
    if client_id(kind).is_none() {
        return Err(not_set_up());
    }
    let limits = Limits {
        browser: timeout,
        keychain: KEYCHAIN_TIMEOUT,
        overall: timeout + AFTER_BROWSER_TIMEOUT,
    };
    connect_with(state, kind, config_for(kind), open_browser, limits)
}

fn connect_with(
    state: &CloudState,
    kind: ProviderKind,
    config: OAuthConfig,
    open_browser: impl FnOnce(&str) -> Result<(), CommandError> + Send + 'static,
    limits: Limits,
) -> Result<String, CommandError> {
    // A new sign-in replaces one that is still waiting.
    let mine = state.connect_epoch.fetch_add(1, AtomicOrdering::SeqCst) + 1;
    let stage = Arc::new(AtomicU8::new(STAGE_STARTED));
    let provider = Traced {
        inner: (state.make)(kind),
        stage: Arc::clone(&stage),
    };
    let store = GuardedStore {
        inner: Arc::clone(&state.store),
        epoch: Arc::clone(&state.connect_epoch),
        mine,
        stage: Arc::clone(&stage),
        timeout: limits.keychain,
    };
    let (tx, rx) = mpsc::channel();
    let worker_stage = Arc::clone(&stage);
    std::thread::spawn(move || {
        let opener = move |url: &str| {
            open_browser(url)?;
            worker_stage.store(STAGE_BROWSER_OPENED, AtomicOrdering::SeqCst);
            trace(kind, "browser_opened, waiting for the redirect");
            Ok(())
        };
        let result = oauth::sign_in(&provider, &config, &store, opener, limits.browser)
            .map(|tokens| tokens.account);
        let _ = tx.send(result);
    });

    let deadline = Instant::now() + limits.overall;
    let result = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(result) => break result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if state.connect_epoch.load(AtomicOrdering::SeqCst) != mine {
                    break Err(cancelled());
                }
                if Instant::now() >= deadline {
                    // Whatever still runs may not store tokens any more.
                    state.connect_epoch.fetch_add(1, AtomicOrdering::SeqCst);
                    break Err(CommandError::new(
                        ErrorKind::Network,
                        "The sign-in took too long. Try again.",
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(CommandError::new(
                    ErrorKind::Io,
                    "The sign-in stopped unexpectedly.",
                ));
            }
        }
    };
    trace_outcome(kind, stage.load(AtomicOrdering::SeqCst), &result);
    result
}

fn trace_outcome(kind: ProviderKind, stage: u8, result: &Result<String, CommandError>) {
    let Err(e) = result else {
        return trace(kind, "done");
    };
    let what = match stage {
        STAGE_STARTED => "browser_open_failed",
        STAGE_BROWSER_OPENED if e.message.contains("timed out") => "timed_out_waiting_for_browser",
        STAGE_BROWSER_OPENED => "redirect_or_token_exchange_failed",
        STAGE_ACCOUNT_LOOKUP => "account_lookup_failed",
        _ => "keychain_save_failed",
    };
    trace(kind, &format!("{what} ({:?}): {}", e.kind, e.message));
}

// ---- Tauri commands ----

/// Decodes a header sent through `encodeURIComponent`.
fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, CommandError> {
    let invalid = || CommandError::new(ErrorKind::Io, format!("The {name} is missing or invalid."));
    let value = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(invalid)?;
    crate::commands::percent_decode(value).ok_or_else(invalid)
}

fn body<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], CommandError> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err(CommandError::new(
            ErrorKind::Io,
            "The file content is missing.",
        )),
    }
}

fn kind_from_header(value: &str) -> Result<ProviderKind, CommandError> {
    ProviderKind::ALL
        .into_iter()
        .find(|k| k.prefix() == value)
        .ok_or_else(|| CommandError::new(ErrorKind::Io, "Unknown cloud service."))
}

#[tauri::command(async)]
pub fn cloud_accounts(state: tauri::State<'_, CloudState>) -> Vec<CloudAccount> {
    accounts(&state)
}

#[tauri::command]
pub async fn cloud_connect<R: Runtime>(
    app: AppHandle<R>,
    provider: ProviderKind,
) -> Result<String, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CloudState>();
        let opener = app.clone();
        connect(
            &state,
            provider,
            move |url| {
                opener.opener().open_url(url, None::<&str>).map_err(|e| {
                    CommandError::new(ErrorKind::Io, format!("The browser could not open: {e}"))
                })
            },
            SIGN_IN_TIMEOUT,
        )
    })
    .await
    .map_err(|e| CommandError::new(ErrorKind::Io, format!("The sign-in stopped: {e}")))?
}

#[tauri::command(async)]
pub fn cloud_cancel_connect(state: tauri::State<'_, CloudState>) {
    cancel_connect(&state);
}

#[tauri::command(async)]
pub fn cloud_disconnect(
    state: tauri::State<'_, CloudState>,
    provider: ProviderKind,
) -> Result<(), CommandError> {
    disconnect(&state, provider)
}

#[tauri::command(async)]
pub fn cloud_list(
    state: tauri::State<'_, CloudState>,
    provider: ProviderKind,
) -> Result<Vec<RemoteFile>, CommandError> {
    list(&state, provider)
}

#[tauri::command(async)]
pub fn cloud_read(
    state: tauri::State<'_, CloudState>,
    item: String,
) -> Result<tauri::ipc::Response, CommandError> {
    read(&state, &item).map(tauri::ipc::Response::new)
}

/// Body: the file bytes. Header `item`: the (URL-encoded) item id.
#[tauri::command(async)]
pub fn cloud_save(
    state: tauri::State<'_, CloudState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, CommandError> {
    let item = header(&request, "item")?;
    save(&state, &item, body(&request)?).map(str::to_owned)
}

/// Body: the file bytes. Headers `provider` and `name` (URL-encoded). Returns the item id.
#[tauri::command(async)]
pub fn cloud_create(
    state: tauri::State<'_, CloudState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, CommandError> {
    let kind = kind_from_header(&header(&request, "provider")?)?;
    let name = header(&request, "name")?;
    create(&state, kind, &name, body(&request)?)
}

#[tauri::command(async)]
pub fn cloud_pending(state: tauri::State<'_, CloudState>) -> Vec<PendingUpload> {
    state.pending.list()
}

#[tauri::command(async)]
pub fn cloud_flush(state: tauri::State<'_, CloudState>) -> Result<Vec<FlushResult>, CommandError> {
    flush(&state)
}

#[tauri::command(async)]
pub fn cloud_discard_pending(
    state: tauri::State<'_, CloudState>,
    item: String,
) -> Result<(), CommandError> {
    discard_pending(&state, &item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::Tokens;
    use crate::cloud::keychain::MemoryStore;
    use std::sync::atomic::{AtomicU8, Ordering};

    /// 0 = fine, 1 = offline, 2 = remote moved on.
    static MODE: AtomicU8 = AtomicU8::new(0);
    static LOCK: Mutex<()> = Mutex::new(());

    struct Fake;

    fn file(name: &str, revision: &str) -> RemoteFile {
        RemoteFile {
            id: "f1".into(),
            name: name.into(),
            revision: revision.into(),
            size: 3,
            modified_ms: 1,
        }
    }

    impl Provider for Fake {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Drive
        }
        fn account_name(&self, _: &str) -> Result<String, CommandError> {
            Ok("me".into())
        }
        fn list(&self, _: &str) -> Result<Vec<RemoteFile>, CommandError> {
            Ok(vec![file("a.gp", "r1")])
        }
        fn metadata(&self, _: &str, _: &str) -> Result<RemoteFile, CommandError> {
            Ok(file("a.gp", "r2"))
        }
        fn read(&self, _: &str, _: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
            Ok((b"abc".to_vec(), file("a.gp", "r1")))
        }
        fn write_if_revision(
            &self,
            _: &str,
            _: &str,
            revision: &str,
            _: &[u8],
        ) -> Result<RemoteFile, CommandError> {
            match MODE.load(Ordering::SeqCst) {
                1 => Err(CommandError::new(ErrorKind::Network, "offline")),
                2 => Err(CommandError::new(ErrorKind::Conflict, "moved")),
                _ => Ok(file("a.gp", &format!("after-{revision}"))),
            }
        }
        fn create(&self, _: &str, name: &str, _: &[u8]) -> Result<RemoteFile, CommandError> {
            Ok(file(name, "c1"))
        }
        fn revoke(&self, _: &str) -> Result<(), CommandError> {
            Err(CommandError::new(ErrorKind::Network, "ignored"))
        }
    }

    fn fake(_: ProviderKind) -> Box<dyn Provider> {
        Box::new(Fake)
    }

    fn state(dir: &Path) -> CloudState {
        let store = MemoryStore::default();
        store
            .save(
                ProviderKind::Drive,
                &Tokens {
                    access_token: "at".into(),
                    refresh_token: None,
                    expires_at: 0,
                    account: "me@example.com".into(),
                },
            )
            .unwrap();
        CloudState::with_parts(Box::new(store), dir.join("pending"), fake)
    }

    fn revision_of(state: &CloudState, item: &str) -> String {
        state.open_map().get(item).unwrap().revision.clone()
    }

    #[test]
    fn read_records_the_revision() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        MODE.store(0, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        assert_eq!(read(&s, "drive:f1").unwrap(), b"abc");
        assert_eq!(revision_of(&s, "drive:f1"), "r1");
        assert_eq!(list(&s, ProviderKind::Drive).unwrap().len(), 1);
    }

    #[test]
    fn save_uses_the_recorded_revision_and_updates_it() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        MODE.store(0, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        read(&s, "drive:f1").unwrap();
        assert_eq!(save(&s, "drive:f1", b"x").unwrap(), "saved");
        assert_eq!(revision_of(&s, "drive:f1"), "after-r1");
        assert_eq!(save(&s, "drive:f1", b"y").unwrap(), "saved");
        assert_eq!(revision_of(&s, "drive:f1"), "after-after-r1");
    }

    #[test]
    fn save_without_a_read_is_a_conflict() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        MODE.store(0, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        assert_eq!(
            save(&s, "drive:f1", b"x").unwrap_err().kind,
            ErrorKind::Conflict
        );
    }

    #[test]
    fn save_passes_a_conflict_through() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        MODE.store(0, Ordering::SeqCst);
        read(&s, "drive:f1").unwrap();
        MODE.store(2, Ordering::SeqCst);
        let error = save(&s, "drive:f1", b"x").unwrap_err();
        MODE.store(0, Ordering::SeqCst);
        assert_eq!(error.kind, ErrorKind::Conflict);
        assert!(s.pending.list().is_empty());
    }

    #[test]
    fn offline_save_is_queued_and_flushed() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        MODE.store(0, Ordering::SeqCst);
        read(&s, "drive:f1").unwrap();
        MODE.store(1, Ordering::SeqCst);
        assert_eq!(save(&s, "drive:f1", b"x").unwrap(), "queued");
        let queued = s.pending.list();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].revision, "r1");
        assert_eq!(queued[0].name, "a.gp");
        MODE.store(0, Ordering::SeqCst);
        let results = flush(&s).unwrap();
        assert_eq!(
            results,
            vec![FlushResult {
                name: "a.gp".into(),
                outcome: "uploaded".into()
            }]
        );
        assert!(s.pending.list().is_empty());
        // The open tab continues from the revision the metadata reports.
        assert_eq!(revision_of(&s, "drive:f1"), "r2");
    }

    #[test]
    fn discard_removes_a_queued_edit() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        MODE.store(0, Ordering::SeqCst);
        read(&s, "drive:f1").unwrap();
        MODE.store(1, Ordering::SeqCst);
        save(&s, "drive:f1", b"x").unwrap();
        MODE.store(0, Ordering::SeqCst);
        discard_pending(&s, "drive:f1").unwrap();
        assert!(s.pending.list().is_empty());
    }

    #[test]
    fn create_validates_the_extension_and_records_the_revision() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        MODE.store(0, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        assert_eq!(
            create(&s, ProviderKind::Drive, "evil.sh", b"x")
                .unwrap_err()
                .kind,
            ErrorKind::UnsupportedType
        );
        let item = create(&s, ProviderKind::Drive, "new.gp", b"x").unwrap();
        assert_eq!(item, "drive:f1");
        assert_eq!(revision_of(&s, &item), "c1");
    }

    #[test]
    fn disconnect_deletes_tokens_even_when_revoke_fails() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        read(&s, "drive:f1").unwrap();
        disconnect(&s, ProviderKind::Drive).unwrap();
        assert!(s.store.load(ProviderKind::Drive).unwrap().is_none());
        assert!(s.open_map().is_empty());
    }

    #[test]
    fn accounts_list_every_provider_with_the_signed_in_one() {
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        let all = accounts(&s);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].provider, ProviderKind::Drive);
        assert_eq!(all[0].account.as_deref(), Some("me@example.com"));
        assert_eq!(all[1].account, None);
        let json = serde_json::to_value(&all).unwrap();
        assert_eq!(json[0]["provider"], "drive");
        assert_eq!(json[1]["provider"], "onedrive");
        assert_eq!(json[2]["provider"], "dropbox");
        assert_eq!(json[0]["label"], "Google Drive");
        assert!(json[0]["configured"].is_boolean());
    }

    #[test]
    fn connect_without_a_client_id_says_not_set_up() {
        let dir = tempfile::tempdir().unwrap();
        let s = state(dir.path());
        for kind in ProviderKind::ALL {
            if client_id(kind).is_none() {
                let e = connect(&s, kind, |_| Ok(()), Duration::from_millis(10)).unwrap_err();
                assert_eq!(e.kind, ErrorKind::Io);
                assert!(e.message.contains("not set up"));
            }
        }
    }

    // ---- Sign-in: it always ends, and says why ----

    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn config(token_url: &str) -> OAuthConfig {
        OAuthConfig {
            client_id: "cid".into(),
            client_secret: None,
            auth_url: "http://127.0.0.1:1/auth".into(),
            token_url: token_url.into(),
            scopes: vec!["scope".into()],
            extra_auth_params: Vec::new(),
        }
    }

    /// A token endpoint that answers every request with `status` and `body`.
    fn token_server(status: u16, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                read_whole_request(&mut stream);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        url
    }

    /// Reads the request headers and its body. Replying and closing with request bytes still
    /// unread makes Windows reset the connection (os error 10054) and drop the reply.
    fn read_whole_request(stream: &mut TcpStream) {
        let mut data = Vec::new();
        let mut chunk = [0u8; 1024];
        let header_end = loop {
            if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => data.extend_from_slice(&chunk[..n]),
            }
        };
        let head = String::from_utf8_lossy(&data[..header_end]).to_ascii_lowercase();
        let length = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while data.len() < header_end + length {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => data.extend_from_slice(&chunk[..n]),
            }
        }
    }

    /// Plays the browser: follows the authorization URL straight to the redirect.
    fn browser_returns_code(url: &str) -> Result<(), CommandError> {
        let param = |name: &str| {
            url.split(['?', '&'])
                .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
                .unwrap()
                .to_owned()
        };
        let redirect = param("redirect_uri")
            .replace("%3A", ":")
            .replace("%2F", "/");
        let port: u16 = redirect
            .rsplit(':')
            .next()
            .unwrap()
            .trim_end_matches('/')
            .parse()
            .unwrap();
        let state = param("state");
        std::thread::spawn(move || {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(stream, "GET /?code=abc&state={state} HTTP/1.1\r\n\r\n").unwrap();
            let mut sink = String::new();
            let _ = stream.read_to_string(&mut sink);
        });
        Ok(())
    }

    fn limits(browser_ms: u64, keychain_ms: u64, overall_ms: u64) -> Limits {
        Limits {
            browser: Duration::from_millis(browser_ms),
            keychain: Duration::from_millis(keychain_ms),
            overall: Duration::from_millis(overall_ms),
        }
    }

    fn empty_state(dir: &Path, store: Box<dyn TokenStore>) -> CloudState {
        CloudState::with_parts(store, dir.join("pending"), fake)
    }

    const TOKENS_OK: &str = r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#;

    #[test]
    fn a_finished_sign_in_stores_the_tokens_and_returns_the_account() {
        let dir = tempfile::tempdir().unwrap();
        let s = empty_state(dir.path(), Box::new(MemoryStore::default()));
        let cfg = config(&token_server(200, TOKENS_OK));
        let name = connect_with(
            &s,
            ProviderKind::Drive,
            cfg,
            browser_returns_code,
            limits(5_000, 5_000, 10_000),
        )
        .unwrap();
        assert_eq!(name, "me");
        assert_eq!(
            s.store.load(ProviderKind::Drive).unwrap().unwrap().account,
            "me"
        );
    }

    #[test]
    fn a_refused_token_exchange_reaches_the_caller_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = empty_state(dir.path(), Box::new(MemoryStore::default()));
        let cfg = config(&token_server(400, r#"{"error":"invalid_request"}"#));
        let started = Instant::now();
        let e = connect_with(
            &s,
            ProviderKind::Drive,
            cfg,
            browser_returns_code,
            limits(5_000, 5_000, 10_000),
        )
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::AuthExpired);
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(s.store.load(ProviderKind::Drive).unwrap().is_none());
    }

    /// A keychain that never answers, like an unanswered access prompt.
    struct HangingStore;

    impl TokenStore for HangingStore {
        fn load(&self, _: ProviderKind) -> Result<Option<Tokens>, CommandError> {
            Ok(None)
        }
        fn save(&self, _: ProviderKind, _: &Tokens) -> Result<(), CommandError> {
            std::thread::sleep(Duration::from_secs(30));
            Ok(())
        }
        fn delete(&self, _: ProviderKind) -> Result<(), CommandError> {
            Ok(())
        }
    }

    #[test]
    fn a_keychain_that_does_not_answer_ends_the_sign_in_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let s = empty_state(dir.path(), Box::new(HangingStore));
        let cfg = config(&token_server(200, TOKENS_OK));
        let started = Instant::now();
        let e = connect_with(
            &s,
            ProviderKind::Drive,
            cfg,
            browser_returns_code,
            limits(5_000, 300, 10_000),
        )
        .unwrap_err();
        assert!(e.message.contains("keychain"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn cancel_ends_a_waiting_sign_in_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let s = Arc::new(empty_state(dir.path(), Box::new(MemoryStore::default())));
        let canceller = {
            let s = Arc::clone(&s);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                cancel_connect(&s);
            })
        };
        let started = Instant::now();
        let e = connect_with(
            &s,
            ProviderKind::Drive,
            config("http://127.0.0.1:1/token"),
            |_| Ok(()),
            limits(60_000, 5_000, 120_000),
        )
        .unwrap_err();
        canceller.join().unwrap();
        assert!(e.message.contains("cancelled"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_sign_in_that_runs_past_the_overall_limit_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let s = empty_state(dir.path(), Box::new(MemoryStore::default()));
        let started = Instant::now();
        let e = connect_with(
            &s,
            ProviderKind::Drive,
            config("http://127.0.0.1:1/token"),
            |_| Ok(()),
            limits(60_000, 5_000, 400),
        )
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Network);
        assert!(e.message.contains("too long"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_cancelled_sign_in_cannot_store_tokens_late() {
        let dir = tempfile::tempdir().unwrap();
        let s = Arc::new(empty_state(dir.path(), Box::new(MemoryStore::default())));
        let cfg = config(&token_server(200, TOKENS_OK));
        let late = {
            let s = Arc::clone(&s);
            // The browser answers only after Cancel.
            move |url: &str| {
                cancel_connect(&s);
                std::thread::sleep(Duration::from_millis(500));
                browser_returns_code(url)
            }
        };
        let e = connect_with(
            &s,
            ProviderKind::Drive,
            cfg,
            late,
            limits(5_000, 5_000, 10_000),
        )
        .unwrap_err();
        assert!(e.message.contains("cancelled"), "{e}");
        std::thread::sleep(Duration::from_millis(1_500));
        assert!(s.store.load(ProviderKind::Drive).unwrap().is_none());
    }
}
