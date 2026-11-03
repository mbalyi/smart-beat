//! The folder of separated songs: `<app data>/stems/<id>/<kind>.wav` plus `meta.json`.
//!
//! Paths are only ever built from an id that is 16 lower-case hex characters and from one of
//! the five known stem names, never from other user input. A song is written into a staging
//! folder and renamed into place when it is complete, so a half-written song never shows up
//! in the list.
//!
//! The folder is a cache that may be emptied. A song that was saved to a `.sbstems` file or
//! opened from one is pinned and is never evicted (see [`super::bundle`]).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{StemCacheInfo, StemEngine, StemSong};
use crate::separation::StemKind;

/// The cache keeps at most this much audio; saving a song evicts the oldest ones above it.
pub const LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const META: &str = "meta.json";
/// Where the song came from. Not part of [`StemSong`], so the page never sees the path.
const SOURCE: &str = "source.json";
const STAGING_PREFIX: &str = ".tmp-";

/// Bump when the separation changes enough that old stems should not be reused.
pub const ALGORITHM_VERSION: u8 = 1;

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
        StemEngine::Scnet => &b"scnet"[..],
        StemEngine::ScnetXl => &b"scnet-xl"[..],
        StemEngine::Htdemucs => &b"htdemucs"[..],
        StemEngine::Htdemucs6s => &b"htdemucs-6s"[..],
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

/// The audio file a song was separated from, remembered so a later save can embed it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub path: String,
    /// SHA-256 of the file at separation time, lower-case hex.
    pub sha256: String,
}

impl Source {
    pub fn of(path: &Path, bytes: &[u8]) -> Self {
        Self {
            path: path.to_string_lossy().into_owned(),
            sha256: hex(&Sha256::digest(bytes)),
        }
    }

    /// Writes `source.json` into the song folder `dir`.
    pub fn write(&self, dir: &Path) -> Result<(), String> {
        let json = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(SOURCE), json)
            .map_err(|e| format!("The stems could not be saved: {e}"))
    }

    fn read(dir: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(dir.join(SOURCE)).ok()?).ok()
    }
}

/// Lower-case hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

    /// Evicts the songs used longest ago while the cache is over its limit. The song `keep` and
    /// pinned songs stay, so pinned songs alone can take the cache over its limit.
    fn evict(&self, keep: &str) -> Vec<String> {
        let mut songs = self.list();
        let mut total: u64 = songs.iter().map(|s| s.bytes).sum();
        songs.sort_by(|a, b| (last_used(a), &a.id).cmp(&(last_used(b), &b.id)));
        let mut evicted = Vec::new();
        for song in songs {
            if total <= self.limit {
                break;
            }
            if song.id == keep || song.pinned {
                continue;
            }
            if self.delete(&song.id).is_ok() {
                total = total.saturating_sub(song.bytes);
                evicted.push(song.id);
            }
        }
        evicted
    }

    /// The song as `meta.json` has it, if it is saved completely (meta present and every stem
    /// file the right size).
    fn read(&self, id: &str) -> Option<StemSong> {
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

    /// The song, if it is saved completely. `has_original` is worked out now: `meta.json` only
    /// says that the `.sbstems` file of the song has the original; the audio file the song was
    /// separated from counts as long as it can still be read.
    pub fn get(&self, id: &str) -> Option<StemSong> {
        self.read(id).map(|s| self.with_original(s))
    }

    fn with_original(&self, mut song: StemSong) -> StemSong {
        if !song.has_original {
            song.has_original = self.source(&song.id).is_some_and(|source| {
                let path = Path::new(&source.path);
                path.is_file() && std::fs::File::open(path).is_ok()
            });
        }
        song
    }

    /// Changes the song's `meta.json` (written whole next to it, then renamed over it).
    /// Returns the new state, or an error when the song is not in the cache.
    pub fn update(&self, id: &str, change: impl FnOnce(&mut StemSong)) -> Result<StemSong, String> {
        let mut song = self
            .read(id)
            .ok_or("That song is not saved any more.".to_string())?;
        change(&mut song);
        let dir = self.song_dir(id)?;
        let meta = serde_json::to_vec(&song).map_err(|e| e.to_string())?;
        let temp = dir.join(format!("{META}.tmp"));
        std::fs::write(&temp, meta)
            .and_then(|()| std::fs::rename(&temp, dir.join(META)))
            .map_err(|e| format!("The song could not be updated: {e}"))?;
        Ok(self.with_original(song))
    }

    /// Marks the song as opened now.
    pub fn touch(&self, id: &str) -> Result<StemSong, String> {
        self.update(id, |s| s.last_opened = Some(super::now_ms()))
    }

    /// Pins or unpins the song.
    pub fn pin(&self, id: &str, pinned: bool) -> Result<StemSong, String> {
        self.update(id, |s| s.pinned = pinned)
    }

    /// The audio file the song was separated from, if it was remembered.
    pub fn source(&self, id: &str) -> Option<Source> {
        Source::read(&self.song_dir(id).ok()?)
    }

    /// Remembers where a song that is already in the cache came from, unless it knows already.
    pub fn remember_source(&self, song: &StemSong, source: &Source) -> Result<StemSong, String> {
        if self.source(&song.id).is_none() {
            source.write(&self.song_dir(&song.id)?)?;
        }
        self.get(&song.id)
            .ok_or_else(|| "That song is not saved any more.".to_string())
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

/// When the song was last used: opened, or else made.
fn last_used(song: &StemSong) -> u64 {
    song.last_opened.unwrap_or(0).max(song.created_at_ms)
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
            pinned: false,
            last_opened: None,
            saved_path: None,
            has_original: false,
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

    #[test]
    fn a_pinned_song_survives_eviction_and_an_unpinned_one_goes() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf()).with_limit(100);
        save(&store, "aaaaaaaaaaaaaaaa", 1, 40);
        save(&store, "bbbbbbbbbbbbbbbb", 2, 40);
        store.pin("aaaaaaaaaaaaaaaa", true).unwrap();
        // Over the limit: the oldest is pinned, so the next oldest goes.
        let evicted = save(&store, "cccccccccccccccc", 3, 40);
        assert_eq!(evicted, ["bbbbbbbbbbbbbbbb"]);
        // Pinned songs alone may take the cache over its limit; nothing else is left to evict.
        store.pin("cccccccccccccccc", true).unwrap();
        let evicted = save(&store, "dddddddddddddddd", 4, 90);
        assert!(evicted.is_empty(), "{evicted:?}");
        let ids: Vec<_> = store.list().into_iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            ["dddddddddddddddd", "cccccccccccccccc", "aaaaaaaaaaaaaaaa"]
        );
        // Unpinning makes it a candidate again.
        store.pin("aaaaaaaaaaaaaaaa", false).unwrap();
        // 180 bytes against 100: the oldest unpinned ones go, the pinned one stays.
        assert_eq!(
            save(&store, "eeeeeeeeeeeeeeee", 5, 10),
            ["aaaaaaaaaaaaaaaa", "dddddddddddddddd"]
        );
        assert!(store.get("cccccccccccccccc").is_some());
    }

    #[test]
    fn eviction_goes_by_last_use_not_by_age() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf()).with_limit(100);
        save(&store, "aaaaaaaaaaaaaaaa", 1, 40);
        save(&store, "bbbbbbbbbbbbbbbb", 2, 40);
        // The older song was opened just now.
        store.touch("aaaaaaaaaaaaaaaa").unwrap();
        assert!(store.get("aaaaaaaaaaaaaaaa").unwrap().last_opened.is_some());
        assert_eq!(
            save(&store, "cccccccccccccccc", 3, 40),
            ["bbbbbbbbbbbbbbbb"]
        );
    }

    #[test]
    fn a_meta_file_from_before_saving_files_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().to_path_buf());
        save(&store, "aaaaaaaaaaaaaaaa", 7, 10);
        let meta = dir.path().join("aaaaaaaaaaaaaaaa").join("meta.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
        for key in ["pinned", "lastOpened", "savedPath", "hasOriginal"] {
            assert!(
                value.as_object_mut().unwrap().remove(key).is_some(),
                "{key}"
            );
        }
        std::fs::write(&meta, serde_json::to_vec(&value).unwrap()).unwrap();
        let song = store.get("aaaaaaaaaaaaaaaa").unwrap();
        assert!(!song.pinned && !song.has_original);
        assert_eq!((song.last_opened, song.saved_path), (None, None));
        assert_eq!(song.created_at_ms, 7);
        // Updating it writes the new fields.
        store.pin("aaaaaaaaaaaaaaaa", true).unwrap();
        assert!(store.get("aaaaaaaaaaaaaaaa").unwrap().pinned);
        assert!(store.update("ffffffffffffffff", |_| {}).is_err());
    }

    #[test]
    fn has_original_follows_the_source_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = StemStore::new(dir.path().join("stems"));
        let audio = dir.path().join("take.wav");
        std::fs::write(&audio, b"audio").unwrap();
        let staging = store.staging("aaaaaaaaaaaaaaaa").unwrap();
        std::fs::write(staging.path().join("other.wav"), [0u8; 10]).unwrap();
        Source::of(&audio, b"audio").write(staging.path()).unwrap();
        store
            .commit(staging, &song("aaaaaaaaaaaaaaaa", 1, 10))
            .unwrap();
        assert!(store.get("aaaaaaaaaaaaaaaa").unwrap().has_original);
        assert!(store.list()[0].has_original);
        std::fs::remove_file(&audio).unwrap();
        assert!(!store.get("aaaaaaaaaaaaaaaa").unwrap().has_original);
        // The source is never part of what the page is sent.
        let json = serde_json::to_string(&store.list()[0]).unwrap();
        assert!(
            !json.contains("take.wav") && !json.contains("sha256"),
            "{json}"
        );
    }
}
