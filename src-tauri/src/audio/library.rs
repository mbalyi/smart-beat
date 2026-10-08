//! The user's sound library: amp and pedal captures (Neural Amp Modeler
//! `.nam`) and cabinet impulse responses (`.wav`) imported from their own
//! files. Imports are copied into the app data folder and never leave the
//! machine. Built-in cabinets are generated (no recorded IRs are bundled).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::backing::Interpolator;
use super::chain::AssetSource;
use super::dsp::biquad::{Biquad, Coefficients, FilterKind};
use super::dsp::convolver::{IrSpectrum, MAX_IR_SAMPLES};

const INDEX_FILE: &str = "library.json";
const INDEX_VERSION: u32 = 1;
/// Largest file accepted for import.
pub const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
pub const BUILTIN_PREFIX: &str = "builtin:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Amp,
    Cab,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub kind: AssetKind,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// File name inside the library folder (empty for built-ins).
    pub file: String,
    /// Sample rate the asset was made for.
    pub sample_rate: u32,
    /// Original file name, for the user's reference.
    pub source: String,
    pub builtin: bool,
    /// For amps: whether the capture already includes a speaker cabinet.
    #[serde(default)]
    pub includes_cab: bool,
    /// Something the user should know about this file (empty when nothing):
    /// for example that only the first part of a long impulse response is used.
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    version: u32,
    items: Vec<LibraryItem>,
}

/// A built-in cabinet: id, name, tags, high pass (Hz), presence peak (Hz, dB), low pass (Hz).
type CabSpec = (
    &'static str,
    &'static str,
    &'static [&'static str],
    f32,
    (f32, f32),
    f32,
);

const BUILTIN_CABS: [CabSpec; 4] = [
    (
        "4x12-modern",
        "4×12 modern (generated)",
        &["metal", "djent", "metalcore"],
        80.0,
        (2_500.0, 4.0),
        5_500.0,
    ),
    (
        "4x12-vintage",
        "4×12 vintage (generated)",
        &["rock", "nu-metal", "hardcore"],
        90.0,
        (1_800.0, 3.0),
        4_500.0,
    ),
    (
        "2x12-open",
        "2×12 open back (generated)",
        &["clean", "ambient"],
        70.0,
        (3_000.0, 2.0),
        7_000.0,
    ),
    (
        "8x10-bass",
        "8×10 bass (generated)",
        &["bass"],
        40.0,
        (800.0, 3.0),
        4_000.0,
    ),
];

/// A deterministic cabinet-like impulse response: a decaying noise burst
/// shaped by the cabinet's band limits and presence peak.
pub fn generated_cab(id: &str, sample_rate: f32) -> Option<Vec<f32>> {
    let (_, _, _, hp, (peak_hz, peak_db), lp) = *BUILTIN_CABS.iter().find(|c| c.0 == id)?;
    let len = (0.05 * sample_rate) as usize; // 50 ms
    let mut seed: u32 = 0x9e37_79b9
        ^ id.bytes()
            .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32));
    let mut filters = [Biquad::default(); 4];
    filters[0].set(Coefficients::new(
        FilterKind::HighPass,
        hp,
        0.9,
        0.0,
        sample_rate,
    ));
    filters[1].set(Coefficients::new(
        FilterKind::Peak,
        peak_hz,
        1.2,
        peak_db,
        sample_rate,
    ));
    filters[2].set(Coefficients::new(
        FilterKind::LowPass,
        lp,
        0.8,
        0.0,
        sample_rate,
    ));
    filters[3].set(Coefficients::new(
        FilterKind::LowPass,
        lp * 1.2,
        0.6,
        0.0,
        sample_rate,
    ));
    let ir = (0..len)
        .map(|i| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let noise = (seed as f32 / u32::MAX as f32) * 2.0 - 1.0;
            let t = i as f32 / sample_rate;
            let x = if i == 0 {
                1.0
            } else {
                noise * (-t / 0.006).exp() * 0.5
            };
            filters.iter_mut().fold(x, |s, f| f.tick(s))
        })
        .collect();
    Some(ir)
}

fn builtin_items() -> Vec<LibraryItem> {
    BUILTIN_CABS
        .iter()
        .map(|(id, name, tags, ..)| LibraryItem {
            id: format!("{BUILTIN_PREFIX}{id}"),
            kind: AssetKind::Cab,
            name: (*name).into(),
            tags: tags.iter().map(|t| (*t).into()).collect(),
            file: String::new(),
            sample_rate: 0,
            source: "Smart Beat".into(),
            builtin: true,
            includes_cab: false,
            note: String::new(),
        })
        .collect()
}

/// FNV-1a: a stable id from the file content (same file → same id).
fn content_id(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Reads a WAV impulse response as mono floats (the channels averaged).
pub fn read_ir(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let reader = hound::WavReader::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("This is not a WAV file the app can read ({e})"))?;
    let spec = reader.spec();
    if spec.channels == 0 || spec.sample_rate < 8_000 || spec.sample_rate > 384_000 {
        return Err("The WAV file has an unusual format (channels or sample rate)".into());
    }
    let channels = spec.channels as usize;
    let samples: Result<Vec<f32>, _> = match spec.sample_format {
        hound::SampleFormat::Float => reader.into_samples::<f32>().collect(),
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1i64 << (spec.bits_per_sample.clamp(8, 32) - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect()
        }
    };
    let samples = samples.map_err(|e| format!("The WAV file is damaged ({e})"))?;
    let mono: Vec<f32> = samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .take(MAX_IR_SAMPLES * 8)
        .collect();
    if mono.is_empty() || mono.iter().all(|s| *s == 0.0) {
        return Err("The impulse response is silent".into());
    }
    if !mono.iter().all(|s| s.is_finite()) {
        return Err("The impulse response contains invalid samples".into());
    }
    Ok((mono, spec.sample_rate))
}

/// Band-limited resampling (windowed sinc; converting down filters first so
/// nothing aliases).
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let step = from as f64 / to as f64;
    let interpolator = Interpolator::new(step);
    let len = ((input.len() as f64) / step).floor().max(1.0) as usize;
    (0..len)
        .map(|i| interpolator.read(input, i as f64 * step))
        .collect()
}

/// What to tell the user about an impulse response the engine cannot use whole.
fn ir_note(samples: usize, rate: u32) -> String {
    if samples <= MAX_IR_SAMPLES {
        return String::new();
    }
    format!(
        "Only the first {:.1} s of this {:.1} s impulse response is used.",
        MAX_IR_SAMPLES as f64 / rate as f64,
        samples as f64 / rate as f64
    )
}

pub struct Library {
    dir: PathBuf,
    index: Mutex<Vec<LibraryItem>>,
    /// Loaded assets, keyed by id and (for IRs) the engine's sample rate.
    irs: Mutex<HashMap<(String, u32), Arc<IrSpectrum>>>,
    amps: Mutex<HashMap<String, Arc<nam_rs::NamModel>>>,
}

impl Library {
    pub fn new(dir: PathBuf) -> Self {
        let items = fs::read(dir.join(INDEX_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Index>(&bytes).ok())
            .filter(|index| index.version == INDEX_VERSION)
            .map(|index| index.items)
            .unwrap_or_default();
        Self {
            dir,
            index: Mutex::new(items),
            irs: Mutex::new(HashMap::new()),
            amps: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<LibraryItem> {
        let mut items = builtin_items();
        items.extend(self.index.lock().unwrap().iter().cloned());
        items
    }

    fn save(&self, items: &[LibraryItem]) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let index = Index {
            version: INDEX_VERSION,
            items: items.to_vec(),
        };
        let json = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
        let tmp = self.dir.join(format!("{INDEX_FILE}.tmp"));
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.dir.join(INDEX_FILE)).map_err(|e| e.to_string())
    }

    /// Checks and copies a user's file into the library.
    pub fn import(&self, path: &Path, kind: AssetKind) -> Result<LibraryItem, String> {
        let meta = fs::metadata(path).map_err(|e| format!("The file cannot be read ({e})"))?;
        if meta.len() > MAX_IMPORT_BYTES {
            return Err("The file is too large (over 64 MB)".into());
        }
        let bytes = fs::read(path).map_err(|e| format!("The file cannot be read ({e})"))?;
        let source = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = content_id(&bytes);
        let (name, sample_rate, includes_cab, extension, note) = match kind {
            AssetKind::Amp => {
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| "This is not a Neural Amp Modeler (.nam) file")?;
                let model = nam_rs::NamModel::from_json_str(text).map_err(|e| {
                    format!("This is not a Neural Amp Modeler file the app can use ({e})")
                })?;
                nam_rs::Model::from_nam(&model)
                    .map_err(|e| format!("The amp model cannot run ({e})"))?;
                let meta = model.metadata_typed();
                let name = meta
                    .name
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or(stem);
                (
                    name,
                    model.expected_sample_rate() as u32,
                    meta.includes_cab().unwrap_or(false),
                    "nam",
                    String::new(),
                )
            }
            AssetKind::Cab => {
                let (samples, rate) = read_ir(&bytes)?;
                (stem, rate, false, "wav", ir_note(samples.len(), rate))
            }
        };
        let file = format!("{id}.{extension}");
        let mut items = self.index.lock().unwrap();
        if let Some(existing) = items.iter().find(|i| i.id == id) {
            return Ok(existing.clone());
        }
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        fs::write(self.dir.join(&file), &bytes)
            .map_err(|e| format!("The file cannot be copied ({e})"))?;
        let item = LibraryItem {
            id,
            kind,
            name,
            tags: Vec::new(),
            file,
            sample_rate,
            source,
            builtin: false,
            includes_cab,
            note,
        };
        items.push(item.clone());
        self.save(&items)?;
        Ok(item)
    }

    pub fn update(&self, id: &str, name: String, tags: Vec<String>) -> Result<LibraryItem, String> {
        let mut items = self.index.lock().unwrap();
        let item = items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or("No such item in the library")?;
        let name = name.trim();
        if name.is_empty() || name.len() > 200 {
            return Err("The name must be 1 to 200 characters".into());
        }
        item.name = name.to_string();
        item.tags = tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .take(20)
            .collect();
        let updated = item.clone();
        self.save(&items)?;
        Ok(updated)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut items = self.index.lock().unwrap();
        let Some(pos) = items.iter().position(|i| i.id == id) else {
            return Err("No such item in the library".into());
        };
        let item = items.remove(pos);
        let _ = fs::remove_file(self.dir.join(&item.file));
        self.irs.lock().unwrap().retain(|(k, _), _| k != id);
        self.amps.lock().unwrap().remove(id);
        self.save(&items)
    }

    /// The asset source for an engine running at `sample_rate`.
    pub fn assets(self: &Arc<Self>, sample_rate: u32) -> LibraryAssets {
        LibraryAssets {
            library: self.clone(),
            sample_rate,
        }
    }

    fn load_ir(&self, id: &str, rate: u32) -> Option<Arc<IrSpectrum>> {
        let key = (id.to_string(), rate);
        if let Some(found) = self.irs.lock().unwrap().get(&key) {
            return Some(found.clone());
        }
        let samples = if let Some(builtin) = id.strip_prefix(BUILTIN_PREFIX) {
            generated_cab(builtin, rate as f32)?
        } else {
            let item = self
                .index
                .lock()
                .unwrap()
                .iter()
                .find(|i| i.id == id && i.kind == AssetKind::Cab)?
                .clone();
            let bytes = fs::read(self.dir.join(&item.file)).ok()?;
            let (ir, from) = read_ir(&bytes).ok()?;
            resample(&ir, from, rate)
        };
        let spectrum = Arc::new(IrSpectrum::new(&samples));
        self.irs.lock().unwrap().insert(key, spectrum.clone());
        Some(spectrum)
    }

    fn load_amp(&self, id: &str) -> Option<Arc<nam_rs::NamModel>> {
        if let Some(found) = self.amps.lock().unwrap().get(id) {
            return Some(found.clone());
        }
        let item = self
            .index
            .lock()
            .unwrap()
            .iter()
            .find(|i| i.id == id && i.kind == AssetKind::Amp)?
            .clone();
        let text = fs::read_to_string(self.dir.join(&item.file)).ok()?;
        let model = Arc::new(nam_rs::NamModel::from_json_str(&text).ok()?);
        self.amps
            .lock()
            .unwrap()
            .insert(id.to_string(), model.clone());
        Some(model)
    }
}

pub struct LibraryAssets {
    library: Arc<Library>,
    sample_rate: u32,
}

impl AssetSource for LibraryAssets {
    fn impulse_response(&self, id: &str) -> Option<Arc<IrSpectrum>> {
        self.library.load_ir(id, self.sample_rate)
    }
    fn amp_model(&self, id: &str) -> Option<Arc<nam_rs::NamModel>> {
        self.library.load_amp(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: &[f32], rate: u32, channels: u16) -> Vec<u8> {
        let mut out = std::io::Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::new(&mut out, spec).unwrap();
        for s in samples {
            for _ in 0..channels {
                w.write_sample((s * 8_388_607.0) as i32).unwrap();
            }
        }
        w.finalize().unwrap();
        out.into_inner()
    }

    #[test]
    fn generated_cabs_are_finite_and_deterministic() {
        for (id, ..) in BUILTIN_CABS {
            let a = generated_cab(id, 48_000.0).unwrap();
            assert_eq!(a, generated_cab(id, 48_000.0).unwrap());
            assert!(a.iter().all(|s| s.is_finite()));
        }
        assert!(generated_cab("nope", 48_000.0).is_none());
    }

    #[test]
    fn reads_stereo_24_bit_irs_as_mono() {
        let (ir, rate) = read_ir(&wav(&[0.5, 0.25, -0.125], 44_100, 2)).unwrap();
        assert_eq!(rate, 44_100);
        assert_eq!(ir.len(), 3);
        assert!((ir[0] - 0.5).abs() < 1e-4);
        assert!(read_ir(b"RIFF....WAVEjunk").is_err());
        assert!(read_ir(&wav(&[0.0; 10], 48_000, 1)).is_err());
    }

    #[test]
    fn resamples_smoothly_and_to_the_new_length() {
        use std::f32::consts::TAU;
        // A 1 kHz tone at 24 kHz, doubled to 48 kHz, must stay the same tone.
        let input: Vec<f32> = (0..480)
            .map(|i| (TAU * 1_000.0 * i as f32 / 24_000.0).sin())
            .collect();
        let out = resample(&input, 24_000, 48_000);
        assert_eq!(out.len(), 960);
        for (i, value) in out.iter().enumerate().skip(20).take(900) {
            let truth = (TAU * 1_000.0 * i as f32 / 48_000.0).sin();
            assert!(
                (value - truth).abs() < 0.02,
                "sample {i}: {value} vs {truth}"
            );
        }
        // Converting down keeps the length ratio and does not alias a tone
        // above the new Nyquist back into the band.
        let tone: Vec<f32> = (0..4_800)
            .map(|i| (TAU * 20_000.0 * i as f32 / 48_000.0).sin())
            .collect();
        let down = resample(&tone, 48_000, 24_000);
        assert_eq!(down.len(), 2_400);
        let rms = (down[50..2_350].iter().map(|s| s * s).sum::<f32>() / 2_300.0).sqrt();
        assert!(rms < 0.1, "aliased: {rms}");
    }

    #[test]
    fn stereo_irs_average_both_channels() {
        let mut out = std::io::Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::new(&mut out, spec).unwrap();
        for (l, r) in [(16_384i16, 0i16), (0, 8_192)] {
            w.write_sample(l).unwrap();
            w.write_sample(r).unwrap();
        }
        w.finalize().unwrap();
        let (ir, _) = read_ir(&out.into_inner()).unwrap();
        assert!(
            (ir[0] - 0.25).abs() < 1e-3 && (ir[1] - 0.125).abs() < 1e-3,
            "{ir:?}"
        );
    }

    #[test]
    fn a_long_impulse_response_is_imported_with_a_note() {
        let dir = tempfile::tempdir().unwrap();
        let long = dir.path().join("hall.wav");
        let samples: Vec<f32> = (0..MAX_IR_SAMPLES + 5_000)
            .map(|i| if i == 0 { 1.0 } else { 0.001 })
            .collect();
        fs::write(&long, wav(&samples, 48_000, 1)).unwrap();
        let short = dir.path().join("cab.wav");
        fs::write(&short, wav(&[1.0, 0.5], 48_000, 1)).unwrap();
        let library = Arc::new(Library::new(dir.path().join("lib")));
        let item = library.import(&long, AssetKind::Cab).unwrap();
        assert!(item.note.contains("Only the first 1.4 s"), "{}", item.note);
        assert!(
            library
                .import(&short, AssetKind::Cab)
                .unwrap()
                .note
                .is_empty()
        );
        // The note is stored with the item.
        let again = Library::new(dir.path().join("lib"));
        assert!(
            again
                .list()
                .iter()
                .any(|i| i.id == item.id && !i.note.is_empty())
        );
    }

    #[test]
    fn imports_a_valid_amp_capture_and_uses_its_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tiny-file-name.nam");
        fs::write(
            &file,
            crate::audio::test_fixtures::tiny_nam(Some(44_100.0), Some(-20.0)),
        )
        .unwrap();
        let library = Arc::new(Library::new(dir.path().join("lib")));
        let item = library.import(&file, AssetKind::Amp).unwrap();
        assert_eq!(item.kind, AssetKind::Amp);
        assert_eq!(item.name, "Tiny test amp", "the name inside the file wins");
        assert_eq!(item.sample_rate, 44_100);
        assert_eq!(item.source, "tiny-file-name.nam");
        assert!(library.assets(48_000).amp_model(&item.id).is_some());
        // The copy lives in the library folder only.
        assert!(dir.path().join("lib").join(&item.file).is_file());
        // A new instance finds it again.
        let again = Arc::new(Library::new(dir.path().join("lib")));
        assert!(again.assets(48_000).amp_model(&item.id).is_some());
    }

    #[test]
    fn files_of_the_wrong_kind_or_shape_are_refused_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        let library = Arc::new(Library::new(dir.path().join("lib")));
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            fs::write(&path, bytes).unwrap();
            path
        };
        let nam = crate::audio::test_fixtures::tiny_nam(None, None);
        // A WAV given to the amp importer, a capture given to the cabinet importer.
        let err = library
            .import(
                &write("cab.wav", &wav(&[1.0, 0.5], 48_000, 1)),
                AssetKind::Amp,
            )
            .unwrap_err();
        assert!(err.contains("Neural Amp Modeler"), "{err}");
        let err = library
            .import(&write("amp.nam", nam.as_bytes()), AssetKind::Cab)
            .unwrap_err();
        assert!(err.contains("WAV"), "{err}");
        // Empty, truncated and non-UTF-8 files.
        assert!(
            library
                .import(&write("empty.nam", b""), AssetKind::Amp)
                .is_err()
        );
        assert!(
            library
                .import(&write("empty.wav", b""), AssetKind::Cab)
                .is_err()
        );
        let cut = &nam.as_bytes()[..nam.len() / 2];
        assert!(
            library
                .import(&write("cut.nam", cut), AssetKind::Amp)
                .is_err()
        );
        assert!(
            library
                .import(
                    &write("binary.nam", &[0xff, 0xfe, 0x00, 0x80]),
                    AssetKind::Amp
                )
                .is_err()
        );
        // A missing file.
        let err = library
            .import(&dir.path().join("nope.nam"), AssetKind::Amp)
            .unwrap_err();
        assert!(err.contains("cannot be read"), "{err}");
        // Nothing of that ended up in the library.
        assert!(library.list().iter().all(|i| i.builtin));
        assert!(!dir.path().join("lib").join("library.json").exists());
    }

    #[test]
    fn imports_lists_renames_and_removes_irs() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("My Cab.wav");
        fs::write(&file, wav(&[1.0, 0.5, 0.25], 48_000, 1)).unwrap();
        let library = Arc::new(Library::new(dir.path().join("lib")));
        let item = library.import(&file, AssetKind::Cab).unwrap();
        assert_eq!(item.name, "My Cab");
        assert_eq!(
            library.import(&file, AssetKind::Cab).unwrap().id,
            item.id,
            "same file, same item"
        );
        assert!(library.list().iter().any(|i| i.id == item.id));
        assert!(library.assets(44_100).impulse_response(&item.id).is_some());
        library
            .update(&item.id, "Renamed".into(), vec!["metal".into(), " ".into()])
            .unwrap();
        // A new instance reads the index back.
        let again = Library::new(dir.path().join("lib"));
        let stored = again.list().into_iter().find(|i| i.id == item.id).unwrap();
        assert_eq!((stored.name.as_str(), stored.tags.len()), ("Renamed", 1));
        library.remove(&item.id).unwrap();
        assert!(
            Library::new(dir.path().join("lib"))
                .list()
                .iter()
                .all(|i| i.builtin)
        );
    }

    #[test]
    fn rejects_bad_amp_files_and_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("broken.nam");
        fs::write(&file, b"{\"architecture\": \"Nope\"}").unwrap();
        let library = Arc::new(Library::new(dir.path().join("lib")));
        assert!(library.import(&file, AssetKind::Amp).is_err());
        assert!(library.assets(48_000).amp_model("missing").is_none());
        assert!(
            library
                .assets(48_000)
                .impulse_response("builtin:4x12-modern")
                .is_some()
        );
        assert!(library.remove("missing").is_err());
    }
}
