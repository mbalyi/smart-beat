import { screen, within } from "@testing-library/react";

import { EqControls, EqPopover } from "@/components/audio/eq-popover";
import { FLAT_EQ } from "@/lib/score/mixer";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const LONG_NAME = "Bass (Sam Rivers) and more";

/** The text a person reads around a knob: its label and value. */
const readout = (knob: HTMLElement) => knob.parentElement?.textContent ?? "";

describe("EqControls", () => {
  it("labels every knob by what it sets, not by a long track name (#83)", () => {
    renderWithProviders(<EqControls name={LONG_NAME} eq={FLAT_EQ} onChange={vi.fn()} />);
    const texts = screen.getAllByRole("slider").map(readout);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain("EQ low");
    expect(texts[1]).toContain("EQ mid");
    expect(texts[2]).toContain("EQ mid freq");
    expect(texts[3]).toContain("EQ high");
    // The track name is not repeated under the knobs.
    for (const text of texts) expect(text).not.toContain("Bass");
    // It is still part of every control's accessible name.
    expect(screen.getByRole("slider", { name: `${LONG_NAME}, EQ low` })).toBeInTheDocument();
  });

  it("labels the ten bands by their frequency", () => {
    renderWithProviders(
      <EqControls
        name={LONG_NAME}
        eq={{ ...FLAT_EQ, graphic: Array(10).fill(0) }}
        onChange={vi.fn()}
      />,
    );
    const group = screen.getByRole("group", { name: `Graphic EQ, ${LONG_NAME}` });
    const knobs = within(group).getAllByRole("slider");
    expect(knobs).toHaveLength(10);
    const texts = knobs.map(readout);
    expect(texts.map((t) => t.split("0.0 dB")[0]!.trim())).toEqual([
      "31 Hz",
      "62 Hz",
      "125 Hz",
      "250 Hz",
      "500 Hz",
      "1 kHz",
      "2 kHz",
      "4 kHz",
      "8 kHz",
      "16 kHz",
    ]);
    expect(screen.getByRole("slider", { name: `${LONG_NAME}, EQ 1 kHz` })).toHaveAttribute(
      "title",
      expect.stringContaining("0.0 dB"),
    );
    for (const text of texts) expect(text).not.toContain("Bass");
  });

  it("keeps a name with a comma out of the visible label", () => {
    renderWithProviders(<EqControls name="Guitar, lead" eq={FLAT_EQ} onChange={vi.fn()} />);
    const low = screen.getByRole("slider", { name: "Guitar, lead, EQ low" });
    expect(readout(low)).toContain("EQ low");
    expect(readout(low)).not.toContain("lead");
  });
});

describe("EqPopover", () => {
  it("shows the track name once, as the heading", async () => {
    const { user } = renderWithProviders(
      <EqPopover name={LONG_NAME} eq={FLAT_EQ} onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: `EQ for ${LONG_NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: `EQ, ${LONG_NAME}` });
    const heading = within(dialog).getByRole("heading", { name: `EQ: ${LONG_NAME}` });
    expect(heading).toHaveAttribute("title", LONG_NAME);
    // Visible text outside the heading never repeats the name.
    expect(within(dialog).getAllByText(LONG_NAME, { exact: false })).toEqual([heading]);
    await expectNoA11yViolations();
  });
});
