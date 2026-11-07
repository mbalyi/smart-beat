import { screen } from "@testing-library/react";

import { DirectConnectionHelp } from "@/components/practice-together/direct-connection-help";
import { PracticeTogetherDialog } from "@/components/practice-together/practice-together-dialog";
import type { PracticeTogether } from "@/hooks/use-practice-together";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

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
