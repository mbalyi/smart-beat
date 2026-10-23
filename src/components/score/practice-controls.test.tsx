import { fireEvent, screen } from "@testing-library/react";

import { PracticeControls, SpeedTrainerDialog } from "@/components/score/practice-controls";
import { initialPractice, type PracticeState } from "@/lib/score/practice";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(practice: Partial<PracticeState> = {}, extra: { nativeAudio?: boolean } = {}) {
  const props = {
    practice: { ...initialPractice(), ...practice },
    barCount: 8,
    onLoopChange: vi.fn(),
    onRangeChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onMetronomeChange: vi.fn(),
    onCountInChange: vi.fn(),
    onCountInBeatsChange: vi.fn(),
    onMetronomeSoundChange: vi.fn(),
    onMetronomeVolumeChange: vi.fn(),
    onOpenTrainer: vi.fn(),
    onStopTrainer: vi.fn(),
    ...extra,
  };
  return { ...renderWithProviders(<PracticeControls {...props} />), props };
}

describe("PracticeControls", () => {
  it("offers loop, speed, the Speed Trainer, metronome and count-in", async () => {
    const { user, props } = setup();

    expect(screen.getByRole("group", { name: "Practice" })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Loop from bar" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Speed" })).toHaveTextContent("100%");

    await user.click(screen.getByRole("button", { name: "Loop" }));
    await user.click(screen.getByRole("button", { name: "Metronome" }));
    await user.click(screen.getByRole("button", { name: "Count-in" }));
    await user.click(screen.getByRole("button", { name: "Speed Trainer…" }));

    expect(props.onLoopChange).toHaveBeenCalledWith(true);
    expect(props.onMetronomeChange).toHaveBeenCalledWith(true);
    expect(props.onCountInChange).toHaveBeenCalledWith(true);
    expect(props.onOpenTrainer).toHaveBeenCalledOnce();
    await expectNoA11yViolations();
  });

  it("changes the speed", async () => {
    const { user, props } = setup();
    await user.click(screen.getByRole("combobox", { name: "Speed" }));
    await user.click(await screen.findByRole("option", { name: "50%" }));
    expect(props.onSpeedChange).toHaveBeenCalledWith(50);
  });

  it("edits the bars of the loop", async () => {
    const { user, props } = setup({ loop: true, range: { start: 1, end: 3 } });

    const from = screen.getByRole("spinbutton", { name: "Loop from bar" });
    const to = screen.getByRole("spinbutton", { name: "Loop to bar" });
    expect(from).toHaveValue(2);
    expect(to).toHaveValue(4);
    expect(screen.getByRole("button", { name: "Loop" })).toHaveAttribute("aria-pressed", "true");

    await user.clear(to);
    await user.type(to, "6{Enter}");
    expect(props.onRangeChange).toHaveBeenLastCalledWith({ start: 1, end: 5 });

    await user.clear(from);
    await user.type(from, "20");
    await user.tab(); // commits on blur, within the song (and never past the end)
    expect(props.onRangeChange).toHaveBeenLastCalledWith({ start: 7, end: 7 });

    await user.click(to);
    await user.keyboard("9{Escape}");
    expect(props.onRangeChange).toHaveBeenCalledTimes(2);
    await expectNoA11yViolations();
  });

  it("turns the Metronome and Count-in buttons purple while on (#57)", () => {
    setup({ metronome: true, countIn: true });
    expect(screen.getByRole("button", { name: "Count-in" }).className).toContain("bg-[#9a2ae6]");
    expect(screen.getByRole("button", { name: "Metronome" }).className).toContain("bg-[#9a2ae6]");
  });

  describe("settings popups (#182)", () => {
    it("shows the gears only while Metronome and Count-in are on", () => {
      const { unmount } = setup();
      expect(screen.queryByRole("button", { name: "Click sound and volume" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Beats to count in" })).toBeNull();
      unmount();

      setup({ metronome: true, countIn: true });
      expect(screen.getByRole("button", { name: "Click sound and volume" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Beats to count in" })).toBeInTheDocument();
    });

    it("picks the number of beats to count in with the keyboard", async () => {
      const { user, props } = setup({ countIn: true });
      screen.getByRole("button", { name: "Beats to count in" }).focus();
      await user.keyboard("{Enter}");
      const select = await screen.findByRole("combobox", { name: "Beats to count in" });
      expect(select).toHaveTextContent("4 beats");

      await user.click(select);
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "1 beat",
        "2 beats",
        "4 beats",
        "6 beats",
        "8 beats",
        "12 beats",
      ]);
      await user.click(screen.getByRole("option", { name: "6 beats" }));
      expect(props.onCountInBeatsChange).toHaveBeenCalledWith(6);
    });

    it("picks the click sound and a volume above the master volume", async () => {
      const { user, props } = setup({ metronome: true, metronomeVolume: 1.5 });
      await user.click(screen.getByRole("button", { name: "Click sound and volume" }));

      const volume = await screen.findByRole("slider", { name: "Click volume" });
      expect(volume).toHaveAttribute("max", "3");
      expect(volume).toHaveAttribute("aria-valuetext", "150 percent");
      fireEvent.change(volume, { target: { value: "3" } });
      expect(props.onMetronomeVolumeChange).toHaveBeenLastCalledWith(3);

      await user.click(screen.getByRole("combobox", { name: "Click sound" }));
      expect(screen.getAllByRole("option")).toHaveLength(4);
      await user.click(screen.getByRole("option", { name: "Cowbell" }));
      expect(props.onMetronomeSoundChange).toHaveBeenCalledWith("cowbell");
    });

    it("explains that other sounds need the native engine", async () => {
      const { user } = setup({ metronome: true }, { nativeAudio: false });
      await user.click(screen.getByRole("button", { name: "Click sound and volume" }));
      expect(await screen.findByText(/need the native audio engine/)).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Click sound" })).toBeDisabled();
    });

    it("has no accessibility violations with a popup open", async () => {
      const { user } = setup({ metronome: true, countIn: true });
      await user.click(screen.getByRole("button", { name: "Click sound and volume" }));
      await screen.findByRole("slider", { name: "Click volume" });
      await expectNoA11yViolations();
    });
  });

  it("shows the Speed Trainer's progress and stops it", async () => {
    const { user, props } = setup({
      loop: true,
      speed: 70,
      trainer: { from: 60, to: 100, step: 10, loopsPerStep: 1, loopsAtSpeed: 0, holding: false },
    });

    expect(screen.getByRole("status")).toHaveTextContent("Trainer 70% → 100%");
    expect(screen.getByRole("combobox", { name: "Speed" })).toHaveTextContent("70%");
    await user.click(screen.getByRole("button", { name: "Stop the Speed Trainer" }));
    expect(props.onStopTrainer).toHaveBeenCalledOnce();
  });
});

describe("SpeedTrainerDialog", () => {
  it("starts from the suggested bars with sensible defaults", async () => {
    const onStart = vi.fn();
    const onOpenChange = vi.fn();
    const { user } = renderWithProviders(
      <SpeedTrainerDialog
        open
        onOpenChange={onOpenChange}
        barCount={8}
        initialRange={{ start: 2, end: 3 }}
        onStart={onStart}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Speed Trainer" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "From bar" })).toHaveValue(3);
    expect(screen.getByRole("spinbutton", { name: "To bar" })).toHaveValue(4);
    await expectNoA11yViolations();

    const target = screen.getByRole("spinbutton", { name: "Target speed" });
    await user.clear(target);
    await user.type(target, "120");
    const step = screen.getByRole("spinbutton", { name: "Increase by" });
    await user.clear(step);
    await user.type(step, "5");
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(onStart).toHaveBeenCalledWith(
      { from: 60, to: 120, step: 5, loopsPerStep: 1 },
      { start: 2, end: 3 },
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("can be cancelled", async () => {
    const onStart = vi.fn();
    const onOpenChange = vi.fn();
    const { user } = renderWithProviders(
      <SpeedTrainerDialog
        open
        onOpenChange={onOpenChange}
        barCount={8}
        initialRange={{ start: 0, end: 0 }}
        onStart={onStart}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onStart).not.toHaveBeenCalled();
  });
});

const SECTIONS = [
  { name: "Verse", start: 0, end: 3, label: "Verse · bars 1–4" },
  { name: "Chorus", start: 4, end: 7, label: "Chorus · bars 5–8" },
];

describe("practice by section and Stay at this speed (#83)", () => {
  it("loops a section chosen by name", async () => {
    const onRangeChange = vi.fn();
    const { user } = renderWithProviders(
      <PracticeControls
        practice={{ ...initialPractice(), loop: true }}
        barCount={8}
        onLoopChange={vi.fn()}
        onRangeChange={onRangeChange}
        onSpeedChange={vi.fn()}
        onMetronomeChange={vi.fn()}
        onCountInChange={vi.fn()}
        onOpenTrainer={vi.fn()}
        onStopTrainer={vi.fn()}
        sections={SECTIONS}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Section" }));
    await user.click(await screen.findByRole("option", { name: "Chorus · bars 5–8" }));
    expect(onRangeChange).toHaveBeenCalledWith({ start: 4, end: 7 });
  });

  it("stays at the trainer's speed and says so", async () => {
    const onHoldTrainer = vi.fn();
    const trainer = { from: 60, to: 100, step: 10, loopsPerStep: 1, loopsAtSpeed: 0 };
    const props = {
      barCount: 8,
      onLoopChange: vi.fn(),
      onRangeChange: vi.fn(),
      onSpeedChange: vi.fn(),
      onMetronomeChange: vi.fn(),
      onCountInChange: vi.fn(),
      onOpenTrainer: vi.fn(),
      onStopTrainer: vi.fn(),
      onHoldTrainer,
    };
    const { user, rerender } = renderWithProviders(
      <PracticeControls
        {...props}
        practice={{
          ...initialPractice(),
          loop: true,
          speed: 70,
          trainer: { ...trainer, holding: false },
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Stay at this speed" }));
    expect(onHoldTrainer).toHaveBeenCalledWith(true);
    rerender(
      <PracticeControls
        {...props}
        practice={{
          ...initialPractice(),
          loop: true,
          speed: 70,
          trainer: { ...trainer, holding: true },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Trainer staying at 70%");
    expect(screen.getByRole("button", { name: "Stay at this speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoA11yViolations();
  });
});

describe("SpeedTrainerDialog: sections and count-in between loops (#83)", () => {
  it("starts on a section, counting in before every loop with the native engine", async () => {
    const onStart = vi.fn();
    const { user } = renderWithProviders(
      <SpeedTrainerDialog
        open
        onOpenChange={vi.fn()}
        barCount={8}
        initialRange={{ start: 0, end: 0 }}
        sections={SECTIONS}
        countInBetweenAvailable
        onStart={onStart}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Section to practise" }));
    await user.click(await screen.findByRole("option", { name: "Chorus · bars 5–8" }));
    expect(screen.getByRole("spinbutton", { name: "From bar" })).toHaveValue(5);
    await user.click(screen.getByRole("checkbox", { name: "Count in before every loop" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ countInBetween: true }), {
      start: 4,
      end: 7,
    });
    await expectNoA11yViolations();
  });

  it("explains that the count-in between loops needs the native engine", () => {
    renderWithProviders(
      <SpeedTrainerDialog
        open
        onOpenChange={vi.fn()}
        barCount={8}
        initialRange={{ start: 0, end: 0 }}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Count in before every loop" })).toBeDisabled();
    expect(screen.getByText(/Needs the native audio engine/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Section to practise" })).toBeNull();
  });
});
