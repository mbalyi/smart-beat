import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AddSamplesDialog } from "@/components/samples/add-samples-dialog";
import type { ArchiveReport, FolderScan, SampleFolder, SampleProgress } from "@/lib/samples/types";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const tauri = vi.hoisted(() => ({
  pickSampleFolder: vi.fn<() => Promise<string | null>>(),
  pickSampleArchive: vi.fn<() => Promise<string | null>>(),
  pickSampleFiles: vi.fn<() => Promise<string[] | null>>(),
  scanSampleFolder: vi.fn<(path: string) => Promise<FolderScan>>(),
  inspectSampleArchive: vi.fn<(path: string) => Promise<ArchiveReport>>(),
  linkSampleFolder: vi.fn<(path: string) => Promise<SampleFolder>>(),
  importSampleFolder: vi.fn<(path: string, jobId: string) => Promise<SampleFolder>>(),
  importSampleArchive: vi.fn<(path: string, jobId: string) => Promise<SampleFolder>>(),
  importSampleFiles:
    vi.fn<(paths: string[], name: string, jobId: string) => Promise<SampleFolder>>(),
  cancelSampleJob: vi.fn<(jobId: string) => Promise<void>>(),
  onSampleProgress: vi.fn(),
}));
vi.mock("@/lib/tauri", async (original) => ({ ...(await original<object>()), ...tauri }));

const added = (over: Partial<SampleFolder> = {}): SampleFolder => ({
  id: "aaaaaaaaaaaa",
  name: "Drum Kits",
  kind: "linked",
  path: "/Music/Drum Kits",
  available: true,
  fileCount: 1204,
  addedMs: 1,
  ...over,
});
const scan = (over: Partial<FolderScan> = {}): FolderScan => ({
  fileCount: 412,
  skipped: 12,
  totalBytes: 412 * 1024 * 1024,
  subfolders: 38,
  ...over,
});
const report = (over: Partial<ArchiveReport> = {}): ArchiveReport => ({
  name: "Loops-Vol2.zip",
  sizeBytes: 640 * 1024 * 1024,
  audioFiles: 214,
  skippedFiles: 31,
  unpackedBytes: 1.1 * 1024 ** 3,
  safe: true,
  problem: null,
  ...over,
});

let progress: (p: SampleProgress) => void = () => {};

function setup() {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();
  const ui = renderWithProviders(
    <AddSamplesDialog open onOpenChange={onOpenChange} onAdded={onAdded} />,
  );
  return { ...ui, onOpenChange, onAdded };
}

const dialog = () => screen.getByRole("dialog");
const next = (name: RegExp | string) => screen.getByRole("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
  tauri.onSampleProgress.mockImplementation(async (handler) => {
    progress = handler;
    return () => {};
  });
  tauri.cancelSampleJob.mockResolvedValue();
});

describe("AddSamplesDialog", () => {
  it("starts on the source step with the four ways to bring samples in", async () => {
    setup();
    expect(dialog()).toHaveAccessibleName("Add samples");
    const radios = within(screen.getByRole("radiogroup", { name: "Source" })).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Link a folder"),
      expect.stringContaining("Import a folder"),
      expect.stringContaining("Import an archive"),
      expect.stringContaining("Add audio files"),
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent(/Source.*Review.*Done/);
  });

  it("shows the Samples logo in the header and keeps the title for screen readers", () => {
    setup();
    expect(screen.getByTestId("add-samples-logo")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("dialog", { name: "Add samples" })).toBeInTheDocument();
    expect(screen.getByText("Add samples", { selector: "h2" })).toHaveClass("sr-only");
  });

  describe("audio files", () => {
    const picked = ["/Music/kick.wav", "/Music/Loops/snare.FLAC", "/Music/notes.txt"];

    async function toReview() {
      tauri.pickSampleFiles.mockResolvedValue(picked);
      const ui = setup();
      await ui.user.click(screen.getByTestId("source-files"));
      await ui.user.click(next("Continue"));
      return ui;
    }

    it("lists the audio that was chosen, says it will be copied and names the new folder", async () => {
      const { user } = await toReview();
      expect(screen.getByRole("heading", { name: "Add audio files" })).toBeInTheDocument();
      expect(screen.getByTestId("chosen-path")).toHaveTextContent("No files chosen");
      expect(next("Copy files")).toBeDisabled();
      await user.click(next("Choose files…"));
      expect(await screen.findByText("2 samples will be copied")).toBeInTheDocument();
      const names = within(screen.getByRole("list", { name: "Chosen files" })).getAllByRole(
        "listitem",
      );
      expect(names.map((n) => n.textContent)).toEqual(["kick.wav", "snare.FLAC"]);
      expect(screen.getByText("1 skipped (not audio)")).toBeInTheDocument();
      expect(
        screen.getByText(/The files are copied\. The originals stay where they are/),
      ).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Imported samples");
      expect(next("Copy files")).toBeEnabled();
    });

    it("copies the files into a folder with the edited name, then is done", async () => {
      tauri.importSampleFiles.mockResolvedValue(
        added({ name: "My picks", kind: "imported", path: null, fileCount: 2 }),
      );
      const { user, onAdded } = await toReview();
      await user.click(next("Choose files…"));
      const name = await screen.findByRole("textbox", { name: "Folder name" });
      await user.clear(name);
      await user.type(name, "My picks");
      await user.click(next("Copy files"));
      expect(tauri.importSampleFiles).toHaveBeenCalledWith(
        ["/Music/kick.wav", "/Music/Loops/snare.FLAC"],
        "My picks",
        expect.any(String),
      );
      expect(tauri.linkSampleFolder).not.toHaveBeenCalled();
      expect(tauri.importSampleFolder).not.toHaveBeenCalled();
      expect(await screen.findByRole("heading", { name: "My picks is ready" })).toBeInTheDocument();
      expect(onAdded).toHaveBeenCalledTimes(1);
    });

    it("names the folder after a single file and keeps a name the user typed", async () => {
      tauri.pickSampleFiles.mockResolvedValueOnce(["/Music/Big Kick.wav"]);
      const { user } = setup();
      await user.click(screen.getByTestId("source-files"));
      await user.click(next("Continue"));
      await user.click(next("Choose files…"));
      const name = await screen.findByRole("textbox", { name: "Folder name" });
      expect(name).toHaveValue("Big Kick");
      await user.clear(name);
      await user.type(name, "Mine");
      tauri.pickSampleFiles.mockResolvedValueOnce(picked);
      await user.click(next("Choose files…"));
      await screen.findByText("2 samples will be copied");
      expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("Mine");
    });

    it("will not copy a choice with no audio in it", async () => {
      tauri.pickSampleFiles.mockResolvedValue(["/Music/notes.txt"]);
      const { user } = setup();
      await user.click(screen.getByTestId("source-files"));
      await user.click(next("Continue"));
      await user.click(next("Choose files…"));
      expect(await screen.findByText("No audio files in that choice")).toBeInTheDocument();
      expect(next("Copy files")).toBeDisabled();
    });

    it("shows progress and can cancel the copy", async () => {
      let finish: (f: SampleFolder) => void = () => {};
      tauri.importSampleFiles.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const { user, onAdded } = await toReview();
      await user.click(next("Choose files…"));
      await screen.findByText("2 samples will be copied");
      await user.click(next("Copy files"));
      const jobId = tauri.importSampleFiles.mock.calls[0]![2];
      act(() => progress({ jobId, phase: "copying", done: 1, total: 4 }));
      expect(screen.getByRole("progressbar", { name: "Copying" })).toHaveAttribute(
        "aria-valuenow",
        "25",
      );
      expect(screen.getByRole("textbox", { name: "Folder name" })).toBeDisabled();
      await user.click(next("Cancel copying"));
      expect(tauri.cancelSampleJob).toHaveBeenCalledWith(jobId);
      act(() => finish(added({ kind: "imported", path: null, fileCount: 2 })));
      await waitFor(() => expect(onAdded).toHaveBeenCalled());
    });

    it("stays on the review step when the copy is cancelled", async () => {
      tauri.importSampleFiles.mockRejectedValue({ kind: "io", message: "Cancelled." });
      const { user, onAdded } = await toReview();
      await user.click(next("Choose files…"));
      await screen.findByText("2 samples will be copied");
      await user.click(next("Copy files"));
      await waitFor(() => expect(next("Copy files")).toBeEnabled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onAdded).not.toHaveBeenCalled();
    });

    it("has no accessibility violations on the review step", async () => {
      const { user } = await toReview();
      await user.click(next("Choose files…"));
      await screen.findByText("2 samples will be copied");
      await expectNoA11yViolations(dialog());
    });
  });

  it("links a folder: choose, review what was found, add, done", async () => {
    tauri.pickSampleFolder.mockResolvedValue("/Music/Drum Kits");
    tauri.scanSampleFolder.mockResolvedValue(
      scan({ fileCount: 1204, totalBytes: 6.4 * 1024 ** 3 }),
    );
    tauri.linkSampleFolder.mockResolvedValue(added());
    const { user, onAdded, onOpenChange } = setup();
    await user.click(next("Continue"));
    expect(screen.getByRole("heading", { name: "Link a folder" })).toBeInTheDocument();
    expect(next("Add folder")).toBeDisabled();
    await user.click(next("Choose folder…"));
    expect(await screen.findByText("1,204 samples found")).toBeInTheDocument();
    expect(screen.getByTestId("chosen-path")).toHaveTextContent("/Music/Drum Kits");
    expect(
      screen.getByText(/38 subfolders · 12 skipped \(not audio\) · 6.4 GB/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Files stay where they are/)).toBeInTheDocument();
    await user.click(next("Add folder"));
    expect(tauri.linkSampleFolder).toHaveBeenCalledWith("/Music/Drum Kits");
    expect(tauri.importSampleFolder).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Drum Kits is ready" })).toBeInTheDocument();
    expect(onAdded).toHaveBeenCalledWith(added());
    await user.click(next("Show samples"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("will not add a folder that has no audio in it", async () => {
    tauri.pickSampleFolder.mockResolvedValue("/Documents");
    tauri.scanSampleFolder.mockResolvedValue(scan({ fileCount: 0 }));
    const { user } = setup();
    await user.click(next("Continue"));
    await user.click(next("Choose folder…"));
    expect(await screen.findByText("No audio files found in that folder")).toBeInTheDocument();
    expect(next("Add folder")).toBeDisabled();
  });

  it("imports a folder with progress and can cancel the copy", async () => {
    tauri.pickSampleFolder.mockResolvedValue("/Music/Drum Kits");
    tauri.scanSampleFolder.mockResolvedValue(scan());
    let finish: (f: SampleFolder) => void = () => {};
    tauri.importSampleFolder.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { user, onAdded } = setup();
    await user.click(screen.getByTestId("source-folder"));
    await user.click(next("Continue"));
    await user.click(next("Choose folder…"));
    await screen.findByText("412 samples found");
    await user.click(next("Copy files"));
    const [path, jobId] = tauri.importSampleFolder.mock.calls[0]!;
    expect(path).toBe("/Music/Drum Kits");
    act(() => progress({ jobId, phase: "copying", done: 50, total: 200 }));
    expect(screen.getByRole("progressbar", { name: "Copying" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    // Another job's progress is not ours.
    act(() => progress({ jobId: "other", phase: "copying", done: 200, total: 200 }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    await user.click(next("Cancel copying"));
    expect(tauri.cancelSampleJob).toHaveBeenCalledWith(jobId);
    act(() => finish(added({ kind: "imported", path: null, fileCount: 412 })));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });

  it("shows why an unsafe archive was refused and offers no way to add it", async () => {
    tauri.pickSampleArchive.mockResolvedValue("/Downloads/evil.zip");
    tauri.inspectSampleArchive.mockResolvedValue(
      report({
        safe: false,
        audioFiles: 0,
        problem: "The archive has paths that point outside the target folder.",
      }),
    );
    const { user } = setup();
    await user.click(screen.getByTestId("source-archive"));
    await user.click(next("Continue"));
    await user.click(next("Choose archive…"));
    expect(await screen.findByText("Archive was not unpacked")).toBeInTheDocument();
    expect(screen.getByText(/point outside the target folder/)).toBeInTheDocument();
    expect(screen.getByText("Nothing was written.")).toBeInTheDocument();
    expect(next("Unpack and add")).toBeDisabled();
    expect(tauri.importSampleArchive).not.toHaveBeenCalled();
  });

  it("unpacks a safe archive after showing what is inside", async () => {
    tauri.pickSampleArchive.mockResolvedValue("/Downloads/Loops-Vol2.zip");
    tauri.inspectSampleArchive.mockResolvedValue(report());
    tauri.importSampleArchive.mockResolvedValue(
      added({ name: "Loops-Vol2", kind: "archive", path: null, fileCount: 214 }),
    );
    const { user, onAdded } = setup();
    await user.click(screen.getByTestId("source-archive"));
    await user.click(next("Continue"));
    await user.click(next("Choose archive…"));
    expect(await screen.findByText("Loops-Vol2.zip: 214 samples")).toBeInTheDocument();
    expect(screen.getByText(/31 other files will be skipped/)).toBeInTheDocument();
    await user.click(next("Unpack and add"));
    expect(await screen.findByRole("heading", { name: "Loops-Vol2 is ready" })).toBeInTheDocument();
    expect(tauri.importSampleArchive).toHaveBeenCalledWith(
      "/Downloads/Loops-Vol2.zip",
      expect.any(String),
    );
    expect(onAdded).toHaveBeenCalledTimes(1);
    await user.click(next("Add another"));
    expect(screen.getByRole("heading", { name: "Where are your samples?" })).toBeInTheDocument();
  });

  it("keeps the choice when the user cancels the file chooser, and shows failures", async () => {
    tauri.pickSampleFolder.mockResolvedValueOnce(null);
    const { user } = setup();
    await user.click(next("Continue"));
    await user.click(next("Choose folder…"));
    expect(screen.getByTestId("chosen-path")).toHaveTextContent("No folder chosen");
    tauri.pickSampleFolder.mockResolvedValue("/Music/Gone");
    tauri.scanSampleFolder.mockRejectedValue({
      kind: "not-found",
      message: "That folder does not exist.",
    });
    await user.click(next("Choose folder…"));
    expect(await screen.findByRole("alert")).toHaveTextContent("That folder does not exist.");
    expect(next("Add folder")).toBeDisabled();
  });

  it("goes back to the source step and Close leaves the dialog", async () => {
    const { user, onOpenChange } = setup();
    await user.click(next("Continue"));
    await user.click(next("Back"));
    expect(screen.getByRole("heading", { name: "Where are your samples?" })).toBeInTheDocument();
    const footerClose = screen
      .getAllByRole("button", { name: "Close" })
      .find((b) => b.textContent === "Close")!;
    await user.click(footerClose);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stops a running copy when the dialog is closed", async () => {
    tauri.pickSampleFolder.mockResolvedValue("/Music/Drum Kits");
    tauri.scanSampleFolder.mockResolvedValue(scan());
    tauri.importSampleFolder.mockReturnValue(new Promise(() => {}));
    const { user, unmount } = setup();
    await user.click(screen.getByTestId("source-folder"));
    await user.click(next("Continue"));
    await user.click(next("Choose folder…"));
    await screen.findByText("412 samples found");
    await user.click(next("Copy files"));
    const jobId = tauri.importSampleFolder.mock.calls[0]![1];
    unmount();
    expect(tauri.cancelSampleJob).toHaveBeenCalledWith(jobId);
  });

  it("has no accessibility violations on the source and review steps", async () => {
    tauri.pickSampleFolder.mockResolvedValue("/Music/Drum Kits");
    tauri.scanSampleFolder.mockResolvedValue(scan());
    const { user } = setup();
    await expectNoA11yViolations(dialog());
    await user.click(next("Continue"));
    await user.click(next("Choose folder…"));
    await screen.findByText("412 samples found");
    await expectNoA11yViolations(dialog());
  });
});
