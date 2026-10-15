import { act, renderHook, waitFor } from "@testing-library/react";
import { usePlugins } from "@/hooks/use-plugins";
import type { EffectSlot } from "@/lib/audio/effects";
import { mockTauri } from "@/test/tauri";

const chain: EffectSlot[] = [
  {
    type: "plugin",
    format: "clap",
    path: "/plugins/gain.clap",
    name: "Gain",
    state: "",
    enabled: true,
  },
];

afterEach(() => vi.useRealTimers());

it("turns off existing plugin blocks, clears status, and stops polling", async () => {
  localStorage.setItem("smart-beat.plugins-enabled", "1");
  let enabled = false;
  const calls = mockTauri({
    plugins_set_enabled: (args) => {
      enabled = (args as { enabled: boolean }).enabled;
    },
    plugins_enabled: () => enabled,
    audio_plugin_info: () => [
      { index: 0, name: "Gain", latencySamples: 64, alive: true, error: "" },
    ],
  });
  const { result } = renderHook(() => usePlugins({ track: 0 }, 1, chain));
  await waitFor(() => expect(result.current.info.size).toBe(1));
  expect(enabled).toBe(true);
  act(() => result.current.setEnabled(false));
  await waitFor(() => expect(enabled).toBe(false));
  expect(result.current.info.size).toBe(0);
  expect(localStorage.getItem("smart-beat.plugins-enabled")).toBe("0");
  const polls = calls.filter((call) => call.cmd === "audio_plugin_info").length;
  vi.useFakeTimers();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(calls.filter((call) => call.cmd === "audio_plugin_info")).toHaveLength(polls);
});

it("reports crashes after the initial status and addresses the selected track and sound", async () => {
  localStorage.setItem("smart-beat.plugins-enabled", "1");
  let error = "";
  const calls = mockTauri({
    plugins_set_enabled: () => null,
    plugins_enabled: () => true,
    audio_plugin_info: () => [{ index: 0, name: "Gain", latencySamples: 64, alive: !error, error }],
  });
  vi.useFakeTimers();
  const { result, rerender, unmount } = renderHook(
    ({ track, sound }) => usePlugins({ track }, sound, chain),
    { initialProps: { track: 0, sound: 0 } },
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(result.current.info.get(0)?.alive).toBe(true);
  error = "The plugin helper timed out";
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(result.current.info.get(0)).toMatchObject({ alive: false, error });
  rerender({ track: 1, sound: 2 });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(calls.filter((call) => call.cmd === "audio_plugin_info").at(-1)?.args).toEqual({
    track: 1,
    sound: 2,
  });
  unmount();
  const count = calls.length;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(calls).toHaveLength(count);
});
