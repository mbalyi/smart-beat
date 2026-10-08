import { screen } from "@testing-library/react";

import { EDIT_PRESSED, MUTE_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("Toggle", () => {
  it("is filled green with an inset ring when on, so it never looks like an idle grey one", () => {
    renderWithProviders(
      <Toggle pressed variant="outline">
        Loop
      </Toggle>,
    );
    const toggle = screen.getByRole("button", { name: "Loop" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.className).toContain("data-[state=on]:bg-green-700");
    expect(toggle.className).toContain("dark:data-[state=on]:bg-green-700");
    // The ring does not depend on telling the colours apart.
    expect(toggle.className).toContain("data-[state=on]:inset-ring-2");
    expect(toggle.className).not.toContain("data-[state=on]:bg-muted");
  });

  it("lets a toggle with its own pressed colour replace the green completely", () => {
    renderWithProviders(
      <>
        <Toggle pressed className={EDIT_PRESSED}>
          Edit
        </Toggle>
        <Toggle pressed className={MUTE_PRESSED}>
          Mute
        </Toggle>
      </>,
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.className).toContain("dark:data-[state=on]:bg-sky-700");
    expect(edit.className).not.toContain("green");
    const mute = screen.getByRole("button", { name: "Mute" });
    expect(mute.className).toContain("dark:data-[state=on]:bg-red-700");
    expect(mute.className).not.toContain("green");
  });

  it("styles the chosen item of a toggle group the same way", async () => {
    const { container } = renderWithProviders(
      <ToggleGroup type="single" value="b" aria-label="Layout">
        <ToggleGroupItem value="a">Page</ToggleGroupItem>
        <ToggleGroupItem value="b">Horizontal</ToggleGroupItem>
      </ToggleGroup>,
    );
    const chosen = screen.getByRole("radio", { name: "Horizontal" });
    expect(chosen).toHaveAttribute("data-state", "on");
    expect(chosen.className).toContain("data-[state=on]:bg-green-700");
    await expectNoA11yViolations(container);
  });
});
