//! Direct cloud drive access (#187, phase 2): Google Drive, OneDrive and Dropbox without the
//! provider's desktop app.
//!
//! Each provider is its own module behind the [`Provider`] trait. Sign-in is OAuth with PKCE in
//! the system browser ([`oauth`]); tokens live only in the OS keychain ([`keychain`]).

pub mod dropbox;
pub mod google_drive;
pub mod keychain;
pub mod lease;
pub mod oauth;
pub mod onedrive;
pub mod pages;
pub mod pending;

use serde::{Deserialize, Serialize};

use crate::error::{CommandError, ErrorKind};

/// The supported providers. The serialized name is also the prefix of recent-file ids
/// (`drive:<fileId>`, see [`item_id`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Drive,
    Onedrive,
    Dropbox,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 3] = [Self::Drive, Self::Onedrive, Self::Dropbox];

    /// Prefix used in item ids and keychain entries.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Drive => "drive",
            Self::Onedrive => "onedrive",
            Self::Dropbox => "dropbox",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Drive => "Google Drive",
            Self::Onedrive => "OneDrive",
            Self::Dropbox => "Dropbox",
        }
    }
}

/// A file in a provider. `revision` is the provider's change token (Drive `headRevisionId`,
/// Dropbox `rev`, OneDrive `eTag`): a save passes the one it opened and fails with
/// [`ErrorKind::Conflict`] if the remote moved on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteFile {
    /// Provider's own id (Drive file id, OneDrive item id, Dropbox path_lower).
    pub id: String,
    pub name: String,
    pub revision: String,
    pub size: u64,
    pub modified_ms: u64,
}

/// OAuth tokens. Stored only by [`keychain::TokenStore`]; never serialized elsewhere and never
/// printed (see the manual `Debug`).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Seconds since the Unix epoch when the access token expires, 0 when unknown.
    pub expires_at: u64,
    /// Display name of the linked account.
    pub account: String,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("account", &self.account)
            .field("access_token", &"<hidden>")
            .finish()
    }
}

/// What every provider offers. Methods take a valid access token; [`oauth::Session`] refreshes
/// it. A 401 maps to [`ErrorKind::AuthExpired`], a failed request to [`ErrorKind::Network`], a
/// stale revision to [`ErrorKind::Conflict`].
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    /// Display name of the account behind `token`.
    fn account_name(&self, token: &str) -> Result<String, CommandError>;
    /// Tabs in Smart Beat's folder (App folder / `drive.file` scope), newest first.
    fn list(&self, token: &str) -> Result<Vec<RemoteFile>, CommandError>;
    fn metadata(&self, token: &str, id: &str) -> Result<RemoteFile, CommandError>;
    fn read(&self, token: &str, id: &str) -> Result<(Vec<u8>, RemoteFile), CommandError>;
    /// Replaces the content of `id` if the remote revision is still `revision`.
    fn write_if_revision(
        &self,
        token: &str,
        id: &str,
        revision: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, CommandError>;
    /// Creates a new file with `name`.
    fn create(&self, token: &str, name: &str, bytes: &[u8]) -> Result<RemoteFile, CommandError>;
    /// Asks the provider to invalidate the token (best effort).
    fn revoke(&self, token: &str) -> Result<(), CommandError>;
}

/// Recent-file id of a provider item: `drive:<id>`.
pub fn item_id(kind: ProviderKind, id: &str) -> String {
    format!("{}:{id}", kind.prefix())
}

/// Splits a recent-file id into provider and item, `None` for local paths.
pub fn parse_item_id(value: &str) -> Option<(ProviderKind, &str)> {
    let (prefix, id) = value.split_once(':')?;
    let kind = ProviderKind::ALL
        .into_iter()
        .find(|k| k.prefix() == prefix)?;
    (!id.is_empty()).then_some((kind, id))
}

/// Maps an HTTP failure to the error the UI shows.
pub fn http_error(error: ureq::Error, what: &str) -> CommandError {
    match error {
        ureq::Error::StatusCode(401) => CommandError::new(
            ErrorKind::AuthExpired,
            "The cloud sign-in expired or was revoked. Connect the account again.",
        ),
        ureq::Error::StatusCode(404) => {
            CommandError::new(ErrorKind::NotFound, format!("{what} could not be found."))
        }
        ureq::Error::StatusCode(409 | 412) => CommandError::new(
            ErrorKind::Conflict,
            format!("{what} changed in the cloud since you opened it."),
        ),
        ureq::Error::StatusCode(code) => CommandError::new(
            ErrorKind::Network,
            format!("The cloud service refused the request ({code})."),
        ),
        other => CommandError::new(
            ErrorKind::Network,
            format!("The cloud service could not be reached: {other}"),
        ),
    }
}

/// Percent-encodes `value` for a URL query or path segment.
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Builds a ureq agent that returns status codes as errors with a sane timeout.
pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .build()
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_ids_round_trip() {
        let id = item_id(ProviderKind::Drive, "abc");
        assert_eq!(id, "drive:abc");
        assert_eq!(parse_item_id(&id), Some((ProviderKind::Drive, "abc")));
        assert_eq!(parse_item_id("/home/me/a.gp"), None);
        assert_eq!(parse_item_id("C:\\a.gp"), None);
        assert_eq!(parse_item_id("drive:"), None);
    }

    #[test]
    fn dropbox_paths_keep_colons() {
        assert_eq!(
            parse_item_id("dropbox:/a:b.gp"),
            Some((ProviderKind::Dropbox, "/a:b.gp"))
        );
    }

    #[test]
    fn statuses_map_to_ui_errors() {
        assert_eq!(
            http_error(ureq::Error::StatusCode(401), "x").kind,
            ErrorKind::AuthExpired
        );
        assert_eq!(
            http_error(ureq::Error::StatusCode(412), "x").kind,
            ErrorKind::Conflict
        );
        assert_eq!(
            http_error(ureq::Error::StatusCode(500), "x").kind,
            ErrorKind::Network
        );
    }

    #[test]
    fn tokens_are_not_printed() {
        let t = Tokens {
            access_token: "secret".into(),
            refresh_token: Some("secret2".into()),
            expires_at: 0,
            account: "me".into(),
        };
        let shown = format!("{t:?}");
        assert!(!shown.contains("secret"));
    }

    #[test]
    fn encodes_reserved_characters() {
        assert_eq!(encode("a b/ü"), "a%20b%2F%C3%BC");
    }
}
