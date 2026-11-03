import { emit } from "@tauri-apps/api/event";
import { screen, waitFor } from "@testing-library/react";

import { CloudStems } from "@/components/cloud-stems";
import { Welcome } from "@/components/welcome";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";

const MB = 1024 * 1024;
const stems = (name: string, placeholder = false, size = 82 * MB) => ({
  name: `${name}.sbstems`,
  path: `/cloud/${name}.sbstems`,
  size,
  modified_ms: 1,
  placeholder,
});

describe("CloudStems", () => {
  it("is hidden when no cloud folder is linked", async () => {
    const calls = mockTauri();
    backend.cloudStems = [stems("Neon Nights")];
    renderWithProviders(<CloudStems onOpen={vi.fn()} />);

    await waitFor(() => expect(calls.some((c) => c.cmd === "get_cloud_folder")).toBe(true));
    expect(calls.some((c) => c.cmd === "list_cloud_stems")).toBe(false);
    expect(screen.queryByRole("heading", { name: "Stems in your cloud folder" })).toBeNull();
  });

  it("is hidden when the folder has no saved stems", async () => {
    const calls = mockTauri();
    backend.cloudFolder = "/cloud";
    renderWithProviders(<CloudStems onOpen={vi.fn()} />);

    await waitFor(() => expect(calls.some((c) => c.cmd === "list_cloud_stems")).toBe(true));
    expect(screen.queryByRole("heading", { name: "Stems in your cloud folder" })).toBeNull();
  });

  it("is hidden when the folder cannot be read", async () => {
    const calls = mockTauri({
      list_cloud_stems: () => {
        throw { kind: "not-found", message: "gone" };
      },
    });
    backend.cloudFolder = "/cloud";
    renderWithProviders(<CloudStems onOpen={vi.fn()} />);

    await waitFor(() => expect(calls.some((c) => c.cmd === "list_cloud_stems")).toBe(true));
    expect(screen.queryByRole("heading", { name: "Stems in your cloud folder" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the files as cards with a Stems badge, a Cloud mark, the name and the size", async () => {
    mockTauri();
    backend.cloudFolder = "/cloud";
    backend.cloudStems = [stems("Neon Nights"), stems("Blue Hour", false, 5 * MB)];
    const { container } = renderWithProviders(<CloudStems onOpen={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "Stems in your cloud folder" }),
    ).toBeInTheDocument();
    const card = screen.getByRole("button", { name: /Neon Nights/ });
    expect(card).toHaveTextContent("Neon Nights");
    expect(card).not.toHaveTextContent(".sbstems");
    expect(card).toHaveTextContent("Stems");
    expect(card).toHaveTextContent("Cloud");
    expect(card).toHaveTextContent("82 MB");
    expect(card).not.toHaveTextContent(/waiting/i);
    expect(screen.getByRole("button", { name: /Blue Hour/ })).toHaveTextContent("5 MB");
    await expectNoA11yViolations(container);
  });

  it("marks an online-only file as waiting for download, and downloading once Rust waits", async () => {
    mockTauri();
    backend.cloudFolder = "/cloud";
    backend.cloudStems = [stems("Far Away", true), stems("Here")];
    const { container } = renderWithProviders(<CloudStems onOpen={vi.fn()} />);

    const waiting = await screen.findByRole("button", { name: /Far Away/ });
    expect(waiting).toHaveTextContent("Waiting for download");
    expect(waiting).toHaveAttribute("data-placeholder", "true");
    expect(screen.getByRole("button", { name: /Here/ })).not.toHaveTextContent(/waiting/i);
    await expectNoA11yViolations(container);

    await emit("cloud-download-waiting", "/cloud/Far Away.sbstems");
    await waitFor(() => expect(waiting).toHaveTextContent("Downloading…"));
  });

  it("opens a file by its path", async () => {
    mockTauri();
    backend.cloudFolder = "/cloud";
    backend.cloudStems = [stems("Neon Nights"), stems("Far Away", true)];
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<CloudStems onOpen={onOpen} />);

    await user.click(await screen.findByRole("button", { name: /Far Away/ }));
    expect(onOpen).toHaveBeenCalledWith("/cloud/Far Away.sbstems");
  });
});

describe("Welcome: stems in your cloud folder", () => {
  const renderWelcome = (onOpenCloudStem?: (path: string) => void) =>
    renderWithProviders(
      <Welcome
        onOpenFile={vi.fn()}
        onNewSong={vi.fn()}
        onShowShortcuts={vi.fn()}
        onOpenCloudStem={onOpenCloudStem}
      />,
    );

  it("shows the section and opens a file through the handler", async () => {
    mockTauri();
    backend.cloudFolder = "/cloud";
    backend.cloudStems = [stems("Neon Nights")];
    const onOpen = vi.fn();
    const { user } = renderWelcome(onOpen);

    await user.click(await screen.findByRole("button", { name: /Neon Nights/ }));
    expect(onOpen).toHaveBeenCalledWith("/cloud/Neon Nights.sbstems");
  });

  it("leaves the section out without a handler", async () => {
    const calls = mockTauri();
    backend.cloudFolder = "/cloud";
    backend.cloudStems = [stems("Neon Nights")];
    renderWelcome();

    await screen.findByRole("heading", { level: 1 });
    expect(calls.some((c) => c.cmd === "list_cloud_stems")).toBe(false);
    expect(screen.queryByRole("heading", { name: "Stems in your cloud folder" })).toBeNull();
  });
});
