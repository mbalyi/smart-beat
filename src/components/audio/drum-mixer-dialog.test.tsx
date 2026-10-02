import { screen, within } from "@testing-library/react";
import { act, useState } from "react";

import { DrumMixerDialog } from "@/components/audio/drum-mixer-dialog";
import { DRUM_ELEMENTS } from "@/lib/audio/drum-elements";
import { meters } from "@/lib/audio/meter-store";
import type { DrumMixer } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(engineOn = true) {
  const onChange = vi.fn();
  const onEnableEngine = vi.fn();
  let latest: DrumMixer | null = null;
  function Harness() {
    const [mixer, setMixer] = useState<DrumMixer | null>(null);
    return (
      <DrumMixerDialog
        open
        onOpenChange={vi.fn()}
        trackIndex={2}
        trackName="Drums"
        mixer={mixer}
        onChange={(next) => {
          latest = next;
          onChange(next);
          setMixer(next);
        }}
        engineOn={engineOn}
        onEnableEngine={onEnableEngine}
      />
    );
  }
  const utils = renderWithProviders(<Harness />);
  const dialog = screen.getByRole("dialog", { name: "Drum mixer: Drums" });
  return { ...utils, dialog, onChange, onEnableEngine, mixer: () => latest };
}

describe("DrumMixerDialog", () => {
  it("lists every kit piece with mute, solo, volume in dB, pan and a meter", async () => {
    const { dialog } = setup();
    const rows = within(dialog).getAllByTestId("drum-element");
    expect(rows).toHaveLength(DRUM_ELEMENTS.length);
    const snare = rows[0]!;
    expect(within(snare).getByRole("slider", { name: "Volume, Snare" })).toHaveAttribute(
      "aria-valuetext",
      "0.0 dB",
    );
    expect(within(snare).getByRole("slider", { name: "Pan, Snare" })).toHaveAttribute(
      "aria-valuetext",
      "Centre",
    );
    expect(within(snare).getByText("C")).toBeInTheDocument();
    expect(within(snare).getByRole("meter", { name: "Level, Snare" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("mixes pieces and switches the kit to mono", async () => {
    const { user, dialog, mixer } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Mute Hi-Hat" }));
    expect(mixer()!.elements.find((e) => e.id === "hihat")!.mute).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Solo Kick" }));
    expect(mixer()!.elements.find((e) => e.id === "kick")!.solo).toBe(true);
    const volume = within(dialog).getByRole("slider", { name: "Volume, Snare" });
    volume.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(mixer()!.elements.find((e) => e.id === "snare")!.volume).toBeCloseTo(0.98);
    const pan = within(dialog).getByRole("slider", { name: "Pan, Ride" });
    pan.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(mixer()!.elements.find((e) => e.id === "ride")!.pan).toBeCloseTo(0.1);
    expect(within(dialog).getByText("10R")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "Mono" }));
    expect(mixer()!.stereo).toBe(false);
    expect(within(dialog).getByRole("slider", { name: "Pan, Ride" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(dialog).getByRole("button", { name: "Reset the kit" }));
    expect(mixer()).toBeNull();
  });

  it("lights the meters from the engine's element levels", () => {
    const { dialog } = setup();
    const drums = [[], [], DRUM_ELEMENTS.map((_, i) => (i === 3 ? 1 : 0))];
    act(() => meters.set({ tracks: [], master: 0, drums }));
    const kick = within(dialog).getByRole("meter", { name: "Level, Kick" });
    expect(kick).toHaveAttribute("aria-valuenow", "100");
    expect(within(dialog).getByRole("meter", { name: "Level, Snare" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("offers to turn on the engine", async () => {
    const { user, dialog, onEnableEngine } = setup(false);
    await user.click(within(dialog).getByRole("button", { name: "Turn it on" }));
    expect(onEnableEngine).toHaveBeenCalled();
  });
});
