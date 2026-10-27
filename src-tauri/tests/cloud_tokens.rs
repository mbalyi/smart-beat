//! The keychain boundary (#187): after sign-in, reading, saving, creating, queueing offline and
//! flushing, no token string appears in any file of the app data folder.

use std::fs;
use std::path::Path;

use smart_beat_lib::cloud::keychain::{MemoryStore, TokenStore};
use smart_beat_lib::cloud::{Provider, ProviderKind, RemoteFile, Tokens};
use smart_beat_lib::cloud_commands::{self as cc, CloudState};
use smart_beat_lib::cloud_folder::CloudFolderStore;
use smart_beat_lib::error::{CommandError, ErrorKind};
use smart_beat_lib::recent::RecentStore;

const ACCESS: &str = "ya29.SECRET-ACCESS-TOKEN-1f3a";
const REFRESH: &str = "1//SECRET-REFRESH-TOKEN-9c2d";

struct Fake;

fn file(name: &str) -> RemoteFile {
    RemoteFile {
        id: "f1".into(),
        name: name.into(),
        revision: "r1".into(),
        size: 1,
        modified_ms: 1,
    }
}

impl Provider for Fake {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Drive
    }
    fn account_name(&self, _: &str) -> Result<String, CommandError> {
        Ok("me@example.com".into())
    }
    fn list(&self, _: &str) -> Result<Vec<RemoteFile>, CommandError> {
        Ok(vec![file("a.gp")])
    }
    fn metadata(&self, _: &str, _: &str) -> Result<RemoteFile, CommandError> {
        Ok(file("a.gp"))
    }
    fn read(&self, _: &str, _: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
        Ok((b"abc".to_vec(), file("a.gp")))
    }
    fn write_if_revision(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &[u8],
    ) -> Result<RemoteFile, CommandError> {
        Err(CommandError::new(ErrorKind::Network, "offline"))
    }
    fn create(&self, _: &str, name: &str, _: &[u8]) -> Result<RemoteFile, CommandError> {
        Ok(file(name))
    }
    fn revoke(&self, _: &str) -> Result<(), CommandError> {
        Ok(())
    }
}

fn fake(_: ProviderKind) -> Box<dyn Provider> {
    Box::new(Fake)
}

fn scan(dir: &Path, found: &mut Vec<String>, files: &mut usize) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan(&path, found, files);
        } else {
            *files += 1;
            let bytes = fs::read(&path).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            for secret in [ACCESS, REFRESH] {
                if text.contains(secret) {
                    found.push(path.display().to_string());
                }
            }
        }
    }
}

#[test]
fn no_token_reaches_the_app_data_folder() {
    let dir = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    store
        .save(
            ProviderKind::Drive,
            &Tokens {
                access_token: ACCESS.into(),
                refresh_token: Some(REFRESH.into()),
                expires_at: 0,
                account: "me@example.com".into(),
            },
        )
        .unwrap();
    let state = CloudState::with_parts(Box::new(store), dir.path().join("pending"), fake);

    // Everything that writes to disk.
    cc::list(&state, ProviderKind::Drive).unwrap();
    cc::read(&state, "drive:f1").unwrap();
    assert_eq!(cc::save(&state, "drive:f1", b"edit").unwrap(), "queued");
    cc::create(&state, ProviderKind::Drive, "new.gp", b"x").unwrap();
    let _ = cc::flush(&state);
    RecentStore::new(dir.path()).add("drive:f1").unwrap();
    CloudFolderStore::new(dir.path())
        .set(Some(dir.path().to_str().unwrap()))
        .unwrap();

    // The webview-facing data carries no token either.
    let shown = serde_json::to_string(&cc::accounts(&state)).unwrap();
    assert!(!shown.contains(ACCESS) && !shown.contains(REFRESH));

    let (mut found, mut files) = (Vec::new(), 0);
    scan(dir.path(), &mut found, &mut files);
    assert!(files >= 3, "the scan saw only {files} files");
    assert!(found.is_empty(), "tokens found in {found:?}");
}
