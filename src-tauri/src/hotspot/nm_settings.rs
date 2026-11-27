//! The NetworkManager connection settings of a hosted Wi-Fi network (#258), as plain data so
//! they can be tested on every system. `network_manager.rs` turns them into D-Bus values
//! (`a{sa{sv}}`).

use std::collections::BTreeMap;

/// The connection's name in NetworkManager's list.
pub const CONNECTION_ID: &str = "Smart Beat practice network";

/// One setting's value, in the D-Bus types NetworkManager expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingValue {
    /// `s`
    Str(String),
    /// `ay` (the SSID is bytes, not text)
    Bytes(Vec<u8>),
    /// `b`
    Bool(bool),
    /// `as`
    StrList(Vec<String>),
}

/// Setting groups (`connection`, `802-11-wireless`, …) to their keys.
pub type Settings = BTreeMap<&'static str, BTreeMap<&'static str, SettingValue>>;

fn text(value: &str) -> SettingValue {
    SettingValue::Str(value.to_owned())
}

fn list(values: &[&str]) -> SettingValue {
    SettingValue::StrList(values.iter().map(|v| (*v).to_owned()).collect())
}

/// A WPA2 access point on the Wi-Fi adapter that shares this computer's connection (if any) and
/// hands out addresses itself (`ipv4.method` `shared`), the same as `nmcli device wifi hotspot`.
/// It is not started again by itself later (`autoconnect` false), and it stays on 2.4 GHz with
/// AES only, which every laptop can join.
pub fn hotspot_settings(uuid: &str, ssid: &str, passphrase: &str) -> Settings {
    let connection = BTreeMap::from([
        ("id", text(CONNECTION_ID)),
        ("uuid", text(uuid)),
        ("type", text("802-11-wireless")),
        ("autoconnect", SettingValue::Bool(false)),
    ]);
    let wireless = BTreeMap::from([
        ("ssid", SettingValue::Bytes(ssid.as_bytes().to_vec())),
        ("mode", text("ap")),
        ("band", text("bg")),
    ]);
    let security = BTreeMap::from([
        ("key-mgmt", text("wpa-psk")),
        ("psk", text(passphrase)),
        ("proto", list(&["rsn"])),
        ("pairwise", list(&["ccmp"])),
        ("group", list(&["ccmp"])),
    ]);
    let ipv4 = BTreeMap::from([("method", text("shared"))]);
    let ipv6 = BTreeMap::from([("method", text("ignore"))]);
    BTreeMap::from([
        ("connection", connection),
        ("802-11-wireless", wireless),
        ("802-11-wireless-security", security),
        ("ipv4", ipv4),
        ("ipv6", ipv6),
    ])
}

/// D-Bus error names that mean NetworkManager is not there to ask.
const NO_SERVICE_ERRORS: &[&str] = &[
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.NameHasNoOwner",
    "org.freedesktop.DBus.Error.NoServer",
    "org.freedesktop.DBus.Error.Spawn.ServiceNotFound",
];
/// D-Bus error names that mean the system (polkit) said no.
const DENIED_ERRORS: &[&str] = &[
    "org.freedesktop.NetworkManager.PermissionDenied",
    "org.freedesktop.DBus.Error.AccessDenied",
    "org.freedesktop.DBus.Error.AuthFailed",
    "org.freedesktop.PolicyKit1.Error.NotAuthorized",
];

/// What a failed D-Bus call to NetworkManager means for the user, from the error's name (empty
/// when there is none) and its text.
pub fn classify_dbus_error(name: &str, message: &str) -> super::HotspotError {
    use super::HotspotError;
    if NO_SERVICE_ERRORS.contains(&name) {
        HotspotError::NoNetworkManager
    } else if DENIED_ERRORS.contains(&name) {
        HotspotError::AccessDenied
    } else if name.ends_with(".UnknownDevice") || name.ends_with(".NotSupported") {
        HotspotError::NoAccessPoint
    } else {
        HotspotError::Failed(message.to_owned())
    }
}

/// A random version 4 UUID (`8-4-4-4-12` hex digits) for the new connection.
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("system random numbers");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(settings: &'a Settings, group: &str, key: &str) -> &'a SettingValue {
        settings
            .get(group)
            .and_then(|g| g.get(key))
            .unwrap_or_else(|| panic!("{group}.{key} is missing"))
    }

    #[test]
    fn the_hotspot_is_a_shared_wpa2_access_point() {
        let s = hotspot_settings("uuid-1", "SmartBeat-K7QD", "abcd2345efgh");
        assert_eq!(get(&s, "connection", "type"), &text("802-11-wireless"));
        assert_eq!(get(&s, "connection", "uuid"), &text("uuid-1"));
        assert_eq!(
            get(&s, "connection", "autoconnect"),
            &SettingValue::Bool(false)
        );
        assert_eq!(
            get(&s, "802-11-wireless", "ssid"),
            &SettingValue::Bytes(b"SmartBeat-K7QD".to_vec())
        );
        assert_eq!(get(&s, "802-11-wireless", "mode"), &text("ap"));
        assert_eq!(
            get(&s, "802-11-wireless-security", "key-mgmt"),
            &text("wpa-psk")
        );
        assert_eq!(
            get(&s, "802-11-wireless-security", "psk"),
            &text("abcd2345efgh")
        );
        assert_eq!(get(&s, "ipv4", "method"), &text("shared"));
        assert_eq!(
            s.keys().copied().collect::<Vec<_>>(),
            [
                "802-11-wireless",
                "802-11-wireless-security",
                "connection",
                "ipv4",
                "ipv6"
            ]
        );
    }

    #[test]
    fn dbus_errors_become_typed_errors() {
        use crate::hotspot::HotspotError;
        assert_eq!(
            classify_dbus_error("org.freedesktop.DBus.Error.ServiceUnknown", "x"),
            HotspotError::NoNetworkManager
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.NetworkManager.PermissionDenied", "x"),
            HotspotError::AccessDenied
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "x"),
            HotspotError::AccessDenied
        );
        assert_eq!(
            classify_dbus_error("org.freedesktop.NetworkManager.Device.NotSupported", "x"),
            HotspotError::NoAccessPoint
        );
        assert_eq!(
            classify_dbus_error("", "the bus went away"),
            HotspotError::Failed("the bus went away".into())
        );
    }

    #[test]
    fn uuids_are_random_version_4() {
        let a = random_uuid();
        assert_eq!(a.len(), 36);
        assert_eq!(a.matches('-').count(), 4);
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "{a}");
        assert_ne!(a, random_uuid());
    }
}
