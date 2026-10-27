//! Advisory edit lease (#187): a small file next to the tab says which device is editing it.
//! Other devices open the tab read-only while the lease is fresh. Providers do not enforce
//! locks, so this only warns; a crashed device's lease expires.

use serde::{Deserialize, Serialize};

/// A lease is stale this long after its last heartbeat.
pub const STALE_AFTER_SECS: u64 = 10 * 60;
/// How often the editing device renews its lease.
pub const HEARTBEAT_SECS: u64 = 5 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub device: String,
    /// Seconds since the Unix epoch of the last heartbeat.
    pub heartbeat: u64,
}

/// File name of the lease for `tab`.
pub fn file_name(tab: &str) -> String {
    format!(".{tab}.smartbeat-lease")
}

impl Lease {
    pub fn new(device: &str, now: u64) -> Self {
        Self {
            device: device.to_owned(),
            heartbeat: now,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// A damaged lease file reads as no lease.
    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }

    pub fn is_stale(&self, now: u64) -> bool {
        now.saturating_sub(self.heartbeat) >= STALE_AFTER_SECS
    }

    /// Whether `device` must open the tab read-only because someone else holds a fresh lease.
    pub fn blocks(&self, device: &str, now: u64) -> bool {
        self.device != device && !self.is_stale(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_lease_of_another_device_blocks() {
        let lease = Lease::new("laptop", 1000);
        assert!(lease.blocks("phone", 1000 + 60));
    }

    #[test]
    fn your_own_lease_never_blocks() {
        assert!(!Lease::new("laptop", 1000).blocks("laptop", 1001));
    }

    #[test]
    fn a_stale_lease_expires() {
        let lease = Lease::new("laptop", 1000);
        assert!(!lease.blocks("phone", 1000 + STALE_AFTER_SECS));
        assert!(lease.blocks("phone", 1000 + STALE_AFTER_SECS - 1));
    }

    #[test]
    fn heartbeat_is_shorter_than_expiry() {
        const { assert!(HEARTBEAT_SECS * 2 <= STALE_AFTER_SECS) };
    }

    #[test]
    fn round_trips_and_ignores_damage() {
        let lease = Lease::new("a", 5);
        assert_eq!(Lease::from_bytes(&lease.to_bytes()), Some(lease));
        assert_eq!(Lease::from_bytes(b"{nope"), None);
    }

    #[test]
    fn lease_file_sits_next_to_the_tab() {
        assert_eq!(file_name("song.gp"), ".song.gp.smartbeat-lease");
    }
}
