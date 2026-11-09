import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";

import { PaletteCell, VariantCell } from "@/components/score/palette-cell";
import type { ToggleState } from "@/lib/score/editor";
import type { PaletteBox, PaletteItem } from "@/lib/score/palette-model";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const item = (
  id: string,
  label: string,
  mark: string,
  o: Partial<PaletteItem> = {},
): PaletteItem => ({
  id,
  label,
  visual: { mark },
  action: { type: "rest" },
  ...o,
});

const SLIDE: PaletteBox = {
  id: "slide",
  label: "Slide",
  columns: 3,
  idle: { mark: "sl." },
  groups: [
    {
      items: [
        item("a", "Shift slide", "sh."),
        item("b", "Legato slide", "leg."),
        item("c", "Slide out down", "out"),
        item("d", "Slide in", "in"),
        item("e", "Pick slide", "pick"),
      ],
    },
  ],
};

/** A box whose pressed item follows the picks, like the palette does with the score. */
function Harness({
  onDone = () => {},
  initial = null,
  box = SLIDE,
}: {
  onDone?: () => void;
  initial?: string | null;
  box?: PaletteBox;
}) {
  const [on, setOn] = useState<string | null>(initial);
  return (
    <>
      <button type="button">Score</button>
      <VariantCell
        box={box}
        groups={box.groups}
        stateOf={(i): ToggleState => (i.id === on ? "on" : "off")}
        isDisabled={(i) => i.id === "e"}
        onPick={(i) => {
          setOn((now) => (now === i.id ? null : i.id));
        }}
        onDone={onDone}
      />
    </>
  );
}

describe("PaletteCell", () => {
  it("is an icon-only 32px button named by its label and mark, with a tooltip", async () => {
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <PaletteCell label="Palm mute" mark="P.M." shortcut="P" onClick={onClick}>
        <span aria-hidden="true">P.M.</span>
      </PaletteCell>,
    );
    const cell = screen.getByRole("button", { name: "Palm mute, P.M." });
    expect(cell.className).toContain("size-8");
    expect(cell.className).toContain("palette-cell");
    await user.hover(cell);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Palm mute (P)");
    await user.click(cell);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is pressed in the brand purple, half pressed when mixed, and never blue", () => {
    renderWithProviders(
      <>
        <PaletteCell label="On" state="on">
          x
        </PaletteCell>
        <PaletteCell label="Some" state="mixed">
          x
        </PaletteCell>
        <PaletteCell label="Off" state="off">
          x
        </PaletteCell>
        <PaletteCell label="Action">x</PaletteCell>
        <PaletteCell label="Radio" checked>
          x
        </PaletteCell>
      </>,
    );
    const on = screen.getByRole("button", { name: "On" });
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(on).toHaveAttribute("data-state", "on");
    expect(on.className).toContain("bg-[#9a2ae6]");
    expect(on.className).not.toContain("sky");
    const some = screen.getByRole("button", { name: "Some" });
    expect(some).toHaveAttribute("aria-pressed", "mixed");
    expect(some.className).toContain("#9a2ae6");
    expect(screen.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Action" })).not.toHaveAttribute("aria-pressed");
    expect(screen.getByRole("radio", { name: "Radio" })).toBeChecked();
  });

  it("can be disabled and does not take focus on mouse down", () => {
    renderWithProviders(
      <>
        <PaletteCell label="Free">x</PaletteCell>
        <PaletteCell label="Off" disabled>
          x
        </PaletteCell>
      </>,
    );
    expect(screen.getByRole("button", { name: "Off" })).toBeDisabled();
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Free" }))).toBe(false);
  });
});

describe("VariantCell", () => {
  it("opens a box on the right as a group named after the family and closes it again", async () => {
    const { user } = renderWithProviders(<Harness />);
    const trigger = screen.getByRole("button", { name: /^Slide/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const group = await screen.findByRole("group", { name: "Slide" });
    expect(group).toHaveAttribute("data-side", "right");
    expect(within(group).getAllByRole("button")).toHaveLength(5);
    // Focus moves into the box, onto the first variant.
    await waitFor(() =>
      expect(within(group).getByRole("button", { name: /^Shift slide/ })).toHaveFocus(),
    );

    await user.click(trigger);
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Slide" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the pick in the cell, hands focus to the score and shows the pick again when off", async () => {
    const onDone = vi.fn();
    const { user } = renderWithProviders(<Harness onDone={onDone} />);
    // Nothing is on and nothing picked: the idle icon.
    expect(screen.getByRole("button", { name: /^Slide/ })).toHaveTextContent("sl.");

    await user.click(screen.getByRole("button", { name: /^Slide/ }));
    await user.click(
      within(await screen.findByRole("group", { name: "Slide" })).getByRole("button", {
        name: /^Legato slide/,
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(screen.queryByRole("group", { name: "Slide" })).not.toBeInTheDocument();

    // The variant that is on shows in the cell, which is lit and named after it.
    const cell = screen.getByRole("button", { name: /^Slide, Legato slide \(on\)/ });
    expect(cell).toHaveTextContent("leg.");
    expect(cell.className).toContain("#9a2ae6");

    // Switched off again: the cell still shows the last pick, but no longer lit.
    await user.click(cell);
    await user.click(
      within(await screen.findByRole("group", { name: "Slide" })).getByRole("button", {
        name: /^Legato slide/,
      }),
    );
    const idle = await screen.findByRole("button", { name: /^Slide/ });
    expect(idle).toHaveTextContent("leg.");
    expect(idle.className).not.toContain("#9a2ae6");
  });

  it("marks the variant that is on as pressed and starts on it", async () => {
    const { user } = renderWithProviders(<Harness initial="c" />);
    await user.click(screen.getByRole("button", { name: "Slide, Slide out down (on)" }));
    const group = await screen.findByRole("group", { name: "Slide" });
    const pressed = within(group).getByRole("button", { name: "Slide out down" });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(pressed.className).toContain("#9a2ae6");
    expect(within(group).getByRole("button", { name: /^Shift slide/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await waitFor(() => expect(pressed).toHaveFocus());
  });

  it("moves in two dimensions with the arrow keys and skips disabled variants", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: /^Slide/ }));
    const group = await screen.findByRole("group", { name: "Slide" });
    const button = (name: string) =>
      within(group).getByRole("button", { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(button("Shift slide")).toHaveFocus());

    await user.keyboard("{ArrowRight}");
    expect(button("Legato slide")).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    // Three columns: down from the third of the first row is nothing (the row below has two), so stay.
    expect(button("Slide out down")).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(button("Shift slide")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(button("Slide in")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(button("Shift slide")).toHaveFocus();
    await user.keyboard("{End}");
    // The last variant is disabled: the one before it is the end.
    expect(button("Slide in")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(button("Shift slide")).toHaveFocus();
  });

  it("closes on Escape and returns focus to the cell", async () => {
    const onDone = vi.fn();
    const { user } = renderWithProviders(<Harness onDone={onDone} />);
    const trigger = screen.getByRole("button", { name: /^Slide/ });
    await user.click(trigger);
    await screen.findByRole("group", { name: "Slide" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Slide" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("opens from the keyboard", async () => {
    const { user } = renderWithProviders(<Harness />);
    screen.getByRole("button", { name: /^Slide/ }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("group", { name: "Slide" })).toBeInTheDocument();
  });

  it("has no accessibility violations, closed and open", async () => {
    const { user } = renderWithProviders(<Harness initial="b" />);
    await expectNoA11yViolations();
    await user.click(screen.getByRole("button", { name: /^Slide/ }));
    await screen.findByRole("group", { name: "Slide" });
    await expectNoA11yViolations();
  });

  it("names the groups of a box with several", async () => {
    const box: PaletteBox = {
      ...SLIDE,
      groups: [
        { label: "Slide out", items: [item("a", "Shift slide", "sh.")] },
        { label: "Slide in", items: [item("d", "Slide in", "in")] },
      ],
    };
    const { user } = renderWithProviders(<Harness box={box} />);
    await user.click(screen.getByRole("button", { name: /^Slide/ }));
    const group = await screen.findByRole("group", { name: "Slide" });
    expect(within(group).getByRole("group", { name: "Slide out" })).toBeInTheDocument();
    expect(within(group).getByRole("group", { name: "Slide in" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });
});
