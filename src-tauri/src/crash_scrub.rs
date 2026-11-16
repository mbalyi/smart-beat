//! Scrubs a crash event before it leaves the device (docs/crash-reports.md).
//!
//! Pure functions, no I/O: [`scrub_event`] builds a **new** event that only holds what the
//! allow-list names and drops everything else, so a field Sentry adds in a later version cannot
//! leak by accident. Allowed: the exception type, stack frames (function name and an app-relative
//! source location with line and column), the release (the app version), the environment
//! (`production` or `development`), the tag `os` (`macos`, `windows` or `linux`) and the SDK name
//! and version. Never kept: messages and exception values, user, IP address, request,
//! breadcrumbs, contexts, extra data, other tags, modules, threads, local variables, attachments,
//! absolute paths, URLs, user names, e-mail addresses, IPv4 addresses and long tokens. The
//! `server_name` is sent empty. A frame that is not valid is dropped, and an event without a
//! valid frame is dropped (`scrub_event` returns `None`).
//!
//! The UI has the same rules in `src/lib/crash-scrub.ts`.

use std::borrow::Cow;

use sentry::protocol::{ClientSdkInfo, Event, Exception, Frame, Level, Map, Stacktrace, Values};

/// Longest function name, exception type or path that is kept.
const MAX_TEXT: usize = 200;
/// A run of this many letters and digits looks like a token and is never sent.
const TOKEN_RUN: usize = 24;
/// Folders that mean a path is not part of Smart Beat: dependencies, the toolchain, build output.
const FOREIGN_FOLDERS: [&str; 8] = [
    "/.cargo/",
    "/registry/",
    "/rustc/",
    "/.rustup/",
    "/library/",
    "/node_modules/",
    "/target/",
    "/vendor/",
];

/// The tag value for the operating system, or `None` for one the app is not built for.
pub fn os_name() -> Option<&'static str> {
    match std::env::consts::OS {
        "macos" => Some("macos"),
        "windows" => Some("windows"),
        "linux" => Some("linux"),
        _ => None,
    }
}

/// The only two environments that are sent.
pub fn environment() -> &'static str {
    if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    }
}

/// Builds the event that is sent, or `None` when the event must not be sent at all.
///
/// `release` is the app version; `environment` is `production` or `development`. A value that
/// does not look like a version (or one of the two environments) is left out.
pub fn scrub_event(
    event: Event<'static>,
    release: &str,
    environment: &str,
    os: Option<&str>,
) -> Option<Event<'static>> {
    let exceptions: Vec<Exception> = event
        .exception
        .values
        .into_iter()
        .filter_map(scrub_exception)
        .collect();
    if exceptions.is_empty() {
        return None;
    }
    let mut tags = Map::new();
    if let Some(os) = os.filter(|os| ["macos", "windows", "linux"].contains(os)) {
        tags.insert("os".to_owned(), os.to_owned());
    }
    Some(Event {
        event_id: event.event_id,
        level: match event.level {
            Level::Fatal => Level::Fatal,
            _ => Level::Error,
        },
        platform: Cow::Borrowed("native"),
        timestamp: event.timestamp,
        // Not the machine's name: sent, but empty.
        server_name: Some(Cow::Borrowed("")),
        release: clean_release(release).map(Cow::Owned),
        environment: ["production", "development"]
            .contains(&environment)
            .then(|| Cow::Owned(environment.to_owned())),
        tags,
        exception: Values::from(exceptions),
        sdk: Some(Cow::Owned(ClientSdkInfo {
            name: "sentry.rust".to_owned(),
            version: event
                .sdk
                .as_ref()
                .and_then(|sdk| clean_release(&sdk.version))
                .unwrap_or_default(),
            integrations: Vec::new(),
            packages: Vec::new(),
        })),
        ..Event::default()
    })
}

/// The exception type and its valid frames. `None` when no frame is valid.
fn scrub_exception(exception: Exception) -> Option<Exception> {
    let frames: Vec<Frame> = exception
        .stacktrace
        .map(|trace| trace.frames)
        .unwrap_or_default()
        .into_iter()
        .filter_map(scrub_frame)
        .collect();
    if frames.is_empty() {
        return None;
    }
    Some(Exception {
        ty: clean_type(&exception.ty).unwrap_or_else(|| "error".to_owned()),
        stacktrace: Some(Stacktrace {
            frames,
            ..Stacktrace::default()
        }),
        // The message (`value`), the module, the mechanism and the thread are not kept.
        ..Exception::default()
    })
}

/// A frame with a function name and/or an app-relative location, or `None` when it has neither.
fn scrub_frame(frame: Frame) -> Option<Frame> {
    let function = frame.function.as_deref().and_then(clean_function);
    let location = [frame.filename.as_deref(), frame.abs_path.as_deref()]
        .into_iter()
        .flatten()
        .find_map(app_location);
    if function.is_none() && location.is_none() {
        return None;
    }
    let has_location = location.is_some();
    Some(Frame {
        in_app: Some(has_location),
        // A line number means nothing without the file it belongs to.
        lineno: frame.lineno.filter(|_| has_location),
        colno: frame.colno.filter(|_| has_location),
        filename: location,
        function,
        ..Frame::default()
    })
}

/// A readable function name without the hash, or `None` when it could hold personal data.
pub fn clean_function(name: &str) -> Option<String> {
    let name = strip_hash(name.trim());
    let printable = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " _:<>{}()[]&*,'$#;.=!+-?^|".contains(c));
    if name.is_empty() || name.len() > MAX_TEXT || !printable || looks_personal(name) {
        return None;
    }
    Some(name.to_owned())
}

/// The exception type (`panic`, `Error`, ...), or `None` when it is not a plain identifier.
fn clean_type(ty: &str) -> Option<String> {
    let ty = ty.trim();
    let plain = ty
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_:.<>$ -".contains(c));
    (!ty.is_empty() && ty.len() <= 100 && plain && !looks_personal(ty)).then(|| ty.to_owned())
}

/// A version such as `1.3.0` or `1.4.0-beta.1`.
fn clean_release(version: &str) -> Option<String> {
    let ok = !version.is_empty()
        && version.len() <= 40
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
    ok.then(|| version.to_owned())
}

/// Removes the trailing `::h0123456789abcdef` hash of an older symbol name.
fn strip_hash(name: &str) -> &str {
    if let Some((head, tail)) = name.rsplit_once("::h")
        && tail.len() == 16
        && tail.chars().all(|c| c.is_ascii_hexdigit())
    {
        return head;
    }
    name
}

/// The app-relative location (`src/...` or `src-tauri/src/...`) of a source path, or `None` for
/// a path outside Smart Beat (a dependency, the toolchain, anything on its own disk) or one that
/// is not a plain Rust file path. The folders above `src` (user name, project folder) are
/// removed, never shortened.
pub fn app_location(path: &str) -> Option<String> {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() || path.contains("://") || path.contains("..") {
        return None;
    }
    // Leading slash added so the markers also match at the start of a relative path.
    let probe = format!("/{}", path.trim_start_matches("./"));
    if FOREIGN_FOLDERS.iter().any(|folder| probe.contains(folder)) {
        return None;
    }
    let relative = if let Some(at) = probe.rfind("/src-tauri/src/") {
        &probe[at + 1..]
    } else {
        let at = probe.rfind("/src/")?;
        &probe[at + 1..]
    };
    let segments_ok = relative.split('/').all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
    });
    let valid = segments_ok
        && relative.len() <= MAX_TEXT
        && relative.ends_with(".rs")
        && !looks_personal(relative);
    valid.then(|| relative.to_owned())
}

/// Whether `text` holds something that must never leave the device: a URL or scheme, an e-mail
/// address, a path separator, a backslash, an IPv4 address or a long token.
fn looks_personal(text: &str) -> bool {
    text.contains("://")
        || text.contains('@')
        || text.contains('\\')
        || text.contains(':') && text.split(':').any(|part| part.starts_with("//"))
        || has_ipv4(text)
        || has_long_run(text)
}

/// A run of [`TOKEN_RUN`] or more ASCII letters and digits.
fn has_long_run(text: &str) -> bool {
    let mut run = 0;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            run += 1;
            if run >= TOKEN_RUN {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

/// Four dot-separated groups of one to three digits that are each at most 255.
fn has_ipv4(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        if !bytes[start].is_ascii_digit() || (start > 0 && bytes[start - 1].is_ascii_digit()) {
            start += 1;
            continue;
        }
        let mut at = start;
        let mut groups = 0;
        loop {
            let digits = bytes[at..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            let value = text[at..at + digits].parse::<u32>().unwrap_or(u32::MAX);
            if digits == 0 || digits > 3 || value > 255 {
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
        start += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use sentry::protocol::{
        Breadcrumb, Context, DeviceContext, Request, TemplateInfo, Thread, User,
    };

    /// Strings that must never appear in anything sent.
    const FORBIDDEN: [&str; 14] = [
        "jane",
        "Jane",
        "/Users",
        "C:\\",
        "My Secret Song",
        ".gp5",
        "token=abc123",
        "https://x.test",
        "x.test",
        "file://",
        "tauri://",
        "localhost",
        "example.com",
        "192.168",
    ];

    fn frame(function: Option<&str>, file: Option<&str>) -> Frame {
        Frame {
            function: function.map(str::to_owned),
            filename: file.map(str::to_owned),
            abs_path: file.map(str::to_owned),
            lineno: Some(42),
            colno: Some(7),
            module: Some("jane_module".to_owned()),
            package: Some("/Users/jane/pkg".to_owned()),
            symbol: Some("jane_symbol".to_owned()),
            context_line: Some("let secret = \"My Secret Song.gp5\";".to_owned()),
            pre_context: vec!["jane@example.com".to_owned()],
            post_context: vec!["https://x.test/a?token=abc123".to_owned()],
            vars: [(
                "path".to_owned(),
                serde_json::json!("/Users/jane/My Secret Song.gp5"),
            )]
            .into(),
            instruction_addr: Some(0x1234.into()),
            ..Frame::default()
        }
    }

    fn crash(frames: Vec<Frame>) -> Event<'static> {
        let mut event = Event {
            level: Level::Fatal,
            message: Some("could not open /Users/jane/My Secret Song.gp5".to_owned()),
            exception: vec![Exception {
                ty: "panic".to_owned(),
                value: Some("called unwrap on /Users/jane/My Secret Song.gp5".to_owned()),
                module: Some("jane".to_owned()),
                stacktrace: Some(Stacktrace {
                    frames,
                    ..Stacktrace::default()
                }),
                ..Exception::default()
            }]
            .into(),
            server_name: Some("janes-macbook.local".into()),
            release: Some("9.9.9-jane".into()),
            dist: Some("jane".into()),
            logger: Some("jane".to_owned()),
            transaction: Some("/Users/jane/x".to_owned()),
            culprit: Some("/Users/jane/x".to_owned()),
            user: Some(User {
                email: Some("jane@example.com".to_owned()),
                username: Some("jane".to_owned()),
                ip_address: Some("192.168.1.20".parse().unwrap()),
                ..User::default()
            }),
            request: Some(Request {
                url: Some("https://x.test/a?token=abc123".parse().unwrap()),
                ..Request::default()
            }),
            template: Some(TemplateInfo::default()),
            ..Event::default()
        };
        event.breadcrumbs.values.push(Breadcrumb {
            message: Some("opened My Secret Song.gp5".to_owned()),
            ..Breadcrumb::default()
        });
        event.contexts.insert(
            "device".to_owned(),
            Context::Device(Box::new(DeviceContext {
                name: Some("Jane's MacBook".to_owned()),
                ..DeviceContext::default()
            })),
        );
        event
            .extra
            .insert("file".to_owned(), serde_json::json!("file:///Users/jane/x"));
        event
            .tags
            .insert("path".to_owned(), "C:\\Users\\jane\\x".to_owned());
        event
            .modules
            .insert("jane".to_owned(), "tauri://localhost/index.html".to_owned());
        event.threads.values.push(Thread {
            name: Some("jane".to_owned()),
            ..Thread::default()
        });
        event
    }

    fn json(event: &Event<'static>) -> String {
        serde_json::to_string(event).unwrap()
    }

    fn app_frame() -> Frame {
        frame(
            Some("smart_beat_lib::audio::engine::render::h0123456789abcdef"),
            Some("/Users/jane/Documents/smart-beat/src-tauri/src/audio/engine.rs"),
        )
    }

    #[test]
    fn keeps_only_the_allowed_fields() {
        let scrubbed = scrub_event(
            crash(vec![app_frame()]),
            "1.3.0",
            "production",
            Some("macos"),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&scrubbed).unwrap()["exception"],
            serde_json::json!({ "values": [{
                "type": "panic",
                "stacktrace": { "frames": [{
                    "function": "smart_beat_lib::audio::engine::render",
                    "filename": "src-tauri/src/audio/engine.rs",
                    "lineno": 42,
                    "colno": 7,
                    "in_app": true,
                }] }
            }] })
        );
        assert_eq!(scrubbed.release.as_deref(), Some("1.3.0"));
        assert_eq!(scrubbed.environment.as_deref(), Some("production"));
        assert_eq!(scrubbed.server_name.as_deref(), Some(""));
        assert_eq!(scrubbed.level, Level::Fatal);
        assert_eq!(scrubbed.tags.len(), 1);
        assert_eq!(scrubbed.tags.get("os").map(String::as_str), Some("macos"));
        assert_eq!(scrubbed.sdk.as_ref().unwrap().name, "sentry.rust");
        assert!(scrubbed.sdk.as_ref().unwrap().integrations.is_empty());
        assert!(scrubbed.sdk.as_ref().unwrap().packages.is_empty());
        assert!(scrubbed.message.is_none() && scrubbed.logentry.is_none());
        assert!(scrubbed.user.is_none() && scrubbed.request.is_none());
        assert!(scrubbed.breadcrumbs.values.is_empty());
        assert!(scrubbed.contexts.is_empty() && scrubbed.extra.is_empty());
        assert!(scrubbed.modules.is_empty() && scrubbed.threads.values.is_empty());
        assert!(scrubbed.transaction.is_none() && scrubbed.culprit.is_none());
        assert!(scrubbed.dist.is_none() && scrubbed.logger.is_none());
        assert!(scrubbed.template.is_none() && scrubbed.stacktrace.is_none());
        assert_eq!(scrubbed.fingerprint, Event::default().fingerprint);
        let sent = json(&scrubbed);
        for forbidden in FORBIDDEN {
            assert!(!sent.contains(forbidden), "{forbidden} in {sent}");
        }
    }

    #[test]
    fn nothing_personal_survives_in_any_frame_field() {
        let hostile = [
            frame(
                Some("/Users/jane/My Secret Song.gp5"),
                Some("C:\\Users\\jane\\My Secret Song.gp5"),
            ),
            frame(
                Some("https://x.test/a?token=abc123"),
                Some("https://x.test/a?token=abc123"),
            ),
            frame(Some("file:///Users/jane/x"), Some("file:///Users/jane/x")),
            frame(
                Some("tauri://localhost/index.html"),
                Some("tauri://localhost/index.html"),
            ),
            frame(Some("jane@example.com"), Some("jane@example.com")),
            frame(Some("connect 192.168.1.20 failed"), None),
            frame(Some("abcdefghijklmnopqrstuvwx1234"), None),
        ];
        // Every one of these is dropped; the one valid frame keeps the event alive.
        let mut frames = hostile.to_vec();
        frames.push(app_frame());
        let scrubbed = scrub_event(crash(frames), "1.3.0", "production", Some("linux")).unwrap();
        assert_eq!(
            scrubbed.exception.values[0]
                .stacktrace
                .as_ref()
                .unwrap()
                .frames
                .len(),
            1
        );
        let sent = json(&scrubbed);
        for forbidden in FORBIDDEN {
            assert!(!sent.contains(forbidden), "{forbidden} in {sent}");
        }
    }

    #[test]
    fn a_frame_keeps_a_clean_function_when_its_path_is_not_ours() {
        let scrubbed = scrub_event(
            crash(vec![frame(
                Some("core::panicking::panic_fmt"),
                Some("/Users/jane/.cargo/registry/src/index.crates.io-1/foo-1.0.0/src/lib.rs"),
            )]),
            "1.3.0",
            "production",
            None,
        )
        .unwrap();
        let kept = &scrubbed.exception.values[0]
            .stacktrace
            .as_ref()
            .unwrap()
            .frames[0];
        assert_eq!(kept.function.as_deref(), Some("core::panicking::panic_fmt"));
        assert_eq!(kept.filename, None);
        // A line without its file means nothing, so it goes too.
        assert_eq!(kept.lineno, None);
        assert_eq!(kept.colno, None);
        assert_eq!(kept.in_app, Some(false));
        assert!(scrubbed.tags.is_empty(), "no os tag for an unknown system");
    }

    #[test]
    fn an_event_without_a_valid_frame_is_dropped() {
        assert!(scrub_event(crash(vec![]), "1.3.0", "production", None).is_none());
        assert!(
            scrub_event(
                crash(vec![
                    frame(None, Some("/Users/jane/secret.rs")),
                    frame(None, None)
                ]),
                "1.3.0",
                "production",
                None
            )
            .is_none()
        );
        let mut message_only = Event {
            message: Some("My Secret Song.gp5".to_owned()),
            ..Event::default()
        };
        message_only.level = Level::Error;
        assert!(scrub_event(message_only, "1.3.0", "production", None).is_none());
    }

    #[test]
    fn release_environment_and_os_are_checked_too() {
        let event = || crash(vec![app_frame()]);
        let odd = scrub_event(event(), "/Users/jane", "jane's mac", Some("jane")).unwrap();
        assert_eq!(odd.release, None);
        assert_eq!(odd.environment, None);
        assert!(odd.tags.is_empty());
        let dev = scrub_event(event(), "1.4.0-beta.1", "development", Some("windows")).unwrap();
        assert_eq!(dev.release.as_deref(), Some("1.4.0-beta.1"));
        assert_eq!(dev.environment.as_deref(), Some("development"));
        assert_eq!(dev.tags.get("os").map(String::as_str), Some("windows"));
    }

    #[test]
    fn an_exception_type_that_could_hold_data_is_replaced() {
        let mut event = crash(vec![app_frame()]);
        event.exception.values[0].ty = "failed to open /Users/jane/My Secret Song.gp5".to_owned();
        let scrubbed = scrub_event(event, "1.3.0", "production", None).unwrap();
        assert_eq!(scrubbed.exception.values[0].ty, "error");
        let sent = json(&scrubbed);
        for forbidden in FORBIDDEN {
            assert!(!sent.contains(forbidden), "{forbidden} in {sent}");
        }
    }

    #[test]
    fn app_locations_are_relative_to_the_project() {
        for (path, expected) in [
            ("src/audio/mod.rs", Some("src/audio/mod.rs")),
            ("./src/audio/mod.rs", Some("src/audio/mod.rs")),
            (
                "src-tauri/src/telemetry.rs",
                Some("src-tauri/src/telemetry.rs"),
            ),
            (
                "/Users/jane/work/smart-beat/src-tauri/src/stems/mod.rs",
                Some("src-tauri/src/stems/mod.rs"),
            ),
            (
                "C:\\Users\\jane\\work\\smart-beat\\src-tauri\\src\\stems\\mod.rs",
                Some("src-tauri/src/stems/mod.rs"),
            ),
            (
                "/home/jane/smart-beat/src/practice.rs",
                Some("src/practice.rs"),
            ),
            // Not ours.
            (
                "/Users/jane/.cargo/registry/src/x/foo-1.0.0/src/lib.rs",
                None,
            ),
            (
                "C:\\Users\\jane\\.cargo\\registry\\src\\x\\foo\\src\\lib.rs",
                None,
            ),
            ("/rustc/abc123/library/core/src/panicking.rs", None),
            (
                "/Users/jane/smart-beat/src-tauri/target/debug/build/x/out/y.rs",
                None,
            ),
            ("https://x.test/src/a.rs", None),
            ("tauri://localhost/src/a.rs", None),
            ("file:///Users/jane/src/a.rs", None),
            // Not a plain Rust path.
            ("/Users/jane/src/My Secret Song.gp5", None),
            ("/Users/jane/src/a.rs?token=abc123", None),
            ("src/../../etc/passwd.rs", None),
            ("/Users/jane/Documents/notes.txt", None),
            ("", None),
        ] {
            assert_eq!(app_location(path).as_deref(), expected, "{path}");
        }
    }

    #[test]
    fn text_checks_catch_urls_addresses_and_tokens() {
        for bad in [
            "https://x.test/a",
            "tauri://localhost/index.html",
            "file:///Users/jane/x",
            "jane@example.com",
            "C:\\Users\\jane",
            "host 10.0.0.1",
            "1.2.3.4",
            "0123456789abcdef01234567",
            "AbCdEfGhIjKlMnOpQrStUvWx",
        ] {
            assert!(looks_personal(bad), "{bad}");
        }
        for fine in [
            "smart_beat_lib::audio::engine::render",
            "<alloc::vec::Vec<T> as core::ops::Drop>::drop",
            "core::ops::function::FnOnce::call_once{{vtable.shim}}",
            "version 1.3.0",
            "1.2.3",
            "300.1.1.1",
            "0123456789abcdef",
        ] {
            assert!(!looks_personal(fine), "{fine}");
        }
    }

    #[test]
    fn function_names_lose_their_hash_and_odd_characters_drop_them() {
        assert_eq!(
            clean_function("a::b::c::h0123456789abcdef").as_deref(),
            Some("a::b::c")
        );
        assert_eq!(
            clean_function("a::b::hello").as_deref(),
            Some("a::b::hello")
        );
        assert_eq!(clean_function("a b/c"), None);
        assert_eq!(clean_function("naïve"), None);
        assert_eq!(clean_function(""), None);
        assert_eq!(clean_function(&"a_".repeat(150)), None);
    }

    #[test]
    fn the_os_and_environment_helpers_return_known_values() {
        assert!(matches!(
            os_name(),
            Some("macos" | "windows" | "linux") | None
        ));
        assert!(["production", "development"].contains(&environment()));
    }
}
