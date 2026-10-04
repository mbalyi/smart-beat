//! Imported drum kits (#40): free sampled kits in SFZ or SF2/SF3 that the
//! user brings, kept in `<app data>/kits/<id>/` with their licence. Kits load
//! lazily: startup reads only `kits.json`; samples are decoded the first time
//! a track picks the kit.
//!
//! Licences: kits with a non-commercial licence are refused. CC0, public
//! domain, CC-BY and CC-BY-SA kits are accepted (CC-BY ones are credited in the
//! licences dialog); a kit whose licence cannot be found needs the user to
//! confirm they may use it.

pub mod sampler;
pub mod sfz;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rustysynth::SoundFont;
use serde::{Deserialize, Serialize};

use sampler::{SampleData, SfzKit};
use sfz::Region;

/// Largest kit accepted (samples copied into the library).
pub const MAX_KIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Largest SF2/SF3 kit (loaded whole).
pub const MAX_SOUNDFONT_KIT_BYTES: u64 = 512 * 1024 * 1024;
/// Largest licence or readme file read.
const MAX_TEXT_BYTES: u64 = 256 * 1024;
const INDEX: &str = "kits.json";
const REGIONS: &str = "regions.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KitFormat {
    Sfz,
    Sf2,
    Sf3,
}

/// The licences a kit can be imported under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LicenceKind {
    Cc0,
    PublicDomain,
    CcBy,
    CcBySa,
    /// Another licence that allows commercial use (the user confirmed it).
    OtherCommercial,
    /// Could not be found; the user confirmed they may use the kit.
    Unknown,
}

impl LicenceKind {
    /// Whether the licences dialog must credit the kit.
    pub fn needs_credit(self) -> bool {
        matches!(self, Self::CcBy | Self::CcBySa | Self::OtherCommercial)
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "cc0" => Self::Cc0,
            "public-domain" => Self::PublicDomain,
            "cc-by" => Self::CcBy,
            "cc-by-sa" => Self::CcBySa,
            "other-commercial" => Self::OtherCommercial,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitLicence {
    pub kind: LicenceKind,
    /// The licence text found next to the kit (shortened).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Who made the kit, for the credit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<String>,
}

/// A drum mixer piece the kit plays, with the keys it covers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitPiece {
    pub element: String,
    pub keys: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitInfo {
    pub id: String,
    pub name: String,
    pub format: KitFormat,
    pub licence: KitLicence,
    /// Drum mixer pieces the kit has samples for.
    pub pieces: Vec<KitPiece>,
    /// Drum mixer pieces it has nothing for (they stay silent).
    pub missing: Vec<String>,
    pub size_bytes: u64,
    /// Things the import could not take over (unsupported opcodes…).
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// The drum mixer's pieces and their keys: mirrors `DRUM_ELEMENTS` in
/// `src/lib/audio/drum-elements.ts` (a test keeps them equal).
pub const DRUM_ELEMENTS: [(&str, &[u8]); 17] = [
    ("snare", &[31, 37, 38, 40, 91]),
    ("hihat", &[42, 44, 46, 92]),
    ("acoustic-kick", &[35]),
    ("kick", &[36, 114]),
    ("tom1", &[50]),
    ("tom2", &[48]),
    ("tom3", &[47]),
    ("tom4", &[45]),
    ("tom5", &[41, 43]),
    ("ride", &[29, 51, 53, 59, 93, 94, 126, 127]),
    ("splash", &[55, 95]),
    ("china", &[52, 96]),
    ("crash-high", &[49, 97]),
    ("crash-medium", &[57, 98]),
    ("cowbell-low", &[99, 100]),
    ("cowbell-medium", &[56, 101]),
    ("cowbell-high", &[102, 103]),
];

/// Which drum mixer pieces a kit's keys cover, and which it lacks.
pub fn map_pieces(keys: &BTreeSet<u8>) -> (Vec<KitPiece>, Vec<String>) {
    let mut pieces = Vec::new();
    let mut missing = Vec::new();
    for (element, element_keys) in DRUM_ELEMENTS {
        let covered: Vec<u8> = element_keys
            .iter()
            .copied()
            .filter(|k| keys.contains(k))
            .collect();
        if covered.is_empty() {
            missing.push(element.to_string());
        } else {
            pieces.push(KitPiece {
                element: element.to_string(),
                keys: covered,
            });
        }
    }
    (pieces, missing)
}

/// What the import found out about the licence.
#[derive(Debug, Clone, PartialEq)]
pub enum Detected {
    Licence(KitLicence),
    NonCommercial(String),
    Unknown,
}

/// Licence, copying and readme files next to a kit.
fn licence_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            ["licen", "copying", "readme", "credits", "about"]
                .iter()
                .any(|w| name.contains(w))
        })
        .collect();
    files.sort();
    files
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_TEXT_BYTES {
        return None;
    }
    std::fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Reads the licence of a kit from the files next to it.
pub fn detect_licence(dir: &Path) -> Detected {
    let texts: Vec<String> = licence_files(dir)
        .iter()
        .filter_map(|p| read_text(p))
        .collect();
    if texts.is_empty() {
        return Detected::Unknown;
    }
    let all = texts.join("\n");
    let lower = all.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    if has(&[
        "noncommercial",
        "non-commercial",
        "non commercial",
        "by-nc",
        "cc-nc",
        "not for commercial",
        "no commercial",
    ]) {
        return Detected::NonCommercial(
            "Its licence does not allow commercial use (non-commercial).".into(),
        );
    }
    let kind = if has(&[
        "sharealike",
        "share-alike",
        "share alike",
        "by-sa",
        "cc-by-sa",
    ]) {
        LicenceKind::CcBySa
    } else if has(&[
        "creative commons attribution",
        "cc-by",
        "cc by 4",
        "cc by 3",
        "cc-by-4",
        "attribution 4.0",
        "attribution 3.0",
    ]) {
        LicenceKind::CcBy
    } else if has(&["cc0", "creative commons zero", "public domain dedication"]) {
        LicenceKind::Cc0
    } else if has(&["public domain"]) {
        LicenceKind::PublicDomain
    } else {
        return Detected::Unknown;
    };
    let attribution = all
        .lines()
        .map(str::trim)
        .find(|line| {
            let l = line.to_ascii_lowercase();
            !line.is_empty()
                && line.len() < 200
                && [
                    "copyright",
                    "created by",
                    "recorded by",
                    "author",
                    "made by",
                    "©",
                ]
                .iter()
                .any(|w| l.contains(w))
        })
        .map(str::to_string);
    let text: String = all.chars().take(4_000).collect();
    Detected::Licence(KitLicence {
        kind,
        text: Some(text),
        attribution,
    })
}

/// A kit ready to play.
pub enum LoadedKit {
    SoundFont(Arc<SoundFont>),
    Sfz(Arc<SfzKit>),
}

/// Keeps a relative path inside the kit folder ("../x.wav" → "external/x.wav").
fn safe_relative(path: &Path, index: usize) -> PathBuf {
    let normal: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_owned()),
            _ => None,
        })
        .collect();
    let escapes = path.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    });
    if escapes || normal.is_empty() {
        let name = path.file_name().map_or_else(
            || format!("sample-{index}.wav"),
            |n| n.to_string_lossy().into_owned(),
        );
        PathBuf::from("external").join(format!("{index}-{name}"))
    } else {
        normal.iter().collect()
    }
}

/// A kit's name from its file: "Muldjord Kit.sfz" → "Muldjord Kit"; a
/// generic file name ("kit.sfz", "drums.sf2") takes its folder's name.
pub fn default_name(source: &Path) -> String {
    const GENERIC: [&str; 6] = ["kit", "drumkit", "drum kit", "drums", "main", "default"];
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().trim().to_string())
        .unwrap_or_default();
    if !stem.is_empty() && !GENERIC.contains(&stem.to_ascii_lowercase().as_str()) {
        return stem;
    }
    source
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Drum kit".into())
}

fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "kit".into()
    } else {
        s.chars().take(40).collect()
    }
}

/// The user's drum kits.
pub struct KitLibrary {
    dir: PathBuf,
    index: Mutex<Vec<KitInfo>>,
    /// Kits decoded so far (by id).
    loaded: Mutex<HashMap<String, Arc<LoadedKit>>>,
}

/// How the user answered the licence question in the import dialog.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// The licence the user picked (`cc0`, `cc-by`…), when none was found or to correct it.
    #[serde(default)]
    pub licence: Option<String>,
    /// The user confirmed they may use a kit whose licence is unknown.
    #[serde(default)]
    pub accept_unknown: bool,
    #[serde(default)]
    pub attribution: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

impl KitLibrary {
    pub fn new(dir: PathBuf) -> Self {
        let index = std::fs::read(dir.join(INDEX))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            dir,
            index: Mutex::new(index),
            loaded: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<KitInfo> {
        self.index.lock().unwrap().clone()
    }

    fn save_index(&self, index: &[KitInfo]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
        let tmp = self.dir.join(format!("{INDEX}.tmp"));
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(tmp, self.dir.join(INDEX)).map_err(|e| e.to_string())
    }

    fn new_id(&self, name: &str) -> String {
        let index = self.index.lock().unwrap();
        let base = slug(name);
        let mut id = base.clone();
        let mut n = 2;
        while index.iter().any(|k| k.id == id) || self.dir.join(&id).exists() {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }

    /// Decides the licence: what the files say, corrected or confirmed by the user.
    fn licence_for(source: &Path, options: &ImportOptions) -> Result<KitLicence, String> {
        let dir = source.parent().unwrap_or(Path::new("."));
        let detected = detect_licence(dir);
        if let Detected::NonCommercial(reason) = &detected {
            return Err(format!("This kit cannot be imported. {reason}"));
        }
        let chosen = match options.licence.as_deref() {
            Some(text) if text.contains("nc") => {
                return Err("Kits with a non-commercial licence cannot be imported.".into());
            }
            Some(text) => Some(LicenceKind::parse(text).ok_or("Unknown licence")?),
            None => None,
        };
        let mut licence = match (detected, chosen) {
            (Detected::Licence(found), None) => found,
            (Detected::Licence(found), Some(kind)) => KitLicence { kind, ..found },
            (Detected::Unknown, Some(LicenceKind::Unknown) | None) => {
                if !options.accept_unknown {
                    return Err(
                        "The kit's licence could not be found: confirm that you may use it.".into(),
                    );
                }
                KitLicence {
                    kind: LicenceKind::Unknown,
                    text: None,
                    attribution: None,
                }
            }
            (Detected::Unknown, Some(kind)) => KitLicence {
                kind,
                text: None,
                attribution: None,
            },
            (Detected::NonCommercial(_), _) => unreachable!(),
        };
        if let Some(attribution) = options
            .attribution
            .as_ref()
            .filter(|a| !a.trim().is_empty())
        {
            licence.attribution = Some(attribution.trim().chars().take(200).collect());
        }
        Ok(licence)
    }

    /// Imports an `.sfz` (with the samples it uses) or an `.sf2`/`.sf3` kit.
    pub fn import(&self, source: &Path, options: &ImportOptions) -> Result<KitInfo, String> {
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let format = match ext.as_str() {
            "sfz" => KitFormat::Sfz,
            "sf2" => KitFormat::Sf2,
            "sf3" => KitFormat::Sf3,
            _ => return Err("Pick an .sfz, .sf2 or .sf3 drum kit.".into()),
        };
        let licence = Self::licence_for(source, options)?;
        let name = options
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| default_name(source))
            .trim()
            .chars()
            .take(80)
            .collect::<String>();
        let id = self.new_id(&name);
        let folder = self.dir.join(&id);
        let result = match format {
            KitFormat::Sfz => self.import_sfz(source, &folder),
            KitFormat::Sf2 | KitFormat::Sf3 => self.import_soundfont(source, &folder, format),
        };
        let (keys, size_bytes, warnings) = match result {
            Ok(found) => found,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&folder);
                return Err(error);
            }
        };
        let (pieces, missing) = map_pieces(&keys);
        if pieces.is_empty() {
            let _ = std::fs::remove_dir_all(&folder);
            return Err("The kit has no sounds on the General MIDI drum keys.".into());
        }
        let info = KitInfo {
            id,
            name,
            format,
            licence,
            pieces,
            missing,
            size_bytes,
            warnings,
        };
        let mut index = self.index.lock().unwrap();
        index.push(info.clone());
        if let Err(e) = self.save_index(&index) {
            index.pop();
            let _ = std::fs::remove_dir_all(&folder);
            return Err(format!("The kit library cannot be saved: {e}"));
        }
        Ok(info)
    }

    fn import_sfz(
        &self,
        source: &Path,
        folder: &Path,
    ) -> Result<(BTreeSet<u8>, u64, Vec<String>), String> {
        let sfz = sfz::parse(source)?;
        let base = source.parent().unwrap_or(Path::new("."));
        // Each sample file once, with where it goes in the kit folder.
        let mut copies: BTreeMap<PathBuf, PathBuf> = BTreeMap::new();
        let mut total = 0u64;
        for region in &sfz.regions {
            if copies.contains_key(&region.sample) {
                continue;
            }
            let meta = std::fs::metadata(&region.sample).map_err(|_| {
                format!(
                    "A sample of the kit is missing: {}",
                    region.sample.display()
                )
            })?;
            total += meta.len();
            if total > MAX_KIT_BYTES {
                return Err("The kit is larger than 4 GB.".into());
            }
            let relative = region.sample.strip_prefix(base).unwrap_or(&region.sample);
            let target = Path::new("samples").join(safe_relative(relative, copies.len()));
            copies.insert(region.sample.clone(), target);
        }
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        for (from, to) in &copies {
            let to = folder.join(to);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(from, &to).map_err(|e| format!("A sample cannot be copied: {e}"))?;
        }
        let regions: Vec<Region> = sfz
            .regions
            .iter()
            .map(|r| Region {
                sample: copies[&r.sample].clone(),
                ..r.clone()
            })
            .collect();
        let json = serde_json::to_vec(&regions).map_err(|e| e.to_string())?;
        std::fs::write(folder.join(REGIONS), json).map_err(|e| e.to_string())?;
        // The original file, for reference.
        let _ = std::fs::copy(source, folder.join("kit.sfz"));
        let warnings = if sfz.ignored.is_empty() {
            Vec::new()
        } else {
            vec![format!(
                "Not used: {}",
                sfz.ignored.iter().cloned().collect::<Vec<_>>().join(", ")
            )]
        };
        Ok((sfz.keys(), total, warnings))
    }

    fn import_soundfont(
        &self,
        source: &Path,
        folder: &Path,
        format: KitFormat,
    ) -> Result<(BTreeSet<u8>, u64, Vec<String>), String> {
        let size = std::fs::metadata(source).map_err(|e| e.to_string())?.len();
        if size > MAX_SOUNDFONT_KIT_BYTES {
            return Err("The SoundFont is larger than 512 MB.".into());
        }
        let bytes = std::fs::read(source).map_err(|e| e.to_string())?;
        let font = super::parse_sound_font(&bytes)?;
        let keys = drum_keys(&font);
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        let file = if format == KitFormat::Sf3 {
            "kit.sf3"
        } else {
            "kit.sf2"
        };
        std::fs::write(folder.join(file), &bytes).map_err(|e| e.to_string())?;
        Ok((keys, size, Vec::new()))
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut index = self.index.lock().unwrap();
        let before = index.len();
        index.retain(|k| k.id != id);
        if index.len() == before {
            return Err("No such kit".into());
        }
        self.save_index(&index)?;
        self.loaded.lock().unwrap().remove(id);
        let _ = std::fs::remove_dir_all(self.dir.join(id));
        Ok(())
    }

    /// The kit, decoded on first use (call it off the audio thread).
    pub fn load(&self, id: &str) -> Result<Arc<LoadedKit>, String> {
        if let Some(kit) = self.loaded.lock().unwrap().get(id) {
            return Ok(kit.clone());
        }
        let info = self
            .list()
            .into_iter()
            .find(|k| k.id == id)
            .ok_or("The drum kit is no longer in the library")?;
        let folder = self.dir.join(&info.id);
        let kit = match info.format {
            KitFormat::Sf2 | KitFormat::Sf3 => {
                let file = if info.format == KitFormat::Sf3 {
                    "kit.sf3"
                } else {
                    "kit.sf2"
                };
                let bytes = std::fs::read(folder.join(file)).map_err(|e| e.to_string())?;
                LoadedKit::SoundFont(Arc::new(super::parse_sound_font(&bytes)?))
            }
            KitFormat::Sfz => {
                let json = std::fs::read(folder.join(REGIONS)).map_err(|e| e.to_string())?;
                let regions: Vec<Region> =
                    serde_json::from_slice(&json).map_err(|e| e.to_string())?;
                LoadedKit::Sfz(Arc::new(decode_kit(&folder, regions)?))
            }
        };
        let kit = Arc::new(kit);
        self.loaded
            .lock()
            .unwrap()
            .insert(id.to_string(), kit.clone());
        Ok(kit)
    }
}

/// Decodes every sample of a kit (each file once).
pub fn decode_kit(folder: &Path, regions: Vec<Region>) -> Result<SfzKit, String> {
    let mut decoded: HashMap<PathBuf, Arc<SampleData>> = HashMap::new();
    let mut samples = Vec::with_capacity(regions.len());
    for region in &regions {
        // Kit data must stay inside its folder.
        let relative = safe_relative(&region.sample, 0);
        if relative != region.sample {
            return Err("The kit refers to a file outside its folder".into());
        }
        let sample = match decoded.get(&region.sample) {
            Some(s) => s.clone(),
            None => {
                let path = folder.join(&region.sample);
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("A sample of the kit cannot be read: {e}"))?;
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_ascii_lowercase);
                let audio = super::backing::decode(bytes, ext.as_deref())?;
                let s = Arc::new(SampleData {
                    rate: audio.rate as f32,
                    left: audio.left.into(),
                    right: audio.right.into(),
                });
                decoded.insert(region.sample.clone(), s.clone());
                s
            }
        };
        samples.push(sample);
    }
    Ok(SfzKit { regions, samples })
}

/// The keys of a SoundFont's drum kits (bank 128).
pub fn drum_keys(font: &SoundFont) -> BTreeSet<u8> {
    let mut keys = BTreeSet::new();
    for preset in font.get_presets() {
        if preset.get_bank_number() != 128 {
            continue;
        }
        for region in preset.get_regions() {
            let instrument = &font.get_instruments()[region.get_instrument_id()];
            for inner in instrument.get_regions() {
                let lo = inner
                    .get_key_range_start()
                    .max(region.get_key_range_start());
                let hi = inner.get_key_range_end().min(region.get_key_range_end());
                for key in lo.max(0)..=hi.min(127) {
                    keys.insert(key as u8);
                }
            }
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_kit_keys_to_drum_mixer_pieces() {
        let keys: BTreeSet<u8> = [36, 38, 42, 46, 49, 51].into_iter().collect();
        let (pieces, missing) = map_pieces(&keys);
        let names: Vec<_> = pieces.iter().map(|p| p.element.as_str()).collect();
        assert_eq!(names, ["snare", "hihat", "kick", "ride", "crash-high"]);
        assert_eq!(pieces[1].keys, [42, 46]);
        assert!(missing.contains(&"tom1".to_string()));
        assert_eq!(pieces.len() + missing.len(), DRUM_ELEMENTS.len());
    }

    #[test]
    fn keeps_copied_samples_inside_the_kit_folder() {
        assert_eq!(
            safe_relative(Path::new("Kick/a.wav"), 3),
            PathBuf::from("Kick/a.wav")
        );
        assert_eq!(
            safe_relative(Path::new("../shared/b.wav"), 3),
            PathBuf::from("external/3-b.wav")
        );
        assert_eq!(
            safe_relative(Path::new("/abs/c.wav"), 1),
            PathBuf::from("external/1-c.wav")
        );
        assert_eq!(slug("Muldjord Kit (v2)!"), "muldjord-kit--v2");
        assert_eq!(
            default_name(Path::new("/k/Muldjord Kit.sfz")),
            "Muldjord Kit"
        );
        assert_eq!(default_name(Path::new("/k/DRS Kit/kit.sfz")), "DRS Kit");
        assert_eq!(default_name(Path::new("/k/Naked/Drums.SF2")), "Naked");
        assert_eq!(slug("ÄÖ"), "kit");
    }

    fn licence_dir(text: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("LICENSE.txt"), text).unwrap();
        dir
    }

    #[test]
    fn reads_licences_and_refuses_non_commercial_ones() {
        let by = licence_dir(
            "My Kit\nRecorded by Jane Doe, 2023\nCreative Commons Attribution 4.0 International",
        );
        let Detected::Licence(licence) = detect_licence(by.path()) else {
            panic!("not found")
        };
        assert_eq!(licence.kind, LicenceKind::CcBy);
        assert_eq!(
            licence.attribution.as_deref(),
            Some("Recorded by Jane Doe, 2023")
        );
        assert!(licence.kind.needs_credit());

        let sa = licence_dir("Licensed under CC BY-SA 4.0");
        assert!(matches!(
            detect_licence(sa.path()),
            Detected::Licence(KitLicence {
                kind: LicenceKind::CcBySa,
                ..
            })
        ));
        let cc0 = licence_dir("CC0 1.0 Universal (public domain dedication)");
        assert!(matches!(
            detect_licence(cc0.path()),
            Detected::Licence(KitLicence {
                kind: LicenceKind::Cc0,
                ..
            })
        ));
        let nc = licence_dir("Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)");
        assert!(matches!(
            detect_licence(nc.path()),
            Detected::NonCommercial(_)
        ));
        let nothing = tempfile::tempdir().unwrap();
        assert_eq!(detect_licence(nothing.path()), Detected::Unknown);
        let unclear = licence_dir("Free to use, have fun!");
        assert_eq!(detect_licence(unclear.path()), Detected::Unknown);
    }

    #[test]
    fn the_user_confirms_unknown_licences_and_cannot_pick_non_commercial_ones() {
        let dir = tempfile::tempdir().unwrap();
        let kit = dir.path().join("kit.sfz");
        let ask = ImportOptions::default();
        assert!(
            KitLibrary::licence_for(&kit, &ask)
                .unwrap_err()
                .contains("confirm")
        );
        let ok = ImportOptions {
            accept_unknown: true,
            ..Default::default()
        };
        assert_eq!(
            KitLibrary::licence_for(&kit, &ok).unwrap().kind,
            LicenceKind::Unknown
        );
        let picked = ImportOptions {
            licence: Some("cc-by".into()),
            attribution: Some("  Jane  ".into()),
            ..Default::default()
        };
        let licence = KitLibrary::licence_for(&kit, &picked).unwrap();
        assert_eq!(
            (licence.kind, licence.attribution.as_deref()),
            (LicenceKind::CcBy, Some("Jane"))
        );
        let nc = ImportOptions {
            licence: Some("cc-by-nc".into()),
            accept_unknown: true,
            ..Default::default()
        };
        assert!(
            KitLibrary::licence_for(&kit, &nc)
                .unwrap_err()
                .contains("non-commercial")
        );
    }

    #[test]
    fn drum_elements_match_the_ui_table() {
        let ts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/audio/drum-elements.ts"),
        )
        .unwrap();
        for (element, keys) in DRUM_ELEMENTS {
            let keys: Vec<String> = keys.iter().map(u8::to_string).collect();
            let line = format!("{{ id: \"{element}\",");
            let row = ts
                .lines()
                .find(|l| l.contains(&line))
                .unwrap_or_else(|| panic!("{element}"));
            assert!(
                row.contains(&format!("keys: [{}]", keys.join(", "))),
                "{row}"
            );
        }
    }
}
