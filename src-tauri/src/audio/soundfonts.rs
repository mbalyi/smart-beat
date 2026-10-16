//! The user's extra SoundFonts (#81): `.sf2` / `.sf3` files imported from their computer, and
//! the recommended banks downloaded from the built-in catalogue. Both are kept in
//! `<app data>/soundfonts/<id>/` with an index (`soundfonts.json`) and never leave the machine.
//!
//! Nothing is bundled: the catalogue only names where a bank can be fetched. Every download is
//! checked against its size and SHA-256, and archives (`.zip`, `.7z`) are unpacked here, so the
//! file that ends up on disk is the one named in the catalogue. Two of the banks are free for
//! personal use only; they are fetched from their author's own site to the user's computer and
//! are never hosted or redistributed by Smart Beat.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const INDEX_FILE: &str = "soundfonts.json";
const INDEX_VERSION: u32 = 1;
/// Largest SoundFont that is imported, installed or loaded. The biggest catalogue bank is 395 MB.
pub const MAX_BYTES: u64 = 512 * 1024 * 1024;
/// A download of this size on a slow line takes a while; only a stalled connection should fail.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(3 * 60 * 60);
/// Prefix of the ids the audio engine knows stored banks by (the bundled ones have none).
pub const ENGINE_PREFIX: &str = "sf:";

/// How a catalogue download is packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Packing {
    /// The download is the SoundFont.
    File,
    /// A `.zip` holding the SoundFont.
    Zip,
    /// A `.7z` holding the SoundFont.
    SevenZip,
}

/// A recommended bank. Sizes and sums were measured on the files named in `docs/licensing.md`.
#[derive(Debug, Clone, Copy)]
pub struct CatalogueEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub licence: &'static str,
    /// Free for personal use only (the dialog says so).
    pub personal_use_only: bool,
    pub url: &'static str,
    /// The page the bank is published on, for the "more information" link.
    pub page: &'static str,
    pub packing: Packing,
    /// Size and SHA-256 of what is downloaded.
    pub download_bytes: u64,
    pub download_sha256: &'static str,
    /// For archives: the SoundFont inside, with its size and SHA-256.
    pub member: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

pub const CATALOGUE: [CatalogueEntry; 5] = [
    CatalogueEntry {
        id: "musescore-general",
        name: "MuseScore General",
        description: "A large General MIDI bank made for MuseScore and built on FluidR3. Balanced, detailed and compact for its quality.",
        licence: "MIT",
        personal_use_only: false,
        url: "https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3",
        page: "https://musescore.org/en/handbook/3/soundfonts-and-sfz-files",
        packing: Packing::File,
        download_bytes: 39_900_972,
        download_sha256: "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
        member: "MuseScore_General.sf3",
        bytes: 39_900_972,
        sha256: "5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3",
    },
    CatalogueEntry {
        id: "generaluser-gs",
        name: "GeneralUser GS",
        description: "A small General MIDI and GS bank with 259 presets and 11 drum kits. Light and quick to load.",
        licence: "GeneralUser GS License v2.0 (free, including commercial use)",
        personal_use_only: false,
        url: "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/97049183643d5fc5a9322a69c5b09efb667c6c3a/GeneralUser-GS.sf2",
        page: "https://github.com/mrbumpy409/GeneralUser-GS",
        packing: Packing::File,
        download_bytes: 32_319_396,
        download_sha256: "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe",
        member: "GeneralUser-GS.sf2",
        bytes: 32_319_396,
        sha256: "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe",
    },
    CatalogueEntry {
        id: "fluidr3-gm",
        name: "FluidR3 GM (stereo)",
        description: "The classic full stereo FluidR3 General MIDI bank. Richer than the built-in mono version, and large.",
        licence: "MIT",
        personal_use_only: false,
        url: "https://github.com/pianobooster/fluid-soundfont/releases/download/v3.1/FluidR3_GM.sf2",
        page: "https://github.com/pianobooster/fluid-soundfont",
        packing: Packing::File,
        download_bytes: 148_398_306,
        download_sha256: "74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0",
        member: "FluidR3_GM.sf2",
        bytes: 148_398_306,
        sha256: "74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0",
    },
    CatalogueEntry {
        id: "timbres-of-heaven",
        name: "Timbres of Heaven",
        description: "A very detailed General MIDI, GS and XG bank, known for realistic instruments. Very large: it takes a while to load and needs plenty of memory.",
        licence: "Free for personal use only. Do not redistribute.",
        personal_use_only: true,
        url: "https://midkar.com/SoundFonts/Timbres%20Of%20Heaven%20GM_GS_XG_SFX%20V%203.4%20Final.7z",
        page: "https://midkar.com/SoundFonts/TOH.html",
        packing: Packing::SevenZip,
        download_bytes: 264_239_592,
        download_sha256: "ee74c940935753fa5cff472607c729d96a4f9f20b85b36cf4e50b965d8309cf9",
        member: "Timbres Of Heaven GM_GS_XG_SFX V 3.4 Final.sf2",
        bytes: 395_249_188,
        sha256: "a94524fc660ce203dd9216dae008d75c1375c15701eaaa67b95f3aad1dea9384",
    },
    CatalogueEntry {
        id: "arachno",
        name: "Arachno",
        description: "A full-size General MIDI bank with 9 drum kits, by Maxime Abbey.",
        licence: "Free for personal use only. Do not redistribute.",
        personal_use_only: true,
        url: "https://www.dropbox.com/s/2rnpya9ecb9m4jh/arachno-soundfont-10-sf2.zip?dl=1",
        page: "http://www.arachnosoft.com/main/download.php?id=soundfont-sf2",
        packing: Packing::Zip,
        download_bytes: 143_356_181,
        download_sha256: "5c0c573abe6c5e1a3ccceba5d52a4229db24283620c9a3eb1f403018e2aa22df",
        member: "Arachno SoundFont - Version 1.0.sf2",
        bytes: 155_405_818,
        sha256: "9a57fb3b6714e69dda12390e351b087e81fc3b1eca15c6b4bbe172799f4cf3cd",
    },
];

pub fn catalogue_entry(id: &str) -> Option<&'static CatalogueEntry> {
    CATALOGUE.iter().find(|entry| entry.id == id)
}

/// One installed SoundFont (imported or downloaded).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFontInfo {
    pub id: String,
    pub name: String,
    /// File name inside `<id>/`.
    pub file: String,
    pub bytes: u64,
    /// The catalogue entry it came from (none: imported from the user's files).
    #[serde(default)]
    pub catalogue: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    version: u32,
    items: Vec<SoundFontInfo>,
}

/// What the catalogue dialog shows for each recommended bank.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueItem {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub licence: &'static str,
    pub personal_use_only: bool,
    pub page: &'static str,
    pub download_bytes: u64,
    /// Size on disk once installed.
    pub bytes: u64,
    pub installed: bool,
}

pub struct SoundFontLibrary {
    dir: PathBuf,
    index: Mutex<Vec<SoundFontInfo>>,
}

/// The id of a stored bank in the audio engine.
pub fn engine_id(id: &str) -> String {
    format!("{ENGINE_PREFIX}{id}")
}

/// A lowercase ASCII id from a file or bank name.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.chars().take(40).collect();
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "soundfont".into()
    } else {
        out.to_string()
    }
}

fn is_soundfont_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("sf2") || e.eq_ignore_ascii_case("sf3"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Copies `from` to `to` and returns the size and SHA-256 of what was copied.
fn copy_hashed(from: &mut dyn Read, to: &mut dyn Write) -> std::io::Result<(u64, String)> {
    let (mut hasher, mut total) = (Sha256::new(), 0u64);
    let mut chunk = vec![0u8; 256 * 1024];
    loop {
        let n = from.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
        to.write_all(&chunk[..n])?;
        total += n as u64;
        if total > MAX_BYTES {
            return Err(std::io::Error::other("the file is too large"));
        }
    }
    Ok((total, hex(&hasher.finalize())))
}

impl SoundFontLibrary {
    pub fn new(dir: PathBuf) -> Self {
        let items = fs::read(dir.join(INDEX_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Index>(&bytes).ok())
            .filter(|index| index.version == INDEX_VERSION)
            .map(|index| index.items)
            .unwrap_or_default();
        // An entry whose file was deleted by hand is dropped.
        let items = items
            .into_iter()
            .filter(|item| dir.join(&item.id).join(&item.file).is_file())
            .collect();
        Self {
            dir,
            index: Mutex::new(items),
        }
    }

    pub fn list(&self) -> Vec<SoundFontInfo> {
        self.index.lock().unwrap().clone()
    }

    pub fn catalogue(&self) -> Vec<CatalogueItem> {
        let index = self.index.lock().unwrap();
        CATALOGUE
            .iter()
            .map(|entry| CatalogueItem {
                id: entry.id,
                name: entry.name,
                description: entry.description,
                licence: entry.licence,
                personal_use_only: entry.personal_use_only,
                page: entry.page,
                download_bytes: entry.download_bytes,
                bytes: entry.bytes,
                installed: index.iter().any(|i| i.id == entry.id),
            })
            .collect()
    }

    /// Where the file of an installed bank is.
    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        let index = self.index.lock().unwrap();
        let item = index.iter().find(|i| i.id == id)?;
        Some(self.dir.join(&item.id).join(&item.file))
    }

    fn save(&self, items: &[SoundFontInfo]) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("Could not save the list: {e}"))?;
        let index = Index {
            version: INDEX_VERSION,
            items: items.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
        let temp = self.dir.join(format!("{INDEX_FILE}.tmp"));
        fs::write(&temp, bytes).map_err(|e| format!("Could not save the list: {e}"))?;
        fs::rename(&temp, self.dir.join(INDEX_FILE))
            .map_err(|e| format!("Could not save the list: {e}"))
    }

    fn new_id(items: &[SoundFontInfo], name: &str) -> String {
        let base = slug(name);
        let mut id = base.clone();
        let mut n = 2;
        while items.iter().any(|i| i.id == id) || catalogue_entry(&id).is_some() {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }

    /// Copies a `.sf2` or `.sf3` from the user's files into the library.
    pub fn import(&self, source: &Path) -> Result<SoundFontInfo, String> {
        if !is_soundfont_file(source) {
            return Err("Choose a SoundFont file (.sf2 or .sf3).".into());
        }
        let meta = fs::metadata(source).map_err(|e| format!("Could not read the file: {e}"))?;
        if !meta.is_file() {
            return Err("Choose a SoundFont file (.sf2 or .sf3).".into());
        }
        if meta.len() > MAX_BYTES {
            return Err(format!(
                "The SoundFont is too large ({} MB is the limit).",
                MAX_BYTES / 1024 / 1024
            ));
        }
        // A broken file is refused here, not when the user first plays with it.
        let bytes = fs::read(source).map_err(|e| format!("Could not read the file: {e}"))?;
        super::parse_sound_font(&bytes)?;
        drop(bytes);

        let stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("SoundFont");
        let name = stem.to_string();
        let ext = source
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("sf2")
            .to_ascii_lowercase();
        let file = format!("{}.{ext}", slug(stem));

        let mut items = self.index.lock().unwrap();
        let id = Self::new_id(&items, &name);
        let folder = self.dir.join(&id);
        fs::create_dir_all(&folder).map_err(|e| format!("Could not import the file: {e}"))?;
        if let Err(e) = fs::copy(source, folder.join(&file)) {
            let _ = fs::remove_dir_all(&folder);
            return Err(format!("Could not import the file: {e}"));
        }
        let info = SoundFontInfo {
            id,
            name,
            file,
            bytes: meta.len(),
            catalogue: None,
        };
        items.push(info.clone());
        if let Err(e) = self.save(&items) {
            items.pop();
            let _ = fs::remove_dir_all(&folder);
            return Err(e);
        }
        Ok(info)
    }

    /// Deletes a bank and its file.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut items = self.index.lock().unwrap();
        let Some(position) = items.iter().position(|i| i.id == id) else {
            return Err("This SoundFont is not installed.".into());
        };
        let removed = items.remove(position);
        if let Err(e) = self.save(&items) {
            items.insert(position, removed);
            return Err(e);
        }
        // The list no longer names it, so a leftover folder only wastes space.
        let _ = fs::remove_dir_all(self.dir.join(id));
        Ok(())
    }

    /// Adds a bank whose file `source` was produced by the installer (already checked).
    fn adopt(&self, entry: &CatalogueEntry, source: &Path) -> Result<SoundFontInfo, String> {
        let mut items = self.index.lock().unwrap();
        if items.iter().any(|i| i.id == entry.id) {
            return Err("This SoundFont is already installed.".into());
        }
        let folder = self.dir.join(entry.id);
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).map_err(|e| format!("Could not save the SoundFont: {e}"))?;
        let file = entry.member.to_string();
        if let Err(e) = fs::rename(source, folder.join(&file)) {
            let _ = fs::remove_dir_all(&folder);
            return Err(format!("Could not save the SoundFont: {e}"));
        }
        let info = SoundFontInfo {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            file,
            bytes: entry.bytes,
            catalogue: Some(entry.id.to_string()),
        };
        items.push(info.clone());
        if let Err(e) = self.save(&items) {
            items.pop();
            let _ = fs::remove_dir_all(&folder);
            return Err(e);
        }
        Ok(info)
    }

    fn scratch(&self, entry: &CatalogueEntry) -> PathBuf {
        self.dir.join(format!(".download-{}", entry.id))
    }
}

// --- Download --------------------------------------------------------------------

/// One download at a time: two would write the same scratch folder.
static DOWNLOADING: Mutex<()> = Mutex::new(());
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Asks the running download to stop. It removes its partial files and reports "cancelled".
pub fn cancel_download() {
    CANCELLED.store(true, Ordering::SeqCst);
}

/// What the dialog is told while a bank is fetched.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Downloading(f32),
    Unpacking,
}

/// The message of a cancelled download. The UI shows nothing for it.
pub const CANCELLED_MESSAGE: &str = "cancelled";

fn check_cancelled() -> Result<(), String> {
    if CANCELLED.load(Ordering::SeqCst) {
        Err(CANCELLED_MESSAGE.into())
    } else {
        Ok(())
    }
}

/// Downloads `url` to `dest`, checking size and SHA-256. The file appears under its name only
/// when it is complete and right.
fn download_file(
    url: &str,
    dest: &Path,
    bytes: u64,
    sha256: &str,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("Could not download the SoundFont: {e}"))?;
    let partial = dest.with_extension("part");
    let result = (|| -> Result<(), String> {
        let io = |e: std::io::Error| format!("Could not save the SoundFont: {e}");
        let mut file = fs::File::create(&partial).map_err(io)?;
        let mut reader = response.body_mut().as_reader();
        let (mut hasher, mut done) = (Sha256::new(), 0u64);
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            check_cancelled()?;
            let n = reader
                .read(&mut chunk)
                .map_err(|e| format!("Could not download the SoundFont: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&chunk[..n]);
            file.write_all(&chunk[..n]).map_err(io)?;
            done += n as u64;
            if done > bytes {
                break;
            }
            on_bytes(done);
        }
        file.flush().map_err(io)?;
        if done != bytes || hex(&hasher.finalize()) != sha256 {
            return Err(
                "The downloaded file is not the expected one. Try again later.".to_string(),
            );
        }
        fs::rename(&partial, dest).map_err(io)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

/// Unpacks `member` of the archive at `archive` into `dest`, checking its size and SHA-256.
fn unpack(entry: &CatalogueEntry, archive: &Path, dest: &Path) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        let io = |e: std::io::Error| format!("Could not unpack the SoundFont: {e}");
        let mut out = fs::File::create(dest).map_err(io)?;
        let found = match entry.packing {
            Packing::File => return Err("This SoundFont is not packed.".into()),
            Packing::Zip => {
                let file = fs::File::open(archive).map_err(io)?;
                let mut zip = zip::ZipArchive::new(file)
                    .map_err(|e| format!("Could not unpack the SoundFont: {e}"))?;
                let mut member = zip
                    .by_name(entry.member)
                    .map_err(|e| format!("Could not unpack the SoundFont: {e}"))?;
                Some(copy_hashed(&mut member, &mut out).map_err(io)?)
            }
            Packing::SevenZip => {
                let file = fs::File::open(archive).map_err(io)?;
                let mut reader =
                    sevenz_rust2::ArchiveReader::new(file, sevenz_rust2::Password::empty())
                        .map_err(|e| format!("Could not unpack the SoundFont: {e}"))?;
                let mut found = None;
                reader
                    .for_each_entries(|item, data| {
                        if item.name() == entry.member {
                            found = Some(copy_hashed(data, &mut out)?);
                            return Ok(false);
                        }
                        Ok(true)
                    })
                    .map_err(|e| format!("Could not unpack the SoundFont: {e}"))?;
                found
            }
        };
        out.flush().map_err(io)?;
        match found {
            Some((size, sum)) if size == entry.bytes && sum == entry.sha256 => Ok(()),
            Some(_) => Err("The unpacked SoundFont is not the expected file.".into()),
            None => Err("The download does not contain the SoundFont.".into()),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

impl SoundFontLibrary {
    /// Downloads and installs a catalogue bank. `on_phase` reports progress.
    pub fn install_from_catalogue(
        &self,
        id: &str,
        on_phase: &mut dyn FnMut(Phase),
    ) -> Result<SoundFontInfo, String> {
        let entry = catalogue_entry(id).ok_or("Unknown SoundFont.")?;
        let _only_one = DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner());
        CANCELLED.store(false, Ordering::SeqCst);
        if self.index.lock().unwrap().iter().any(|i| i.id == entry.id) {
            return Err("This SoundFont is already installed.".into());
        }
        let scratch = self.scratch(entry);
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&scratch).map_err(|e| format!("Could not save the SoundFont: {e}"))?;
        let result = (|| {
            let downloaded = scratch.join("download");
            let mut last = -1.0f32;
            download_file(
                entry.url,
                &downloaded,
                entry.download_bytes,
                entry.download_sha256,
                &mut |done| {
                    let fraction = done as f32 / entry.download_bytes as f32;
                    if fraction - last >= 0.01 {
                        last = fraction;
                        on_phase(Phase::Downloading(fraction));
                    }
                },
            )?;
            on_phase(Phase::Downloading(1.0));
            check_cancelled()?;
            let file = if entry.packing == Packing::File {
                downloaded
            } else {
                on_phase(Phase::Unpacking);
                let unpacked = scratch.join("unpacked");
                unpack(entry, &downloaded, &unpacked)?;
                unpacked
            };
            self.adopt(entry, &file)
        })();
        let _ = fs::remove_dir_all(&scratch);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sonivox from alphaTab is a small real SoundFont, used by the other audio tests too.
    fn sonivox() -> Vec<u8> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3");
        fs::read(path).expect("run pnpm install first")
    }

    fn library() -> (tempfile::TempDir, SoundFontLibrary) {
        let dir = tempfile::tempdir().unwrap();
        let lib = SoundFontLibrary::new(dir.path().join("soundfonts"));
        (dir, lib)
    }

    #[test]
    fn ids_are_lowercase_ascii() {
        assert_eq!(slug("My Cool SoundFont (v2)!"), "my-cool-soundfont-v2");
        assert_eq!(slug("日本語"), "soundfont");
        assert_eq!(slug(&"a".repeat(80)).len(), 40);
    }

    #[test]
    fn the_catalogue_is_consistent() {
        let mut ids: Vec<_> = CATALOGUE.iter().map(|e| e.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOGUE.len());
        for entry in &CATALOGUE {
            assert!(entry.url.starts_with("https://"), "{}", entry.id);
            assert_eq!(entry.download_sha256.len(), 64, "{}", entry.id);
            assert_eq!(entry.sha256.len(), 64, "{}", entry.id);
            assert!(entry.bytes <= MAX_BYTES, "{}", entry.id);
            assert!(is_soundfont_file(Path::new(entry.member)), "{}", entry.id);
            if entry.packing == Packing::File {
                assert_eq!(entry.download_sha256, entry.sha256, "{}", entry.id);
                assert_eq!(entry.download_bytes, entry.bytes, "{}", entry.id);
            }
        }
        // The two personal-use banks say so.
        assert!(
            catalogue_entry("timbres-of-heaven")
                .unwrap()
                .personal_use_only
        );
        assert!(catalogue_entry("arachno").unwrap().personal_use_only);
        assert!(
            !catalogue_entry("musescore-general")
                .unwrap()
                .personal_use_only
        );
    }

    #[test]
    fn imports_lists_and_removes_a_soundfont() {
        let (dir, lib) = library();
        let source = dir.path().join("My Piano Bank.sf3");
        fs::write(&source, sonivox()).unwrap();

        let info = lib.import(&source).unwrap();
        assert_eq!(info.id, "my-piano-bank");
        assert_eq!(info.name, "My Piano Bank");
        assert_eq!(info.catalogue, None);
        assert_eq!(lib.list(), vec![info.clone()]);
        assert!(lib.path_of(&info.id).unwrap().is_file());

        // The same file again gets a second id; the list survives a restart.
        let again = lib.import(&source).unwrap();
        assert_eq!(again.id, "my-piano-bank-2");
        let reopened = SoundFontLibrary::new(dir.path().join("soundfonts"));
        assert_eq!(reopened.list().len(), 2);

        lib.remove(&info.id).unwrap();
        assert_eq!(lib.list().len(), 1);
        assert!(!dir.path().join("soundfonts").join(&info.id).exists());
        assert!(lib.remove(&info.id).is_err());
    }

    #[test]
    fn refuses_files_that_are_not_soundfonts() {
        let (dir, lib) = library();
        let text = dir.path().join("notes.txt");
        fs::write(&text, "hello").unwrap();
        assert!(lib.import(&text).unwrap_err().contains("SoundFont file"));

        let broken = dir.path().join("broken.sf2");
        fs::write(&broken, b"not a soundfont at all").unwrap();
        assert!(lib.import(&broken).is_err());
        assert!(lib.list().is_empty());
        assert!(!dir.path().join("soundfonts").join("broken").exists());

        assert!(lib.import(&dir.path().join("missing.sf2")).is_err());
    }

    #[test]
    fn an_entry_whose_file_is_gone_is_dropped_on_start() {
        let (dir, lib) = library();
        let source = dir.path().join("gone.sf3");
        fs::write(&source, sonivox()).unwrap();
        let info = lib.import(&source).unwrap();
        fs::remove_file(lib.path_of(&info.id).unwrap()).unwrap();
        let reopened = SoundFontLibrary::new(dir.path().join("soundfonts"));
        assert!(reopened.list().is_empty());
    }

    #[test]
    fn catalogue_items_know_what_is_installed() {
        let (_dir, lib) = library();
        assert!(lib.catalogue().iter().all(|item| !item.installed));
        let entry = catalogue_entry("generaluser-gs").unwrap();
        let file = lib.scratch(entry).join("f");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"x").unwrap();
        lib.adopt(entry, &file).unwrap();
        let items = lib.catalogue();
        assert!(
            items
                .iter()
                .find(|i| i.id == "generaluser-gs")
                .unwrap()
                .installed
        );
        assert!(!items.iter().find(|i| i.id == "arachno").unwrap().installed);
        assert!(lib.adopt(entry, &file).is_err());
        lib.remove("generaluser-gs").unwrap();
        assert!(lib.catalogue().iter().all(|item| !item.installed));
    }

    #[test]
    fn an_imported_name_never_takes_a_catalogue_id() {
        let (dir, lib) = library();
        let source = dir.path().join("Arachno.sf3");
        fs::write(&source, sonivox()).unwrap();
        assert_eq!(lib.import(&source).unwrap().id, "arachno-2");
    }

    /// Serves `body` once on a local port, for the download tests.
    fn serve(body: Vec<u8>) -> String {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/bank.sf2")
    }

    /// The tests share `CANCELLED`, so the ones that touch it run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn a_download_is_checked_and_a_wrong_one_leaves_nothing() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        CANCELLED.store(false, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let body = b"0123456789".to_vec();
        let sum = hex(&Sha256::digest(&body));

        let dest = dir.path().join("ok");
        let mut seen = 0;
        download_file(&serve(body.clone()), &dest, 10, &sum, &mut |n| seen = n).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), body);
        assert_eq!(seen, 10);

        let bad = dir.path().join("bad");
        let err = download_file(&serve(body.clone()), &bad, 10, &"0".repeat(64), &mut |_| {})
            .unwrap_err();
        assert!(err.contains("not the expected"), "{err}");
        assert!(!bad.exists() && !bad.with_extension("part").exists());

        let short = dir.path().join("short");
        assert!(download_file(&serve(body), &short, 11, &sum, &mut |_| {}).is_err());
        assert!(!short.exists() && !short.with_extension("part").exists());

        let down = dir.path().join("down");
        let err = download_file("http://127.0.0.1:9/x", &down, 1, &sum, &mut |_| {}).unwrap_err();
        assert!(err.contains("Could not download"), "{err}");
    }

    #[test]
    fn a_cancelled_download_removes_its_partial_file() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("c");
        let url = serve(vec![7u8; 1000]);
        CANCELLED.store(true, Ordering::SeqCst);
        let err = download_file(&url, &dest, 1000, &"0".repeat(64), &mut |_| {}).unwrap_err();
        CANCELLED.store(false, Ordering::SeqCst);
        assert_eq!(err, CANCELLED_MESSAGE);
        assert!(!dest.exists() && !dest.with_extension("part").exists());
    }

    #[test]
    fn unpacks_the_named_member_of_a_zip_and_checks_it() {
        let dir = tempfile::tempdir().unwrap();
        let body = b"fake soundfont bytes".to_vec();
        let archive = dir.path().join("bank.zip");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("readme.txt", options).unwrap();
            zip.write_all(b"hello").unwrap();
            zip.start_file("Bank.sf2", options).unwrap();
            zip.write_all(&body).unwrap();
            zip.finish().unwrap();
        }
        let sum: &'static str = Box::leak(hex(&Sha256::digest(&body)).into_boxed_str());
        let entry = CatalogueEntry {
            packing: Packing::Zip,
            member: "Bank.sf2",
            bytes: body.len() as u64,
            sha256: sum,
            ..CATALOGUE[0]
        };
        let out = dir.path().join("out");
        unpack(&entry, &archive, &out).unwrap();
        assert_eq!(fs::read(&out).unwrap(), body);

        let wrong = CatalogueEntry {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ..entry
        };
        let out2 = dir.path().join("out2");
        assert!(unpack(&wrong, &archive, &out2).is_err());
        assert!(!out2.exists());

        let missing = CatalogueEntry {
            member: "Other.sf2",
            ..entry
        };
        assert!(unpack(&missing, &archive, &dir.path().join("out3")).is_err());
    }

    /// Needs the real 264 MB archive, so it only runs on request:
    /// `SF_TEST_TOH_7Z=/path/to/archive.7z cargo test --lib -- --ignored real_7z`.
    #[test]
    #[ignore = "needs the real Timbres of Heaven archive"]
    fn real_7z_archive_unpacks_and_matches_the_catalogue() {
        let archive = std::env::var("SF_TEST_TOH_7Z").expect("set SF_TEST_TOH_7Z");
        let entry = catalogue_entry("timbres-of-heaven").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        unpack(entry, Path::new(&archive), &out).unwrap();
        assert_eq!(fs::metadata(&out).unwrap().len(), entry.bytes);
    }
}
