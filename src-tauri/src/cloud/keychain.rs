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

/// Remembers what the inner store answered, so the keychain is read at most once per provider
/// and run: every read of a keychain item can raise a macOS access prompt. Saves and deletes
/// go through and update the remembered answer.
pub struct CachedStore<S: TokenStore> {
    inner: S,
    seen: Mutex<HashMap<&'static str, Option<Tokens>>>,
}

impl<S: TokenStore> CachedStore<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            seen: Mutex::new(HashMap::new()),
        }
    }

    fn seen(&self) -> std::sync::MutexGuard<'_, HashMap<&'static str, Option<Tokens>>> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl<S: TokenStore> TokenStore for CachedStore<S> {
    fn load(&self, kind: ProviderKind) -> Result<Option<Tokens>, CommandError> {
        if let Some(known) = self.seen().get(kind.prefix()) {
            return Ok(known.clone());
        }
        let loaded = self.inner.load(kind)?;
        self.seen().insert(kind.prefix(), loaded.clone());
        Ok(loaded)
    }
    fn save(&self, kind: ProviderKind, tokens: &Tokens) -> Result<(), CommandError> {
        self.inner.save(kind, tokens)?;
        self.seen().insert(kind.prefix(), Some(tokens.clone()));
        Ok(())
    }
    fn delete(&self, kind: ProviderKind) -> Result<(), CommandError> {
        self.inner.delete(kind)?;
        self.seen().insert(kind.prefix(), None);
        Ok(())
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

    /// Counts how often the inner store is read.
    #[derive(Default)]
    struct Counting(MemoryStore, std::sync::atomic::AtomicUsize);
    impl TokenStore for Counting {
        fn load(&self, kind: ProviderKind) -> Result<Option<Tokens>, CommandError> {
            self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.0.load(kind)
        }
        fn save(&self, kind: ProviderKind, tokens: &Tokens) -> Result<(), CommandError> {
            self.0.save(kind, tokens)
        }
        fn delete(&self, kind: ProviderKind) -> Result<(), CommandError> {
            self.0.delete(kind)
        }
    }

    #[test]
    fn the_cache_reads_the_inner_store_once_per_provider() {
        let cached = CachedStore::new(Counting::default());
        cached.save(ProviderKind::Drive, &tokens()).unwrap();
        cached.inner.1.store(0, std::sync::atomic::Ordering::SeqCst);
        // Known from the save: no read at all.
        assert_eq!(cached.load(ProviderKind::Drive).unwrap(), Some(tokens()));
        // Unknown provider: one read, then remembered (also an empty answer).
        assert_eq!(cached.load(ProviderKind::Dropbox).unwrap(), None);
        assert_eq!(cached.load(ProviderKind::Dropbox).unwrap(), None);
        assert_eq!(cached.inner.1.load(std::sync::atomic::Ordering::SeqCst), 1);
        cached.delete(ProviderKind::Drive).unwrap();
        assert_eq!(cached.load(ProviderKind::Drive).unwrap(), None);
        assert_eq!(cached.inner.1.load(std::sync::atomic::Ordering::SeqCst), 1);
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
