import { act, screen, waitFor, within } from "@testing-library/react";

import { RecordModelsDialog } from "@/components/ai/record-models-dialog";
import {
  getAiState,
  onInstallerReturn,
  resetAiStore,
  seedAiState,
  statusWith,
} from "@/lib/ai/ai-store";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  muscriptorStatus: vi.fn(),
  deleteMuscriptorModel: vi.fn(),
  pianoModelStatus: vi.fn(),
  downloadPianoModel: vi.fn(),
  removePianoModel: vi.fn(),
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...tauri,
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));

const PIANO_BYTES = 56_799_421;

beforeEach(() => {
  localStorage.clear();
  resetAiStore();
  vi.clearAllMocks();
  document.documentElement.classList.remove("dark");
  tauri.isTauri.mockReturnValue(true);
  tauri.muscriptorStatus.mockResolvedValue(statusWith(["medium"]));
  tauri.deleteMuscriptorModel.mockResolvedValue(statusWith([]));
  tauri.pianoModelStatus.mockResolvedValue({ installed: false, bytes: PIANO_BYTES });
  tauri.downloadPianoModel.mockResolvedValue(undefined);
  tauri.removePianoModel.mockResolvedValue({ installed: false, bytes: PIANO_BYTES });
  seedAiState({ ready: true, status: statusWith(["medium"]), size: "medium" });
});

async function setup(open = true) {
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(<RecordModelsDialog open={open} onOpenChange={onOpenChange} />);
  if (open) await screen.findByRole("dialog", { name: "Record to Tab Models" });
  return { ...utils, onOpenChange };
}
/** The Close button of the footer (the corner one has the same name). */
const closeButton = () =>
  screen.getAllByRole("button", { name: "Close" }).find((b) => b.dataset.slot !== "dialog-close")!;
const row = (id: string) => screen.getByTestId(`model-row-${id}`);

describe("RecordModelsDialog", () => {
  it("lists everything Record to tab and Import from Audio use, in sections that say who uses it", async () => {
    await setup();
    const sections = screen.getAllByRole("region");
    expect(sections.map((s) => within(s).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "MuScriptor (AI mode)",
      "High-accuracy piano",
      "Built in",
    ]);
    expect(screen.getByText("Used by Record to tab and Import from Audio")).toBeInTheDocument();
    expect(screen.getByText("Used by Record to tab (piano, High accuracy)")).toBeInTheDocument();
    expect(screen.getByText("Used by Record to tab")).toBeInTheDocument();
    for (const size of ["Small", "Medium", "Large"]) {
      expect(screen.getByText(`MuScriptor ${size}`)).toBeInTheDocument();
    }
    expect(within(row("muscriptor-small")).getByText("Download 210 MB")).toBeInTheDocument();
    expect(within(row("muscriptor-large")).getByText("Download 2.7 GB")).toBeInTheDocument();
    expect(screen.getByText("Transkun piano model")).toBeInTheDocument();
    for (const id of ["basic-pitch", "drum-hits"]) {
      expect(within(row(id)).getByText("Built in")).toBeInTheDocument();
      expect(within(row(id)).getByText(/nothing to install/)).toBeInTheDocument();
      expect(within(row(id)).queryByRole("button")).toBeNull();
    }
  });

  it("shows which MuScriptor size is installed and in use", async () => {
    await setup();
    expect(within(row("muscriptor-medium")).getByText("Installed")).toBeInTheDocument();
    expect(within(row("muscriptor-medium")).getByText("In use")).toBeInTheDocument();
    expect(within(row("muscriptor-small")).getByText("Not installed")).toBeInTheDocument();
    expect(
      within(row("muscriptor-small")).getByRole("button", { name: "Install the Small model" }),
    ).toBeEnabled();
  });

  it("hands over to the installer with the size chosen, and the installer comes back", async () => {
    const back = vi.fn();
    onInstallerReturn("models", back);
    const { user, onOpenChange } = await setup();
    await user.click(screen.getByRole("button", { name: "Install the Large model" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(getAiState().size).toBe("large");
    expect(getAiState().installer).toEqual({ open: true, returnTo: "models" });
  });

  it("deletes a size with a second click, like the picker in the installer", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Delete the Medium model" }));
    expect(tauri.deleteMuscriptorModel).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(tauri.deleteMuscriptorModel).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete the Medium model" }));
    await user.click(screen.getByRole("button", { name: "Delete Medium" }));
    expect(tauri.deleteMuscriptorModel).toHaveBeenCalledWith("medium");
    await waitFor(() =>
      expect(within(row("muscriptor-medium")).getByText("Not installed")).toBeInTheDocument(),
    );
  });

  it("lets another installed size be the one in use", async () => {
    tauri.muscriptorStatus.mockResolvedValue(statusWith(["small", "medium"]));
    seedAiState({ status: statusWith(["small", "medium"]), size: "medium" });
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Use the Small model" }));
    expect(getAiState().size).toBe("small");
    expect(within(row("muscriptor-small")).getByText("In use")).toBeInTheDocument();
  });

  it("says why a delete failed", async () => {
    tauri.deleteMuscriptorModel.mockRejectedValue({ kind: "io", message: "Could not delete it." });
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Delete the Medium model" }));
    await user.click(screen.getByRole("button", { name: "Delete Medium" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not delete it.");
  });

  it("says MuScriptor is not available where the engine is not built in", async () => {
    tauri.muscriptorStatus.mockResolvedValue({ ...statusWith([]), supported: false });
    seedAiState({ ready: false, unsupported: true });
    await setup();
    expect(screen.getByText("MuScriptor is not available on this platform.")).toBeInTheDocument();
    expect(screen.queryByText("MuScriptor Small")).toBeNull();
  });

  describe("the piano model", () => {
    it("downloads with progress, then shows as installed", async () => {
      let finish!: () => void;
      let progress!: (fraction: number) => void;
      tauri.downloadPianoModel.mockImplementation(
        (onProgress: (fraction: number) => void) =>
          new Promise<void>((resolve) => {
            progress = onProgress;
            finish = resolve;
          }),
      );
      const { user, onOpenChange } = await setup();
      const transkun = row("transkun");
      expect(await within(transkun).findByText("Download 57 MB")).toBeInTheDocument();
      await user.click(
        within(transkun).getByRole("button", { name: "Install the Transkun piano model" }),
      );
      act(() => progress(0.42));
      expect(within(transkun).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
      // Nothing can be started or deleted, and the window stays while it downloads.
      expect(closeButton()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Install the Small model" })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(onOpenChange).not.toHaveBeenCalledWith(false);

      tauri.pianoModelStatus.mockResolvedValue({ installed: true, bytes: PIANO_BYTES });
      await act(async () => finish());
      expect(await within(transkun).findByText("Installed")).toBeInTheDocument();
      expect(
        within(transkun).getByRole("button", { name: "Delete the Transkun piano model" }),
      ).toBeEnabled();
      expect(closeButton()).toBeEnabled();
    });

    it("says why a download failed and offers it again", async () => {
      tauri.downloadPianoModel.mockRejectedValue({ kind: "audio", message: "No network." });
      const { user } = await setup();
      await user.click(
        await screen.findByRole("button", { name: "Install the Transkun piano model" }),
      );
      expect(await within(row("transkun")).findByRole("alert")).toHaveTextContent("No network.");
      expect(
        screen.getByRole("button", { name: "Install the Transkun piano model" }),
      ).toBeEnabled();
    });

    it("deletes it with a second click", async () => {
      tauri.pianoModelStatus.mockResolvedValue({ installed: true, bytes: PIANO_BYTES });
      const { user } = await setup();
      await user.click(
        await screen.findByRole("button", { name: "Delete the Transkun piano model" }),
      );
      expect(tauri.removePianoModel).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Delete Transkun piano" }));
      expect(tauri.removePianoModel).toHaveBeenCalledTimes(1);
      expect(await within(row("transkun")).findByText("Not installed")).toBeInTheDocument();
    });
  });

  it("closes with Close and starts afresh next time", async () => {
    const { user, onOpenChange } = await setup();
    await user.click(closeButton());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("has no accessibility violations in light and dark", async () => {
    tauri.pianoModelStatus.mockResolvedValue({ installed: true, bytes: PIANO_BYTES });
    const { user } = await setup();
    await screen.findByRole("button", { name: "Delete the Transkun piano model" });
    const dialog = screen.getByRole("dialog");
    await expectNoA11yViolations(dialog);
    await user.click(screen.getByRole("button", { name: "Delete the Medium model" }));
    await expectNoA11yViolations(dialog);
    document.documentElement.classList.add("dark");
    await expectNoA11yViolations(dialog);
  });
});
