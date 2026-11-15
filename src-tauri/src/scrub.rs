//! Anonymised stack traces for error telemetry (#242, docs/analytics.md).
//!
//! A trace is a short list of *frames*: function-like names and app-relative source locations
//! such as `audio_start` or `src/audio/mod.rs:123`. This module is the single place that decides
//! what a frame may look like. Everything here is an allow-list: a frame that does not match the
//! grammar exactly is dropped, never repaired, so a path, a user name, a score file name, a URL
//! or an error message cannot get through by accident. The error message is never an input.
//!
//! The same grammar is enforced by the page (`src/lib/scrub-stack.ts`) and by the analytics
//! Worker; this module re-checks what the page sends and computes the `hash` that groups equal
//! traces.
//!
//! ```text
//! NAME     = [A-Za-z_$][A-Za-z0-9_$<>.-]{0,59}
//! PATH     = (src|src-tauri/src)/[A-Za-z0-9_./-]{1,80}
//! BASEFILE = [A-Za-z0-9_-]{1,40}\.(js|mjs|ts|tsx|rs)
//! LOC      = (PATH|BASEFILE)(:[0-9]{1,6}){0,2}
//! FRAME    = NAME | LOC | NAME " " LOC          (at most 100 characters)
//! ```

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::telemetry::FORMATS;

/// Most frames in one trace.
pub const MAX_FRAMES: usize = 8;
/// Most characters in one frame.
pub const MAX_FRAME_LEN: usize = 100;
/// How many of the first frames the hash covers: the command and the Rust origin. Later frames
/// (minified page code) change with every release, so they would split one problem into many.
pub const HASH_FRAMES: usize = 2;
/// How many entries of a page-supplied list are looked at (the rest is ignored unseen).
const MAX_SCANNED: usize = 64;

/// What the page sends with an `error` event: `{ frames, ext? }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct TraceInput {
    #[serde(default)]
    pub frames: Vec<String>,
    #[serde(default)]
    pub ext: Option<String>,
}

/// A trace that passed the grammar: 1 to [`MAX_FRAMES`] frames, an allow-listed `ext`, a `hash`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trace {
    pub hash: String,
    pub frames: Vec<String>,
    pub ext: Option<String>,
}

impl Trace {
    /// Re-scrubs what the page sent. `None` when no frame survives (the error is still counted,
    /// there is just no trace).
    pub fn from_input(input: &TraceInput) -> Option<Self> {
        let frames = scrub_frames(&input.frames);
        Self::new(frames, input.ext.as_deref())
    }

    /// A trace of already scrubbed frames (see [`scrub_frames`]); `None` when there are none.
    pub fn new(frames: Vec<String>, ext: Option<&str>) -> Option<Self> {
        if frames.is_empty() {
            return None;
        }
        Some(Self {
            hash: hash(&frames),
            ext: ext.map(|e| ext_or_other(e).to_owned()),
            frames,
        })
    }
}

/// `src/audio/mod.rs:123` for a source location inside this crate, `None` for anything else
/// (dependencies, the standard library, test files, unknown layouts). Only the part from `src/`
/// on is kept, so no home folder, user name or checkout path can leave through it. The result
/// also has to be a valid frame.
pub fn origin(file: &str, line: u32) -> Option<String> {
    let path = app_relative(file)?;
    let frame = format!("{path}:{line}");
    valid_frame(&frame).then_some(frame)
}

/// The file relative to the crate (`src/...`), or `None` when it is not inside the app crate.
pub fn app_relative(file: &str) -> Option<String> {
    let file = file.replace('\\', "/");
    let manifest = env!("CARGO_MANIFEST_DIR").replace('\\', "/");
    let relative = match file.strip_prefix(manifest.trim_end_matches('/')) {
        Some(rest) => rest.trim_start_matches('/'),
        None if file.starts_with("src/") || file.starts_with("src-tauri/src/") => &file,
        // A build that maps the checkout to another prefix: keep what starts at the app's
        // source folder, never what is in front of it.
        None => file
            .find("/src-tauri/src/")
            .map(|at| &file[at + 1..])
            .unwrap_or(""),
    };
    (relative.starts_with("src/") || relative.starts_with("src-tauri/src/"))
        .then(|| relative.to_owned())
}

/// Keeps the valid frames of `frames`, in order, at most [`MAX_FRAMES`].
pub fn scrub_frames<S: AsRef<str>>(frames: &[S]) -> Vec<String> {
    frames
        .iter()
        .take(MAX_SCANNED)
        .map(AsRef::as_ref)
        .filter(|frame| valid_frame(frame))
        .take(MAX_FRAMES)
        .map(str::to_owned)
        .collect()
}

/// The file extension of the file involved, only from the same list as the `open_file` and
/// `export` counters; anything else (including an empty string) is `other`.
pub fn ext_or_other(ext: &str) -> &'static str {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    FORMATS
        .iter()
        .find(|known| **known == ext)
        .copied()
        .unwrap_or("other")
}

/// First 16 lowercase hex characters of the SHA-256 of the first [`HASH_FRAMES`] (two) frames joined by
/// a line feed (UTF-8). Does not depend on the app version.
pub fn hash(frames: &[String]) -> String {
    let top = frames
        .iter()
        .take(HASH_FRAMES)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n");
    let digest = Sha256::digest(top.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `frame` is exactly a frame of the grammar and passes the extra reject rules.
pub fn valid_frame(frame: &str) -> bool {
    if frame.is_empty() || frame.chars().count() > MAX_FRAME_LEN || !frame.is_ascii() {
        return false;
    }
    if frame.contains(['@', '\\', '?', '#'])
        || frame.contains("..")
        || frame.contains("://")
        || has_ipv4(frame)
        || has_long_run(frame)
    {
        return false;
    }
    let mut parts = frame.split(' ');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(one), None, None) => is_name(one) || is_location(one),
        (Some(name), Some(location), None) => is_name(name) && is_location(location),
        _ => false,
    }
}

fn is_name(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    text.len() <= 60
        && (first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '<' | '>' | '.' | '-'))
}

fn is_location(text: &str) -> bool {
    let mut parts = text.split(':');
    let Some(file) = parts.next() else {
        return false;
    };
    let numbers: Vec<&str> = parts.collect();
    numbers.len() <= 2
        && numbers
            .iter()
            .all(|n| (1..=6).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
        && (is_app_path(file) || is_base_file(file))
}

fn is_app_path(text: &str) -> bool {
    let rest = text
        .strip_prefix("src-tauri/src/")
        .or_else(|| text.strip_prefix("src/"));
    rest.is_some_and(|rest| {
        (1..=80).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-'))
    })
}

fn is_base_file(text: &str) -> bool {
    let Some((stem, extension)) = text.rsplit_once('.') else {
        return false;
    };
    (1..=40).contains(&stem.len())
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        && matches!(extension, "js" | "mjs" | "ts" | "tsx" | "rs")
}

/// Anything shaped like `d+.d+.d+.d+` (an IPv4 address or a version-like number), at any place.
fn has_ipv4(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        if bytes[start].is_ascii_digit() {
            let mut at = start;
            let mut groups = 0;
            loop {
                let digits = bytes[at..]
                    .iter()
                    .take_while(|b| b.is_ascii_digit())
                    .count();
                if digits == 0 {
                    break;
                }
                groups += 1;
                at += digits;
                if groups == 4 {
                    return true;
                }
                if bytes.get(at) == Some(&b'.') {
                    at += 1;
                } else {
                    break;
                }
            }
            // Skip the whole digit run so every start is looked at once.
            start += bytes[start..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
        } else {
            start += 1;
        }
    }
    false
}

/// A run of 24 or more letters and digits (a token, a key, a hash).
fn has_long_run(text: &str) -> bool {
    let mut run = 0;
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() {
            run += 1;
            if run >= 24 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrub(frames: &[&str]) -> Vec<String> {
        scrub_frames(frames)
    }

    #[test]
    fn valid_frames_of_every_shape_pass() {
        for frame in [
            "audio_start",
            "src/audio/mod.rs:123",
            "src-tauri/src/m4a.rs:39",
            "startPlayback index-AbC123.js:1:48211",
            "src/lib/tauri.ts:650:12",
            "invoke",
            "$fn",
            "Foo.bar<T>",
            "index-AbC123.js",
            "export_stems src/stems/export.rs:280",
            "panic src/audio/mod.rs:12",
        ] {
            assert!(valid_frame(frame), "{frame}");
        }
    }

    #[test]
    fn a_username_in_a_path_is_dropped_on_both_systems() {
        assert!(scrub(&["/Users/jane/Documents/app/src/audio/mod.rs:12"]).is_empty());
        assert!(scrub(&["C:\\Users\\jane\\app\\src\\audio\\mod.rs:12"]).is_empty());
        assert!(scrub(&["open C:\\Users\\jane\\x.rs:3"]).is_empty());
        assert!(scrub(&["~/jane/src/audio/mod.rs:1", "/home/jane/x.rs:1"]).is_empty());
        assert!(scrub(&["file:///Users/jane/app/index.js:1"]).is_empty());
        assert!(scrub(&["tauri://localhost/assets/index-abc.js:1:2"]).is_empty());
    }

    #[test]
    fn a_score_file_name_is_dropped() {
        for frame in [
            "My Secret Song.gp5",
            "Secret.gp5:1",
            "open My Secret Song.gp5",
            "src/My Secret Song.gp5",
            "src/songs/My Secret Song.gp5:4",
        ] {
            assert!(!valid_frame(frame), "{frame}");
        }
    }

    #[test]
    fn urls_tokens_and_emails_are_dropped() {
        for frame in [
            "https://example.com/a?token=abc",
            "http://localhost:1420/index.js:1",
            "fetch?token=abc",
            "index.js:1#frag",
            "jane@example.com",
            "send jane@example.com",
            "src/a@b.rs:1",
            "Error: could not open the file",
            "TypeError: x is not a function",
            "at foo (index.js:1:2)",
            "192.168.1.20",
            "connect 10.0.0.1:80",
            "foo 1.2.3.4",
        ] {
            assert!(!valid_frame(frame), "{frame}");
        }
    }

    #[test]
    fn long_tokens_and_overlong_frames_are_dropped() {
        assert!(!valid_frame("abcdefghijklmnopqrstuvwx"));
        assert!(!valid_frame("src/abcdefghijklmnopqrstuvwxyz.rs:1"));
        assert!(!valid_frame("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"));
        assert!(valid_frame("abcdefghijklmnopqrstuvw"), "23 characters");
        assert!(
            valid_frame("abc_defghijklmnopqrstuvwxyz"),
            "runs are broken by `_`"
        );
        assert!(!valid_frame(&"a_".repeat(51)), "over 100 characters");
        let name = "a_".repeat(30); // a 60-character NAME is the longest
        assert!(valid_frame(&name));
        assert!(!valid_frame(&format!("{name}b")), "61-character NAME");
        assert!(!valid_frame(""));
        assert!(!valid_frame(" "));
        assert!(!valid_frame("a  b"));
        assert!(!valid_frame("a b c"));
    }

    #[test]
    fn paths_must_be_app_relative_without_traversal() {
        for frame in [
            "src/../secret.rs:1",
            "src/a/..",
            "../src/a.rs:1",
            "/src/a.rs:1",
            "lib/a.rs:1",
            "other/src/a.rs:1",
            "src/a.rs:1:2:3",
            "src/a.rs:1234567",
            "src/a.rs:x",
            "src/a.rs:",
            "src/",
            "src/é.rs:1",
        ] {
            assert!(!valid_frame(frame), "{frame}");
        }
        // 1 to 80 characters after the `src/` prefix.
        assert!(valid_frame(&format!("src/{}", "a/".repeat(40))));
        assert!(!valid_frame(&format!("src/{}", "a/".repeat(41))));
    }

    #[test]
    fn bundle_file_names_have_no_directory() {
        assert!(valid_frame("index-AbC123.js:1:2"));
        assert!(valid_frame("main.mjs"));
        assert!(!valid_frame("assets/index-AbC123.js:1:2"));
        assert!(!valid_frame("index-AbC123.css:1:2"));
        assert!(!valid_frame("index-AbC123.js:1:2:3"));
    }

    #[test]
    fn invalid_frames_are_dropped_and_the_cap_is_eight() {
        let frames = scrub(&[
            "export_stems",
            "Error: boom",
            "src/stems/mod.rs:10",
            "/Users/jane/x.js:1",
            "a",
            "b",
            "c",
            "d",
            "e",
            "f",
            "g",
            "h",
        ]);
        assert_eq!(frames.len(), MAX_FRAMES);
        assert_eq!(frames[0], "export_stems");
        assert_eq!(frames[1], "src/stems/mod.rs:10");
        assert_eq!(frames[7], "f");
        assert!(scrub(&["Error: boom", "/Users/jane"]).is_empty());
        let none: [&str; 0] = [];
        assert!(scrub(&none).is_empty());
        // Huge lists are not walked to the end.
        let many: Vec<String> = (0..10_000).map(|n| format!("f{n}")).collect();
        assert_eq!(scrub_frames(&many).len(), MAX_FRAMES);
    }

    #[test]
    fn ext_is_allow_listed() {
        assert_eq!(ext_or_other("gp5"), "gp5");
        assert_eq!(ext_or_other("GP5"), "gp5");
        assert_eq!(ext_or_other(".mid"), "mid");
        assert_eq!(ext_or_other("sbstems"), "other");
        assert_eq!(ext_or_other("My Secret Song"), "other");
        assert_eq!(ext_or_other("/Users/jane/x.gp5"), "other");
        assert_eq!(ext_or_other(""), "other");
        for known in FORMATS {
            assert_eq!(ext_or_other(known), *known);
        }
    }

    #[test]
    fn the_hash_is_stable_and_covers_the_first_two_frames() {
        let frames: Vec<String> = [
            "audio_start",
            "src/audio/mod.rs:123",
            "startPlayback index-A.js:1:2",
            "x",
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        let a = hash(&frames);
        assert_eq!(a.len(), 16);
        assert!(
            a.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(a, hash(&frames));
        // Same top two frames, other tail (another release's bundle): same group. Another
        // command or another origin: another group.
        let mut tail = frames.clone();
        tail[2] = "startPlayback index-B.js:1:2".into();
        tail.push("z".into());
        assert_eq!(a, hash(&tail));
        let mut other = frames.clone();
        other[1] = "src/audio/mod.rs:124".into();
        assert_ne!(a, hash(&other));
        let mut other = frames.clone();
        other[0] = "audio_stop".into();
        assert_ne!(a, hash(&other));
        // Pinned value of the shared fixture: SHA-256("a\nb") first 16 hex characters.
        let abc: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(hash(&abc), "7e18f737311b2dc3");
        assert_eq!(hash(&abc[..2]), hash(&abc));
        // A one-frame trace hashes just that frame.
        assert_eq!(hash(&abc[..1]).len(), 16);
    }

    #[test]
    fn a_trace_needs_at_least_one_valid_frame() {
        assert!(Trace::from_input(&TraceInput::default()).is_none());
        let input = TraceInput {
            frames: vec!["Error: nope".into(), "/Users/jane/My Song.gp5".into()],
            ext: Some("gp5".into()),
        };
        assert!(Trace::from_input(&input).is_none());
        let input = TraceInput {
            frames: vec![
                "audio_start".into(),
                "/Users/jane/My Song.gp5".into(),
                "src/audio/mod.rs:9".into(),
            ],
            ext: Some("My Song.gp5".into()),
        };
        let trace = Trace::from_input(&input).unwrap();
        assert_eq!(trace.frames, ["audio_start", "src/audio/mod.rs:9"]);
        assert_eq!(trace.ext.as_deref(), Some("other"));
        assert_eq!(trace.hash, hash(&trace.frames));
        let no_ext = Trace::from_input(&TraceInput {
            frames: vec!["a".into()],
            ext: None,
        })
        .unwrap();
        assert_eq!(no_ext.ext, None);
    }

    #[test]
    fn locations_are_reduced_to_the_app_relative_path() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        assert_eq!(
            origin("src/audio/mod.rs", 12).as_deref(),
            Some("src/audio/mod.rs:12")
        );
        assert_eq!(
            origin(&format!("{manifest}/src/m4a.rs"), 39).as_deref(),
            Some("src/m4a.rs:39")
        );
        assert_eq!(
            origin(&format!("{}/src/m4a.rs", manifest.replace('/', "\\")), 39).as_deref(),
            Some("src/m4a.rs:39")
        );
        assert_eq!(
            origin("src-tauri/src/m4a.rs", 7).as_deref(),
            Some("src-tauri/src/m4a.rs:7")
        );
        // Another checkout prefix: only the part from the app's source folder on is kept.
        assert_eq!(
            origin(
                "/Users/runner/jane/smart-beat/src-tauri/src/audio/mod.rs",
                3
            )
            .as_deref(),
            Some("src-tauri/src/audio/mod.rs:3")
        );
        for outside in [
            "/Users/jane/.cargo/registry/src/index.crates.io-1/foo-1.0.0/src/lib.rs",
            "/rustc/abc/library/core/src/option.rs",
            "tests/panic_counter.rs",
            &format!("{manifest}/tests/ipc.rs"),
            &format!("{manifest}/build.rs"),
            "/Users/jane/x/src/audio/mod.rs",
            "C:\\Users\\jane\\x.rs",
            "",
        ] {
            assert_eq!(origin(outside, 1), None, "{outside}");
        }
        // A location whose frame would not be valid is dropped, not shortened.
        assert_eq!(origin("src/abcdefghijklmnopqrstuvwxyz.rs", 1), None);
    }

    #[test]
    fn input_json_shape() {
        let input: TraceInput =
            serde_json::from_str(r#"{"frames":["a","b"],"ext":"gp5"}"#).unwrap();
        assert_eq!(input.frames, ["a", "b"]);
        assert_eq!(input.ext.as_deref(), Some("gp5"));
        let bare: TraceInput = serde_json::from_str(r#"{"frames":["a"]}"#).unwrap();
        assert_eq!(bare.ext, None);
    }
}
