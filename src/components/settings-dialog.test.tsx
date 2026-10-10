import { screen, waitFor } from "@testing-library/react";

import { SettingsDialog } from "@/components/settings-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";

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
  });

  it("closes with Escape", async () => {
    mockTauri();
    const { user, onOpenChange } = renderSettings();
    await screen.findByText(/does not collect/);
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
