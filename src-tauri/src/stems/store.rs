//! The folder of separated songs: `<app data>/stems/<id>/<kind>.wav` plus `meta.json`.
//!
//! Paths are only ever built from an id that is 16 lower-case hex characters and from one of
//! the five known stem names, never from other user input. A song is written into a staging
//! folder and renamed into place when it is complete, so a half-written song never shows up
//! in the list.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use super::{StemCacheInfo, StemEngine, StemSong};
use crate::separation::StemKind;

/// The cache keeps at most this much audio; saving a song evicts the oldest ones above it.
pub const LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const META: &str = "meta.json";
const STAGING_PREFIX: &str = ".tmp-";

/// Bump when the separation changes enough that old stems should not be reused.
const ALGORITHM_VERSION: u8 = 1;

/// Whether `id` is 16 lower-case hex characters.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The song id: the first 16 hex characters of the SHA-256 of the file's bytes, the engine,
/// the stems asked for and the drum setting.
pub fn song_id(bytes: &[u8], engine: StemEngine, kinds: &[StemKind], strong_drums: bool) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.update([0, ALGORITHM_VERSION]);
    hasher.update(match engine {
        StemEngine::Fast => &b"fast"[..],
        StemEngine::Neural => &b"neural"[..],
    });
    for kind in kinds {
        hasher.update([0]);
        hasher.update(kind.id().as_bytes());
    }
    hasher.update([0, u8::from(strong_drums)]);
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| dir_bytes(&e.path())).sum::<u64>())
        .unwrap_or(0)
}

/// A folder a song is being written into. Removed unless it is committed.
pub struct Staging {
    path: PathBuf,
    id: String,
    keep: bool,
}

impl Staging {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// Cheap to clone: it is only a path and a number, the folder is the shared state.
#[derive(Debug, Clone)]
pub struct StemStore {
    root: PathBuf,
    limit: u64,
}

impl StemStore {
    /// A store in `root` with the default limit. Leftovers of a crashed job are removed.
    pub fn new(root: PathBuf) -> Self {
        let store = Self {
            root,
            limit: LIMIT_BYTES,
        };
        store.sweep_staging();
        store
    }

    /// The same store with another size limit (tests use a tiny one).
    pub fn with_limit(mut self, limit: u64) -> Self {
        self.limit = limit;
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }

    fn sweep_staging(&self) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
            {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    pub fn song_dir(&self, id: &str) -> Result<PathBuf, String> {
        if !is_valid_id(id) {
            return Err("That is not a separated song".into());
        }
        Ok(self.root.join(id))
    }

    pub fn stem_path(&self, id: &str, kind: StemKind) -> Result<PathBuf, String> {
        Ok(self.song_dir(id)?.join(format!("{}.wav", kind.id())))
    }

    /// A fresh folder to write the song `id` into.
    pub fn staging(&self, id: &str) -> Result<Staging, String> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        self.song_dir(id)?;
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = self
            .root
            .join(format!("{STAGING_PREFIX}{id}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("The stems folder could not be created: {e}"))?;
        Ok(Staging {
            path,
            id: id.to_owned(),
            keep: false,
        })
    }

    /// Moves a finished staging folder into place under its id, writes `meta.json`, and evicts
    /// the oldest songs while the cache is over its limit. The new song is never evicted.
    /// Returns the ids evicted.
    pub fn commit(&self, mut staging: Staging, song: &StemSong) -> Result<Vec<String>, String> {
        if staging.id != song.id {
            return Err("The stems do not belong to this song".into());
        }
        let meta = serde_json::to_vec(song).map_err(|e| e.to_string())?;
        std::fs::write(staging.path.join(META), meta)
            .map_err(|e| format!("The stems could not be saved: {e}"))?;
        let dest = self.song_dir(&song.id)?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| format!("The old stems could not be replaced: {e}"))?;
        }
        std::fs::rename(&staging.path, &dest)
            .map_err(|e| format!("The stems could not be saved: {e}"))?;
        staging.keep = true;
        Ok(self.evict(&song.id))
    }

    fn evict(&self, keep: &str) -> Vec<String> {
        let mut songs = self.list();
        let mut total: u64 = songs.iter().map(|s| s.bytes).sum();
        songs.sort_by(|a, b| (a.created_at_ms, &a.id).cmp(&(b.created_at_ms, &b.id)));
        let mut evicted = Vec::new();
        for song in songs {
            if total <= self.limit {
                break;
            }
            if song.id == keep {
                continue;
            }
            if self.delete(&song.id).is_ok() {
                total = total.saturating_sub(song.bytes);
                evicted.push(song.id);
            }
        }
        evicted
    }

    /// The song, if it is saved completely (meta present and every stem file the right size).
    pub fn get(&self, id: &str) -> Option<StemSong> {
        let dir = self.song_dir(id).ok()?;
        let song: StemSong = serde_json::from_slice(&std::fs::read(dir.join(META)).ok()?).ok()?;
        if song.id != id || song.stems.is_empty() {
            return None;
        }
        let whole = song.stems.iter().all(|s| {
            std::fs::metadata(dir.join(format!("{}.wav", s.kind.id())))
                .is_ok_and(|m| m.len() == s.bytes)
        });
        whole.then_some(song)
    }

    /// All saved songs, newest first.
    pub fn list(&self) -> Vec<StemSong> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut songs: Vec<StemSong> = entries
            .flatten()
            .filter_map(|e| self.get(&e.file_name().to_string_lossy()))
            .collect();
        songs.sort_by(|a, b| (b.created_at_ms, &b.id).cmp(&(a.created_at_ms, &a.id)));
        songs
    }

    pub fn info(&self) -> StemCacheInfo {
        let songs = self.list();
        StemCacheInfo {
            bytes: songs.iter().map(|s| s.bytes).sum(),
            count: songs.len() as u32,
            limit_bytes: self.limit,
        }
    }

    /// Removes a song. A song that is not there is not an error.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let dir = self.song_dir(id)?;
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("The stems could not be deleted: {e}")),
        }
    }

    /// Removes everything in the cache folder (also leftovers). Returns the bytes freed.
    pub fn clear(&self) -> Result<u64, String> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Ok(0);
        };
        let mut freed = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            let size = dir_bytes(&path);
            let result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            result.map_err(|e| format!("The stems could not be deleted: {e}"))?;
            freed += size;
        }
        Ok(freed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stems::StemInfo;

    pub fn song(id: &str, created: u64, bytes: u64) -> StemSong {
        StemSong {
            id: id.into(),
            name: "x".into(),
            duration_seconds: 1.0,
            sample_rate: 44_100,
            engine: StemEngine::Fast,
            strong_drums: false,
            stems: vec![StemInfo {
                kind: StemKind::Other,
                bytes,
            }],
            mono: false,
            skipped: vec![],
            panned_share: 0.0,
            bytes,
            created_at_ms: created,
        }
    }

    fn save(store: &StemStore, id: &str, created: u64, bytes: u64) -> Vec<String> {
        let staging = store.staging(id).unwrap();
        std::fs::write(staging.path().join("other.wav"), vec![0u8; bytes as usize]).unwrap();
        store.commit(staging, &song(id, created, bytes)).unwrap()
    }

    #[test]
    fn ids_are_sixteen_lower_case_hex_characters() {
        assert!(is_valid_id("0123456789abcdef"));
        for bad in [
            "",
            "0123456789abcde",
            "0123456789abcdef0",
            "0123456789ABCDEF",
            "../0123456789abc",
            "0123456789abcde/",
            "0123456789abcdeg",
        ] {
            assert!(!is_valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn the_id_depends_on_the_file_and_every_option() {
        let base = song_id(b"audio", StemEngine::Fast, &[StemKind::Drums], false);
        assert!(is_valid_id(&base));
        assert_eq!(
            base,
            song_id(b"audio", StemEngine::Fast, &[StemKind::Drums], false)
        );
        let others = [
            song_id(b"audio2", StemEngine::Fast, &[StemKind::Drums], false),
            song_id(b"audio", StemEngine::Neural, &[StemKind::Drums], false),
            song_id(b"audio", StemEngine::Fast, &[StemKind::Bass], false),
            song_id(
                b"audio",
                StemEngine::Fast,
                &[StemKind::Drums, StemKind::Bass],
                false,
            ),
            song_id(b"audio", StemEngine::Fast, &[StemKind::Drums], true),
        ];
        for other in &others {
            assert_ne!(&base, other);
        }
    }

    #[test]
    fn paths_are_built_from_valid_ids_only() {
        let store = StemStore::new(PathBuf::from("/nonexistent/stems"));
        assert!(store.song_dir("../../etc/passwd").is_err());
        assert!(store.stem_path("..", StemKind::Bass).is_err());
        assert_eq!(
            store.stem_path("0123456789abcdef", StemKind::Bass).unwrap(),
            PathBuf::from("/nonexistent/stems/0123456789abcdef/bass.wav")
        );
        assert!(store.delete("../x").is_err());
    }

    #[test]
    fn a_saved_song_is_listed_newest_first_and_counted() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        assert!(store.list().is_empty());
        assert_eq!(store.info().count, 0);
        save(&store, "aaaaaaaaaaaaaaaa", 100, 10);
        save(&store, "bbbbbbbbbbbbbbbb", 300, 20);
        save(&store, "cccccccccccccccc", 200, 30);
        let ids: Vec<_> = store.list().into_iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            ["bbbbbbbbbbbbbbbb", "cccccccccccccccc", "aaaaaaaaaaaaaaaa"]
        );
        let info = store.info();
        assert_eq!(
            (info.count, info.bytes, info.limit_bytes),
            (3, 60, LIMIT_BYTES)
        );
    }

    #[test]
    fn a_song_with_a_missing_or_short_stem_is_not_served() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        save(&store, "aaaaaaaaaaaaaaaa", 1, 10);
        assert!(store.get("aaaaaaaaaaaaaaaa").is_some());
        let file = store
            .stem_path("aaaaaaaaaaaaaaaa", StemKind::Other)
            .unwrap();
        std::fs::write(&file, b"short").unwrap();
        assert!(store.get("aaaaaaaaaaaaaaaa").is_none());
        assert!(store.list().is_empty());
        std::fs::remove_file(&file).unwrap();
        assert!(store.get("aaaaaaaaaaaaaaaa").is_none());
    }

    #[test]
    fn the_oldest_songs_go_first_and_the_new_one_stays() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf()).with_limit(100);
        assert!(save(&store, "aaaaaaaaaaaaaaaa", 1, 40).is_empty());
        assert!(save(&store, "bbbbbbbbbbbbbbbb", 2, 40).is_empty());
        // 120 bytes: the oldest has to go, 80 are left.
        let evicted = save(&store, "cccccccccccccccc", 3, 40);
        assert_eq!(evicted, ["aaaaaaaaaaaaaaaa"]);
        assert!(!dir.path().join("aaaaaaaaaaaaaaaa").exists());
        // A song bigger than the whole limit is kept, everything else makes room for it.
        let evicted = save(&store, "dddddddddddddddd", 4, 500);
        assert_eq!(evicted.len(), 2);
        let ids: Vec<_> = store.list().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["dddddddddddddddd"]);
    }

    #[test]
    fn staging_leftovers_are_removed_and_never_listed() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        let staging = store.staging("aaaaaaaaaaaaaaaa").unwrap();
        let path = staging.path().to_path_buf();
        std::fs::write(path.join("other.wav"), b"half").unwrap();
        assert!(store.list().is_empty());
        // Dropping an uncommitted staging folder removes it.
        drop(staging);
        assert!(!path.exists());
        // A crash leaves one behind; the next start removes it.
        let leftover = dir.path().join(".tmp-aaaaaaaaaaaaaaaa-1-1");
        std::fs::create_dir_all(&leftover).unwrap();
        StemStore::new(dir.path().to_path_buf());
        assert!(!leftover.exists());
    }

    #[test]
    fn delete_and_clear_free_the_space() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        save(&store, "aaaaaaaaaaaaaaaa", 1, 10);
        save(&store, "bbbbbbbbbbbbbbbb", 2, 20);
        store.delete("aaaaaaaaaaaaaaaa").unwrap();
        store.delete("aaaaaaaaaaaaaaaa").unwrap();
        assert_eq!(store.list().len(), 1);
        // 20 bytes of audio and the meta file.
        let freed = store.clear().unwrap();
        assert!(freed >= 20, "{freed}");
        assert!(store.list().is_empty());
        assert_eq!(store.clear().unwrap(), 0);
    }
}
