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
pub mod transfer;

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

/// How much a share link allows its holder (#201).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShareLevel {
    /// Look at and download the file.
    View,
    /// Change the file too.
    Edit,
}

impl ProviderKind {
    /// The link levels the provider can make. Dropbox links are view only here: an editor link
    /// needs account features Smart Beat cannot count on.
    pub fn share_levels(self) -> &'static [ShareLevel] {
        match self {
            Self::Drive | Self::Onedrive => &[ShareLevel::View, ShareLevel::Edit],
            Self::Dropbox => &[ShareLevel::View],
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
    /// A link to file `id` that anyone who has it can open (#201). The link is a secret like a
    /// token: callers never log it. The default says it is not supported; the real providers
    /// override it.
    fn share_link(
        &self,
        _token: &str,
        _id: &str,
        _level: ShareLevel,
    ) -> Result<String, CommandError> {
        Err(CommandError::new(
            ErrorKind::Io,
            "This cloud service cannot make share links yet.",
        ))
    }
    /// Uploads the file at `path` as a new file called `name`, in chunks read from disk (the file
    /// may be well over 100 MB, so it is never held in memory whole). `progress` receives the
    /// fraction sent, 0 to 1. `cancel` is checked between chunks: setting it ends the upload with
    /// [`ErrorKind::Io`] with the message [`STOPPED`] and leaves nothing behind. (Stem separation,
    /// #186.) The default says it is not supported; the real providers override it.
    fn upload_file(
        &self,
        _token: &str,
        _name: &str,
        _path: &std::path::Path,
        _progress: &mut dyn FnMut(f32),
        _cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<RemoteFile, CommandError> {
        Err(CommandError::new(
            ErrorKind::Io,
            "This cloud service cannot upload large files yet.",
        ))
    }
    /// Downloads file `id` to `dest` (streamed to disk, never held whole in memory) and returns
    /// its metadata. `progress` and `cancel` work as in [`Provider::upload_file`]; a cancelled
    /// or failed download leaves no partial file at `dest`.
    fn download_file(
        &self,
        _token: &str,
        _id: &str,
        _dest: &std::path::Path,
        _progress: &mut dyn FnMut(f32),
        _cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<RemoteFile, CommandError> {
        Err(CommandError::new(
            ErrorKind::Io,
            "This cloud service cannot download large files yet.",
        ))
    }
}

/// Whether a file name is a saved stems file (`.sbstems`, any case). A provider lists these next
/// to the tabs, and the commands then keep the two kinds apart (#186).
pub fn is_stems_name(name: &str) -> bool {
    name.to_lowercase().ends_with(".sbstems")
}

/// The message of the error a stopped transfer ends with: the one the stem file commands use, so
/// the page tells a stop from a failure the same way.
pub const STOPPED: &str = crate::stems::bundle::STOPPED;

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

/// Maps an HTTP failure of a share request to the error the UI shows: a refusal (403) means the
/// account or its organisation does not allow links, which reconnecting would not change.
pub fn share_http_error(error: ureq::Error, what: &str) -> CommandError {
    match error {
        ureq::Error::StatusCode(403) => CommandError::new(
            ErrorKind::Io,
            "This account does not allow sharing this file with a link.",
        ),
        other => http_error(other, what),
    }
}

/// Whether `link` looks like what a provider hands out: an `https://` address without spaces.
/// Anything else is not copied to the clipboard.
pub fn is_share_link(link: &str) -> bool {
    link.starts_with("https://")
        && link.len() > "https://".len()
        && !link.chars().any(|c| c.is_whitespace() || c.is_control())
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
    fn share_levels_follow_what_the_provider_can_make() {
        assert_eq!(
            ProviderKind::Drive.share_levels(),
            [ShareLevel::View, ShareLevel::Edit]
        );
        assert_eq!(ProviderKind::Dropbox.share_levels(), [ShareLevel::View]);
        assert_eq!(
            serde_json::to_string(&ShareLevel::Edit).unwrap(),
            "\"edit\""
        );
    }

    #[test]
    fn only_https_addresses_are_share_links() {
        assert!(is_share_link("https://drive.google.com/file/d/1/view"));
        assert!(!is_share_link("http://example.com/x"));
        assert!(!is_share_link("https://"));
        assert!(!is_share_link("https://a.com/x y"));
        assert!(!is_share_link("javascript:alert(1)"));
    }

    #[test]
    fn a_refused_share_is_not_an_expired_sign_in() {
        let error = share_http_error(ureq::Error::StatusCode(403), "x");
        assert_eq!(error.kind, ErrorKind::Io);
        assert!(!error.message.contains("403"));
        assert_eq!(
            share_http_error(ureq::Error::StatusCode(401), "x").kind,
            ErrorKind::AuthExpired
        );
    }

    #[test]
    fn encodes_reserved_characters() {
        assert_eq!(encode("a b/ü"), "a%20b%2F%C3%BC");
    }
}
