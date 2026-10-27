//! IPC commands for direct cloud access (#187, phase 2): connect, list, read, save and create
//! tabs in Google Drive, OneDrive and Dropbox, and the offline queue.
//!
//! Tokens stay in the [`TokenStore`] (the OS keychain): they are never returned to the webview,
//! logged or sent to telemetry. The webview only sees provider names, account labels and item
//! ids (`drive:<id>`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

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
    store: Box<dyn TokenStore>,
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
            store,
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

/// Runs the browser sign-in and returns the account name.
pub fn connect(
    state: &CloudState,
    kind: ProviderKind,
    open_browser: impl FnOnce(&str) -> Result<(), CommandError>,
    timeout: Duration,
) -> Result<String, CommandError> {
    if client_id(kind).is_none() {
        return Err(not_set_up());
    }
    let provider = (state.make)(kind);
    let tokens = oauth::sign_in(
        provider.as_ref(),
        &config_for(kind),
        state.store.as_ref(),
        open_browser,
        timeout,
    )?;
    Ok(tokens.account)
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
}
