import { act, screen, waitFor } from "@testing-library/react";

import { AiInstallerDialog } from "@/components/ai/ai-installer-dialog";
import {
  getAiState,
  onInstallerReturn,
  openInstaller,
  resetAiStore,
  seedAiState,
  statusWith,
} from "@/lib/ai/ai-store";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  muscriptorStatus: vi.fn(),
  acceptMuscriptorTerms: vi.fn(),
  downloadMuscriptorModel: vi.fn(),
  cancelMuscriptorDownload: vi.fn(),
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...tauri,
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  resetAiStore();
  vi.clearAllMocks();
  tauri.isTauri.mockReturnValue(true);
  tauri.muscriptorStatus.mockResolvedValue(statusWith([], false));
  tauri.acceptMuscriptorTerms.mockResolvedValue(statusWith([], true));
  tauri.downloadMuscriptorModel.mockResolvedValue(statusWith(["medium"]));
  seedAiState({ ready: true, status: statusWith([], false) });
});

const installer = () => screen.getByTestId("ai-installer");
const footerButtons = () =>
  Array.from(installer().querySelectorAll<HTMLButtonElement>('[data-slot="dialog-footer"] button'));
async function open(returnTo: "record" | "audio" = "record") {
  const utils = renderWithProviders(<AiInstallerDialog />);
  act(() => openInstaller(returnTo));
  await screen.findByRole("dialog");
  return utils;
}
/** Names and order of the footer buttons: where the user's hands go. */
const footerNames = () => footerButtons().map((b) => b.textContent?.trim());

describe("AiInstallerDialog", () => {
  it("is closed until something asks for it", () => {
    renderWithProviders(<AiInstallerDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts with Powered by MuScriptor, its licence and its links", async () => {
    await open();
    expect(screen.getByRole("heading", { name: "Powered by MuScriptor" })).toBeInTheDocument();
    expect(screen.getByText(/non-commercial use only/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kyutai" })).toHaveAttribute(
      "href",
      "https://kyutai.org/",
    );
    expect(screen.getByRole("link", { name: "Mirelo" })).toHaveAttribute(
      "href",
      "https://mirelo.ai/",
    );
    expect(screen.getByRole("link", { name: "Online demo" })).toHaveAttribute(
      "href",
      "https://muscriptor.kyutai.org/",
    );
    expect(
      screen.getByText(/not affiliated with or endorsed by Kyutai or Mirelo/),
    ).toBeInTheDocument();
    // The pictures are decoration only: no alternative text, and no logo of the model's authors.
    const pictures = Array.from(installer().querySelectorAll("img"));
    expect(pictures.length).toBeGreaterThan(0);
    for (const picture of pictures) expect(picture.getAttribute("alt")).toBe("");
  });

  it("walks models, terms and download, and needs both boxes before it downloads", async () => {
    const back = vi.fn();
    onInstallerReturn("audio", back);
    const { user } = await open("audio");
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    expect(screen.getByRole("heading", { name: "Pick your model size" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Medium/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Small/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const download = screen.getByRole("button", { name: "Continue" });
    expect(download).toBeDisabled();
    expect(screen.getByRole("link", { name: /Read the model card/ })).toHaveAttribute(
      "href",
      "https://huggingface.co/MuScriptor/muscriptor-medium",
    );
    await user.click(
      screen.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }),
    );
    expect(download).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /only use MuScriptor with my own music/ }),
    );
    expect(download).toBeEnabled();

    tauri.downloadMuscriptorModel.mockResolvedValue(statusWith(["small"]));
    await user.click(download);
    await screen.findByRole("heading", { name: "Everything is set up!" });
    expect(tauri.acceptMuscriptorTerms).toHaveBeenCalledWith("small", true);
    expect(tauri.downloadMuscriptorModel).toHaveBeenCalledWith("small", expect.any(Function));

    await user.click(screen.getByRole("button", { name: "Back to Import from Audio" }));
    expect(getAiState().installer.open).toBe(false);
    expect(back).toHaveBeenCalledOnce();
  });

  it("ticks the boxes only when the terms of the chosen size are on file", async () => {
    tauri.muscriptorStatus.mockResolvedValue(statusWith([], ["small"]));
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    await user.click(screen.getByRole("radio", { name: /Small/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Small was accepted before: nothing to tick, the download can start.
    expect(
      screen.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("radio", { name: /Medium/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Medium has no record of its own yet: both boxes are open again.
    expect(
      screen.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("keeps the footer buttons where they are on every step", async () => {
    const { user } = await open();
    const names: string[][] = [];
    names.push(footerNames() as string[]);
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    names.push(footerNames() as string[]);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    names.push(footerNames() as string[]);
    // Two buttons, always: Close or Back on the left, the primary action on the right.
    for (const row of names) expect(row).toHaveLength(2);
    expect(names.map((row) => row[0])).toEqual(["Close", "Back", "Back"]);
    // The frame never changes: one fixed height class on every step.
    expect(installer().className).toContain("h-[min(44rem,calc(100dvh-2rem))]");
  });

  it("shows the five steps and where the user is", async () => {
    const { user } = await open();
    const steps = () => screen.getAllByRole("listitem").filter((li) => li.closest("ol"));
    expect(steps().map((li) => li.textContent?.replace(/\(.*\)/, "").trim())).toEqual([
      "1About",
      "2Model",
      "3Terms",
      "4Download",
      "5Complete",
    ]);
    expect(steps()[0]).toHaveAttribute("aria-current", "step");
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    expect(steps()[0]).not.toHaveAttribute("aria-current");
    expect(steps()[1]).toHaveAttribute("aria-current", "step");
  });

  it("shows a failed download with its reason and lets the user try again", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByRole("checkbox", { name: /accepted the MuScriptor weight terms/ }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /only use MuScriptor with my own music/ }),
    );
    tauri.downloadMuscriptorModel.mockRejectedValueOnce({ message: "The network dropped." });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("The network dropped.")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    await screen.findByRole("heading", { name: "Everything is set up!" });
  });

  it("stops a running download when it is closed, and returns the user", async () => {
    const back = vi.fn();
    onInstallerReturn("record", back);
    const { user } = await open("record");
    seedAiState({ status: statusWith([], true) });
    let release: (() => void) | undefined;
    tauri.downloadMuscriptorModel.mockImplementation(
      () =>
        new Promise((_, reject) => {
          release = () => reject({ message: "Download stopped." });
        }),
    );
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: "Downloading…" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(tauri.cancelMuscriptorDownload).toHaveBeenCalled();
    release?.();
    await waitFor(() => expect(getAiState().download).toBeNull());
    expect(back).toHaveBeenCalledOnce();
  });

  it("has no accessibility violations", async () => {
    const { user } = await open();
    await expectNoA11yViolations(installer());
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    await expectNoA11yViolations(installer());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await expectNoA11yViolations(installer());
  });
});
