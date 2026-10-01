import { screen, within } from "@testing-library/react";
import { useState } from "react";

import { PedalboardDialog, type PedalboardTarget } from "@/components/audio/pedalboard-dialog";
import { defaultEffect, type EffectSlot, type EffectType } from "@/lib/audio/effects";
import type { BlockProblem, LibraryItem } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const LIBRARY: LibraryItem[] = [
  {
    id: "builtin:4x12-modern",
    kind: "cab",
    name: "4×12 modern (generated)",
    tags: [],
    file: "",
    sampleRate: 0,
    source: "Smart Beat",
    builtin: true,
    includesCab: false,
  },
  {
    id: "abc",
    kind: "amp",
    name: "My 5150",
    tags: ["metal"],
    file: "abc.nam",
    sampleRate: 48_000,
    source: "5150.nam",
    builtin: false,
    includesCab: true,
  },
];

const TRACK: PedalboardTarget = { track: 0, name: "Rhythm guitar", presetTarget: "guitar" };

function setup({
  initial = [],
  target = TRACK,
  problems = [],
  engineOn = true,
  focusType,
}: {
  initial?: EffectSlot[];
  target?: PedalboardTarget;
  problems?: BlockProblem[];
  engineOn?: boolean;
  focusType?: EffectType;
} = {}) {
  const onChange = vi.fn();
  const onImport = vi.fn();
  const onEnableEngine = vi.fn();
  let latest = initial;
  function Harness() {
    const [chain, setChain] = useState(initial);
    return (
      <PedalboardDialog
        open
        onOpenChange={vi.fn()}
        target={target}
        chain={chain}
        onChange={(next) => {
          latest = next;
          onChange(next);
          setChain(next);
        }}
        problems={problems}
        library={LIBRARY}
        onImport={onImport}
        onManageLibrary={vi.fn()}
        engineOn={engineOn}
        onEnableEngine={onEnableEngine}
        focusType={focusType}
      />
    );
  }
  const utils = renderWithProviders(<Harness />);
  const dialog = screen.getByRole("dialog", { name: /Effects: / });
  return { ...utils, dialog, onChange, onImport, onEnableEngine, chain: () => latest };
}

const types = (chain: EffectSlot[]) => chain.map((s) => s.type);

describe("PedalboardDialog", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty and adds effects from the categorised library", async () => {
    const { user, dialog, chain } = setup();
    expect(within(dialog).getByText("No effects yet.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add effect" }));
    expect(screen.getByText("Dynamics")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Noise gate" }));
    await user.click(within(dialog).getByRole("button", { name: "Add effect" }));
    await user.click(screen.getByRole("menuitem", { name: "Cabinet" }));
    expect(types(chain())).toEqual(["gate", "cab"]);
    expect(within(dialog).getAllByTestId("effect-block")).toHaveLength(2);
    await expectNoA11yViolations();
  });

  it("removes with Delete and reorders with Alt+arrows and the buttons", async () => {
    const { user, dialog, chain } = setup({
      initial: [defaultEffect("gate"), defaultEffect("drive"), defaultEffect("cab")],
    });
    const first = within(dialog).getByRole("button", { name: "1. Noise gate" });
    first.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(types(chain())).toEqual(["drive", "gate", "cab"]);
    await user.click(within(dialog).getByRole("button", { name: "Move Cabinet up" }));
    expect(types(chain())).toEqual(["drive", "cab", "gate"]);
    within(dialog).getByRole("button", { name: "1. Drive" }).focus();
    await user.keyboard("{Delete}");
    expect(types(chain())).toEqual(["cab", "gate"]);
    await user.click(within(dialog).getByRole("button", { name: "Remove Noise gate" }));
    expect(types(chain())).toEqual(["cab"]);
  });

  it("switches blocks off and edits their settings", async () => {
    const { user, dialog, chain } = setup({ initial: [defaultEffect("compressor")] });
    await user.click(within(dialog).getByRole("switch", { name: "Compressor 1 on" }));
    expect(chain()[0]!.enabled).toBe(false);
    const ratio = within(dialog).getByRole("slider", { name: "Compressor ratio" });
    expect(ratio).toHaveAttribute("aria-valuetext", "4.0:1");
    ratio.focus();
    await user.keyboard("{ArrowRight}");
    expect(chain()[0]).toMatchObject({ ratio: 4.1 });
  });

  it("edits EQ bands and drive types", async () => {
    const { user, dialog, chain } = setup({ initial: [defaultEffect("eq")] });
    const band = within(dialog).getByRole("slider", { name: "Equalizer 1 kHz" });
    band.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    const eq = chain()[0]!;
    expect(eq.type === "eq" && eq.bands[5]!.gainDb).toBe(1);
  });

  it("loads a genre preset and saves the chain as the user's preset", async () => {
    const { user, dialog, chain } = setup();
    await user.click(within(dialog).getByRole("combobox", { name: "Genre" }));
    await user.click(screen.getByRole("option", { name: "Djent" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Guitar presets" }));
    expect(screen.queryByRole("option", { name: /Nu-metal crunch/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Djent 8-string/ }));
    expect(types(chain())).toEqual(["gate", "compressor", "drive", "drive", "cab", "eq"]);
    await user.type(within(dialog).getByRole("textbox", { name: "Save as preset" }), "Mine");
    await user.click(within(dialog).getByRole("button", { name: "Save the preset" }));
    expect(JSON.parse(localStorage.getItem("smart-beat:effect-presets")!)[0].name).toBe("Mine");
  });

  it("limits the master chain to three effects", async () => {
    const { dialog } = setup({
      target: { track: null, name: "Master", presetTarget: "master" },
      initial: [defaultEffect("eq"), defaultEffect("compressor"), defaultEffect("compressor")],
    });
    expect(within(dialog).getByRole("button", { name: "Add effect" })).toBeDisabled();
    expect(within(dialog).getByText("The chain is full (3 effects).")).toBeInTheDocument();
  });

  it("picks amp captures and cabinets from the library, or imports one", async () => {
    const { user, dialog, chain, onImport } = setup({ initial: [defaultEffect("amp")] });
    await user.click(within(dialog).getByRole("combobox", { name: "Amp or pedal capture" }));
    await user.click(screen.getByRole("option", { name: /My 5150/ }));
    expect(chain()[0]).toMatchObject({ model: "abc" });
    await user.click(within(dialog).getByRole("button", { name: "Import…" }));
    expect(onImport).toHaveBeenCalledWith("amp");
  });

  it("shows why a block cannot play and offers to turn on the engine", async () => {
    const { user, dialog, onEnableEngine } = setup({
      initial: [defaultEffect("amp")],
      problems: [{ index: 0, message: "Amp model “x” is not in the library" }],
      engineOn: false,
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("not in the library");
    await user.click(within(dialog).getByRole("button", { name: "Turn it on" }));
    expect(onEnableEngine).toHaveBeenCalled();
  });

  it("opens at the block the EQ button asks for", () => {
    const { dialog } = setup({
      initial: [defaultEffect("gate"), defaultEffect("eq")],
      focusType: "eq",
    });
    expect(within(dialog).getByRole("button", { name: "2. Equalizer" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
