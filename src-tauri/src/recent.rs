//! The most recently opened songs, stored as a JSON list in the app data folder
//! and shown on the welcome screen and in File › Open Recent.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, ErrorKind};

/// How many songs are remembered.
pub const MAX_RECENT: usize = 10;

/// File name of the list inside the app data folder.
pub const FILE_NAME: &str = "recent.json";

/// Registers the store in the app data folder unless one is managed already
/// (tests use their own). Called by both the menu builder and the setup hook,
/// whichever runs first.
pub fn ensure_store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    use tauri::Manager;
    if app.try_state::<RecentStore>().is_none() {
        app.manage(RecentStore::new(app.path().app_data_dir()?));
    }
    Ok(())
}

/// Reads and writes the recent files list. Stored as Tauri state.
#[derive(Debug, Clone)]
pub struct RecentStore {
    path: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    paths: Vec<String>,
}

impl RecentStore {
    /// `dir` is created on the first save.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            path: dir.into().join(FILE_NAME),
        }
    }

    /// Remembered paths, most recent first. A damaged file reads as an empty list.
    pub fn load(&self) -> Vec<String> {
        let Ok(json) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        match serde_json::from_str::<Stored>(&json) {
            Ok(mut stored) => {
                stored.paths.retain(|p| !p.is_empty());
                stored.paths.truncate(MAX_RECENT);
                stored.paths
            }
            Err(error) => {
                eprintln!("ignoring recent files {}: {error}", self.path.display());
                Vec::new()
            }
        }
    }

    /// Moves `path` to the front (adding it if new) and returns the new list.
    pub fn add(&self, path: &str) -> Result<Vec<String>, CommandError> {
        if path.is_empty() {
            return Err(CommandError::new(ErrorKind::NotFound, "The path is empty."));
        }
        let mut paths = self.load();
        paths.retain(|existing| existing != path);
        paths.insert(0, path.to_owned());
        paths.truncate(MAX_RECENT);
        self.save(&paths)?;
        Ok(paths)
    }

    /// Forgets `path` (e.g. the file was deleted) and returns the new list.
    pub fn remove(&self, path: &str) -> Result<Vec<String>, CommandError> {
        let mut paths = self.load();
        paths.retain(|existing| existing != path);
        self.save(&paths)?;
        Ok(paths)
    }

    pub fn clear(&self) -> Result<Vec<String>, CommandError> {
        self.save(&[])?;
        Ok(Vec::new())
    }

    /// Saves atomically: a crash mid-write never leaves a torn file.
    fn save(&self, paths: &[String]) -> Result<(), CommandError> {
        let dir = self.path.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(dir).map_err(|e| io_error(&e))?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e))?;
        let stored = Stored {
            paths: paths.to_vec(),
        };
        serde_json::to_writer_pretty(&mut file, &stored)
            .map_err(io::Error::from)
            .and_then(|()| file.flush())
            .map_err(|e| io_error(&e))?;
        file.persist(&self.path).map_err(|e| io_error(&e.error))?;
        Ok(())
    }
}

fn io_error(error: &io::Error) -> CommandError {
    CommandError::new(
        ErrorKind::Io,
        format!("The recent files list could not be saved: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, RecentStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = RecentStore::new(dir.path().join("nested"));
        (dir, store)
    }

    #[test]
    fn starts_empty() {
        let (_dir, store) = store();
        assert!(store.load().is_empty());
    }

    #[test]
    fn newest_first_and_deduplicated() {
        let (_dir, store) = store();
        store.add("/a.gp5").unwrap();
        store.add("/b.gp5").unwrap();
        let list = store.add("/a.gp5").unwrap();
        assert_eq!(list, ["/a.gp5", "/b.gp5"]);
        assert_eq!(store.load(), list);
    }

    #[test]
    fn keeps_only_ten() {
        let (_dir, store) = store();
        for n in 0..15 {
            store.add(&format!("/song{n}.gp5")).unwrap();
        }
        let list = store.load();
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], "/song14.gp5");
        assert_eq!(list[9], "/song5.gp5");
    }

    #[test]
    fn remove_and_clear() {
        let (_dir, store) = store();
        store.add("/a.gp5").unwrap();
        store.add("/b.gp5").unwrap();
        assert_eq!(store.remove("/a.gp5").unwrap(), ["/b.gp5"]);
        assert_eq!(store.remove("/missing.gp5").unwrap(), ["/b.gp5"]);
        assert!(store.clear().unwrap().is_empty());
        assert!(store.load().is_empty());
    }

    #[test]
    fn rejects_an_empty_path() {
        let (_dir, store) = store();
        let error = store.add("").unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
    }

    #[test]
    fn damaged_files_read_as_empty_and_can_be_overwritten() {
        let (_dir, store) = store();
        fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        fs::write(&store.path, "{not json").unwrap();
        assert!(store.load().is_empty());
        assert_eq!(store.add("/a.gp5").unwrap(), ["/a.gp5"]);
    }

    #[test]
    fn oversized_or_blank_stored_lists_are_trimmed() {
        let (_dir, store) = store();
        fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        let paths: Vec<String> = (0..20).map(|n| format!("/s{n}.gp5")).collect();
        let mut with_blank = vec![String::new()];
        with_blank.extend(paths);
        fs::write(
            &store.path,
            serde_json::to_string(&Stored { paths: with_blank }).unwrap(),
        )
        .unwrap();
        let list = store.load();
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0], "/s0.gp5");
    }
}
