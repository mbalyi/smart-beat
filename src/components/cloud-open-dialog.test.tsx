import { screen } from "@testing-library/react";

import { CloudOpenDialog } from "@/components/cloud-open-dialog";
import { cloudItemName } from "@/lib/cloud-items";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const item = (name: string, modified_ms: number, size = 2048) => ({
  id: `drive:${name}`,
  name,
  revision: "1",
  size,
  modified_ms,
});

function setup() {
  const onOpenChange = vi.fn();
  const onPick = vi.fn();
  const view = renderWithProviders(
    <CloudOpenDialog
      provider="drive"
      label="Google Drive"
      open
      onOpenChange={onOpenChange}
      onPick={onPick}
    />,
  );
  return { ...view, onOpenChange, onPick };
}

describe("CloudOpenDialog", () => {
  beforeEach(() => localStorage.clear());

  it("lists the newest tab first and shows size", async () => {
    mockTauri({
      cloud_list: () => [
        item("old.gp", 1000),
        item("new.gp", Date.now() - 60_000, 3 * 1024 * 1024),
      ],
    });
    setup();

    const rows = await screen.findAllByTestId("cloud-open-item");
    expect(rows.map((r) => r.getAttribute("title"))).toEqual(["new.gp", "old.gp"]);
    expect(rows[0]).toHaveTextContent("3.0 MB");
    expect(screen.getByRole("heading", { name: "Open from Google Drive" })).toBeInTheDocument();
  });

  it("picks a tab, remembers its name and closes", async () => {
    mockTauri({ cloud_list: () => [item("riff.gp", 5)] });
    const { user, onPick, onOpenChange } = setup();

    await user.click(await screen.findByRole("button", { name: /riff\.gp/ }));
    expect(onPick).toHaveBeenCalledWith("drive:riff.gp");
    expect(cloudItemName("drive:riff.gp")).toBe("riff.gp");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hands over an item id even when the backend lists a bare Drive id (regression)", async () => {
    mockTauri({
      cloud_list: () => [{ ...item("riff.gp", 5), id: "1aVLa7Sl-Qy5CKCMKJi5DyKlUjdH_G4pK" }],
    });
    const { user, onPick } = setup();

    await user.click(await screen.findByRole("button", { name: /riff\.gp/ }));
    expect(onPick).toHaveBeenCalledWith("drive:1aVLa7Sl-Qy5CKCMKJi5DyKlUjdH_G4pK");
  });

  it("explains an empty drive", async () => {
    mockTauri({ cloud_list: () => [] });
    setup();
    expect(
      await screen.findByText(
        "No tabs saved to Google Drive yet. Use Save As › Google Drive to add one.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an error and retries", async () => {
    let fail = true;
    mockTauri({
      cloud_list: () => {
        if (fail) throw { kind: "network", message: "down" };
        return [item("back.gp", 5)];
      },
    });
    const { user } = setup();

    expect(await screen.findByRole("alert")).toHaveTextContent(/can't be reached/);
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /back\.gp/ })).toBeInTheDocument();
  });

  it("asks to reconnect when the sign-in expired", async () => {
    mockTauri({
      cloud_list: () => {
        throw { kind: "auth-expired", message: "expired" };
      },
    });
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reconnect Google Drive in Settings",
    );
  });

  it("has no accessibility violations", async () => {
    mockTauri({ cloud_list: () => [item("riff.gp", 5)] });
    setup();
    await screen.findByRole("button", { name: /riff\.gp/ });
    await expectNoA11yViolations(screen.getByRole("dialog"));
  });
});
