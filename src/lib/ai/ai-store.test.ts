import {
  chooseSize,
  onInstallerReturn,
  closeInstaller,
  getAiState,
  installModel,
  openInstaller,
  refreshAi,
  resetAiStore,
  rightsDetail,
  seedAiState,
  statusWith,
  canRun,
  isInstalled,
} from "@/lib/ai/ai-store";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  muscriptorStatus: vi.fn(),
  acceptMuscriptorTerms: vi.fn(),
  downloadMuscriptorModel: vi.fn(),
  cancelMuscriptorDownload: vi.fn(),
}));
vi.mock("@/lib/tauri", () => tauri);
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
import { track } from "@/lib/telemetry";

beforeEach(() => {
  localStorage.clear();
  resetAiStore();
  vi.clearAllMocks();
  tauri.isTauri.mockReturnValue(true);
});

describe("the AI store", () => {
  it("knows nothing in a browser", async () => {
    tauri.isTauri.mockReturnValue(false);
    await refreshAi();
    expect(getAiState().ready).toBe(false);
    expect(tauri.muscriptorStatus).not.toHaveBeenCalled();
  });

  it("can run only with the terms accepted and the chosen size installed", async () => {
    tauri.muscriptorStatus.mockResolvedValue(statusWith(["small"], false));
    await refreshAi();
    expect(getAiState().ready).toBe(true);
    expect(canRun(getAiState())).toBe(false);
    seedAiState({ status: statusWith(["small"]) });
    chooseSize("medium");
    // The chosen size is not installed.
    expect(canRun(getAiState())).toBe(false);
    chooseSize("small");
    expect(canRun(getAiState())).toBe(true);
    expect(isInstalled(getAiState(), "large")).toBe(false);
  });

  it("follows what is installed when the chosen size is gone", async () => {
    chooseSize("large");
    tauri.muscriptorStatus.mockResolvedValue(statusWith(["small"]));
    await refreshAi();
    expect(getAiState().size).toBe("small");
  });

  it("remembers the chosen size", () => {
    chooseSize("large");
    resetAiStore();
    expect(getAiState().size).toBe("large");
  });

  it("records the acceptance, downloads and counts both", async () => {
    tauri.muscriptorStatus.mockResolvedValue(statusWith([], false));
    await refreshAi();
    tauri.acceptMuscriptorTerms.mockResolvedValue(statusWith([], true));
    tauri.downloadMuscriptorModel.mockImplementation(async (_size, onProgress) => {
      onProgress(0.5, 1);
      expect(getAiState().download).toEqual({ size: "medium", fraction: 0.5 });
      return statusWith(["medium"]);
    });
    await installModel("medium", true);
    expect(tauri.acceptMuscriptorTerms).toHaveBeenCalledWith(true);
    expect(track).toHaveBeenCalledWith("ai_rights_confirmed");
    expect(track).toHaveBeenCalledWith("ai_install", "medium");
    expect(getAiState().download).toBeNull();
    expect(canRun(getAiState())).toBe(true);
    expect(rightsDetail()).toBe("rights_confirmed");
  });

  it("does not count a confirmation that was refused", async () => {
    tauri.muscriptorStatus.mockResolvedValue(statusWith([], false));
    await refreshAi();
    tauri.acceptMuscriptorTerms.mockRejectedValue({ message: "Confirm your rights." });
    await installModel("medium", false);
    expect(track).not.toHaveBeenCalled();
    expect(tauri.downloadMuscriptorModel).not.toHaveBeenCalled();
    expect(getAiState().error).toBe("Confirm your rights.");
    expect(rightsDetail()).toBe("rights_unconfirmed");
  });

  it("treats a stopped download as no error", async () => {
    tauri.muscriptorStatus.mockResolvedValue(statusWith([], true));
    tauri.downloadMuscriptorModel.mockRejectedValue({ message: "Download stopped." });
    await refreshAi();
    await installModel("small", true);
    expect(getAiState().error).toBeNull();
    expect(track).not.toHaveBeenCalledWith("ai_install", "small");
  });

  it("hands the user back to the dialog that asked", () => {
    const record = vi.fn();
    const audio = vi.fn();
    onInstallerReturn("record", record);
    const stop = onInstallerReturn("audio", audio);
    openInstaller("record");
    expect(getAiState().installer).toEqual({ open: true, returnTo: "record" });
    closeInstaller();
    expect(getAiState().installer.open).toBe(false);
    expect(record).toHaveBeenCalledOnce();
    expect(audio).not.toHaveBeenCalled();
    stop();
    openInstaller("audio");
    closeInstaller();
    expect(audio).not.toHaveBeenCalled();
  });

  it("is not ready where the engine is not built in, like Linux", async () => {
    tauri.muscriptorStatus.mockResolvedValue({ ...statusWith(["medium"]), supported: false });
    await refreshAi();
    expect(getAiState().ready).toBe(false);
    expect(getAiState().unsupported).toBe(true);
    expect(canRun(getAiState())).toBe(true);
  });
});
