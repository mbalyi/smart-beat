import { act, screen, within } from "@testing-library/react";

import { NO_SHARED_EDITING } from "@/hooks/use-shared-editing";
import { NO_SOURCE_SHARING } from "@/hooks/use-source-sync";
import { DirectConnectionHelp } from "@/components/practice-together/direct-connection-help";
import { PracticeTogetherDialog } from "@/components/practice-together/practice-together-dialog";
import { qrPath } from "@/lib/practice-together/wifi-qr";
import type { PracticeTogether } from "@/hooks/use-practice-together";
import {
  onPracticeNetworkStopped,
  practiceNetworkStart,
  practiceNetworkStop,
  practiceNetworkSupport,
} from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

vi.mock(import("@/lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  practiceNetworkSupport: vi.fn(),
  practiceNetworkStart: vi.fn(),
  practiceNetworkStop: vi.fn(),
  onPracticeNetworkStopped: vi.fn(),
}));

const NETWORK = {
  ssid: "SmartBeat-K7QD",
  passphrase: "abcd2345efgh",
  wifiQr: "WIFI:T:WPA;S:SmartBeat-K7QD;P:abcd2345efgh;;",
};
const NO_HOSTING = { canHost: false, reason: "This computer cannot host a network." };
/** The last handler the card gave `onPracticeNetworkStopped`. */
let stoppedBySystem: (reason: string) => void = () => {};
const unlistenStopped = vi.fn();

beforeEach(() => {
  vi.mocked(practiceNetworkSupport).mockReset().mockResolvedValue(NO_HOSTING);
  vi.mocked(practiceNetworkStart).mockReset().mockResolvedValue(NETWORK);
  vi.mocked(practiceNetworkStop).mockReset().mockResolvedValue(undefined);
  unlistenStopped.mockReset();
  vi.mocked(onPracticeNetworkStopped)
    .mockReset()
    .mockImplementation(async (handler) => {
      stoppedBySystem = handler;
      return unlistenStopped;
    });
});

/** Renders the help on a system that can host a network, once the card has asked. */
async function hostable(os: "windows" | "linux" = "windows") {
  vi.mocked(practiceNetworkSupport).mockResolvedValue({ canHost: true, reason: null });
  const utils = renderWithProviders(<DirectConnectionHelp os={os} />);
  const card = await screen.findByRole("region", { name: "Host a network" });
  return { ...utils, card };
}

/** One phrase that only that system's steps contain. */
const ONLY = {
  macos: /Internet Sharing/,
  windows: /Network & internet › Mobile hotspot/,
  linux: /nmcli device wifi hotspot/,
} as const;

describe("DirectConnectionHelp", () => {
  it.each(["macos", "windows", "linux"] as const)("shows only the %s steps", (os) => {
    renderWithProviders(<DirectConnectionHelp os={os} />);
    expect(screen.getByTestId("direct-connection-help")).toHaveAttribute("data-os", os);
    expect(screen.getAllByText(ONLY[os]).length).toBeGreaterThan(0);
    for (const other of Object.keys(ONLY) as (keyof typeof ONLY)[]) {
      if (other !== os) expect(screen.queryByText(ONLY[other])).not.toBeInTheDocument();
    }
  });

  it("shows the steps for the host and for the other player", () => {
    renderWithProviders(<DirectConnectionHelp os="windows" />);
    expect(screen.getByText("The other player")).toBeInTheDocument();
    expect(screen.getByText(/Open the Wi-Fi list, join the network the host made/)).toBeVisible();
  });

  it("explains what to expect and how to check, on every system", () => {
    renderWithProviders(<DirectConnectionHelp os="macos" />);
    expect(screen.getByText(/loses its normal Wi-Fi internet/)).toBeInTheDocument();
    expect(screen.getByText(/±1–5 ms/)).toBeInTheDocument();
    expect(screen.getByText(/Check the connection:/)).toBeInTheDocument();
  });

  it("shows only the cable and phone tips for a system it does not know", () => {
    renderWithProviders(<DirectConnectionHelp os="unknown" />);
    expect(screen.getByText("Easiest and steadiest: a cable")).toBeInTheDocument();
    expect(screen.getByText(/No router: one phone's hotspot/)).toBeInTheDocument();
    for (const phrase of Object.values(ONLY)) {
      expect(screen.queryByText(phrase)).not.toBeInTheDocument();
    }
  });

  it.each(["macos", "windows", "linux", "unknown"] as const)(
    "has no accessibility violations (%s)",
    async (os) => {
      const { container } = renderWithProviders(<DirectConnectionHelp os={os} />);
      await expectNoA11yViolations(container);
    },
  );
});

describe("DirectConnectionHelp: Host a network", () => {
  it("is not offered when this computer cannot host a network", async () => {
    renderWithProviders(<DirectConnectionHelp os="windows" />);
    await act(async () => {});
    expect(practiceNetworkSupport).toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Host a network" })).not.toBeInTheDocument();
    // The steps by hand are all there.
    expect(screen.getByText(/Network & internet › Mobile hotspot/)).toBeInTheDocument();
  });

  it("is never offered on macOS or an unknown system, and is not even asked for", async () => {
    for (const os of ["macos", "unknown"] as const) {
      const { unmount } = renderWithProviders(<DirectConnectionHelp os={os} />);
      await act(async () => {});
      expect(screen.queryByRole("region", { name: "Host a network" })).not.toBeInTheDocument();
      unmount();
    }
    expect(practiceNetworkSupport).not.toHaveBeenCalled();
  });

  it.each(["windows", "linux"] as const)("comes first in the %s guide", async (os) => {
    const { card } = await hostable(os);
    expect(card).toHaveAttribute("data-phase", "idle");
    const help = screen.getByTestId("direct-connection-help");
    const firstOption = within(help).getAllByRole("heading", { level: 4 })[0];
    expect(firstOption).toHaveTextContent("Host a network");
    expect(within(card).getByRole("button", { name: "Start a network" })).toBeEnabled();
  });

  it("starts a network and shows its name, password and QR code", async () => {
    const { user, card } = await hostable();
    await user.click(within(card).getByRole("button", { name: "Start a network" }));
    expect(practiceNetworkStart).toHaveBeenCalledTimes(1);
    expect(await within(card).findByRole("status")).toHaveTextContent(/Your network is on/);
    expect(card).toHaveAttribute("data-phase", "running");
    const [name, password] = within(card).getAllByTestId("network-value");
    expect(name).toHaveTextContent(`Network name${NETWORK.ssid}`);
    expect(password).toHaveTextContent(`Password${NETWORK.passphrase}`);
    expect(
      within(card).getByRole("img", { name: `QR code to join the Wi-Fi network ${NETWORK.ssid}` }),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Copy the password" }));
    expect(await navigator.clipboard.readText()).toBe(NETWORK.passphrase);
    expect(
      await within(card).findByRole("button", { name: "Copied the password" }),
    ).toBeInTheDocument();
  });

  it("stops the network and can start a new one", async () => {
    const { user, card } = await hostable();
    await user.click(within(card).getByRole("button", { name: "Start a network" }));
    await user.click(await within(card).findByRole("button", { name: "Stop the network" }));
    expect(practiceNetworkStop).toHaveBeenCalledTimes(1);
    expect(await within(card).findByRole("button", { name: "Start a network" })).toBeEnabled();
    expect(within(card).queryByTestId("wifi-qr")).not.toBeInTheDocument();
  });

  it("says why a start failed and points to the steps by hand", async () => {
    vi.mocked(practiceNetworkStart).mockRejectedValueOnce({
      kind: "network",
      message: "Wi-Fi is off. Turn it on and try again.",
    });
    const { user, card } = await hostable("linux");
    await user.click(within(card).getByRole("button", { name: "Start a network" }));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("Wi-Fi is off. Turn it on and try again.");
    expect(alert).toHaveTextContent(/steps below/);
    expect(screen.getByText(/nmcli device wifi hotspot/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Try again" }));
    expect(practiceNetworkStart).toHaveBeenCalledTimes(2);
    expect(await within(card).findByText(NETWORK.ssid)).toBeInTheDocument();
  });

  it("says so when the network stops by itself", async () => {
    const { user, card } = await hostable();
    await user.click(within(card).getByRole("button", { name: "Start a network" }));
    await within(card).findByRole("status");
    act(() => stoppedBySystem("Wi-Fi is off. Turn it on and try again."));
    expect(within(card).getByRole("alert")).toHaveTextContent("Wi-Fi is off.");
    expect(within(card).queryByTestId("wifi-qr")).not.toBeInTheDocument();
  });

  it("stops listening when it goes away", async () => {
    const { unmount } = await hostable();
    unmount();
    await act(async () => {});
    expect(unlistenStopped).toHaveBeenCalled();
  });

  it("has no accessibility violations when idle, running and failed", async () => {
    const { user, card, container } = await hostable();
    await expectNoA11yViolations(container);
    await user.click(within(card).getByRole("button", { name: "Start a network" }));
    await within(card).findByRole("status");
    await expectNoA11yViolations(container);
    act(() => stoppedBySystem("The Wi-Fi adapter is busy. Try again in a moment."));
    await expectNoA11yViolations(container);
  });
});

describe("the macOS guide", () => {
  it("puts the cable between the two Macs first and Internet Sharing last", () => {
    renderWithProviders(<DirectConnectionHelp os="macos" />);
    const titles = screen
      .getAllByRole("heading", { level: 4 })
      .map((heading) => heading.textContent ?? "");
    expect(titles[0]).toBe("Best: connect the two Macs with a cable");
    expect(titles.findIndex((t) => /Internet Sharing/.test(t))).toBe(titles.length - 2);
    expect(titles.at(-1)).toBe("What to expect");
    expect(
      screen.getByText(/USB-C or Thunderbolt cable; they link up on 169\.254\.x\.x by themselves/),
    ).toBeInTheDocument();
  });

  it("says a Mac can join a network made by a Windows or Linux laptop", () => {
    renderWithProviders(<DirectConnectionHelp os="macos" />);
    expect(screen.getByTestId("direct-connection-note")).toHaveTextContent(
      /A Mac cannot host a network from Smart Beat, but it can join one .* Windows or Linux laptop/,
    );
  });
});

describe("the Wi-Fi QR code", () => {
  it("draws a square code with a quiet zone, the same for the same text", () => {
    const a = qrPath(NETWORK.wifiQr);
    expect(a.size).toBeGreaterThanOrEqual(21 + 8);
    expect(a.path).toMatch(/^M\d+ \d+h1v1h-1z/);
    // The quiet zone: no module in the first four rows or columns.
    expect(a.path).not.toMatch(/M[0-3] /);
    expect(qrPath(NETWORK.wifiQr)).toEqual(a);
    expect(qrPath("WIFI:T:WPA;S:Other;P:abcd2345efgh;;").path).not.toBe(a.path);
  });
});

function together(): PracticeTogether {
  return {
    state: null,
    hostCode: null,
    approval: null,
    quality: "auto",
    name: "Mark",
    starting: false,
    error: null,
    internetAvailable: true,
    transfer: null,
    readOnly: false,
    edit: NO_SHARED_EDITING,
    sources: NO_SOURCE_SHARING,
    setName: vi.fn(),
    setQuality: vi.fn(),
    host: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    rejoin: vi.fn(async () => {}),
    leave: vi.fn(),
    syncTab: vi.fn(),
    kick: vi.fn(),
    ban: vi.fn(),
    intercept: vi.fn(() => false),
    approvalsWaiting: 0,
    lastSession: null,
  };
}

describe("the direct connection link in the dialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the steps of this computer's system and goes back", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { user } = renderWithProviders(
      <PracticeTogetherDialog open onOpenChange={vi.fn()} together={together()} />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Need a direct connection? (no router, cable or hotspot)",
      }),
    );
    expect(screen.getByTestId("direct-connection-help")).toHaveAttribute("data-os", "macos");
    expect(screen.queryByRole("button", { name: "Start a session" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the connection" }));
    expect(screen.getByRole("button", { name: "Start a session" })).toBeInTheDocument();
  });

  it("is only offered for the same network", async () => {
    const { user } = renderWithProviders(
      <PracticeTogetherDialog open onOpenChange={vi.fn()} together={together()} />,
    );
    await user.click(screen.getByRole("radio", { name: "Over the internet" }));
    expect(
      screen.queryByRole("button", { name: /Need a direct connection/ }),
    ).not.toBeInTheDocument();
  });
});
