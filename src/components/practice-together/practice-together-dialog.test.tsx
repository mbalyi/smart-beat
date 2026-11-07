import { screen, within } from "@testing-library/react";

import { PracticeTogetherDialog } from "@/components/practice-together/practice-together-dialog";
import {
  SyncQualityBadge,
  TogetherButton,
  TogetherChip,
} from "@/components/practice-together/sync-quality";
import type { PracticeTogether } from "@/hooks/use-practice-together";
import { problem, type SessionState } from "@/lib/practice-together/session";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const session = (over: Partial<SessionState> = {}): SessionState => ({
  role: "host",
  phase: "synchronized",
  session: "abc",
  peerName: "Bass laptop",
  quality: { errorMs: 2.5, bucket: "excellent" },
  latency: { samples: 20, p50: 4, p95: 8, jitter: 1 },
  preset: "tight",
  leadMs: 250,
  problem: null,
  peer: { errorMs: 3.2, rtt: 4, driftMs: 1.4 },
  ...over,
});

function together(over: Partial<PracticeTogether> = {}): PracticeTogether {
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
    leave: vi.fn(),
    intercept: vi.fn(() => false),
    ...over,
  };
}

function renderDialog(t: PracticeTogether, onOpenChange = vi.fn()) {
  const utils = renderWithProviders(
    <PracticeTogetherDialog open onOpenChange={onOpenChange} together={t} />,
  );
  return { ...utils, onOpenChange };
}

describe("PracticeTogetherDialog: choosing", () => {
  it("starts hosting on the same network by default", async () => {
    const t = together();
    const { user } = renderDialog(t);
    expect(screen.getByRole("dialog", { name: "Practice together" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start a session" }));
    expect(t.host).toHaveBeenCalledExactlyOnceWith("lan");
  });

  it("hosts over the internet when that is chosen", async () => {
    const t = together();
    const { user } = renderDialog(t);
    await user.click(screen.getByRole("radio", { name: "Over the internet" }));
    await user.click(screen.getByRole("button", { name: "Start a session" }));
    expect(t.host).toHaveBeenCalledExactlyOnceWith("internet");
  });

  it("does not offer the internet where it is not in the build, and says why", () => {
    renderDialog(together({ internetAvailable: false }));
    const internet = screen.getByRole("radio", { name: "Over the internet" });
    expect(internet).toBeDisabled();
    expect(internet).toHaveAccessibleDescription(/needs the online connection service/);
    expect(screen.getByText(/which this build does not include/)).toBeVisible();
  });

  it("offers the internet without a reason where it is in the build", () => {
    renderDialog(together({ internetAvailable: true }));
    expect(screen.getByRole("radio", { name: "Over the internet" })).toBeEnabled();
    expect(screen.queryByText(/which this build does not include/)).not.toBeInTheDocument();
  });

  it("starts on joining when it was opened to join, and says the tab comes from the host", () => {
    renderWithProviders(
      <PracticeTogetherDialog
        open
        onOpenChange={vi.fn()}
        together={together()}
        initialMode="join"
      />,
    );
    expect(screen.getByRole("radio", { name: "Join an existing session" })).toBeChecked();
    expect(screen.getByLabelText("Room code")).toBeInTheDocument();
    expect(screen.getByTestId("mode-hint")).toHaveTextContent("The tab comes from the host");
  });

  it("starts on a new session by default and says the tab is shared", () => {
    renderDialog(together());
    expect(screen.getByRole("radio", { name: "Start a new session" })).toBeChecked();
    expect(screen.queryByLabelText("Room code")).not.toBeInTheDocument();
    expect(screen.getByTestId("mode-hint")).toHaveTextContent("gets this tab from you");
  });

  it("puts the logo in the header, the description above the stepper and no title text", () => {
    renderDialog(together());
    const dialog = screen.getByRole("dialog", { name: "Practice together" });
    expect(within(dialog).getByTestId("together-logo")).toHaveAttribute("aria-hidden", "true");
    // The title is only the logo: its text is for screen readers, and no other heading repeats it.
    const title = within(dialog).getByRole("heading", { name: "Practice together" });
    expect(within(title).getByText("Practice together")).toHaveClass("sr-only");
    expect(within(dialog).getAllByRole("heading")).toHaveLength(1);
    const description = within(dialog).getByText(/Play the same tab with someone else/);
    const stepper = within(dialog).getByRole("list");
    expect(description.compareDocumentPosition(stepper)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows the feature picture at the top of the content, not pinned to the bottom", () => {
    renderDialog(together());
    const hero = document.querySelector("[data-hero='practice-together']");
    expect(hero).toHaveClass("float-right");
    expect(hero?.getAttribute("src")).toContain("practice-together");
  });

  it("joins with a typed code", async () => {
    const t = together();
    const { user } = renderDialog(t);
    await user.click(screen.getByRole("radio", { name: "Join an existing session" }));
    const join = screen.getByRole("button", { name: "Join the session" });
    expect(join).toBeDisabled();
    await user.type(screen.getByLabelText("Room code"), "abcd-efgh");
    await user.click(join);
    expect(t.join).toHaveBeenCalledExactlyOnceWith("lan", "abcd-efgh");
  });

  it("remembers the name as it is typed", async () => {
    const t = together({ name: "" });
    const { user } = renderDialog(t);
    await user.type(screen.getByLabelText("Your name"), "M");
    expect(t.setName).toHaveBeenCalledWith("M");
  });

  it("shows a failure to connect", () => {
    renderDialog(together({ error: "Could not reach the host (timed out)." }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the host");
  });

  it("explains why a finished session ended", () => {
    renderDialog(
      together({ state: session({ phase: "failed", problem: { ...problem("declined") } }) }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The host did not let you in.");
    expect(screen.getByRole("button", { name: "Start a session" })).toBeInTheDocument();
  });

  it("closes from the footer", async () => {
    const { user, onOpenChange } = renderDialog(together());
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("has no accessibility violations", async () => {
    renderDialog(together());
    await expectNoA11yViolations(screen.getByRole("dialog"));
  });
});

describe("PracticeTogetherDialog: connecting", () => {
  const hosting = (over: Partial<PracticeTogether> = {}) =>
    together({
      state: session({
        phase: "waiting",
        peerName: null,
        peer: null,
        quality: { errorMs: Infinity, bucket: "none" },
      }),
      hostCode: { kind: "lan", code: "ABCD-EFGH-JKMN-PQRS-TVWX", address: "192.168.1.5:5000" },
      ...over,
    });

  it("shows the code to give out, and waits", () => {
    renderDialog(hosting());
    expect(screen.getByTestId("room-code")).toHaveTextContent("ABCD-EFGH-JKMN-PQRS-TVWX");
    expect(screen.getByText(/Listening on 192\.168\.1\.5:5000/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for the other player…")).toBeInTheDocument();
  });

  it("asks the host before letting anyone in", async () => {
    const answer = vi.fn();
    const { user } = renderDialog(
      hosting({
        state: session({ phase: "approving", peerName: "Drummer", peer: null }),
        approval: { name: "Drummer", answer },
      }),
    );
    const card = screen.getByRole("alertdialog", { name: "Let this player in?" });
    expect(within(card).getByText("Drummer")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Let in" }));
    await user.click(within(card).getByRole("button", { name: "Decline" }));
    expect(answer.mock.calls).toEqual([[true], [false]]);
  });

  it("shows a guest it is connecting", () => {
    renderDialog(
      together({
        state: session({ role: "guest", phase: "syncing", peerName: "Host", peer: null }),
      }),
    );
    expect(screen.getByText("Connected to Host. Matching the clocks…")).toBeInTheDocument();
  });

  it("cancels the session", async () => {
    const t = hosting();
    const { user } = renderDialog(t);
    await user.click(screen.getByRole("button", { name: "Cancel session" }));
    expect(t.leave).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    renderDialog(hosting({ approval: { name: "Drummer", answer: vi.fn() } }));
    await expectNoA11yViolations(screen.getByRole("dialog"));
  });
});

describe("PracticeTogetherDialog: playing together", () => {
  it("shows the sync quality of both players", () => {
    renderDialog(together({ state: session() }));
    expect(screen.getByTestId("peer-other")).toHaveTextContent("Bass laptop");
    expect(screen.getByTestId("peer-other")).toHaveTextContent("±3.2 ms");
    expect(screen.getByTestId("peer-other")).toHaveTextContent("Excellent");
    expect(screen.getByText("250 ms")).toBeInTheDocument();
  });

  it("tells a guest that Play starts both and the settings follow the host", () => {
    renderDialog(together({ state: session({ role: "guest" }) }));
    expect(screen.getByText(/the host starts both of you at the same moment/)).toBeInTheDocument();
    expect(screen.getByTestId("peer-you")).toHaveTextContent("±2.5 ms");
  });

  it("changes the audio quality", async () => {
    const t = together({ state: session() });
    const { user } = renderDialog(t);
    await user.click(screen.getByRole("combobox", { name: "Audio quality" }));
    await user.click(await screen.findByRole("option", { name: "Safe" }));
    expect(t.setQuality).toHaveBeenCalledWith("safe");
    expect(screen.getByText(/Now using Tight/)).toBeInTheDocument();
  });

  it("shows a warning about the connection", () => {
    renderDialog(together({ state: session({ problem: problem("poor") }) }));
    expect(screen.getByRole("alert")).toHaveTextContent("too unsteady");
  });

  it("leaves the session", async () => {
    const t = together({ state: session() });
    const { user } = renderDialog(t);
    await user.click(screen.getByRole("button", { name: "Leave session" }));
    expect(t.leave).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    renderDialog(together({ state: session({ problem: problem("poor") }) }));
    await expectNoA11yViolations(screen.getByRole("dialog"));
  });
});

describe("TogetherChip", () => {
  it("is not shown without a session", () => {
    const { container } = renderWithProviders(<TogetherChip state={null} onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the other player and the sync error, and opens the dialog", async () => {
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<TogetherChip state={session()} onOpen={onOpen} />);
    const chip = screen.getByTestId("together-chip");
    expect(chip).toHaveAccessibleName(
      "Practice together: synchronized with Bass laptop, ±3.2 ms, Excellent",
    );
    await user.click(chip);
    expect(onOpen).toHaveBeenCalled();
  });

  it("says when the connection is lost or the session ended", () => {
    const { rerender } = renderWithProviders(
      <TogetherChip state={session({ phase: "reconnecting" })} onOpen={vi.fn()} />,
    );
    expect(screen.getByTestId("together-chip")).toHaveAccessibleName(/reconnecting/);
    rerender(<TogetherChip state={session({ phase: "failed" })} onOpen={vi.fn()} />);
    expect(screen.getByTestId("together-chip")).toHaveAccessibleName(/ended/);
  });

  it("has no accessibility violations", async () => {
    renderWithProviders(<TogetherChip state={session()} onOpen={vi.fn()} />);
    await expectNoA11yViolations();
  });
});

describe("SyncQualityBadge", () => {
  it("shows a dash before the first measurement", () => {
    renderWithProviders(<SyncQualityBadge quality={{ errorMs: Infinity, bucket: "none" }} />);
    expect(screen.getByText("Syncing")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("PracticeTogetherDialog: the tab on its way", () => {
  it("shows the guest the tab being received and the host the tab being sent", () => {
    const { unmount } = renderDialog(
      together({
        state: session({ role: "guest", phase: "syncing" }),
        transfer: { direction: "receive", name: "Riff", done: 3, total: 10 },
      }),
    );
    expect(screen.getByText(/Receiving "Riff" from the host/)).toBeVisible();
    expect(screen.getByRole("progressbar", { name: /Receiving "Riff"/ })).toHaveAttribute(
      "value",
      "3",
    );
    unmount();
    renderDialog(
      together({
        state: session({ role: "host", phase: "synchronized" }),
        transfer: { direction: "send", name: "Riff", done: 10, total: 10 },
      }),
    );
    expect(screen.getByText('Sent "Riff".')).toBeVisible();
  });

  it("shows nothing without a transfer", () => {
    renderDialog(together({ state: session({ phase: "syncing" }) }));
    expect(screen.queryByTestId("tab-transfer")).not.toBeInTheDocument();
  });
});

describe("TogetherButton", () => {
  it("is an icon button that opens the dialog while there is no session", async () => {
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<TogetherButton state={null} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: "Practice together" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("together-chip")).not.toBeInTheDocument();
  });

  it("is the button again after a session closed", () => {
    renderWithProviders(<TogetherButton state={session({ phase: "closed" })} onOpen={vi.fn()} />);
    expect(screen.getByTestId("together-button")).toBeInTheDocument();
  });

  it("becomes the sync chip while a session runs", () => {
    renderWithProviders(<TogetherButton state={session()} onOpen={vi.fn()} />);
    expect(screen.getByTestId("together-chip")).toHaveAttribute("data-phase", "synchronized");
    expect(screen.queryByTestId("together-button")).not.toBeInTheDocument();
  });
});
