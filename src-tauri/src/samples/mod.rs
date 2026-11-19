//! The sample browser (issue #232): folders of audio files the user links, copies in or unpacks,
//! a cached index of what they hold, and a preview voice that plays one file at a time without
//! touching the score.
//!
//! Layout inside the app data folder: `samples/folders.json` lists the folders,
//! `samples/<id>/index.json` caches what was learnt about each file, and imported or unpacked
//! folders keep their audio in `samples/<id>/files/`.

pub mod commands;
pub mod files;
pub mod import;
pub mod preview;
pub mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

pub use store::{FolderKind, SampleFolder, SampleStore};

/// Everything the sample commands share. Stored as Tauri state.
pub struct SamplesState {
    pub store: SampleStore,
    pub(crate) jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Counts preview requests (starts and stops). A start only plays if no later request
    /// arrived while it was still decoding, and the check and the start happen under this lock
    /// so a stop cannot slip in between them.
    preview_generation: Mutex<u64>,
}

impl SamplesState {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            store: SampleStore::new(dir),
            jobs: Mutex::default(),
            preview_generation: Mutex::new(0),
        }
    }

    fn generation(&self) -> MutexGuard<'_, u64> {
        self.preview_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Registers a new preview request, before its file is decoded, and returns its ticket.
    pub(crate) fn begin_preview(&self) -> u64 {
        let mut generation = self.generation();
        *generation += 1;
        *generation
    }

    /// Supersedes every pending request, then runs `stop` before anything else can start.
    pub(crate) fn cancel_previews<T>(&self, stop: impl FnOnce() -> T) -> T {
        let mut generation = self.generation();
        *generation += 1;
        stop()
    }

    /// Runs `start` only while `ticket` is still the latest request; `None` means a stop or a
    /// newer preview superseded it and nothing was started.
    pub(crate) fn start_if_current<T>(&self, ticket: u64, start: impl FnOnce() -> T) -> Option<T> {
        let generation = self.generation();
        (*generation == ticket).then(start)
    }

    /// Whether `ticket` is still the latest request.
    pub(crate) fn is_current(&self, ticket: u64) -> bool {
        *self.generation() == ticket
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> SamplesState {
        SamplesState::new(std::env::temp_dir().join("samples-state-test"))
    }

    #[test]
    fn a_preview_that_finished_decoding_after_a_stop_never_starts() {
        let state = state();
        let ticket = state.begin_preview();
        state.cancel_previews(|| ());
        let mut started = false;
        let result = state.start_if_current(ticket, || started = true);
        assert!(result.is_none());
        assert!(!started);
        assert!(!state.is_current(ticket));
    }

    #[test]
    fn a_slow_earlier_preview_does_not_replace_a_newer_one() {
        let state = state();
        let slow = state.begin_preview();
        let newer = state.begin_preview();
        assert!(state.start_if_current(slow, || ()).is_none());
        assert!(state.start_if_current(newer, || ()).is_some());
    }

    #[test]
    fn the_latest_preview_starts_when_nothing_intervened() {
        let state = state();
        let ticket = state.begin_preview();
        assert_eq!(state.start_if_current(ticket, || 7), Some(7));
        assert!(state.is_current(ticket));
    }
}
