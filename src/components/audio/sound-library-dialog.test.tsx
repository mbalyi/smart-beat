import { screen, within } from "@testing-library/react";

import { SoundLibraryDialog } from "@/components/audio/sound-library-dialog";
import { parseTags } from "@/lib/audio/library";
import type { LibraryItem } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const item = (over: Partial<LibraryItem>): LibraryItem => ({
  id: "x",
  kind: "cab",
  name: "Cab",
  tags: [],
  file: "",
  sampleRate: 48_000,
  source: "cab.wav",
  builtin: false,
  includesCab: false,
  ...over,
});

const ITEMS = [
  item({
    id: "builtin:4x12-modern",
    name: "4×12 modern (generated)",
    builtin: true,
    sampleRate: 0,
  }),
  item({ id: "c1", name: "God's cab", source: "gods.wav", tags: ["metal"] }),
  item({ id: "a1", kind: "amp", name: "5150 capture", source: "5150.nam", includesCab: true }),
];

function setup(items = ITEMS) {
  const props = { onImport: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onOpenChange: vi.fn() };
  const utils = renderWithProviders(<SoundLibraryDialog open items={items} {...props} />);
  return { ...utils, ...props, dialog: screen.getByRole("dialog", { name: "Sound library" }) };
}

describe("SoundLibraryDialog", () => {
  it("lists amps and cabinets, with where they came from", async () => {
    const { dialog } = setup();
    const amps = within(dialog).getByRole("region", { name: "Amps and pedals" });
    const cabs = within(dialog).getByRole("region", { name: "Cabinets" });
    expect(within(amps).getByText("5150 capture")).toBeInTheDocument();
    expect(within(amps).getByText(/includes a cabinet/)).toBeInTheDocument();
    expect(within(cabs).getAllByTestId("library-item")).toHaveLength(2);
    expect(within(cabs).getByText(/Built in, generated/)).toBeInTheDocument();
    expect(within(dialog).getByText(/never bundled with the app or uploaded/)).toBeInTheDocument();
    // Built-ins cannot be renamed or removed.
    expect(within(cabs).queryByRole("button", { name: /Remove 4×12/ })).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("imports, renames with tags and removes", async () => {
    const { user, dialog, onImport, onRename, onRemove } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Import .nam…" }));
    expect(onImport).toHaveBeenCalledWith("amp");
    await user.click(within(dialog).getByRole("button", { name: "Import .wav…" }));
    expect(onImport).toHaveBeenCalledWith("cab");

    await user.click(within(dialog).getByRole("button", { name: "Rename God's cab" }));
    const name = within(dialog).getByRole("textbox", { name: "Name of God's cab" });
    await user.clear(name);
    await user.type(name, "V30 cab");
    const tags = within(dialog).getByRole("textbox", { name: "Tags of God's cab" });
    await user.clear(tags);
    await user.type(tags, "metal, djent, metal");
    await user.click(within(dialog).getByRole("button", { name: "Save the name and tags" }));
    expect(onRename).toHaveBeenCalledWith("c1", "V30 cab", ["metal", "djent"]);

    await user.click(within(dialog).getByRole("button", { name: "Remove 5150 capture" }));
    expect(onRemove).toHaveBeenCalledWith("a1");
  });

  it("says when nothing is imported", () => {
    const { dialog } = setup([]);
    expect(within(dialog).getAllByText("Nothing imported yet.")).toHaveLength(2);
    expect(parseTags(" a ,, b,a ")).toEqual(["a", "b"]);
  });
});
