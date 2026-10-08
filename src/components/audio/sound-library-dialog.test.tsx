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
  note: "",
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

  it("shows what the user should know about a file", () => {
    const { dialog } = setup([
      item({
        id: "long",
        name: "Hall",
        note: "Only the first 1.4 s of this 3.0 s impulse response is used.",
      }),
    ]);
    expect(within(dialog).getByText(/Only the first 1.4 s/)).toBeInTheDocument();
  });

  it("searches and filters by tag (#41)", async () => {
    const many = [
      ...ITEMS,
      item({ id: "c2", name: "Greenback", source: "gb.wav", tags: ["rock"] }),
      item({ id: "a2", kind: "amp", name: "Plexi", source: "plexi.nam", tags: ["rock", "metal"] }),
    ];
    const { user, dialog } = setup(many);
    const rows = () =>
      within(dialog)
        .getAllByTestId("library-item")
        .map((li) => li.textContent ?? "");
    expect(rows()).toHaveLength(5);
    // Tag buttons, one per tag, pressed state follows the choice.
    const filter = within(dialog).getByRole("group", { name: "Filter by tag" });
    const rock = within(filter).getByRole("button", { name: "rock" });
    expect(rock).toHaveAttribute("aria-pressed", "false");
    await user.click(rock);
    expect(rock).toHaveAttribute("aria-pressed", "true");
    // Amps are listed before cabinets.
    expect(rows().map((r) => r.replace(/Imported from.*/, ""))).toEqual(["Plexi", "Greenback"]);
    // Search narrows it further; clicking the tag again clears it.
    await user.type(within(dialog).getByRole("searchbox", { name: "Search the library" }), "plexi");
    expect(rows()).toHaveLength(1);
    await user.click(rock);
    expect(rows()).toHaveLength(1);
    await user.clear(within(dialog).getByRole("searchbox", { name: "Search the library" }));
    expect(rows()).toHaveLength(5);
    // Nothing found.
    await user.type(within(dialog).getByRole("searchbox", { name: "Search the library" }), "zzz");
    expect(within(dialog).getAllByText("Nothing matches.")).toHaveLength(2);
    await expectNoA11yViolations();
  });

  it("says when nothing is imported", () => {
    const { dialog } = setup([]);
    expect(within(dialog).getAllByText("Nothing imported yet.")).toHaveLength(2);
    expect(parseTags(" a ,, b,a ")).toEqual(["a", "b"]);
  });
});
