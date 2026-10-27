//! Where cloud tokens live: the OS keychain and nowhere else. Never in `settings.json`, the
//! recent list, a `.gp` file or the logs (#187).

use std::collections::HashMap;
use std::sync::Mutex;

use super::{ProviderKind, Tokens};
use crate::error::{CommandError, ErrorKind};

/// Keychain service name.
pub const SERVICE: &str = "app.smartbeat.cloud";

/// Storage for one [`Tokens`] per provider.
pub trait TokenStore: Send + Sync {
    fn load(&self, kind: ProviderKind) -> Result<Option<Tokens>, CommandError>;
    fn save(&self, kind: ProviderKind, tokens: &Tokens) -> Result<(), CommandError>;
    fn delete(&self, kind: ProviderKind) -> Result<(), CommandError>;
}

fn error(action: &str, e: &keyring::Error) -> CommandError {
    // The message names the action only: keyring errors never contain the secret.
    CommandError::new(
        ErrorKind::Io,
        format!("The system keychain could not {action}: {e}"),
    )
}

/// The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
#[derive(Debug, Default)]
pub struct Keychain;

impl Keychain {
    fn entry(kind: ProviderKind) -> Result<keyring::Entry, CommandError> {
        keyring::Entry::new(SERVICE, kind.prefix()).map_err(|e| error("open the entry", &e))
    }
}

impl TokenStore for Keychain {
    fn load(&self, kind: ProviderKind) -> Result<Option<Tokens>, CommandError> {
        match Self::entry(kind)?.get_password() {
            Ok(json) => Ok(serde_json::from_str(&json).ok()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(error("read the sign-in", &e)),
        }
    }

    fn save(&self, kind: ProviderKind, tokens: &Tokens) -> Result<(), CommandError> {
        let json = serde_json::to_string(tokens)
            .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))?;
        Self::entry(kind)?
            .set_password(&json)
            .map_err(|e| error("store the sign-in", &e))
    }

    fn delete(&self, kind: ProviderKind) -> Result<(), CommandError> {
        match Self::entry(kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(error("remove the sign-in", &e)),
        }
    }
}

/// In-memory store for tests.
#[derive(Debug, Default)]
pub struct MemoryStore(Mutex<HashMap<&'static str, Tokens>>);

impl TokenStore for MemoryStore {
    fn load(&self, kind: ProviderKind) -> Result<Option<Tokens>, CommandError> {
        Ok(self.0.lock().unwrap().get(kind.prefix()).cloned())
    }
    fn save(&self, kind: ProviderKind, tokens: &Tokens) -> Result<(), CommandError> {
        self.0.lock().unwrap().insert(kind.prefix(), tokens.clone());
        Ok(())
    }
    fn delete(&self, kind: ProviderKind) -> Result<(), CommandError> {
        self.0.lock().unwrap().remove(kind.prefix());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> Tokens {
        Tokens {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_at: 5,
            account: "me@example.com".into(),
        }
    }

    #[test]
    fn memory_store_round_trips_per_provider() {
        let store = MemoryStore::default();
        store.save(ProviderKind::Drive, &tokens()).unwrap();
        assert_eq!(store.load(ProviderKind::Drive).unwrap(), Some(tokens()));
        assert_eq!(store.load(ProviderKind::Dropbox).unwrap(), None);
        store.delete(ProviderKind::Drive).unwrap();
        assert_eq!(store.load(ProviderKind::Drive).unwrap(), None);
    }
}
