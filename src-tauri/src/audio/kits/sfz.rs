//! A reader for SFZ instrument files, written for Smart Beat (no third-party
//! code), covering what drum kits use (#40): `<control>`, `<global>`,
//! `<master>`, `<group>` and `<region>` headers with inheritance,
//! `default_path`, `#define` and `#include`, key and velocity ranges, round
//! robin (`seq_length`/`seq_position`, `lorand`/`hirand`), choke groups
//! (`group`/`off_by`), volume, pan, tuning and the release time. Other
//! opcodes are ignored and reported.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Deepest `#include` nesting followed.
const MAX_INCLUDE_DEPTH: usize = 8;
/// Largest SFZ text read (a damaged file must not exhaust memory).
pub const MAX_SFZ_BYTES: u64 = 8 * 1024 * 1024;

/// One playable region of the kit, with every inherited opcode applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    /// The sample file (absolute while importing, relative to the kit folder once copied).
    pub sample: PathBuf,
    pub lokey: u8,
    pub hikey: u8,
    pub lovel: u8,
    pub hivel: u8,
    pub pitch_keycenter: u8,
    /// Cents of pitch per key away from the key centre (100 = pitched, 0 = drum).
    pub pitch_keytrack: f32,
    /// Fine tuning in cents (plus `transpose` × 100).
    pub tune: f32,
    pub volume_db: f32,
    /// -100 (left) … 100 (right).
    pub pan: f32,
    /// How much velocity changes the level (0…100 %).
    pub amp_veltrack: f32,
    pub seq_length: u32,
    pub seq_position: u32,
    pub lorand: f32,
    pub hirand: f32,
    /// Choke groups: playing a region of `group` silences regions with that `off_by`.
    pub group: u32,
    pub off_by: u32,
    /// Seconds a voice fades for when it is choked or let go.
    pub release: f32,
}

impl Default for Region {
    fn default() -> Self {
        Self {
            sample: PathBuf::new(),
            lokey: 0,
            hikey: 127,
            lovel: 1,
            hivel: 127,
            pitch_keycenter: 60,
            pitch_keytrack: 100.0,
            tune: 0.0,
            volume_db: 0.0,
            pan: 0.0,
            amp_veltrack: 100.0,
            seq_length: 1,
            seq_position: 1,
            lorand: 0.0,
            hirand: 1.0,
            group: 0,
            off_by: 0,
            release: 0.005,
        }
    }
}

impl Region {
    pub fn plays(&self, key: u8, velocity: u8) -> bool {
        (self.lokey..=self.hikey).contains(&key) && (self.lovel..=self.hivel).contains(&velocity)
    }
}

/// A parsed SFZ file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SfzFile {
    pub regions: Vec<Region>,
    /// Opcodes and headers that are not supported (each once).
    pub ignored: BTreeSet<String>,
}

impl SfzFile {
    /// Every key that plays a region.
    pub fn keys(&self) -> BTreeSet<u8> {
        self.regions
            .iter()
            .flat_map(|r| r.lokey..=r.hikey)
            .collect()
    }
}

/// A MIDI note from a number or a note name ("c4" = 60, "f#2", "eb3").
pub fn parse_key(text: &str) -> Option<u8> {
    let text = text.trim();
    if let Ok(n) = text.parse::<i32>() {
        return u8::try_from(n).ok().filter(|n| *n <= 127);
    }
    let lower = text.to_ascii_lowercase();
    let mut chars = lower.chars();
    let base = match chars.next()? {
        'c' => 0,
        'd' => 2,
        'e' => 4,
        'f' => 5,
        'g' => 7,
        'a' => 9,
        'b' => 11,
        _ => return None,
    };
    let rest: String = chars.collect();
    let (shift, octave) = if let Some(o) = rest.strip_prefix('#') {
        (1, o)
    } else if let Some(o) = rest.strip_prefix('b').filter(|o| !o.is_empty()) {
        (-1, o)
    } else {
        (0, rest.as_str())
    };
    let octave: i32 = octave.parse().ok()?;
    let note = (octave + 1) * 12 + base + shift;
    u8::try_from(note).ok().filter(|n| *n <= 127)
}

/// Removes `//` line comments and `/* */` block comments.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("//") {
            rest = after.find('\n').map_or("", |i| &after[i..]);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |i| &after[i + 2..]);
        } else {
            let c = rest.chars().next().unwrap_or(' ');
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// One token of an SFZ file.
#[derive(Debug, PartialEq)]
enum Token {
    Header(String),
    Opcode(String, String),
}

/// Whether `text` starts with `name=` (an opcode name: letters, digits, `_`).
fn opcode_start(text: &str) -> Option<usize> {
    let name_len = text
        .char_indices()
        .take_while(|(_, c)| c.is_ascii_alphanumeric() || *c == '_')
        .last()
        .map(|(i, c)| i + c.len_utf8())?;
    text[name_len..].starts_with('=').then_some(name_len)
}

/// Splits a line into headers and opcodes. A value runs to the next opcode,
/// header or the end of the line, so sample paths may contain spaces.
fn tokenize_line(line: &str, tokens: &mut Vec<Token>) {
    let mut rest = line.trim_start();
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('<') {
            let end = after.find('>').unwrap_or(after.len());
            tokens.push(Token::Header(after[..end].trim().to_ascii_lowercase()));
            rest = after.get(end + 1..).unwrap_or("").trim_start();
            continue;
        }
        let Some(name_len) = opcode_start(rest) else {
            // Not an opcode: skip one word.
            let skip = rest.find(char::is_whitespace).unwrap_or(rest.len());
            rest = rest[skip..].trim_start();
            continue;
        };
        let name = rest[..name_len].to_ascii_lowercase();
        let value_text = &rest[name_len + 1..];
        let mut end = value_text.len();
        for (i, c) in value_text.char_indices() {
            if c == '<' {
                end = i;
                break;
            }
            if c.is_whitespace() {
                let next = value_text[i..].trim_start();
                if next.starts_with('<') || opcode_start(next).is_some() {
                    end = i;
                    break;
                }
            }
        }
        tokens.push(Token::Opcode(name, value_text[..end].trim().to_string()));
        rest = value_text[end..].trim_start();
    }
}

struct Reader {
    defines: HashMap<String, String>,
    tokens: Vec<Token>,
    errors: Vec<String>,
}

impl Reader {
    fn read(&mut self, path: &Path, depth: usize) {
        if depth > MAX_INCLUDE_DEPTH {
            self.errors
                .push(format!("{}: includes nested too deep", path.display()));
            return;
        }
        let text = match std::fs::metadata(path) {
            Ok(meta) if meta.len() > MAX_SFZ_BYTES => {
                self.errors.push(format!("{} is too large", path.display()));
                return;
            }
            Ok(_) => match std::fs::read(path) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(e) => {
                    self.errors
                        .push(format!("{} cannot be read: {e}", path.display()));
                    return;
                }
            },
            Err(e) => {
                self.errors
                    .push(format!("{} cannot be read: {e}", path.display()));
                return;
            }
        };
        let dir = path.parent().unwrap_or(Path::new("."));
        for line in strip_comments(&text).lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("#define") {
                let mut parts = rest.split_whitespace();
                if let (Some(name), Some(value)) = (parts.next(), parts.next()) {
                    self.defines.insert(name.to_string(), value.to_string());
                }
                continue;
            }
            if let Some(rest) = line.strip_prefix("#include") {
                let file = rest.trim().trim_matches('"');
                self.read(&dir.join(file.replace('\\', "/")), depth + 1);
                continue;
            }
            let mut expanded = line.to_string();
            // Longest names first, so `$KICK2` is not replaced as `$KICK` + "2".
            let mut names: Vec<_> = self.defines.keys().cloned().collect();
            names.sort_by_key(|n| std::cmp::Reverse(n.len()));
            for name in names {
                if expanded.contains(&name) {
                    expanded = expanded.replace(&name, &self.defines[&name]);
                }
            }
            tokenize_line(&expanded, &mut self.tokens);
        }
    }
}

/// Applies one opcode to a region. Returns false if it is not supported.
fn apply(region: &mut Region, name: &str, value: &str) -> bool {
    let num = |v: &str| v.trim().parse::<f32>().ok();
    let key = |v: &str| parse_key(v);
    match name {
        "sample" => region.sample = PathBuf::from(value.replace('\\', "/")),
        "key" => {
            if let Some(k) = key(value) {
                region.lokey = k;
                region.hikey = k;
                region.pitch_keycenter = k;
            }
        }
        "lokey" => region.lokey = key(value).unwrap_or(region.lokey),
        "hikey" => region.hikey = key(value).unwrap_or(region.hikey),
        "pitch_keycenter" => region.pitch_keycenter = key(value).unwrap_or(region.pitch_keycenter),
        "lovel" => region.lovel = num(value).map_or(region.lovel, |v| v.clamp(1.0, 127.0) as u8),
        "hivel" => region.hivel = num(value).map_or(region.hivel, |v| v.clamp(1.0, 127.0) as u8),
        "pitch_keytrack" => region.pitch_keytrack = num(value).unwrap_or(region.pitch_keytrack),
        "tune" => region.tune = num(value).unwrap_or(region.tune),
        "transpose" => region.tune += num(value).unwrap_or(0.0) * 100.0,
        "volume" => region.volume_db = num(value).unwrap_or(0.0).clamp(-144.0, 6.0),
        "pan" => region.pan = num(value).unwrap_or(0.0).clamp(-100.0, 100.0),
        "amp_veltrack" => region.amp_veltrack = num(value).unwrap_or(100.0).clamp(-100.0, 100.0),
        "seq_length" => region.seq_length = num(value).map_or(1, |v| v.max(1.0) as u32),
        "seq_position" => region.seq_position = num(value).map_or(1, |v| v.max(1.0) as u32),
        "lorand" => region.lorand = num(value).unwrap_or(0.0).clamp(0.0, 1.0),
        "hirand" => region.hirand = num(value).unwrap_or(1.0).clamp(0.0, 1.0),
        "group" | "polyphony_group" => region.group = num(value).map_or(0, |v| v.max(0.0) as u32),
        "off_by" => region.off_by = num(value).map_or(0, |v| v.max(0.0) as u32),
        "ampeg_release" => region.release = num(value).unwrap_or(0.005).clamp(0.001, 10.0),
        // Accepted, nothing to do for one-shot drum samples.
        "loop_mode" | "off_mode" | "trigger" | "default_path" => {}
        _ => return false,
    }
    true
}

/// Reads an SFZ file (and its includes). Sample paths come back absolute.
pub fn parse(path: &Path) -> Result<SfzFile, String> {
    let mut reader = Reader {
        defines: HashMap::new(),
        tokens: Vec::new(),
        errors: Vec::new(),
    };
    reader.read(path, 0);
    if let Some(error) = reader.errors.first() {
        return Err(error.clone());
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut file = SfzFile::default();
    let mut default_path = String::new();
    // Opcodes of the open headers, outermost first.
    let mut global: Vec<(String, String)> = Vec::new();
    let mut master: Vec<(String, String)> = Vec::new();
    let mut group: Vec<(String, String)> = Vec::new();
    let mut region: Option<Vec<(String, String)>> = None;
    let mut header = String::new();
    let mut skip_region = false;

    let finish = |opcodes: Option<Vec<(String, String)>>,
                  global: &[(String, String)],
                  master: &[(String, String)],
                  group: &[(String, String)],
                  default_path: &str,
                  file: &mut SfzFile| {
        let Some(own) = opcodes else { return };
        let mut r = Region::default();
        let mut trigger_attack = true;
        for (name, value) in global.iter().chain(master).chain(group).chain(&own) {
            if name == "trigger" && value != "attack" && value != "first" && value != "legato" {
                trigger_attack = false;
            }
            if !apply(&mut r, name, value) {
                file.ignored.insert(name.clone());
            }
        }
        if !trigger_attack || r.sample.as_os_str().is_empty() {
            return;
        }
        let sample = r.sample.to_string_lossy().into_owned();
        // `*sine` and other generators are not samples.
        if sample.starts_with('*') {
            file.ignored.insert("generator sample".into());
            return;
        }
        r.sample = dir.join(format!("{default_path}{sample}"));
        if r.lokey <= r.hikey && r.lovel <= r.hivel {
            file.regions.push(r);
        }
    };

    for token in reader.tokens {
        match token {
            Token::Header(name) => {
                finish(
                    region.take(),
                    &global,
                    &master,
                    &group,
                    &default_path,
                    &mut file,
                );
                skip_region = false;
                match name.as_str() {
                    "control" => {}
                    "global" => {
                        global.clear();
                        master.clear();
                        group.clear();
                    }
                    "master" => {
                        master.clear();
                        group.clear();
                    }
                    "group" => group.clear(),
                    "region" => region = Some(Vec::new()),
                    other => {
                        file.ignored.insert(format!("<{other}>"));
                        skip_region = true;
                    }
                }
                header = name;
            }
            Token::Opcode(name, value) => {
                if skip_region {
                    continue;
                }
                if name == "default_path" {
                    default_path = value.replace('\\', "/");
                    continue;
                }
                let target = match header.as_str() {
                    "global" => &mut global,
                    "master" => &mut master,
                    "group" => &mut group,
                    "region" => match region.as_mut() {
                        Some(r) => r,
                        None => continue,
                    },
                    _ => continue,
                };
                target.push((name, value));
            }
        }
    }
    finish(
        region.take(),
        &global,
        &master,
        &group,
        &default_path,
        &mut file,
    );
    if file.regions.is_empty() {
        return Err("The SFZ file has no regions with samples".into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn reads_note_names_and_numbers() {
        assert_eq!(parse_key("c4"), Some(60));
        assert_eq!(parse_key("C#3"), Some(49));
        assert_eq!(parse_key("eb2"), Some(39));
        assert_eq!(parse_key("b-1"), Some(11));
        assert_eq!(parse_key("36"), Some(36));
        assert_eq!(parse_key("200"), None);
        assert_eq!(parse_key("h3"), None);
    }

    #[test]
    fn inherits_opcodes_and_keeps_spaces_in_sample_paths() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "kit.sfz",
            r"
            // A tiny kit
            <control> default_path=Samples/
            <global> amp_veltrack=80 /* all regions */
            <group> key=36 pitch_keytrack=0 volume=-3
            <region> sample=Kick Drum/kick soft.wav hivel=63
            <region> sample=Kick Drum/kick hard.wav lovel=64
            <group> lokey=c3 hikey=d3 tune=-20 group=1
            <region> sample=snare.wav pan=-25 ampeg_release=0.2
            ",
        );
        let sfz = parse(&path).unwrap();
        assert_eq!(sfz.regions.len(), 3);
        let soft = &sfz.regions[0];
        assert_eq!(
            soft.sample,
            dir.path().join("Samples/Kick Drum/kick soft.wav")
        );
        assert_eq!((soft.lokey, soft.hikey, soft.pitch_keycenter), (36, 36, 36));
        assert_eq!((soft.lovel, soft.hivel), (1, 63));
        assert_eq!(soft.volume_db, -3.0);
        assert_eq!(soft.amp_veltrack, 80.0);
        assert_eq!(soft.pitch_keytrack, 0.0);
        assert_eq!(sfz.regions[1].lovel, 64);
        let snare = &sfz.regions[2];
        assert_eq!((snare.lokey, snare.hikey), (48, 50));
        assert_eq!((snare.tune, snare.pan, snare.group), (-20.0, -25.0, 1));
        assert_eq!(snare.release, 0.2);
        assert_eq!(snare.volume_db, 0.0, "a new group starts afresh");
        assert_eq!(sfz.keys(), [36, 48, 49, 50].into_iter().collect());
    }

    #[test]
    fn follows_defines_and_includes() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "parts/hats.sfz",
            "<region> sample=$HAT.wav key=$HATKEY off_by=2 group=1\n",
        );
        let path = write(
            dir.path(),
            "kit.sfz",
            "#define $HAT closed\n#define $HATKEY 42\n#define $HATKEY_OPEN 46\n\
             #include \"parts/hats.sfz\"\n\
             <region> sample=open.wav key=$HATKEY_OPEN group=2 seq_length=2 seq_position=2\n",
        );
        let sfz = parse(&path).unwrap();
        assert_eq!(sfz.regions.len(), 2);
        // Sample paths are relative to the main file, also in included files.
        assert_eq!(sfz.regions[0].sample, dir.path().join("closed.wav"));
        assert_eq!((sfz.regions[0].lokey, sfz.regions[0].off_by), (42, 2));
        assert_eq!(sfz.regions[1].lokey, 46, "the longer define wins");
        assert_eq!(
            (sfz.regions[1].seq_length, sfz.regions[1].seq_position),
            (2, 2)
        );
    }

    #[test]
    fn reports_what_it_ignores_and_skips_release_triggers() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "kit.sfz",
            "<curve> v000=0\n<region> sample=a.wav key=38 cutoff=500 fil_type=lpf_2p\n\
             <region> sample=b.wav key=38 trigger=release\n<region> sample=*sine key=40\n",
        );
        let sfz = parse(&path).unwrap();
        assert_eq!(sfz.regions.len(), 1);
        assert!(sfz.ignored.contains("cutoff"));
        assert!(sfz.ignored.contains("<curve>"));
        assert!(sfz.ignored.contains("generator sample"));
    }

    #[test]
    fn refuses_files_without_regions_and_survives_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let empty = write(dir.path(), "empty.sfz", "<group> key=36\n");
        assert!(parse(&empty).is_err());
        let garbage = write(
            dir.path(),
            "junk.sfz",
            "<<<>>> ==== = <region sample=\n\u{0}\u{1}",
        );
        assert!(parse(&garbage).is_err());
        let looped = write(dir.path(), "loop.sfz", "#include \"loop.sfz\"\n");
        assert!(parse(&looped).unwrap_err().contains("too deep"));
        assert!(parse(&dir.path().join("missing.sfz")).is_err());
    }
}
