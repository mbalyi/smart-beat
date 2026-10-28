import { screen, waitFor } from "@testing-library/react";

import { CloudScores } from "@/components/cloud-scores";
import { Welcome } from "@/components/welcome";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const score = (name: string, placeholder = false) => ({
  name,
  path: `/cloud/${name}`,
  size: 100,
  modified_ms: 1,
  placeholder,
});

describe("CloudScores", () => {
  it("is hidden when no cloud folder is linked", async () => {
    const calls = mockTauri({ get_cloud_folder: () => null });
    renderWithProviders(<CloudScores onOpen={vi.fn()} />);

    await waitFor(() => expect(calls.some((c) => c.cmd === "get_cloud_folder")).toBe(true));
    expect(screen.queryByRole("heading", { name: "Cloud" })).not.toBeInTheDocument();
  });

  it("lists the tabs and opens one", async () => {
    mockTauri({
      get_cloud_folder: () => "/cloud",
      list_cloud_scores: () => [score("riff.gp5"), score("solo.gp")],
    });
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<CloudScores onOpen={onOpen} />);

    expect(await screen.findByRole("heading", { name: "Cloud" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /solo\.gp/ }));
    expect(onOpen).toHaveBeenCalledWith("/cloud/solo.gp");
    expect(screen.queryByText("Waiting for download")).not.toBeInTheDocument();
  });

  it("marks online-only files as waiting for download", async () => {
    mockTauri({
      get_cloud_folder: () => "/cloud",
      list_cloud_scores: () => [score("riff.gp5"), score("far.gp5", true)],
    });
    const { container } = renderWithProviders(<CloudScores onOpen={vi.fn()} />);

    const waiting = await screen.findByRole("button", { name: /far\.gp5/ });
    expect(waiting).toHaveTextContent("Waiting for download");
    expect(screen.getByRole("button", { name: /riff\.gp5/ })).not.toHaveTextContent(/waiting/i);
    await expectNoA11yViolations(container);
  });

  it("explains an offline or missing folder", async () => {
    mockTauri({
      get_cloud_folder: () => "/cloud",
      list_cloud_scores: () => {
        throw { kind: "not-found", message: "gone" };
      },
    });
    renderWithProviders(<CloudScores onOpen={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Is the drive offline/);
  });

  it("says so when the folder has no tabs", async () => {
    mockTauri({ get_cloud_folder: () => "/cloud", list_cloud_scores: () => [] });
    renderWithProviders(<CloudScores onOpen={vi.fn()} />);

    expect(await screen.findByText(/No tabs in your cloud folder yet/)).toBeInTheDocument();
  });
});

describe("Welcome: Cloud section", () => {
  it("shows the Cloud section only with a handler and a linked folder", async () => {
    mockTauri({ get_cloud_folder: () => "/cloud", list_cloud_scores: () => [score("a.gp5")] });
    renderWithProviders(
      <Welcome
        onOpenFile={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        onOpenCloud={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: /a\.gp5/ })).toBeInTheDocument();
  });
});

describe("CloudScores: online drives (#187)", () => {
  const account = (provider: string, label: string, connected = true) => ({
    provider,
    label,
    configured: true,
    account: connected ? "me@example.com" : null,
  });
  const item = (id: string, name: string) => ({
    id,
    name,
    revision: "r",
    size: 1,
    modified_ms: 1,
  });

  it("lists the tabs of each connected provider, labelled, and opens one by item id", async () => {
    mockTauri({
      get_cloud_folder: () => null,
      cloud_accounts: () => [
        account("drive", "Google Drive"),
        account("dropbox", "Dropbox"),
        account("onedrive", "OneDrive", false),
      ],
      cloud_list: (args) =>
        (args as { provider: string }).provider === "drive"
          ? [item("drive:1", "riff.gp")]
          : [item("dropbox:2", "solo.gp")],
    });
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<CloudScores onOpen={onOpen} />);

    const riff = await screen.findByRole("button", { name: /riff\.gp/ });
    expect(riff).toHaveTextContent("Google Drive");
    const solo = screen.getByRole("button", { name: /solo\.gp/ });
    expect(solo).toHaveTextContent("Dropbox");
    for (const card of [riff, solo]) {
      const logo = card.querySelector("img");
      expect(logo).toHaveAttribute("aria-hidden", "true");
      expect(logo).toHaveAttribute("alt", "");
    }
    expect(riff.querySelector("img")!.getAttribute("src")).not.toBe(
      solo.querySelector("img")!.getAttribute("src"),
    );
    await user.click(riff);
    expect(onOpen).toHaveBeenCalledWith("drive:1");
  });

  it("opens a tab the backend listed with a bare id by its item id (regression)", async () => {
    mockTauri({
      get_cloud_folder: () => null,
      cloud_accounts: () => [account("drive", "Google Drive")],
      cloud_list: () => [item("1aVLa7Sl-Qy5", "riff.gp")],
    });
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<CloudScores onOpen={onOpen} />);

    await user.click(await screen.findByRole("button", { name: /riff\.gp/ }));
    expect(onOpen).toHaveBeenCalledWith("drive:1aVLa7Sl-Qy5");
  });

  it("says to reconnect when a provider's sign-in expired", async () => {
    mockTauri({
      get_cloud_folder: () => null,
      cloud_accounts: () => [account("drive", "Google Drive")],
      cloud_list: () => {
        throw { kind: "auth-expired", message: "expired" };
      },
    });
    renderWithProviders(<CloudScores onOpen={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reconnect Google Drive in Settings",
    );
  });
});
