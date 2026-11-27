//! Practice together (#258): "Host a network". On Windows and Linux the host can make a Wi-Fi
//! network for the other players when there is no router: a Wi-Fi Direct legacy access point on
//! Windows (`wifi_direct.rs`), a NetworkManager hotspot on Linux (`network_manager.rs`). macOS offers no API
//! for it, so a Mac joins a network made by another computer (or a cable, or a phone).
//!
//! Each system is a [`HotspotBackend`]; this module picks the network name and password, keeps
//! the running network and answers the page. The backends block (D-Bus, WinRT), so every command
//! runs off the main thread.

pub mod network;
#[cfg(any(target_os = "linux", test))]
pub mod nm_settings;

#[cfg(target_os = "linux")]
mod network_manager;
#[cfg(windows)]
mod wifi_direct;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::error::{CommandError, ErrorKind};

/// Sent when a running network stops by itself (payload: `{ reason }`). Mirrored in
/// `src/lib/tauri.ts`.
pub const STOPPED_EVENT: &str = "practice-network-stopped";

/// Why a network cannot be made, or stopped. Shown to the user as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotspotError {
    /// This system has no way to make a network (macOS, and anything else).
    Unsupported(String),
    /// Linux: NetworkManager is not running (or there is no system bus).
    NoNetworkManager,
    /// No Wi-Fi adapter that can be an access point.
    NoAccessPoint,
    /// The system refused (Linux: polkit said no).
    AccessDenied,
    /// Wi-Fi is switched off.
    RadioOff,
    /// The Wi-Fi adapter is busy with something else.
    Busy,
    /// Anything else, with the system's words.
    Failed(String),
}

impl std::fmt::Display for HotspotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(why) => f.write_str(why),
            Self::NoNetworkManager => f.write_str(
                "NetworkManager is not running, so Smart Beat cannot make a network here.",
            ),
            Self::NoAccessPoint => {
                f.write_str("This computer has no Wi-Fi adapter that can host a network.")
            }
            Self::AccessDenied => {
                f.write_str("The system did not allow Smart Beat to make a network.")
            }
            Self::RadioOff => f.write_str("Wi-Fi is off. Turn it on and try again."),
            Self::Busy => f.write_str("The Wi-Fi adapter is busy. Try again in a moment."),
            Self::Failed(why) => write!(f, "Could not make a network ({why})."),
        }
    }
}

impl From<HotspotError> for CommandError {
    fn from(e: HotspotError) -> Self {
        CommandError::new(ErrorKind::Network, e.to_string())
    }
}

/// Told when a running network stops by itself, with the reason.
pub type StoppedNotice = Box<dyn Fn(String) + Send + Sync>;

/// One system's way of making a Wi-Fi network.
pub trait HotspotBackend: Send + Sync {
    /// Whether a network can be made here; the error says why not.
    fn support(&self) -> Result<(), HotspotError>;
    /// Starts a WPA2 network. Returns once it runs (or failed). `on_stopped` is called if it
    /// stops later without [`HotspotBackend::stop`].
    fn start(
        &self,
        ssid: &str,
        passphrase: &str,
        on_stopped: StoppedNotice,
    ) -> Result<(), HotspotError>;
    /// Stops the network (nothing happens when none runs).
    fn stop(&self) -> Result<(), HotspotError>;
}

/// The reason given on macOS (and any other system without a backend).
pub const UNSUPPORTED_REASON: &str = "This computer cannot host a network from Smart Beat. A Mac can join a network made by a Windows or Linux laptop, or use a cable.";

/// No backend: macOS and the rest.
#[cfg_attr(any(windows, target_os = "linux"), allow(dead_code))]
struct Unsupported;

impl HotspotBackend for Unsupported {
    fn support(&self) -> Result<(), HotspotError> {
        Err(HotspotError::Unsupported(UNSUPPORTED_REASON.into()))
    }
    fn start(&self, _: &str, _: &str, _: StoppedNotice) -> Result<(), HotspotError> {
        self.support()
    }
    fn stop(&self) -> Result<(), HotspotError> {
        Ok(())
    }
}

#[cfg(windows)]
fn platform_backend() -> Box<dyn HotspotBackend> {
    Box::new(wifi_direct::WifiDirectHotspot::default())
}

#[cfg(target_os = "linux")]
fn platform_backend() -> Box<dyn HotspotBackend> {
    Box::new(network_manager::NetworkManagerHotspot::default())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn platform_backend() -> Box<dyn HotspotBackend> {
    Box::new(Unsupported)
}

/// What the page asks before it offers the button. Mirrored in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSupport {
    pub can_host: bool,
    /// Why not, when `can_host` is false.
    pub reason: Option<String>,
}

/// A running network, for the other players to join. Mirrored in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedNetwork {
    pub ssid: String,
    pub passphrase: String,
    /// The text of a Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`).
    pub wifi_qr: String,
}

impl HostedNetwork {
    fn fresh() -> Self {
        let ssid = network::new_ssid();
        let passphrase = network::new_passphrase();
        let wifi_qr = network::wifi_qr(&ssid, &passphrase);
        Self {
            ssid,
            passphrase,
            wifi_qr,
        }
    }
}

/// The app's hosted network: the system's backend and the network while it runs.
pub struct HotspotState {
    backend: Box<dyn HotspotBackend>,
    running: Mutex<Option<HostedNetwork>>,
}

impl Default for HotspotState {
    fn default() -> Self {
        Self::with_backend(platform_backend())
    }
}

impl HotspotState {
    pub fn with_backend(backend: Box<dyn HotspotBackend>) -> Self {
        Self {
            backend,
            running: Mutex::new(None),
        }
    }

    fn running(&self) -> std::sync::MutexGuard<'_, Option<HostedNetwork>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn support(&self) -> NetworkSupport {
        match self.backend.support() {
            Ok(()) => NetworkSupport {
                can_host: true,
                reason: None,
            },
            Err(e) => NetworkSupport {
                can_host: false,
                reason: Some(e.to_string()),
            },
        }
    }

    /// Starts a network with a new name and password, or returns the one that already runs.
    pub fn start(&self, on_stopped: StoppedNotice) -> Result<HostedNetwork, HotspotError> {
        let mut running = self.running();
        if let Some(network) = running.as_ref() {
            return Ok(network.clone());
        }
        let network = HostedNetwork::fresh();
        self.backend
            .start(&network.ssid, &network.passphrase, on_stopped)?;
        *running = Some(network.clone());
        Ok(network)
    }

    /// Stops the network. It is forgotten even when the system reports an error, so the page
    /// can start a new one.
    pub fn stop(&self) -> Result<(), HotspotError> {
        let mut running = self.running();
        if running.take().is_none() {
            return Ok(());
        }
        self.backend.stop()
    }

    /// The network stopped by itself: forget it.
    pub fn forget(&self) {
        self.running().take();
    }

    /// Whether a network runs.
    pub fn is_running(&self) -> bool {
        self.running().is_some()
    }
}

#[derive(Serialize, Clone)]
struct StoppedPayload {
    reason: String,
}

#[tauri::command(async)]
pub fn practice_network_support(state: State<'_, HotspotState>) -> NetworkSupport {
    state.support()
}

#[tauri::command(async)]
pub fn practice_network_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HotspotState>,
) -> Result<HostedNetwork, CommandError> {
    let notice_app = app.clone();
    let on_stopped: StoppedNotice = Box::new(move |reason| {
        if let Some(state) = notice_app.try_state::<HotspotState>() {
            state.forget();
        }
        let _ = notice_app.emit(STOPPED_EVENT, StoppedPayload { reason });
    });
    Ok(state.start(on_stopped)?)
}

#[tauri::command(async)]
pub fn practice_network_stop(state: State<'_, HotspotState>) -> Result<(), CommandError> {
    Ok(state.stop()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Fake {
        fail_start: Option<HotspotError>,
        fail_stop: Option<HotspotError>,
        starts: AtomicUsize,
        stops: AtomicUsize,
        seen: Mutex<Vec<(String, String)>>,
        notice: Mutex<Option<StoppedNotice>>,
    }

    impl HotspotBackend for Arc<Fake> {
        fn support(&self) -> Result<(), HotspotError> {
            Ok(())
        }
        fn start(&self, ssid: &str, pass: &str, notice: StoppedNotice) -> Result<(), HotspotError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.seen.lock().unwrap().push((ssid.into(), pass.into()));
            *self.notice.lock().unwrap() = Some(notice);
            self.fail_start.clone().map_or(Ok(()), Err)
        }
        fn stop(&self) -> Result<(), HotspotError> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            self.fail_stop.clone().map_or(Ok(()), Err)
        }
    }

    fn state(fake: &Arc<Fake>) -> HotspotState {
        HotspotState::with_backend(Box::new(Arc::clone(fake)))
    }

    #[test]
    fn a_started_network_has_a_valid_name_password_and_qr() {
        let fake = Arc::new(Fake::default());
        let state = state(&fake);
        let network = state.start(Box::new(|_| {})).unwrap();
        assert!(network.ssid.starts_with(network::SSID_PREFIX));
        assert!(network::valid_passphrase(&network.passphrase));
        assert_eq!(
            network.wifi_qr,
            network::wifi_qr(&network.ssid, &network.passphrase)
        );
        assert_eq!(
            fake.seen.lock().unwrap()[0],
            (network.ssid.clone(), network.passphrase.clone())
        );
        assert!(state.is_running());
    }

    #[test]
    fn starting_twice_gives_the_running_network() {
        let fake = Arc::new(Fake::default());
        let state = state(&fake);
        let first = state.start(Box::new(|_| {})).unwrap();
        let second = state.start(Box::new(|_| {})).unwrap();
        assert_eq!(first, second);
        assert_eq!(fake.starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_failed_start_leaves_nothing_running() {
        let fake = Arc::new(Fake {
            fail_start: Some(HotspotError::AccessDenied),
            ..Fake::default()
        });
        let state = state(&fake);
        assert_eq!(
            state.start(Box::new(|_| {})),
            Err(HotspotError::AccessDenied)
        );
        assert!(!state.is_running());
        // Stopping then asks nothing of the system.
        state.stop().unwrap();
        assert_eq!(fake.stops.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stopping_forgets_the_network_even_when_the_system_complains() {
        let fake = Arc::new(Fake {
            fail_stop: Some(HotspotError::Failed("gone".into())),
            ..Fake::default()
        });
        let state = state(&fake);
        state.start(Box::new(|_| {})).unwrap();
        assert!(state.stop().is_err());
        assert!(!state.is_running());
        let again = state.start(Box::new(|_| {})).unwrap();
        assert_eq!(fake.starts.load(Ordering::SeqCst), 2);
        assert!(network::valid_passphrase(&again.passphrase));
    }

    #[test]
    fn a_network_that_stops_by_itself_is_reported() {
        let fake = Arc::new(Fake::default());
        let state = Arc::new(state(&fake));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let (s, h) = (Arc::clone(&state), Arc::clone(&heard));
        state
            .start(Box::new(move |reason| {
                s.forget();
                h.lock().unwrap().push(reason);
            }))
            .unwrap();
        (fake.notice.lock().unwrap().as_ref().unwrap())("Wi-Fi is off".into());
        assert_eq!(*heard.lock().unwrap(), ["Wi-Fi is off"]);
        assert!(!state.is_running());
    }

    #[test]
    fn a_system_without_a_backend_says_why() {
        let state = HotspotState::with_backend(Box::new(Unsupported));
        let support = state.support();
        assert!(!support.can_host);
        assert_eq!(support.reason.as_deref(), Some(UNSUPPORTED_REASON));
        assert!(state.start(Box::new(|_| {})).is_err());
    }

    #[test]
    fn errors_read_as_sentences() {
        let e: CommandError = HotspotError::NoAccessPoint.into();
        assert_eq!(e.kind, ErrorKind::Network);
        assert!(e.message.ends_with('.'));
        assert!(HotspotError::Failed("x".into()).to_string().contains("(x)"));
    }
}
