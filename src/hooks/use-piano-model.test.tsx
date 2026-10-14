import { act, renderHook, waitFor } from "@testing-library/react";

import { usePianoModel } from "@/hooks/use-piano-model";
import { downloadPianoModel, pianoModelStatus } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  pianoModelStatus: vi.fn(),
  downloadPianoModel: vi.fn(),
}));

const BYTES = 56_799_421;

beforeEach(() => {
  vi.mocked(pianoModelStatus).mockResolvedValue({ installed: false, bytes: BYTES });
  vi.mocked(downloadPianoModel).mockResolvedValue();
});
afterEach(() => vi.clearAllMocks());

describe("usePianoModel", () => {
  it("looks the model up only while it is wanted", async () => {
    const { result, rerender } = renderHook(({ on }) => usePianoModel(on), {
      initialProps: { on: false },
    });
    expect(pianoModelStatus).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    rerender({ on: true });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toMatchObject({ installed: false, bytes: BYTES, progress: null });
  });

  it("stays unready when the status cannot be read", async () => {
    vi.mocked(pianoModelStatus).mockRejectedValue(new Error("no"));
    const { result } = renderHook(() => usePianoModel(true));
    await waitFor(() => expect(pianoModelStatus).toHaveBeenCalled());
    expect(result.current.ready).toBe(false);
  });

  it("downloads once, shows the progress and then reports the model installed", async () => {
    let finish!: () => void;
    vi.mocked(downloadPianoModel).mockImplementation(
      (onProgress) =>
        new Promise<void>((resolve) => {
          onProgress?.(0.5);
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => usePianoModel(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      result.current.download();
      result.current.download();
    });
    expect(downloadPianoModel).toHaveBeenCalledTimes(1);
    expect(result.current.progress).toBe(0.5);
    vi.mocked(pianoModelStatus).mockResolvedValue({ installed: true, bytes: BYTES });
    await act(async () => finish());
    await waitFor(() => expect(result.current.installed).toBe(true));
    expect(result.current.progress).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reports why a download failed and allows another try", async () => {
    vi.mocked(downloadPianoModel).mockRejectedValueOnce({
      kind: "audio",
      message: "The downloaded piano model is not the expected file. Try again later.",
    });
    const { result } = renderHook(() => usePianoModel(true));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.download());
    await waitFor(() => expect(result.current.error).toMatch(/not the expected file/));
    expect(result.current.installed).toBe(false);
    expect(result.current.progress).toBeNull();
    act(() => result.current.download());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(downloadPianoModel).toHaveBeenCalledTimes(2);
  });
});
