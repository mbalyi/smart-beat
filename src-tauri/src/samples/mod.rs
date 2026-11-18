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
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

pub use store::{FolderKind, SampleFolder, SampleStore};

/// Everything the sample commands share. Stored as Tauri state.
pub struct SamplesState {
    pub store: SampleStore,
    pub(crate) jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Counts started previews, so a finished one is only reported while it is still the latest.
    pub(crate) preview_generation: AtomicU64,
}

impl SamplesState {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            store: SampleStore::new(dir),
            jobs: Mutex::default(),
            preview_generation: AtomicU64::new(0),
        }
    }
}
