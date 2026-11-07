import type { DesktopOs } from "@/lib/practice-together/desktop-os";

/** One way to get two computers onto the same network, as short numbered steps. */
export interface ConnectionOption {
  id: string;
  title: string;
  /** What the host (or whoever makes the network) does. */
  steps: string[];
  /** What the other player does, when it differs from "join the same network". */
  other?: string[];
}

export interface DirectConnectionGuide {
  os: DesktopOs;
  /** The system's name as people say it. */
  system: string;
  intro: string;
  options: ConnectionOption[];
}

const CABLE: ConnectionOption = {
  id: "cable",
  title: "Easiest and steadiest: a cable",
  steps: [
    "Plug both computers into the same router or switch with network cables. A USB-C or Thunderbolt Ethernet adapter does the same for a computer without a network port.",
    "Wait until each computer shows that it is connected.",
  ],
};

const PHONE: ConnectionOption = {
  id: "phone",
  title: "No router: one phone's hotspot",
  steps: [
    "One of you turns on Personal Hotspot (or Mobile Hotspot) on a phone and tells the other the network name and password.",
    "Both computers join that Wi-Fi network from their Wi-Fi menu. The phone's mobile data is not used for the session.",
  ],
};

const GUIDES: Record<DesktopOs, DirectConnectionGuide> = {
  macos: {
    os: "macos",
    system: "macOS",
    intro:
      "Smart Beat cannot switch a Mac's Wi-Fi sharing on for you, but these ways work without a router.",
    options: [
      CABLE,
      PHONE,
      {
        id: "internet-sharing",
        title: "Make a network on the host Mac (Internet Sharing)",
        steps: [
          "Open System Settings (or System Preferences on an older macOS) › General › Sharing.",
          "Turn on Internet Sharing: share the connection you have (for example Ethernet) to computers using Wi-Fi.",
          "Open the Wi-Fi options, give the network a name and a password, and turn it on. macOS asks for your administrator password.",
        ],
        other: [
          "Open the Wi-Fi menu in the menu bar and join the network the host made, with its password.",
        ],
      },
    ],
  },
  windows: {
    os: "windows",
    system: "Windows",
    intro: "Windows can make a network for the other player (a Mobile hotspot).",
    options: [
      {
        id: "mobile-hotspot",
        title: "Make a network on the host PC (Mobile hotspot)",
        steps: [
          "Open Settings › Network & internet › Mobile hotspot.",
          "Choose the connection to share (Ethernet or Wi-Fi) and turn Mobile hotspot on.",
          "Read out the network name and password shown there.",
        ],
        other: ["Open the Wi-Fi list, join the network the host made and type its password."],
      },
      CABLE,
      PHONE,
    ],
  },
  linux: {
    os: "linux",
    system: "Linux",
    intro: "Most Linux desktops can make a network for the other player.",
    options: [
      {
        id: "wifi-hotspot",
        title: "Make a network on the host computer (Wi-Fi hotspot)",
        steps: [
          "Open Settings › Wi-Fi, open the menu and choose Turn On Wi-Fi Hotspot (GNOME; other desktops have a similar entry).",
          "Read out the network name and password shown there.",
          "Or in a terminal: nmcli device wifi hotspot ssid <name> password <password>",
        ],
        other: ["Open the Wi-Fi list, join the network the host made and type its password."],
      },
      CABLE,
      PHONE,
    ],
  },
  unknown: {
    os: "unknown",
    system: "your computer",
    intro:
      "Put both computers on the same network. Smart Beat does not recognise this system, so here are the two ways that work everywhere.",
    options: [CABLE, PHONE],
  },
};

/** The steps for one system, and only that system. */
export function directConnectionGuide(os: DesktopOs): DirectConnectionGuide {
  return GUIDES[os];
}

/** What to expect and how to check, the same for every system. */
export const DIRECT_CONNECTION_EXPECT: readonly string[] = [
  "A computer that makes the network usually loses its normal Wi-Fi internet while it does (it has one Wi-Fi radio). That is fine for Same network, but Over the internet will not work in the meantime.",
  "Sync accuracy is typically ±1–5 ms on Wi-Fi. A cable is the steadiest.",
];

export const DIRECT_CONNECTION_CHECK =
  "Check the connection: once both computers are on the same network, come back here. The host presses Start a session again, and the other player types the new room code.";
