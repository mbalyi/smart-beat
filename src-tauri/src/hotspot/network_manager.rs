//! Linux: "Host a network" (#258) through NetworkManager on the system D-Bus, the same as
//! `nmcli device wifi hotspot`: a WPA2 access point on a Wi-Fi adapter that can be one, with
//! addresses handed out by NetworkManager (`ipv4.method` `shared`). Stopping takes the connection
//! down and deletes it, so nothing is left in the user's network list.

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use zbus::blocking::{Connection, Proxy, proxy::Builder};
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, Value};

use super::nm_settings::{
    SettingValue, Settings, classify_dbus_error, hotspot_settings, random_uuid,
};
use super::{HotspotBackend, HotspotError, StoppedNotice};

const SERVICE: &str = "org.freedesktop.NetworkManager";
const ROOT_PATH: &str = "/org/freedesktop/NetworkManager";
const ROOT_IFACE: &str = "org.freedesktop.NetworkManager";
const DEVICE_IFACE: &str = "org.freedesktop.NetworkManager.Device";
const WIRELESS_IFACE: &str = "org.freedesktop.NetworkManager.Device.Wireless";
const ACTIVE_IFACE: &str = "org.freedesktop.NetworkManager.Connection.Active";
const SETTINGS_CONNECTION_IFACE: &str = "org.freedesktop.NetworkManager.Settings.Connection";
/// `NM_DEVICE_TYPE_WIFI`.
const DEVICE_TYPE_WIFI: u32 = 2;
/// `NM_WIFI_DEVICE_CAP_AP`: the adapter can be an access point.
const WIFI_CAP_AP: u32 = 0x40;
/// `NM_ACTIVE_CONNECTION_STATE_ACTIVATED` and `…_DEACTIVATED`.
const ACTIVE_ACTIVATED: u32 = 2;
const ACTIVE_DEACTIVATED: u32 = 4;
/// How long NetworkManager has to bring the network up, and how often it is asked.
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(20);
const ACTIVATE_POLL: Duration = Duration::from_millis(250);

/// The connection NetworkManager made, and its activation.
struct Running {
    connection: OwnedObjectPath,
    active: OwnedObjectPath,
}

#[derive(Default)]
pub struct NetworkManagerHotspot {
    running: Mutex<Option<Running>>,
}

fn classify(e: zbus::Error) -> HotspotError {
    let name = match &e {
        zbus::Error::MethodError(name, _, _) => name.as_str().to_owned(),
        zbus::Error::FDO(fdo) => zbus::DBusError::name(fdo.as_ref()).as_str().to_owned(),
        _ => String::new(),
    };
    classify_dbus_error(&name, &e.to_string())
}

fn system_bus() -> Result<Connection, HotspotError> {
    Connection::system().map_err(|_| HotspotError::NoNetworkManager)
}

/// A proxy that always asks (no property cache: the state changes while we wait for it).
fn proxy<'a>(
    conn: &Connection,
    path: &'a str,
    interface: &'a str,
) -> Result<Proxy<'a>, HotspotError> {
    Builder::<Proxy<'a>>::new(conn)
        .destination(SERVICE)
        .and_then(|b| b.path(path))
        .and_then(|b| b.interface(interface))
        .map(|b| b.cache_properties(CacheProperties::No))
        .and_then(|b| b.build())
        .map_err(classify)
}

fn to_value(value: &SettingValue) -> Value<'static> {
    match value {
        SettingValue::Str(text) => Value::from(text.clone()),
        SettingValue::Bytes(bytes) => Value::from(bytes.clone()),
        SettingValue::Bool(on) => Value::from(*on),
        SettingValue::StrList(list) => Value::from(list.clone()),
    }
}

/// The settings as D-Bus wants them (`a{sa{sv}}`).
fn to_dbus(settings: &Settings) -> HashMap<&'static str, HashMap<&'static str, Value<'static>>> {
    settings
        .iter()
        .map(|(group, keys)| {
            let keys = keys.iter().map(|(k, v)| (*k, to_value(v))).collect();
            (*group, keys)
        })
        .collect()
}

/// The first Wi-Fi adapter that can be an access point.
fn access_point_device(conn: &Connection) -> Result<OwnedObjectPath, HotspotError> {
    let root = proxy(conn, ROOT_PATH, ROOT_IFACE)?;
    let enabled: bool = root.get_property("WirelessEnabled").map_err(classify)?;
    let devices: Vec<OwnedObjectPath> = root.call("GetDevices", &()).map_err(classify)?;
    let mut has_wifi = false;
    for path in devices {
        let device = proxy(conn, path.as_str(), DEVICE_IFACE)?;
        let kind: u32 = device.get_property("DeviceType").map_err(classify)?;
        if kind != DEVICE_TYPE_WIFI {
            continue;
        }
        has_wifi = true;
        let wireless = proxy(conn, path.as_str(), WIRELESS_IFACE)?;
        let caps: u32 = wireless
            .get_property("WirelessCapabilities")
            .map_err(classify)?;
        if caps & WIFI_CAP_AP != 0 {
            return if enabled {
                Ok(path.clone())
            } else {
                Err(HotspotError::RadioOff)
            };
        }
    }
    Err(if has_wifi && !enabled {
        HotspotError::RadioOff
    } else {
        HotspotError::NoAccessPoint
    })
}

/// Waits until NetworkManager says the network is up, or that it gave up.
fn wait_activated(conn: &Connection, active: &OwnedObjectPath) -> Result<(), HotspotError> {
    let proxy = proxy(conn, active.as_str(), ACTIVE_IFACE)?;
    let deadline = Instant::now() + ACTIVATE_TIMEOUT;
    loop {
        let state: u32 = proxy.get_property("State").map_err(classify)?;
        match state {
            ACTIVE_ACTIVATED => return Ok(()),
            ACTIVE_DEACTIVATED => {
                return Err(HotspotError::Failed(
                    "NetworkManager could not start the network".into(),
                ));
            }
            _ if Instant::now() >= deadline => {
                return Err(HotspotError::Failed(
                    "NetworkManager did not start the network in time".into(),
                ));
            }
            _ => thread::sleep(ACTIVATE_POLL),
        }
    }
}

/// Takes the network down and deletes its connection. Both are tried; the first error is kept.
fn tear_down(conn: &Connection, running: &Running) -> Result<(), HotspotError> {
    let root = proxy(conn, ROOT_PATH, ROOT_IFACE)?;
    let active = ObjectPath::from(&running.active);
    let down: Result<(), HotspotError> = root
        .call("DeactivateConnection", &(active,))
        .map_err(classify);
    let delete: Result<(), HotspotError> =
        proxy(conn, running.connection.as_str(), SETTINGS_CONNECTION_IFACE)
            .and_then(|c| c.call("Delete", &()).map_err(classify));
    // A connection that is already down cannot be deactivated; deleting it is what matters.
    delete.or(down)
}

impl HotspotBackend for NetworkManagerHotspot {
    fn support(&self) -> Result<(), HotspotError> {
        access_point_device(&system_bus()?).map(|_| ())
    }

    fn start(&self, ssid: &str, passphrase: &str, _: StoppedNotice) -> Result<(), HotspotError> {
        self.stop()?;
        let conn = system_bus()?;
        let device = access_point_device(&conn)?;
        let settings = to_dbus(&hotspot_settings(&random_uuid(), ssid, passphrase));
        let root = proxy(&conn, ROOT_PATH, ROOT_IFACE)?;
        let any = ObjectPath::try_from("/").map_err(|e| HotspotError::Failed(e.to_string()))?;
        let (connection, active): (OwnedObjectPath, OwnedObjectPath) = root
            .call(
                "AddAndActivateConnection",
                &(settings, ObjectPath::from(&device), any),
            )
            .map_err(classify)?;
        let running = Running { connection, active };
        if let Err(e) = wait_activated(&conn, &running.active) {
            let _ = tear_down(&conn, &running);
            return Err(e);
        }
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
        Ok(())
    }

    fn stop(&self) -> Result<(), HotspotError> {
        let running = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        match running {
            Some(running) => tear_down(&system_bus()?, &running),
            None => Ok(()),
        }
    }
}
