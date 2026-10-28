//! Offline edits (#187): a save that cannot reach the provider is kept locally as "pending
//! upload" and sent on reconnect, after a revision check. A remote that moved on in the
//! meantime is never overwritten: the entry is kept as a conflict for the user to resolve.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::{Provider, ProviderKind, RemoteFile};
use crate::error::{CommandError, ErrorKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingUpload {
    pub provider: ProviderKind,
    pub id: String,
    pub name: String,
    /// The remote revision the edit started from.
    pub revision: String,
    /// The remote changed meanwhile: needs the user's decision.
    pub conflict: bool,
    /// Counts the edits of this file; an upload removes only the version it sent.
    #[serde(default)]
    pub generation: u64,
}

/// What happened to one queued upload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Uploaded,
    Conflict,
    /// Still offline: kept for the next try.
    Waiting,
}

/// The queue: one JSON index plus the bytes of each edit, in the app data folder.
#[derive(Debug, Clone)]
pub struct PendingStore {
    dir: PathBuf,
    /// Serializes changes to the index and the queued bytes (saves and flushes run apart).
    lock: Arc<Mutex<()>>,
}

fn io_error(e: &io::Error) -> CommandError {
    CommandError::new(
        ErrorKind::Io,
        format!("The pending uploads could not be saved: {e}"),
    )
}

impl PendingStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Arc::new(Mutex::new(())),
        }
    }

    fn index(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn bytes_path(&self, entry: &PendingUpload) -> PathBuf {
        let key = crate::cloud_folder::hash_hex(
            format!("{}:{}", entry.provider.prefix(), entry.id).as_bytes(),
        );
        self.dir.join(format!("{key}.bin"))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The queued edit of one file, with its bytes, for opening it again.
    pub fn find(&self, provider: ProviderKind, id: &str) -> Option<(PendingUpload, Vec<u8>)> {
        let _guard = self.guard();
        let entry = self
            .list()
            .into_iter()
            .find(|e| e.provider == provider && e.id == id)?;
        let bytes = self.bytes(&entry)?;
        Some((entry, bytes))
    }

    pub fn list(&self) -> Vec<PendingUpload> {
        fs::read_to_string(self.index())
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    fn save(&self, entries: &[PendingUpload]) -> Result<(), CommandError> {
        fs::create_dir_all(&self.dir).map_err(|e| io_error(&e))?;
        let json = serde_json::to_vec_pretty(entries).map_err(|e| io_error(&e.into()))?;
        let tmp = self.dir.join("index.json.tmp");
        fs::write(&tmp, json).map_err(|e| io_error(&e))?;
        fs::rename(&tmp, self.index()).map_err(|e| io_error(&e))
    }

    /// Queues an edit; a newer edit of the same file replaces the older one but keeps the
    /// revision the first edit started from.
    pub fn enqueue(&self, mut entry: PendingUpload, bytes: &[u8]) -> Result<(), CommandError> {
        let _guard = self.guard();
        let mut entries = self.list();
        if let Some(old) = entries
            .iter()
            .find(|e| e.provider == entry.provider && e.id == entry.id)
        {
            entry.revision = old.revision.clone();
            entry.conflict = old.conflict;
            entry.generation = old.generation + 1;
        }
        entries.retain(|e| !(e.provider == entry.provider && e.id == entry.id));
        fs::create_dir_all(&self.dir).map_err(|e| io_error(&e))?;
        fs::write(self.bytes_path(&entry), bytes).map_err(|e| io_error(&e))?;
        entries.push(entry);
        self.save(&entries)
    }

    /// The queued bytes of an entry (to save a conflicting edit as a copy).
    pub fn bytes(&self, entry: &PendingUpload) -> Option<Vec<u8>> {
        fs::read(self.bytes_path(entry)).ok()
    }

    pub fn discard(&self, provider: ProviderKind, id: &str) -> Result<(), CommandError> {
        let _guard = self.guard();
        self.discard_locked(provider, id)
    }

    fn discard_locked(&self, provider: ProviderKind, id: &str) -> Result<(), CommandError> {
        let mut entries = self.list();
        if let Some(entry) = entries
            .iter()
            .find(|e| e.provider == provider && e.id == id)
        {
            let _ = fs::remove_file(self.bytes_path(entry));
        }
        entries.retain(|e| !(e.provider == provider && e.id == id));
        self.save(&entries)
    }

    /// Sends the queued edits of `provider`. Uploaded ones leave the queue.
    pub fn flush(
        &self,
        provider: &dyn Provider,
        token: &str,
    ) -> Result<Vec<(PendingUpload, Outcome, Option<RemoteFile>)>, CommandError> {
        let mut results = Vec::new();
        for entry in self
            .list()
            .into_iter()
            .filter(|e| e.provider == provider.kind())
        {
            if entry.conflict {
                results.push((entry, Outcome::Conflict, None));
                continue;
            }
            let Some(bytes) = self.bytes(&entry) else {
                self.discard(entry.provider, &entry.id)?;
                continue;
            };
            let (outcome, file) =
                match provider.write_if_revision(token, &entry.id, &entry.revision, &bytes) {
                    Ok(file) => {
                        self.finish_upload(&entry, &file)?;
                        (Outcome::Uploaded, Some(file))
                    }
                    Err(e) if e.kind == ErrorKind::Conflict => {
                        self.mark_conflict(&entry)?;
                        (Outcome::Conflict, None)
                    }
                    Err(e) if e.kind == ErrorKind::Network => (Outcome::Waiting, None),
                    Err(e) => return Err(e),
                };
            results.push((entry, outcome, file));
        }
        Ok(results)
    }

    /// The sent version is on the remote. If a newer edit was queued meanwhile it stays,
    /// rebased onto the revision the upload produced.
    fn finish_upload(&self, sent: &PendingUpload, file: &RemoteFile) -> Result<(), CommandError> {
        let _guard = self.guard();
        let mut entries = self.list();
        match entries
            .iter_mut()
            .find(|e| e.provider == sent.provider && e.id == sent.id)
        {
            Some(current) if current.generation != sent.generation => {
                current.revision = file.revision.clone();
                self.save(&entries)
            }
            _ => self.discard_locked(sent.provider, &sent.id),
        }
    }

    fn mark_conflict(&self, entry: &PendingUpload) -> Result<(), CommandError> {
        let _guard = self.guard();
        let mut entries = self.list();
        for e in &mut entries {
            if e.provider == entry.provider && e.id == entry.id {
                e.conflict = true;
            }
        }
        self.save(&entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::RemoteFile;
    use std::sync::Mutex;

    /// A provider whose answer to every write is fixed.
    struct Fake(Mutex<Option<ErrorKind>>, Mutex<Vec<(String, String)>>);

    impl Provider for Fake {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Drive
        }
        fn account_name(&self, _: &str) -> Result<String, CommandError> {
            unimplemented!()
        }
        fn list(&self, _: &str) -> Result<Vec<RemoteFile>, CommandError> {
            unimplemented!()
        }
        fn metadata(&self, _: &str, _: &str) -> Result<RemoteFile, CommandError> {
            unimplemented!()
        }
        fn read(&self, _: &str, _: &str) -> Result<(Vec<u8>, RemoteFile), CommandError> {
            unimplemented!()
        }
        fn write_if_revision(
            &self,
            _: &str,
            id: &str,
            revision: &str,
            _: &[u8],
        ) -> Result<RemoteFile, CommandError> {
            self.1.lock().unwrap().push((id.into(), revision.into()));
            match *self.0.lock().unwrap() {
                Some(kind) => Err(CommandError::new(kind, "x")),
                None => Ok(RemoteFile {
                    id: id.into(),
                    name: "a.gp".into(),
                    revision: "r2".into(),
                    size: 1,
                    modified_ms: 0,
                }),
            }
        }
        fn create(&self, _: &str, _: &str, _: &[u8]) -> Result<RemoteFile, CommandError> {
            unimplemented!()
        }
        fn revoke(&self, _: &str) -> Result<(), CommandError> {
            unimplemented!()
        }
    }

    fn entry(revision: &str) -> PendingUpload {
        PendingUpload {
            provider: ProviderKind::Drive,
            id: "f1".into(),
            name: "a.gp".into(),
            revision: revision.into(),
            conflict: false,
            generation: 0,
        }
    }

    fn fake(error: Option<ErrorKind>) -> Fake {
        Fake(Mutex::new(error), Mutex::new(Vec::new()))
    }

    #[test]
    fn uploads_on_reconnect_with_the_original_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"one").unwrap();
        // A second offline edit keeps the revision the first one started from.
        store.enqueue(entry("r-later"), b"two").unwrap();
        assert_eq!(store.list().len(), 1);
        let provider = fake(None);
        let results = store.flush(&provider, "t").unwrap();
        assert_eq!(results[0].1, Outcome::Uploaded);
        assert_eq!(provider.1.lock().unwrap()[0].1, "r1");
        assert!(store.list().is_empty());
    }

    #[test]
    fn a_newer_edit_queued_during_an_upload_survives_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"one").unwrap();
        let sent = store.list().remove(0);
        // A newer save lands while the first upload is in flight.
        store.enqueue(entry("r1"), b"two").unwrap();
        let file = RemoteFile {
            id: "f1".into(),
            name: "a.gp".into(),
            revision: "r2".into(),
            size: 1,
            modified_ms: 0,
        };
        store.finish_upload(&sent, &file).unwrap();
        let kept = store.list();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].revision, "r2");
        assert_eq!(store.bytes(&kept[0]).unwrap(), b"two");
    }

    #[test]
    fn find_returns_the_queued_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"mine").unwrap();
        let (e, bytes) = store.find(ProviderKind::Drive, "f1").unwrap();
        assert_eq!(
            (e.revision.as_str(), bytes.as_slice()),
            ("r1", &b"mine"[..])
        );
    }

    #[test]
    fn a_moved_remote_is_reported_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"mine").unwrap();
        let results = store.flush(&fake(Some(ErrorKind::Conflict)), "t").unwrap();
        assert_eq!(results[0].1, Outcome::Conflict);
        let kept = store.list();
        assert!(kept[0].conflict);
        assert_eq!(store.bytes(&kept[0]).unwrap(), b"mine");
    }

    #[test]
    fn still_offline_keeps_the_edit() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"mine").unwrap();
        let results = store.flush(&fake(Some(ErrorKind::Network)), "t").unwrap();
        assert_eq!(results[0].1, Outcome::Waiting);
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn revoked_access_stops_the_flush() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"mine").unwrap();
        let error = store
            .flush(&fake(Some(ErrorKind::AuthExpired)), "t")
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::AuthExpired);
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn discard_removes_entry_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = PendingStore::new(dir.path());
        store.enqueue(entry("r1"), b"mine").unwrap();
        store.discard(ProviderKind::Drive, "f1").unwrap();
        assert!(store.list().is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1); // only index.json
    }
}
