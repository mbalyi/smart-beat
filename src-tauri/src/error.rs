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
    /// Any other I/O failure.
    Io,
}

/// Error payload of a failed command: `{ "kind": "not-found", "message": "…" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
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
            serde_json::json!({ "kind": "not-a-score", "message": "nope" })
        );
    }

    #[test]
    fn displays_the_message() {
        assert_eq!(
            CommandError::new(ErrorKind::Io, "disk on fire").to_string(),
            "disk on fire"
        );
    }
}
