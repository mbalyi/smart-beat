import { audioDurationMs } from "./duration";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("cleans up media URLs and gives duration decoding a deadline", async () => {
  vi.useFakeTimers();
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:recording", revokeObjectURL: revoke });
  vi.stubGlobal(
    "Audio",
    class {
      preload = "";
      src = "";
      onloadedmetadata = null;
      onerror = null;
      removeAttribute() {}
    },
  );
  const pending = audioDurationMs(new File(["audio"], "recording.wav"));
  const assertion = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
  expect(revoke).toHaveBeenCalledWith("blob:recording");
});
