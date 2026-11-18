//! The list of sample folders (`samples/folders.json`) and where each one keeps its files.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CommandError, ErrorKind};

const FILE_NAME: &str = "folders.json";
const VERSION: u32 = 1;
/// Most folders a user can have; keeps the list and the chips manageable.
pub const MAX_FOLDERS: usize = 64;

/// How a folder came in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderKind {
    /// Kept where it is; only the location is remembered.
    Linked,
    /// A folder copied into Smart Beat.
    Imported,
    /// An archive unpacked into Smart Beat.
    Archive,
}

/// One folder of samples, as the page sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleFolder {
    pub id: String,
    pub name: String,
    pub kind: FolderKind,
    /// The absolute location of a linked folder.
    pub path: Option<String>,
    /// Whether the files can be read now (a linked folder on an unplugged drive cannot).
    #[serde(default)]
    pub available: bool,
    pub file_count: Option<u32>,
    pub added_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    folders: Vec<SampleFolder>,
}

/// Reads and writes the folder list.
pub struct SampleStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

fn io_error(what: &str, e: &io::Error) -> CommandError {
    CommandError::new(ErrorKind::Io, format!("{what}: {e}"))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

impl SampleStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The folder that holds everything of folder `id`.
    pub fn folder_dir(&self, id: &str) -> PathBuf {
        self.dir.join(id)
    }

    pub fn index_path(&self, id: &str) -> PathBuf {
        self.folder_dir(id).join("index.json")
    }

    /// Where the audio of an imported or unpacked folder lives.
    pub fn files_dir(&self, id: &str) -> PathBuf {
        self.folder_dir(id).join("files")
    }

    /// A fresh folder id: twelve hex digits.
    pub fn new_id(&self, seed: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(seed.as_bytes());
        hasher.update(now_ms().to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        hasher.update(nanos.to_le_bytes());
        hasher
            .finalize()
            .iter()
            .take(6)
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Ids are used as folder names, so only the ones this store makes are accepted.
    pub fn valid_id(id: &str) -> bool {
        id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit())
    }

    fn read(&self) -> Vec<SampleFolder> {
        fs::read_to_string(self.dir.join(FILE_NAME))
            .ok()
            .and_then(|json| serde_json::from_str::<Stored>(&json).ok())
            .map(|s| s.folders)
            .unwrap_or_default()
    }

    fn write(&self, folders: Vec<SampleFolder>) -> Result<(), CommandError> {
        let what = "The sample folders could not be saved";
        fs::create_dir_all(&self.dir).map_err(|e| io_error(what, &e))?;
        let mut file =
            tempfile::NamedTempFile::new_in(&self.dir).map_err(|e| io_error(what, &e))?;
        let stored = Stored {
            version: VERSION,
            folders,
        };
        serde_json::to_writer_pretty(&mut file, &stored)
            .map_err(io::Error::from)
            .and_then(|()| file.flush())
            .map_err(|e| io_error(what, &e))?;
        file.persist(self.dir.join(FILE_NAME))
            .map_err(|e| io_error(what, &e.error))?;
        Ok(())
    }

    /// The folders, with `available` checked now. A damaged file reads as empty.
    pub fn list(&self) -> Vec<SampleFolder> {
        let _guard = self.lock.lock().unwrap();
        self.read()
            .into_iter()
            .map(|mut f| {
                f.available = self.root_of(&f).is_some_and(|root| root.is_dir());
                f
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<SampleFolder, CommandError> {
        self.list()
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| CommandError::new(ErrorKind::NotFound, "That sample folder is gone."))
    }

    /// The folder on disk that holds the files of `folder`.
    pub fn root_of(&self, folder: &SampleFolder) -> Option<PathBuf> {
        match folder.kind {
            FolderKind::Linked => folder.path.as_ref().map(PathBuf::from),
            FolderKind::Imported | FolderKind::Archive => Some(self.files_dir(&folder.id)),
        }
    }

    pub fn add(&self, folder: SampleFolder) -> Result<SampleFolder, CommandError> {
        let _guard = self.lock.lock().unwrap();
        let mut folders = self.read();
        if folders.len() >= MAX_FOLDERS {
            return Err(CommandError::new(
                ErrorKind::Io,
                format!("You can keep up to {MAX_FOLDERS} sample folders. Remove one first."),
            ));
        }
        folders.push(folder.clone());
        self.write(folders)?;
        Ok(folder)
    }

    pub fn update(
        &self,
        id: &str,
        change: impl FnOnce(&mut SampleFolder),
    ) -> Result<SampleFolder, CommandError> {
        let _guard = self.lock.lock().unwrap();
        let mut folders = self.read();
        let found = folders
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| CommandError::new(ErrorKind::NotFound, "That sample folder is gone."))?;
        change(found);
        let updated = found.clone();
        self.write(folders)?;
        Ok(updated)
    }

    pub fn remove(&self, id: &str) -> Result<Option<SampleFolder>, CommandError> {
        let _guard = self.lock.lock().unwrap();
        let mut folders = self.read();
        let Some(at) = folders.iter().position(|f| f.id == id) else {
            return Ok(None);
        };
        let gone = folders.remove(at);
        self.write(folders)?;
        Ok(Some(gone))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(
        store: &SampleStore,
        name: &str,
        kind: FolderKind,
        path: Option<&Path>,
    ) -> SampleFolder {
        SampleFolder {
            id: store.new_id(name),
            name: name.into(),
            kind,
            path: path.map(|p| p.to_string_lossy().into_owned()),
            available: false,
            file_count: None,
            added_ms: now_ms(),
        }
    }

    #[test]
    fn folders_are_remembered_between_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let linked = dir.path().join("drums");
        fs::create_dir(&linked).unwrap();
        let store = SampleStore::new(dir.path().join("samples"));
        let a = store
            .add(folder(&store, "Drums", FolderKind::Linked, Some(&linked)))
            .unwrap();
        let again = SampleStore::new(dir.path().join("samples"));
        let list = again.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, a.id);
        assert!(list[0].available, "the folder exists");
        assert!(SampleStore::valid_id(&a.id));
    }

    #[test]
    fn a_linked_folder_that_vanished_is_unavailable_but_kept() {
        let dir = tempfile::tempdir().unwrap();
        let store = SampleStore::new(dir.path());
        let gone = dir.path().join("unplugged");
        store
            .add(folder(&store, "Drive", FolderKind::Linked, Some(&gone)))
            .unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert!(!list[0].available);
    }

    #[test]
    fn a_damaged_list_reads_as_empty_and_can_be_replaced() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), "{ not json").unwrap();
        let store = SampleStore::new(dir.path());
        assert!(store.list().is_empty());
        store
            .add(folder(&store, "Loops", FolderKind::Imported, None))
            .unwrap();
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn update_and_remove_change_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = SampleStore::new(dir.path());
        let a = store
            .add(folder(&store, "Loops", FolderKind::Imported, None))
            .unwrap();
        let updated = store.update(&a.id, |f| f.file_count = Some(7)).unwrap();
        assert_eq!(updated.file_count, Some(7));
        assert!(store.remove(&a.id).unwrap().is_some());
        assert!(store.remove(&a.id).unwrap().is_none());
        assert!(store.get(&a.id).is_err());
    }

    #[test]
    fn only_ids_made_by_the_store_are_valid() {
        assert!(SampleStore::valid_id("0123456789ab"));
        assert!(!SampleStore::valid_id("../etc"));
        assert!(!SampleStore::valid_id("0123456789abc"));
        assert!(!SampleStore::valid_id(""));
    }
}
