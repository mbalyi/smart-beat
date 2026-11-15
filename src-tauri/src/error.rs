//! Errors returned to the webview by IPC commands.

use serde::Serialize;

/// Machine-readable error category, serialized in kebab-case so the UI can
/// pick a message without parsing text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    /// The file does not exist (or is not a regular file).
    NotFound,
    /// The file extension is not one we open.
    UnsupportedType,
    /// The file is larger than we are willing to load.
    TooLarge,
    /// The extension is fine but the content is not a Guitar Pro file.
    NotAScore,
    /// A mixer settings key that is not a SHA-256 hex digest.
    InvalidKey,
    /// Mixer settings with out-of-range values.
    InvalidSettings,
    /// A menu state the UI sent that can't be shown (e.g. an overlong label).
    InvalidMenuState,
    /// The audio engine or the sound library refused a request (no output
    /// device, a bad SoundFont, an unusable amp model or impulse response).
    Audio,
    /// The file changed on disk (or in the cloud) since it was opened (#187).
    Conflict,
    /// An online-only cloud file did not finish downloading in time (#187).
    DownloadTimeout,
    /// A cloud provider could not be reached (#187).
    Network,
    /// The cloud sign-in expired or was revoked: connect the account again (#187).
    AuthExpired,
    /// A Practice together room code that is not valid (#158).
    InvalidCode,
    /// Any other I/O failure.
    Io,
}

/// Error payload of a failed command: `{ "kind": "not-found", "message": "…" }`, plus, when known,
/// `"origin": "src/audio/mod.rs:123"` (#242).
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
    /// Where in this app the error was created: an app-relative `file:line`, taken from the
    /// caller's source location (`#[track_caller]`), never from the message. It lets an error
    /// trace (docs/analytics.md) say which code failed. Left out of the payload when the error
    /// was created outside the app's own source files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// Two errors are equal when kind and message are: where they were created does not matter.
impl PartialEq for CommandError {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind && self.message == other.message
    }
}

impl Eq for CommandError {}

impl CommandError {
    /// Creates an error and records where it was created. Helpers that build errors for their
    /// callers are `#[track_caller]` too, so the origin is the failing line, not the helper.
    #[track_caller]
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        let at = std::panic::Location::caller();
        Self {
            kind,
            message: message.into(),
            origin: crate::scrub::origin(at.file(), at.line()),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CommandError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_in_kebab_case() {
        let error = CommandError::new(ErrorKind::NotAScore, "nope");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "kind": "not-a-score",
                "message": "nope",
                "origin": error.origin.clone().unwrap(),
            })
        );
    }

    #[test]
    fn origin_is_an_app_relative_location_and_never_the_message() {
        let line = line!() + 1;
        let error = CommandError::new(
            ErrorKind::Io,
            "could not open /Users/jane/My Secret Song.gp5",
        );
        assert_eq!(error.origin, Some(format!("src/error.rs:{line}")));
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["origin"], format!("src/error.rs:{line}"));
        for private in ["jane", "Secret", "gp5", "Users"] {
            assert!(!json["origin"].as_str().unwrap().contains(private));
        }
        // The shape of the payload the page already reads stays the same, with one extra key.
        assert_eq!(json["kind"], "io");
        assert_eq!(json.as_object().unwrap().len(), 3);
    }

    #[test]
    fn a_helper_reports_its_caller_not_itself() {
        #[track_caller]
        fn helper(message: &str) -> CommandError {
            CommandError::new(ErrorKind::Audio, message)
        }
        let error = helper("nope");
        let line = line!() - 1;
        assert_eq!(error.origin, Some(format!("src/error.rs:{line}")));
    }

    #[test]
    fn an_error_without_an_origin_serializes_the_old_shape() {
        let mut error = CommandError::new(ErrorKind::Io, "x");
        error.origin = None;
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "kind": "io", "message": "x" })
        );
    }

    #[test]
    fn equality_ignores_where_the_error_was_created() {
        let a = CommandError::new(ErrorKind::Io, "x");
        let b = CommandError::new(ErrorKind::Io, "x");
        assert_ne!(a.origin, b.origin);
        assert_eq!(a, b);
        assert_ne!(a, CommandError::new(ErrorKind::Io, "y"));
    }

    #[test]
    fn displays_the_message() {
        assert_eq!(
            CommandError::new(ErrorKind::Io, "disk on fire").to_string(),
            "disk on fire"
        );
    }
}
