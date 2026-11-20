import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SamplesPanel, type SamplesPanelProps } from "@/components/samples/samples-panel";
import type { SampleFile, SampleFolder } from "@/lib/samples/types";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const tauri = vi.hoisted(() => ({
  listSampleFolders: vi.fn<() => Promise<SampleFolder[]>>(),
  listSampleFiles: vi.fn<(id: string) => Promise<SampleFile[]>>(),
  probeSampleFiles: vi.fn<(id: string, rels: string[]) => Promise<SampleFile[]>>(),
  startSamplePreview: vi.fn<(id: string, rel: string, volume: number) => Promise<void>>(),
  stopSamplePreview: vi.fn<() => Promise<void>>(),
  setSamplePreviewVolume: vi.fn<(volume: number) => Promise<void>>(),
  onSamplePreviewEnded: vi.fn(),
  onSampleProgress: vi.fn(),
  removeSampleFolder: vi.fn<(id: string, deleteCopy: boolean) => Promise<void>>(),
  relinkSampleFolder: vi.fn(),
  pickSampleFolder: vi.fn(),
}));
vi.mock("@/lib/tauri", async (original) => ({ ...(await original<object>()), ...tauri }));

const folder = (over: Partial<SampleFolder> = {}): SampleFolder => ({
  id: "aaaaaaaaaaaa",
  name: "Drum Kits",
  kind: "linked",
  path: "/Music/Drum Kits",
  available: true,
  fileCount: null,
  addedMs: 1,
  ...over,
});

const sample = (name: string, over: Partial<SampleFile> = {}): SampleFile => ({
  rel: `${name}.wav`,
  name,
  ext: "wav",
  sizeBytes: 1000,
  modifiedMs: 1,
  durationMs: 420,
  sampleRate: 44_100,
  channels: 1,
  peaks: Array.from({ length: 96 }, (_, i) => (i * 7) % 255),
  ...over,
});

const FILES = [sample("Kick_Punch_01"), sample("Snare_Crack"), sample("Hat_Closed")];

function setup(props: Partial<SamplesPanelProps> = {}) {
  const handlers = {
    ensureEngine: vi.fn(() => true),
    onInsert: vi.fn(),
    onDragPoint: vi.fn(),
    onDropSample: vi.fn(),
  };
  const ui = renderWithProviders(
    <div style={{ height: 600 }}>
      <SamplesPanel insertAt="the position line" {...handlers} {...props} />
    </div>,
  );
  return { ...ui, ...handlers };
}

const rows = () => screen.queryAllByTestId("sample-row");
const names = () => rows().map((r) => within(r).getByText(/_/).textContent);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  tauri.listSampleFolders.mockResolvedValue([folder()]);
  tauri.listSampleFiles.mockResolvedValue(FILES);
  tauri.probeSampleFiles.mockResolvedValue([]);
  tauri.startSamplePreview.mockResolvedValue();
  tauri.stopSamplePreview.mockResolvedValue();
  tauri.setSamplePreviewVolume.mockResolvedValue();
  tauri.onSamplePreviewEnded.mockResolvedValue(() => {});
  tauri.onSampleProgress.mockResolvedValue(() => {});
  tauri.removeSampleFolder.mockResolvedValue();
});

describe("SamplesPanel", () => {
  it("lists the files of the linked folders sorted by name, with their length", async () => {
    setup();
    await screen.findByText("Hat_Closed");
    expect(names()).toEqual(["Hat_Closed", "Kick_Punch_01", "Snare_Crack"]);
    expect(within(rows()[0]!).getByText("0.42 s · 44.1 kHz · WAV")).toBeInTheDocument();
    expect(screen.getByText("3 samples")).toBeInTheDocument();
  });

  it("shows a first-run state that offers to add samples", async () => {
    tauri.listSampleFolders.mockResolvedValue([]);
    setup();
    expect(await screen.findByTestId("samples-empty")).toHaveTextContent("No samples yet");
    expect(screen.getAllByRole("button", { name: "Add samples" })).not.toHaveLength(0);
  });

  it("filters the list as the user types and says when nothing matches", async () => {
    const { user } = setup();
    await screen.findByText("Hat_Closed");
    await user.type(screen.getByRole("searchbox", { name: "Search samples" }), "snare");
    expect(names()).toEqual(["Snare_Crack"]);
    expect(screen.getByText("1 sample of 3 samples")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search samples" }), "zzz");
    expect(screen.getByTestId("samples-none")).toHaveTextContent("Nothing matches.");
  });

  it("previews a sample on click and stops the one before", async () => {
    const { user } = setup();
    await screen.findByText("Hat_Closed");
    await user.click(rows()[1]!);
    await waitFor(() =>
      expect(tauri.startSamplePreview).toHaveBeenLastCalledWith(
        "aaaaaaaaaaaa",
        "Kick_Punch_01.wav",
        0.8,
      ),
    );
    expect(rows()[1]).toHaveAttribute("data-playing", "true");
    await user.click(rows()[2]!);
    await waitFor(() => expect(tauri.startSamplePreview).toHaveBeenCalledTimes(2));
    expect(rows()[1]).toHaveAttribute("data-playing", "false");
    expect(rows()[2]).toHaveAttribute("data-playing", "true");
  });

  it("moves with Up and Down, toggles with Space and inserts with Enter", async () => {
    const { user, onInsert } = setup();
    await screen.findByText("Hat_Closed");
    const list = screen.getByRole("listbox", { name: "Samples" });
    list.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(tauri.startSamplePreview).toHaveBeenLastCalledWith(
        "aaaaaaaaaaaa",
        "Hat_Closed.wav",
        0.8,
      ),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(tauri.startSamplePreview).toHaveBeenLastCalledWith(
        "aaaaaaaaaaaa",
        "Kick_Punch_01.wav",
        0.8,
      ),
    );
    expect(list).toHaveAttribute("aria-activedescendant", "sample-1");
    await user.keyboard(" ");
    await waitFor(() => expect(tauri.stopSamplePreview).toHaveBeenCalled());
    expect(rows()[1]).toHaveAttribute("data-playing", "false");
    await user.keyboard(" ");
    expect(rows()[1]).toHaveAttribute("data-playing", "true");
    await user.keyboard("{Enter}");
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0]![0]).toMatchObject({
      folderId: "aaaaaaaaaaaa",
      file: { name: "Kick_Punch_01" },
    });
    // Inserting ends the audition: the clip is what you hear now.
    expect(rows()[1]).toHaveAttribute("data-playing", "false");
  });

  it("inserts on double-click and with the Insert button", async () => {
    const { user, onInsert } = setup();
    await screen.findByText("Hat_Closed");
    expect(screen.getByRole("button", { name: "Insert at the position line" })).toBeDisabled();
    await user.dblClick(rows()[2]!);
    expect(onInsert.mock.calls.at(-1)![0].file.name).toBe("Snare_Crack");
    await user.click(rows()[0]!);
    await user.click(screen.getByRole("button", { name: "Insert at the position line" }));
    expect(onInsert.mock.calls.at(-1)![0].file.name).toBe("Hat_Closed");
  });

  it("does not preview when there is no engine to play it", async () => {
    const ensureEngine = vi.fn(() => false);
    const { user } = setup({ ensureEngine });
    await screen.findByText("Hat_Closed");
    await user.click(rows()[0]!);
    expect(ensureEngine).toHaveBeenCalled();
    expect(tauri.startSamplePreview).not.toHaveBeenCalled();
    expect(rows()[0]).toHaveAttribute("data-playing", "false");
  });

  it("clears the playing row when a preview ends by itself", async () => {
    let ended: (e: { folderId: string; rel: string }) => void = () => {};
    tauri.onSamplePreviewEnded.mockImplementation(async (handler) => {
      ended = handler;
      return () => {};
    });
    const { user } = setup();
    await screen.findByText("Hat_Closed");
    await user.click(rows()[0]!);
    expect(rows()[0]).toHaveAttribute("data-playing", "true");
    act(() => ended({ folderId: "aaaaaaaaaaaa", rel: "Hat_Closed.wav" }));
    expect(rows()[0]).toHaveAttribute("data-playing", "false");
  });

  it("remembers the preview volume and sends it to the engine", async () => {
    setup();
    await screen.findByText("Hat_Closed");
    fireEvent.change(screen.getByRole("slider", { name: "Preview volume" }), {
      target: { value: "35" },
    });
    expect(tauri.setSamplePreviewVolume).toHaveBeenLastCalledWith(0.35);
    expect(localStorage.getItem("smart-beat:sample-preview-volume")).toBe("0.35");
    expect(screen.getByText("35%")).toBeInTheDocument();
  });

  it("stops the preview when the panel goes away", async () => {
    const { unmount } = setup();
    await screen.findByText("Hat_Closed");
    tauri.stopSamplePreview.mockClear();
    unmount();
    expect(tauri.stopSamplePreview).toHaveBeenCalled();
  });

  it("measures the files on screen and drops the ones that cannot be decoded", async () => {
    tauri.listSampleFiles.mockResolvedValue([
      sample("Good_One", { durationMs: null, peaks: null }),
      sample("Broken_One", { durationMs: null, peaks: null }),
    ]);
    tauri.probeSampleFiles.mockResolvedValue([
      sample("Good_One", { durationMs: 1500 }),
      sample("Broken_One", { durationMs: null, peaks: null }),
    ]);
    setup();
    await waitFor(() =>
      expect(tauri.probeSampleFiles).toHaveBeenCalledWith("aaaaaaaaaaaa", [
        "Broken_One.wav",
        "Good_One.wav",
      ]),
    );
    await waitFor(() => expect(names()).toEqual(["Good_One"]));
    expect(within(rows()[0]!).getByText(/1\.5 s/)).toBeInTheDocument();
  });

  it("draws only the rows in view of a folder with thousands of files", async () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      sample(`Loop_${String(i).padStart(4, "0")}`),
    );
    tauri.listSampleFiles.mockResolvedValue(many);
    setup();
    await screen.findByText("Loop_0000");
    expect(rows().length).toBeLessThan(30);
    expect(screen.getByRole("option", { name: /Loop_0000/ })).toHaveAttribute(
      "aria-setsize",
      "5000",
    );
    const list = screen.getByTestId("sample-list");
    fireEvent.scroll(list, { target: { scrollTop: 52 * 2500 } });
    await screen.findByText("Loop_2500");
    expect(screen.queryByText("Loop_0000")).not.toBeInTheDocument();
    expect(rows().length).toBeLessThan(30);
  });

  it("warns about a linked folder that is not there and lets the user locate it", async () => {
    tauri.listSampleFolders.mockResolvedValue([folder({ available: false })]);
    tauri.pickSampleFolder.mockResolvedValue("/Volumes/Back/Drum Kits");
    tauri.relinkSampleFolder.mockResolvedValue(folder({ path: "/Volumes/Back/Drum Kits" }));
    const { user } = setup();
    expect(await screen.findByText(/was not found/)).toBeInTheDocument();
    expect(tauri.listSampleFiles).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Locate…" }));
    await waitFor(() =>
      expect(tauri.relinkSampleFolder).toHaveBeenCalledWith(
        "aaaaaaaaaaaa",
        "/Volumes/Back/Drum Kits",
      ),
    );
    await screen.findByText("Hat_Closed");
  });

  it("explains that removing a linked folder keeps the files, and asks before deleting a copy", async () => {
    tauri.listSampleFolders.mockResolvedValue([
      folder(),
      folder({ id: "bbbbbbbbbbbb", name: "Loops Vol 2", kind: "archive", path: null }),
    ]);
    tauri.listSampleFiles.mockImplementation(async (id) =>
      id === "aaaaaaaaaaaa" ? FILES : [sample("Amen_Loop")],
    );
    const { user } = setup();
    await screen.findByText("Amen_Loop");
    await user.click(screen.getByRole("button", { name: /Drum Kits/ }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Your files are not deleted/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(tauri.removeSampleFolder).toHaveBeenCalledWith("aaaaaaaaaaaa", true),
    );
    // The folder is gone from the list: the other one is shown.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Drum Kits/ })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Loops Vol 2/ }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/deletes the copy Smart Beat made/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(tauri.removeSampleFolder).toHaveBeenCalledTimes(1);
  });

  it("drags a row onto a lane: the pointer is followed and the drop is reported", async () => {
    const { user, onDragPoint, onDropSample } = setup();
    await screen.findByText("Hat_Closed");
    const row = rows()[1]!;
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 12, clientY: 11, pointerId: 1 });
    expect(onDragPoint).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { clientX: 300, clientY: 400, pointerId: 1 });
    expect(onDragPoint).toHaveBeenLastCalledWith(
      { x: 300, y: 400 },
      expect.objectContaining({ file: expect.objectContaining({ name: "Kick_Punch_01" }) }),
    );
    expect(screen.getByTestId("sample-drag-ghost")).toHaveTextContent("Kick_Punch_01");
    fireEvent.pointerUp(window, { clientX: 300, clientY: 400, pointerId: 1 });
    expect(onDropSample).toHaveBeenCalledTimes(1);
    expect(onDropSample.mock.calls[0]![1]).toEqual({ x: 300, y: 400 });
    expect(onDragPoint).toHaveBeenLastCalledWith(null, null);
    expect(screen.queryByTestId("sample-drag-ghost")).not.toBeInTheDocument();
    // The click that ends a drag does not start a preview.
    await user.click(screen.getByRole("searchbox"));
    expect(tauri.startSamplePreview).not.toHaveBeenCalled();
  });

  it("a plain press without movement is a click, and Escape cancels a drag", async () => {
    const { onDropSample } = setup();
    await screen.findByText("Hat_Closed");
    const row = rows()[0]!;
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(onDropSample).not.toHaveBeenCalled();
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 200 });
    expect(onDropSample).not.toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    setup();
    await screen.findByText("Hat_Closed");
    await expectNoA11yViolations();
  });
});
