//! The safe face of the C wrapper around muscriptor.cpp (native/shim.cpp). One `Model` holds a
//! loaded GGUF checkpoint; it runs one transcription at a time.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;

#[repr(C)]
struct RawNote {
    onset: f64,
    offset: f64,
    pitch: c_int,
    program: c_int,
    is_drum: c_int,
}
#[repr(C)]
struct RawModel {
    _private: [u8; 0],
}

type ProgressFn = extern "C" fn(f32, *mut c_void);
type CancelFn = extern "C" fn(*mut c_void) -> c_int;

unsafe extern "C" {
    fn sb_ms_load(
        path: *const c_char,
        out: *mut *mut RawModel,
        cancel: Option<CancelFn>,
        user: *mut c_void,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sb_ms_free(model: *mut RawModel);
    fn sb_ms_device(model: *const RawModel) -> *const c_char;
    #[allow(clippy::too_many_arguments)]
    fn sb_ms_transcribe(
        model: *mut RawModel,
        samples: *const f32,
        count: usize,
        groups: *const c_int,
        group_count: usize,
        progress: Option<ProgressFn>,
        cancel: Option<CancelFn>,
        user: *mut c_void,
        notes: *mut *mut RawNote,
        notes_len: *mut usize,
        err: *mut c_char,
        err_len: usize,
    ) -> c_int;
    fn sb_ms_free_notes(notes: *mut RawNote);
}

/// `msl::Error::Cancelled` plus one, as the wrapper reports it.
const CANCELLED: c_int = 8;

/// One transcribed note. MuScriptor predicts no velocity.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Note {
    pub onset: f64,
    pub offset: f64,
    /// MIDI pitch; the General MIDI drum number for a drum hit.
    pub pitch: u8,
    /// The decoded MIDI program (128 for drums).
    pub program: u8,
    pub is_drum: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Cancelled,
    Failed(String),
}

pub struct Model {
    raw: *mut RawModel,
}
// The wrapper keeps no thread-local state per model; callers serialise the use (a `Mutex`).
unsafe impl Send for Model {}

struct Callbacks<'a> {
    progress: &'a mut dyn FnMut(f32),
    cancelled: &'a dyn Fn() -> bool,
}
extern "C" fn on_progress(fraction: f32, user: *mut c_void) {
    // SAFETY: `user` is the `Callbacks` the calling function keeps alive for the whole call.
    let callbacks = unsafe { &mut *(user as *mut Callbacks) };
    (callbacks.progress)(fraction);
}
extern "C" fn on_cancel(user: *mut c_void) -> c_int {
    // SAFETY: as in `on_progress`.
    let callbacks = unsafe { &*(user as *const Callbacks) };
    c_int::from((callbacks.cancelled)())
}

fn message(buffer: &[c_char]) -> String {
    // SAFETY: the wrapper always terminates the text inside the buffer.
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

impl Model {
    pub fn load(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<Self, Failure> {
        let path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| Failure::Failed("The model path is not valid.".into()))?;
        let mut noop = |_: f32| {};
        let mut callbacks = Callbacks {
            progress: &mut noop,
            cancelled,
        };
        let mut raw = std::ptr::null_mut();
        let mut err = [0 as c_char; 256];
        // SAFETY: all pointers are valid for the call; `callbacks` outlives it.
        let code = unsafe {
            sb_ms_load(
                path.as_ptr(),
                &mut raw,
                Some(on_cancel),
                &mut callbacks as *mut Callbacks as *mut c_void,
                err.as_mut_ptr(),
                err.len(),
            )
        };
        match code {
            0 if !raw.is_null() => Ok(Self { raw }),
            CANCELLED => Err(Failure::Cancelled),
            _ => Err(Failure::Failed(message(&err))),
        }
    }

    /// Where the model runs, such as "CPU" or "Apple M1 Pro".
    pub fn device(&self) -> String {
        // SAFETY: the wrapper returns a NUL-terminated name that stays valid until the next call.
        unsafe { CStr::from_ptr(sb_ms_device(self.raw)) }
            .to_string_lossy()
            .into_owned()
    }

    /// `samples` are 16 kHz mono. `groups` limits the instruments (empty: all).
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        groups: &[i32],
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<Note>, Failure> {
        let mut callbacks = Callbacks {
            progress,
            cancelled,
        };
        let (mut notes, mut len) = (std::ptr::null_mut(), 0usize);
        let mut err = [0 as c_char; 256];
        // SAFETY: as in `load`; the note array is freed below.
        let code = unsafe {
            sb_ms_transcribe(
                self.raw,
                samples.as_ptr(),
                samples.len(),
                groups.as_ptr(),
                groups.len(),
                Some(on_progress),
                Some(on_cancel),
                &mut callbacks as *mut Callbacks as *mut c_void,
                &mut notes,
                &mut len,
                err.as_mut_ptr(),
                err.len(),
            )
        };
        match code {
            0 => {
                // SAFETY: the wrapper returned `len` notes at `notes`.
                let raw = unsafe { std::slice::from_raw_parts(notes, len) };
                let out = raw
                    .iter()
                    .map(|n| Note {
                        onset: n.onset,
                        offset: n.offset,
                        pitch: n.pitch.clamp(0, 127) as u8,
                        program: n.program.clamp(0, 128) as u8,
                        is_drum: n.is_drum != 0,
                    })
                    .collect();
                // SAFETY: allocated by the wrapper, freed once.
                unsafe { sb_ms_free_notes(notes) };
                Ok(out)
            }
            CANCELLED => Err(Failure::Cancelled),
            _ => Err(Failure::Failed(message(&err))),
        }
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        // SAFETY: `raw` came from `sb_ms_load` and is freed once.
        unsafe { sb_ms_free(self.raw) };
    }
}
