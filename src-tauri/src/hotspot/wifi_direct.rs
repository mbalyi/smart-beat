//! Windows: "Host a network" (#258) as a Wi-Fi Direct legacy access point. Laptops and phones
//! without Wi-Fi Direct see it as an ordinary WPA2 network. The publisher lives in the app's state
//! for as long as the network runs: dropping it ends the network.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::Devices::Radios::{Radio, RadioKind, RadioState};
use windows::Devices::WiFiDirect::{
    WiFiDirectAdvertisementPublisher, WiFiDirectAdvertisementPublisherStatus,
    WiFiDirectAdvertisementPublisherStatusChangedEventArgs, WiFiDirectError,
};
use windows::Foundation::TypedEventHandler;
use windows::Security::Credentials::PasswordCredential;
use windows::core::HSTRING;

use super::{HotspotBackend, HotspotError, StoppedNotice};

/// How long the system has to say the network runs (or why not).
const START_TIMEOUT: Duration = Duration::from_secs(10);

/// A running publisher and its status handler.
struct Running {
    publisher: WiFiDirectAdvertisementPublisher,
    token: i64,
}

#[derive(Default)]
pub struct WifiDirectHotspot {
    running: Mutex<Option<Running>>,
}

fn failed(e: windows::core::Error) -> HotspotError {
    HotspotError::Failed(e.message())
}

/// Why the publisher aborted, in the user's words.
fn abort_error(error: WiFiDirectError) -> HotspotError {
    if error == WiFiDirectError::RadioNotAvailable {
        HotspotError::RadioOff
    } else if error == WiFiDirectError::ResourceInUse {
        HotspotError::Busy
    } else {
        HotspotError::Failed(format!("Wi-Fi Direct error {}", error.0))
    }
}

/// Whether the computer has a Wi-Fi radio, and whether it is on.
fn wifi_radio() -> Result<(), HotspotError> {
    let radios = Radio::GetRadiosAsync()
        .and_then(|op| op.join())
        .map_err(failed)?;
    let count = radios.Size().map_err(failed)?;
    let mut found = false;
    for i in 0..count {
        let radio = radios.GetAt(i).map_err(failed)?;
        if radio.Kind().map_err(failed)? != RadioKind::WiFi {
            continue;
        }
        if radio.State().map_err(failed)? == RadioState::On {
            return Ok(());
        }
        found = true;
    }
    Err(if found {
        HotspotError::RadioOff
    } else {
        HotspotError::NoAccessPoint
    })
}

/// The publisher's status changes: the first decisive one goes to `start` (over `first`); once
/// the network runs, an abort or stop goes to `notice`.
fn status_handler(
    first: Sender<Result<(), HotspotError>>,
    started: Arc<AtomicBool>,
    notice: StoppedNotice,
) -> TypedEventHandler<
    WiFiDirectAdvertisementPublisher,
    WiFiDirectAdvertisementPublisherStatusChangedEventArgs,
> {
    let first = Mutex::new(first);
    TypedEventHandler::<
        WiFiDirectAdvertisementPublisher,
        WiFiDirectAdvertisementPublisherStatusChangedEventArgs,
    >::new(move |_, args| {
        let args = args.ok()?;
        let status = args.Status()?;
        let outcome = if status == WiFiDirectAdvertisementPublisherStatus::Started {
            Ok(())
        } else if status == WiFiDirectAdvertisementPublisherStatus::Aborted {
            Err(abort_error(args.Error()?))
        } else if status == WiFiDirectAdvertisementPublisherStatus::Stopped {
            Err(HotspotError::Failed("the network stopped".into()))
        } else {
            return Ok(());
        };
        if started.load(Ordering::SeqCst) {
            if let Err(e) = outcome {
                notice(e.to_string());
            }
        } else if let Ok(first) = first.lock() {
            let _ = first.send(outcome);
        }
        Ok(())
    })
}

fn publisher(
    ssid: &str,
    passphrase: &str,
) -> windows::core::Result<WiFiDirectAdvertisementPublisher> {
    let publisher = WiFiDirectAdvertisementPublisher::new()?;
    let advertisement = publisher.Advertisement()?;
    advertisement.SetIsAutonomousGroupOwnerEnabled(true)?;
    let legacy = advertisement.LegacySettings()?;
    legacy.SetIsEnabled(true)?;
    legacy.SetSsid(&HSTRING::from(ssid))?;
    let credential = PasswordCredential::new()?;
    credential.SetPassword(&HSTRING::from(passphrase))?;
    legacy.SetPassphrase(&credential)?;
    Ok(publisher)
}

impl HotspotBackend for WifiDirectHotspot {
    fn support(&self) -> Result<(), HotspotError> {
        wifi_radio()
    }

    fn start(
        &self,
        ssid: &str,
        passphrase: &str,
        on_stopped: StoppedNotice,
    ) -> Result<(), HotspotError> {
        self.stop()?;
        wifi_radio()?;
        let publisher = publisher(ssid, passphrase).map_err(failed)?;
        let (tx, rx) = channel();
        let started = Arc::new(AtomicBool::new(false));
        let token = publisher
            .StatusChanged(&status_handler(tx, Arc::clone(&started), on_stopped))
            .map_err(failed)?;
        let give_up = |e: HotspotError| {
            let _ = publisher.RemoveStatusChanged(token);
            let _ = publisher.Stop();
            e
        };
        publisher.Start().map_err(|e| give_up(failed(e)))?;
        match rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(give_up(e)),
            Err(_) => {
                return Err(give_up(HotspotError::Failed(
                    "Windows did not start the network in time".into(),
                )));
            }
        }
        started.store(true, Ordering::SeqCst);
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        *running = Some(Running { publisher, token });
        Ok(())
    }

    fn stop(&self) -> Result<(), HotspotError> {
        let running = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let Some(Running { publisher, token }) = running else {
            return Ok(());
        };
        // The handler goes first, so stopping on purpose is not reported as a failure.
        let _ = publisher.RemoveStatusChanged(token);
        publisher.Stop().map_err(failed)
    }
}
