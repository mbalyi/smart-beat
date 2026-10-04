import { screen, within } from "@testing-library/react";

import { DrumKitDialog } from "@/components/audio/drum-kit-dialog";
import type { DrumKit, KitImportOptions } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const KIT: DrumKit = {
  id: "free-kit",
  name: "Free Kit",
  format: "sfz",
  licence: { kind: "cc-by", attribution: "Recorded by Jane Doe" },
  pieces: [
    { element: "snare", keys: [38] },
    { element: "kick", keys: [36] },
  ],
  missing: ["tom1"],
  sizeBytes: 347 * 1024 * 1024,
  warnings: ["Not used: cutoff"],
};

function setup({
  kits = [] as DrumKit[],
  available = true,
  importer = vi.fn(async (_path: string, _options?: KitImportOptions) => KIT),
} = {}) {
  const onRemove = vi.fn();
  const onPick = vi.fn(async () => "/kits/Free Kit/kit.sfz");
  const utils = renderWithProviders(
    <DrumKitDialog
      open
      onOpenChange={vi.fn()}
      kits={kits}
      available={available}
      onPick={onPick}
      onImport={importer}
      onRemove={onRemove}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Drum kits" });
  return { ...utils, dialog, importer, onPick, onRemove };
}

const licenceError = (message: string) => Object.assign(new Error(message), { message });

describe("DrumKitDialog (#40)", () => {
  it("lists kits with format, licence, credit, size and the pieces they play", async () => {
    const { user, dialog, onRemove } = setup({ kits: [KIT] });
    const kit = within(dialog).getByTestId("drum-kit");
    expect(kit).toHaveTextContent("Free Kit");
    expect(kit).toHaveTextContent("SFZ");
    expect(kit).toHaveTextContent("CC BY (credit the author)");
    expect(kit).toHaveTextContent("Recorded by Jane Doe");
    expect(kit).toHaveTextContent("347 MB · Plays Snare, Kick · No Tom 1");
    expect(kit).toHaveTextContent("Not used: cutoff");
    await expectNoA11yViolations();
    await user.click(within(dialog).getByRole("button", { name: "Remove Free Kit" }));
    expect(onRemove).toHaveBeenCalledWith("free-kit");
  });

  it("imports a kit whose licence was found", async () => {
    const { user, dialog, importer } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Import a kit…" }));
    expect(importer).toHaveBeenCalledWith("/kits/Free Kit/kit.sfz", {});
  });

  it("refuses non-commercial kits", async () => {
    const importer = vi.fn(async () => {
      throw licenceError(
        "This kit cannot be imported. Its licence does not allow commercial use (non-commercial).",
      );
    });
    const { user, dialog } = setup({ importer });
    await user.click(within(dialog).getByRole("button", { name: "Import a kit…" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/non-commercial/);
    expect(within(dialog).getByText("This kit cannot be imported")).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "Licence" })).not.toBeInTheDocument();
  });

  it("asks for the licence when none was found, and the user confirms an unknown one", async () => {
    let first = true;
    const importer = vi.fn(async (_path: string, _options?: KitImportOptions) => {
      if (first) {
        first = false;
        throw licenceError("The kit's licence could not be found: confirm that you may use it.");
      }
      return KIT;
    });
    const { user, dialog } = setup({ importer });
    await user.click(within(dialog).getByRole("button", { name: "Import a kit…" }));
    const retry = await within(dialog).findByRole("button", { name: "Import the kit" });
    expect(retry).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Licence" }));
    await user.click(await screen.findByRole("option", { name: "I don't know the licence" }));
    expect(retry).toBeDisabled();
    await user.click(
      within(dialog).getByRole("checkbox", { name: /I have the right to use this kit/ }),
    );
    await expectNoA11yViolations();
    await user.click(retry);
    expect(importer).toHaveBeenLastCalledWith("/kits/Free Kit/kit.sfz", { acceptUnknown: true });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("takes a CC BY licence and its credit from the user", async () => {
    let first = true;
    const importer = vi.fn(async (_path: string, _options?: KitImportOptions) => {
      if (first) {
        first = false;
        throw licenceError("The kit's licence could not be found: confirm that you may use it.");
      }
      return KIT;
    });
    const { user, dialog } = setup({ importer });
    await user.click(within(dialog).getByRole("button", { name: "Import a kit…" }));
    await user.click(await within(dialog).findByRole("combobox", { name: "Licence" }));
    await user.click(await screen.findByRole("option", { name: "CC BY (credit the author)" }));
    await user.type(within(dialog).getByRole("textbox", { name: /Credit/ }), "Jane Doe");
    await user.click(within(dialog).getByRole("button", { name: "Import the kit" }));
    expect(importer).toHaveBeenLastCalledWith("/kits/Free Kit/kit.sfz", {
      licence: "cc-by",
      attribution: "Jane Doe",
    });
  });

  it("explains that importing needs the desktop app", () => {
    const { dialog } = setup({ available: false });
    expect(within(dialog).getByText(/available in the Smart Beat desktop app/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import a kit…" })).toBeDisabled();
  });
});
