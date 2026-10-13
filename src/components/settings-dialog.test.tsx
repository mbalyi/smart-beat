import { act, screen, waitFor } from "@testing-library/react";

import { SettingsDialog } from "@/components/settings-dialog";
import {
  readAudioInput,
  readAudioInputChannel,
  storeAudioInput,
  storeAudioInputChannel,
} from "@/lib/audio/input";
import { expectNoA11yViolations } from "@/test/axe";
import { installMediaDevices } from "@/test/media-devices";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";

const BUILT_IN = { deviceId: "built-in", label: "MacBook Pro Microphone" };
const SCARLETT = { deviceId: "scarlett", label: "Scarlett 2i2 USB" };

function renderSettings() {
  const onOpenChange = vi.fn();
  return {
    ...renderWithProviders(<SettingsDialog open onOpenChange={onOpenChange} />),
    onOpenChange,
  };
}

describe("SettingsDialog", () => {
  it("offers the usage counters switch in a build that can send them", async () => {
    mockTauri();
    backend.usage = { enabled: true, available: true, noticeSeen: true };
    renderSettings();

    const toggle = await screen.findByRole("switch", { name: "Share anonymous usage counts" });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/no identifier/);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("switches the counters off and on, saving each change", async () => {
    const calls = mockTauri();
    backend.usage = { enabled: true, available: true, noticeSeen: true };
    const { user } = renderSettings();

    const toggle = await screen.findByRole("switch");
    await user.click(toggle);
    await waitFor(() => expect(backend.usage.enabled).toBe(false));
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(backend.usage.enabled).toBe(true));
    expect(calls.filter((c) => c.cmd === "set_usage_settings")).toHaveLength(2);
  });

  it("puts the switch back and says so when the setting can't be saved", async () => {
    mockTauri({
      set_usage_settings: () => {
        throw { kind: "io", message: "disk on fire" };
      },
    });
    backend.usage = { enabled: true, available: true, noticeSeen: true };
    const { user } = renderSettings();

    const toggle = await screen.findByRole("switch");
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The setting could not be saved. disk on fire",
    );
    expect(toggle).toBeChecked();
  });

  it("says so when this version collects nothing", async () => {
    mockTauri();
    renderSettings();

    expect(await screen.findByText(/does not collect any usage statistics/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("explains an unavailable settings store", async () => {
    mockTauri({
      get_usage_settings: () => {
        throw { kind: "io", message: "no access" };
      },
    });
    renderSettings();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Settings are unavailable/);
  });

  it("is unavailable in a browser", async () => {
    renderSettings();
    expect(await screen.findByText(/does not collect any usage statistics/)).toBeInTheDocument();
    expect(await screen.findByText("Audio inputs are not available here.")).toBeInTheDocument();
  });

  it("closes with Escape", async () => {
    mockTauri();
    const { user, onOpenChange } = renderSettings();
    await screen.findByText(/does not collect/);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("SettingsDialog: audio input", () => {
  const input = () => screen.findByRole("combobox", { name: "Input" });
  const options = async (user: ReturnType<typeof renderSettings>["user"]) => {
    await user.click(await input());
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent);
    await user.keyboard("{Escape}");
    return names;
  };

  it("lists the inputs and remembers the one chosen for the whole app", async () => {
    installMediaDevices({ inputs: [BUILT_IN, SCARLETT] });
    const { user } = renderSettings();

    expect(await input()).toHaveTextContent("System default");
    expect(await input()).toHaveAccessibleDescription(
      /What the tuner and the monitor track listen to/,
    );
    expect(screen.getByRole("region", { name: "Audio" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all inputs" })).not.toBeInTheDocument();
    // The channel is for the monitor track, which needs the desktop app.
    expect(screen.queryByRole("combobox", { name: "Channel" })).not.toBeInTheDocument();
    await expectNoA11yViolations();

    await user.click(await input());
    await user.click(await screen.findByRole("option", { name: "Scarlett 2i2 USB" }));
    expect(readAudioInput()).toEqual(SCARLETT);
    expect(await input()).toHaveTextContent("Scarlett 2i2 USB");

    await user.click(await input());
    await user.click(await screen.findByRole("option", { name: "System default" }));
    expect(readAudioInput()).toBeNull();
  });

  it("shows all inputs once Smart Beat may use the microphone, and lets go of it", async () => {
    const devices = installMediaDevices({ inputs: [BUILT_IN, SCARLETT], hidden: true });
    const { user } = renderSettings();

    expect(await options(user)).toEqual(["System default"]);
    await expectNoA11yViolations();
    await user.click(screen.getByRole("button", { name: "Show all inputs" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Show all inputs" })).not.toBeInTheDocument(),
    );
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(devices.stop).toHaveBeenCalledTimes(1);
    expect(await options(user)).toEqual(["System default", BUILT_IN.label, SCARLETT.label]);
  });

  it("explains how to allow the microphone when showing all inputs is blocked", async () => {
    installMediaDevices({ inputs: [BUILT_IN], hidden: true, denied: true });
    const { user } = renderSettings();

    await user.click(await screen.findByRole("button", { name: "Show all inputs" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Privacy & Security › Microphone/);
  });

  it("keeps a chosen input that is unplugged, and finds it again when it is plugged in", async () => {
    storeAudioInput(SCARLETT);
    const devices = installMediaDevices({ inputs: [BUILT_IN] });
    const { user } = renderSettings();

    expect(await input()).toHaveTextContent("Scarlett 2i2 USB (not connected)");
    act(() => devices.setInputs([BUILT_IN, SCARLETT]));
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent(/^Scarlett 2i2 USB$/),
    );
    expect(await options(user)).toEqual(["System default", BUILT_IN.label, SCARLETT.label]);
  });

  it("shows the chosen input by name while the names are hidden", async () => {
    storeAudioInput(SCARLETT);
    installMediaDevices({ inputs: [BUILT_IN, SCARLETT], hidden: true });
    renderSettings();
    expect(await input()).toHaveTextContent(/^Scarlett 2i2 USB$/);
  });

  it("knows an input again by its name when its id changed", async () => {
    storeAudioInput({ deviceId: "old-id", label: SCARLETT.label });
    installMediaDevices({ inputs: [BUILT_IN, SCARLETT] });
    const { user } = renderSettings();
    expect(await input()).toHaveTextContent(/^Scarlett 2i2 USB$/);
    expect(await options(user)).toEqual(["System default", BUILT_IN.label, SCARLETT.label]);
  });
});

describe("SettingsDialog: input channel (the monitor track's)", () => {
  const channel = () => screen.findByRole("combobox", { name: "Channel" });

  it("chooses the channel of a multi-input interface, in the desktop app", async () => {
    const calls = mockTauri({ audio_input_channels: () => 2 });
    storeAudioInput(SCARLETT);
    installMediaDevices({ inputs: [BUILT_IN, SCARLETT] });
    const { user } = renderSettings();

    expect(await channel()).toHaveTextContent("Input 1");
    expect(await channel()).toHaveAccessibleDescription(/What the monitor track plays/);
    expect(calls.find((c) => c.cmd === "audio_input_channels")?.args).toEqual({
      device: "Scarlett 2i2 USB",
    });
    await expectNoA11yViolations();

    await user.click(await channel());
    await user.click(await screen.findByRole("option", { name: "Input 2" }));
    expect(readAudioInputChannel()).toBe(1);
    await user.click(await channel());
    await user.click(await screen.findByRole("option", { name: "All inputs mixed" }));
    expect(readAudioInputChannel()).toBeNull();
  });

  it("starts another input on its first channel", async () => {
    mockTauri({ audio_input_channels: () => 2 });
    storeAudioInput(SCARLETT);
    storeAudioInputChannel(1);
    installMediaDevices({ inputs: [BUILT_IN, SCARLETT] });
    const { user } = renderSettings();

    await user.click(await screen.findByRole("combobox", { name: "Input" }));
    await user.click(await screen.findByRole("option", { name: BUILT_IN.label }));
    expect(readAudioInputChannel()).toBe(0);
  });

  it("has no channel choice for an input with one channel, nor in the browser", async () => {
    const calls = mockTauri({ audio_input_channels: () => 1 });
    installMediaDevices({ inputs: [BUILT_IN] });
    renderSettings();
    await screen.findByRole("combobox", { name: "Input" });
    await waitFor(() => expect(calls.some((c) => c.cmd === "audio_input_channels")).toBe(true));
    expect(screen.queryByRole("combobox", { name: "Channel" })).not.toBeInTheDocument();
  });
});
