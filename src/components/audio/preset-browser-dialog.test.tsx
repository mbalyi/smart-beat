import { screen, within } from "@testing-library/react";

import { PresetBrowserDialog } from "@/components/audio/preset-browser-dialog";
import type { PresetTarget } from "@/lib/audio/presets";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(target: PresetTarget = "guitar", targets?: PresetTarget[]) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <PresetBrowserDialog
      open
      onOpenChange={onOpenChange}
      target={target}
      targets={targets}
      onApply={onApply}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Presets" });
  const names = () =>
    within(dialog)
      .getAllByTestId("preset")
      .map((p) => p.querySelector("span")!.firstChild!.textContent);
  return { ...utils, dialog, onApply, onOpenChange, names };
}

describe("PresetBrowserDialog (#42)", () => {
  it("lists the presets for the track and filters them by genre", async () => {
    const { user, dialog, names } = setup();
    expect(names()).toContain("Djent 8-string");
    expect(names()).toContain("Nu-metal crunch");
    await user.click(
      within(within(dialog).getByRole("radiogroup", { name: "Genre" })).getByRole("radio", {
        name: "Deathcore",
      }),
    );
    expect(names()).toEqual(["Deathcore chug"]);
    await user.click(within(dialog).getByRole("radio", { name: "All genres" }));
    expect(names().length).toBeGreaterThan(5);
    await expectNoA11yViolations();
  });

  it("switches what it is for and searches names and descriptions", async () => {
    const { user, dialog, names } = setup("guitar");
    await user.click(within(dialog).getByRole("radio", { name: "Master" }));
    expect(names().every(Boolean)).toBe(true);
    expect(names()).toContain("Djent master");
    await user.type(within(dialog).getByRole("searchbox", { name: "Search" }), "weight");
    expect(names()).toEqual(["Deathcore master"]);
    await user.clear(within(dialog).getByRole("searchbox", { name: "Search" }));
    await user.type(within(dialog).getByRole("searchbox", { name: "Search" }), "zzz");
    expect(within(dialog).getByText("No presets match.")).toBeInTheDocument();
  });

  it("shows what a drum mix sets and applies the chosen preset", async () => {
    const { user, dialog, onApply, onOpenChange } = setup("drums", ["drums"]);
    expect(within(dialog).queryByRole("radiogroup", { name: "For" })).not.toBeInTheDocument();
    const preset = within(dialog)
      .getAllByTestId("preset")
      .find((p) => p.textContent?.includes("Double-kick friendly"))!;
    expect(preset).toHaveTextContent("Drum mix");
    expect(preset).toHaveTextContent(/Kit mix · Noise gate → Compressor → Equalizer/);
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.click(preset);
    expect(preset).toHaveAttribute("aria-checked", "true");
    await user.click(
      within(dialog).getByRole("button", { name: "Apply “Double-kick friendly (default)”" }),
    );
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "drummix-double-kick" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
