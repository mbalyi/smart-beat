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
      { index: 0, name: "Gain", latencySamples: 64, latencyMs: 1.3, alive: true, error: "" },
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
    audio_plugin_info: () => [
      { index: 0, name: "Gain", latencySamples: 64, latencyMs: 1.3, alive: !error, error },
    ],
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

it("describes a plugin with its added latency in milliseconds", async () => {
  localStorage.setItem("smart-beat.plugins-enabled", "1");
  mockTauri({
    plugins_set_enabled: () => null,
    plugins_enabled: () => true,
    audio_plugin_info: () => [
      { index: 0, name: "Gain", latencySamples: 64, latencyMs: 1.3, alive: true, error: "" },
    ],
  });
  const { result } = renderHook(() => usePlugins({ track: 0 }, 1, chain));
  await waitFor(() => expect(result.current.info.size).toBe(1));
  const slot = chain[0] as Extract<EffectSlot, { type: "plugin" }>;
  expect(result.current.describe(slot, 0)).toBe("Gain · +1.3 ms");
});

it("stays applying until the newest opt-in change reaches the backend", async () => {
  localStorage.setItem("smart-beat.plugins-enabled", "0");
  const pending: (() => void)[] = [];
  mockTauri({
    plugins_set_enabled: () => new Promise<void>((resolve) => pending.push(resolve)),
    plugins_enabled: () => false,
    audio_plugin_info: () => [],
  });
  const { result } = renderHook(() => usePlugins({ track: 0 }, 1, []));
  await waitFor(() => expect(result.current.applying).toBe(true));
  act(() => result.current.setEnabled(true));
  expect(result.current.applying).toBe(true);
  // The first call settling must not clear the spinner of the newer one.
  await act(async () => {
    pending[0]?.();
    await Promise.resolve();
  });
  expect(result.current.applying).toBe(true);
  await act(async () => {
    pending[1]?.();
    await Promise.resolve();
  });
  await waitFor(() => expect(result.current.applying).toBe(false));
});

it("addresses monitor plugin status, editor and presets independently of score tracks", async () => {
  localStorage.setItem("smart-beat.plugins-enabled", "1");
  const calls = mockTauri({
    plugins_set_enabled: () => null,
    plugins_enabled: () => true,
    audio_plugin_info: () => [
      { index: 0, name: "Gain", latencySamples: 64, latencyMs: 1.3, alive: true, error: "" },
    ],
    plugin_open_editor: () => [800, 600],
    plugin_save_state: () => "cHJlc2V0",
  });
  const { result } = renderHook(() => usePlugins({ track: "monitor" }, 0, chain));
  await waitFor(() => expect(result.current.info.size).toBe(1));
  expect(await result.current.openEditor(0)).toBeNull();
  expect(await result.current.saveState(0)).toEqual({ state: "cHJlc2V0" });
  for (const cmd of ["audio_plugin_info", "plugin_open_editor", "plugin_save_state"]) {
    expect(calls.find((call) => call.cmd === cmd)?.args).toEqual({
      track: "monitor",
      sound: 0,
      ...(cmd !== "audio_plugin_info" && { index: 0 }),
    });
  }
});
