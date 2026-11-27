//! Practice together (#258): which of this computer's IPv4 addresses go into room codes.
//!
//! The host listens on every network the computer is on, so a guest on the Wi-Fi, on a cable or
//! on a link-local (169.254.x.x) link between two laptops can all reach it. A room code still
//! holds one address, so the host shows one code per address: the best one first (the address a
//! route to the internet would use), the others under "Other networks".

use std::net::{Ipv4Addr, UdpSocket};

use serde::Serialize;

/// Where the default-route trick "connects" to: a documentation address (RFC 5737). Connecting a
/// UDP socket sends nothing; it only makes the system pick the outgoing interface.
const ROUTE_PROBE: &str = "192.0.2.1:9";

/// Interface names (lower case) of adapters that are not a network to another player: containers,
/// virtual machines, VPNs, Apple's peer-to-peer links. They are listed last, not dropped.
const VIRTUAL_PREFIXES: &[&str] = &[
    "docker",
    "br-",
    "veth",
    "virbr",
    "vmnet",
    "vboxnet",
    "utun",
    "tun",
    "tap",
    "wg",
    "zt",
    "bridge",
    "awdl",
    "llw",
    "anpi",
    "gif",
    "stf",
    "ipsec",
    "ppp",
    "tailscale",
];
/// The same for the longer adapter names Windows uses ("vEthernet (WSL)").
const VIRTUAL_PARTS: &[&str] = &[
    "vethernet",
    "virtualbox",
    "vmware",
    "hyper-v",
    "loopback",
    "bluetooth",
    "tailscale",
    "zerotier",
    "vpn",
    "wsl",
];
/// Windows names its Wi-Fi Direct (Mobile hotspot) adapter "Local Area Connection* 12": that is
/// a Wi-Fi network, not a cable, though the start of the name says otherwise.
const WINDOWS_HOTSPOT_PART: &str = "local area connection*";
const WIFI_PREFIXES: &[&str] = &["wlan", "wlp", "wlx", "wl0", "ath", "ra0"];
const WIFI_PARTS: &[&str] = &["wi-fi", "wifi", "wireless", "wlan", "airport"];
const CABLE_PREFIXES: &[&str] = &["eth", "enp", "eno", "ens", "enx"];
const CABLE_PARTS: &[&str] = &["ethernet", "local area connection"];

/// One IPv4 address of one network interface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The interface's name as the system gives it (`en0`, `wlan0`, `Wi-Fi`).
    pub name: String,
    pub ip: Ipv4Addr,
    /// A point-to-point link (a VPN tunnel, as a rule).
    pub point_to_point: bool,
}

impl Candidate {
    pub fn new(name: &str, ip: Ipv4Addr) -> Self {
        Self {
            name: name.to_owned(),
            ip,
            point_to_point: false,
        }
    }
}

/// What kind of network an address is on, as far as the name and the range tell (best effort).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkKind {
    Wifi,
    Cable,
    LinkLocal,
    Other,
}

/// The address a route to the internet would use, if there is one. Nothing is sent.
pub fn default_route_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(ROUTE_PROBE).ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// Every IPv4 address of an interface that is not switched off, unranked.
pub fn candidate_ipv4s() -> Vec<Candidate> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    interfaces
        .into_iter()
        .filter(|i| {
            !matches!(
                i.oper_status,
                if_addrs::IfOperStatus::Down
                    | if_addrs::IfOperStatus::NotPresent
                    | if_addrs::IfOperStatus::LowerLayerDown
            )
        })
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) => Some(Candidate {
                point_to_point: i.is_p2p,
                name: i.name,
                ip,
            }),
            std::net::IpAddr::V6(_) => None,
        })
        .collect()
}

/// This computer's addresses, best first. Never empty: loopback when there is no network.
pub fn host_candidates() -> Vec<Candidate> {
    rank_candidates(&candidate_ipv4s(), default_route_ipv4())
}

/// Orders the addresses for room codes: the default-route address, then private ranges, then
/// link-local (169.254/16), then anything else; adapters that are not a real network (containers,
/// VPNs, virtual machines) after all of those. Loopback, unspecified, multicast and broadcast
/// addresses are dropped, and each address is kept once. Loopback comes back only when nothing
/// else is left, so a host on a computer without a network can still practise with itself.
pub fn rank_candidates(
    candidates: &[Candidate],
    default_route: Option<Ipv4Addr>,
) -> Vec<Candidate> {
    let mut usable: Vec<(u8, usize, &Candidate)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| usable_address(c.ip))
        .map(|(order, c)| (rank_of(c, default_route), order, c))
        .collect();
    usable.sort_by_key(|&(rank, order, _)| (rank, order));
    let mut ranked: Vec<Candidate> = Vec::with_capacity(usable.len());
    for (_, _, c) in usable {
        if !ranked.iter().any(|r| r.ip == c.ip) {
            ranked.push(c.clone());
        }
    }
    if ranked.is_empty() {
        ranked.push(Candidate::new("loopback", Ipv4Addr::LOCALHOST));
    }
    ranked
}

fn usable_address(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast())
}

/// Lower is better.
fn rank_of(c: &Candidate, default_route: Option<Ipv4Addr>) -> u8 {
    const VIRTUAL_PENALTY: u8 = 10;
    let base = if Some(c.ip) == default_route {
        0
    } else if c.ip.is_private() {
        1
    } else if c.ip.is_link_local() {
        2
    } else {
        3
    };
    if is_virtual(c) {
        base + VIRTUAL_PENALTY
    } else {
        base
    }
}

/// An adapter for containers, virtual machines or a VPN rather than a network to another player.
pub fn is_virtual(c: &Candidate) -> bool {
    let name = c.name.to_lowercase();
    c.point_to_point
        || VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p))
        || VIRTUAL_PARTS.iter().any(|p| name.contains(p))
}

/// The kind of network, from the address range and the interface name.
pub fn network_kind(name: &str, ip: Ipv4Addr) -> NetworkKind {
    let name = name.to_lowercase();
    if ip.is_link_local() {
        NetworkKind::LinkLocal
    } else if name.contains(WINDOWS_HOTSPOT_PART)
        || WIFI_PREFIXES.iter().any(|p| name.starts_with(p))
        || WIFI_PARTS.iter().any(|p| name.contains(p))
    {
        NetworkKind::Wifi
    } else if CABLE_PREFIXES.iter().any(|p| name.starts_with(p))
        || CABLE_PARTS.iter().any(|p| name.contains(p))
    {
        NetworkKind::Cable
    } else {
        NetworkKind::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(a: u8, b: u8, c: u8, d: u8) -> Ipv4Addr {
        Ipv4Addr::new(a, b, c, d)
    }

    fn names(ranked: &[Candidate]) -> Vec<&str> {
        ranked.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn the_default_route_address_comes_first() {
        let candidates = [
            Candidate::new("en1", ip(10, 0, 0, 5)),
            Candidate::new("en0", ip(192, 168, 1, 23)),
        ];
        let ranked = rank_candidates(&candidates, Some(ip(192, 168, 1, 23)));
        assert_eq!(names(&ranked), ["en0", "en1"]);
    }

    #[test]
    fn private_ranges_come_before_link_local_and_link_local_is_kept() {
        let candidates = [
            Candidate::new("en5", ip(169, 254, 12, 7)),
            Candidate::new("en9", ip(8, 8, 4, 4)),
            Candidate::new("en0", ip(172, 20, 1, 2)),
        ];
        let ranked = rank_candidates(&candidates, None);
        assert_eq!(names(&ranked), ["en0", "en5", "en9"]);
    }

    #[test]
    fn a_cable_alone_gives_its_link_local_address() {
        let ranked = rank_candidates(
            &[
                Candidate::new("lo0", Ipv4Addr::LOCALHOST),
                Candidate::new("bridge0", ip(169, 254, 3, 4)),
            ],
            None,
        );
        assert_eq!(ranked, [Candidate::new("bridge0", ip(169, 254, 3, 4))]);
    }

    #[test]
    fn loopback_and_unspecified_are_dropped_and_loopback_is_the_last_resort() {
        let ranked = rank_candidates(
            &[
                Candidate::new("lo0", Ipv4Addr::LOCALHOST),
                Candidate::new("x", Ipv4Addr::UNSPECIFIED),
                Candidate::new("en0", ip(192, 168, 0, 9)),
            ],
            None,
        );
        assert_eq!(names(&ranked), ["en0"]);

        let alone = rank_candidates(&[Candidate::new("lo0", Ipv4Addr::LOCALHOST)], None);
        assert_eq!(alone.len(), 1);
        assert_eq!(alone[0].ip, Ipv4Addr::LOCALHOST);
        assert_eq!(rank_candidates(&[], None)[0].ip, Ipv4Addr::LOCALHOST);
    }

    #[test]
    fn virtual_adapters_are_listed_last() {
        let tunnel = Candidate {
            point_to_point: true,
            ..Candidate::new("ppp-like", ip(10, 8, 0, 2))
        };
        let candidates = [
            Candidate::new("docker0", ip(172, 17, 0, 1)),
            Candidate::new("vEthernet (WSL)", ip(172, 25, 0, 1)),
            Candidate::new("utun3", ip(100, 64, 0, 7)),
            tunnel,
            Candidate::new("vboxnet0", ip(192, 168, 56, 1)),
            Candidate::new("Wi-Fi", ip(192, 168, 1, 40)),
            Candidate::new("Ethernet 2", ip(169, 254, 9, 9)),
        ];
        let ranked = rank_candidates(&candidates, Some(ip(100, 64, 0, 7)));
        assert_eq!(&names(&ranked)[..2], ["Wi-Fi", "Ethernet 2"]);
        assert_eq!(ranked.len(), candidates.len());
        // Even when the default route goes through a VPN, the VPN is not the first code.
        assert_ne!(ranked[0].name, "utun3");
    }

    #[test]
    fn an_address_is_offered_once() {
        let ranked = rank_candidates(
            &[
                Candidate::new("en0", ip(192, 168, 1, 2)),
                Candidate::new("en0-alias", ip(192, 168, 1, 2)),
            ],
            None,
        );
        assert_eq!(names(&ranked), ["en0"]);
    }

    #[test]
    fn the_kind_comes_from_the_range_and_the_name() {
        assert_eq!(
            network_kind("en5", ip(169, 254, 1, 1)),
            NetworkKind::LinkLocal
        );
        assert_eq!(network_kind("wlan0", ip(10, 0, 0, 2)), NetworkKind::Wifi);
        assert_eq!(network_kind("wlp2s0", ip(10, 0, 0, 2)), NetworkKind::Wifi);
        assert_eq!(network_kind("Wi-Fi", ip(10, 0, 0, 2)), NetworkKind::Wifi);
        assert_eq!(
            network_kind("Local Area Connection* 12", ip(192, 168, 137, 1)),
            NetworkKind::Wifi
        );
        assert_eq!(network_kind("eth0", ip(10, 0, 0, 2)), NetworkKind::Cable);
        assert_eq!(network_kind("enp3s0", ip(10, 0, 0, 2)), NetworkKind::Cable);
        assert_eq!(
            network_kind("Ethernet", ip(10, 0, 0, 2)),
            NetworkKind::Cable
        );
        assert_eq!(network_kind("en0", ip(10, 0, 0, 2)), NetworkKind::Other);
    }

    #[test]
    fn this_computer_always_has_an_address_for_a_code() {
        let ranked = host_candidates();
        assert!(!ranked.is_empty());
        assert!(ranked.iter().all(|c| !c.ip.is_unspecified()));
        let loopbacks = ranked.iter().filter(|c| c.ip.is_loopback()).count();
        assert!(loopbacks == 0 || ranked.len() == 1, "{ranked:?}");
    }
}
