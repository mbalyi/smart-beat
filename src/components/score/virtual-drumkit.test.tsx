import { screen, within } from "@testing-library/react";

import { VirtualDrumkit } from "@/components/score/virtual-drumkit";
import { drumCategory } from "@/lib/score/drum-map";
import { filterKit, kitEntries } from "@/lib/score/instrument-view";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup({
  editing = true,
  active = [] as number[],
  cursorSound = null as number | null,
} = {}) {
  const props = { onInsert: vi.fn(), onReplace: vi.fn(), onPreview: vi.fn() };
  const utils = renderWithProviders(
    <VirtualDrumkit
      kit={kitEntries()}
      active={active}
      cursorSound={cursorSound}
      editing={editing}
      {...props}
    />,
  );
  return { ...utils, ...props, kit: screen.getByTestId("virtual-drumkit") };
}

describe("kit entries", () => {
  it("lists the whole Virtual Drumkit table, grouped", () => {
    const all = kitEntries();
    expect(all.length).toBeGreaterThan(90);
    expect(all.find((e) => e.id === 91)).toMatchObject({
      name: "Snare (rim shot)",
      category: "Snares",
    });
    expect(drumCategory(36)).toBe("Kicks");
    expect(drumCategory(92)).toBe("Hi-hats");
    expect(drumCategory(43)).toBe("Toms");
    expect(drumCategory(59)).toBe("Cymbals");
    expect(drumCategory(56)).toBe("Percussion");
  });

  it("uses the track's own kit when it has one (imported kits)", () => {
    const own = kitEntries([
      { name: "Big snare", midi: 38, staffLine: 3, notehead: "Normal" },
      { name: "Big snare again", midi: 38, staffLine: 3, notehead: "Normal" },
      { name: "Kick", midi: 36, staffLine: 8, notehead: "Normal" },
    ]);
    expect(own.slice(0, 2).map((e) => [e.id, e.name, e.own])).toEqual([
      [36, "Kick", true],
      [38, "Big snare", true],
    ]);
    // The rest of the table follows, without the numbers the kit already has.
    expect(own.filter((e) => e.id === 38)).toHaveLength(1);
    expect(own.some((e) => e.id === 91 && !e.own)).toBe(true);
  });

  it("finds drums by number, name or group", () => {
    const all = kitEntries();
    expect(filterKit(all, "38").map((e) => e.id)).toEqual([38]);
    expect(filterKit(all, "rim").map((e) => e.name)).toEqual(["Snare (rim shot)"]);
    expect(filterKit(all, "hi-hats").every((e) => e.category === "Hi-hats")).toBe(true);
    expect(filterKit(all, "  ")).toHaveLength(all.length);
  });
});

describe("VirtualDrumkit", () => {
  it("shows every articulation by name and number, in groups", async () => {
    const { kit } = setup();
    for (const group of ["Kicks", "Snares", "Hi-hats", "Toms", "Cymbals", "Percussion"]) {
      expect(within(kit).getByRole("region", { name: group })).toBeInTheDocument();
    }
    expect(within(kit).getByRole("button", { name: "Hi-Hat (half), 92" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("plays and inserts on click, replaces on Shift+click", async () => {
    const { user, kit, onInsert, onReplace, onPreview } = setup();
    await user.click(within(kit).getByRole("button", { name: "Snare (hit), 38" }));
    expect(onPreview).toHaveBeenCalledWith(38);
    expect(onInsert).toHaveBeenCalledWith(38);
    await user.keyboard("{Shift>}");
    await user.click(within(kit).getByRole("button", { name: "Snare (rim shot), 91" }));
    await user.keyboard("{/Shift}");
    expect(onReplace).toHaveBeenCalledWith(91);
  });

  it("only plays when not editing", async () => {
    const { user, kit, onInsert, onPreview } = setup({ editing: false });
    await user.click(within(kit).getByRole("button", { name: "Ride (bell), 53" }));
    expect(onPreview).toHaveBeenCalledWith(53);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys, Home and End, and Shift+Enter replaces", async () => {
    const { user, kit, onReplace } = setup();
    const buttons = within(kit).getAllByTestId("kit-entry");
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(buttons.at(-1)).toHaveFocus();
    await user.keyboard("{Home}{Shift>}{Enter}{/Shift}");
    expect(onReplace).toHaveBeenCalled();
  });

  it("highlights the drums sounding and the one under the cursor", () => {
    const { kit } = setup({ active: [36, 42], cursorSound: 42 });
    expect(within(kit).getByRole("button", { name: "Kick (hit), 36" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(kit).getByRole("button", { name: "Hi-Hat (closed), 42" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("lists the track's own kit first", () => {
    renderWithProviders(
      <VirtualDrumkit
        kit={kitEntries([{ name: "Charley", midi: 42, staffLine: 0, notehead: "X black" }])}
        active={[]}
        cursorSound={null}
        editing
        onInsert={vi.fn()}
        onReplace={vi.fn()}
        onPreview={vi.fn()}
      />,
    );
    const own = screen.getByRole("region", { name: "This track's kit" });
    expect(within(own).getByRole("button", { name: "Charley, 42" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hi-Hat (closed), 42" })).not.toBeInTheDocument();
  });

  it("filters with the search box", async () => {
    const { user, kit } = setup();
    await user.type(
      screen.getByRole("searchbox", { name: "Find a drum by name or number" }),
      "china",
    );
    expect(
      within(kit)
        .getAllByTestId("kit-entry")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["China (hit), 52", "China (choke), 96"]);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(within(kit).getByText(/No drum matches/)).toBeInTheDocument();
  });
});
