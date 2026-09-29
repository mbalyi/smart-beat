import { screen } from "@testing-library/react";

import { PracticeControls, SpeedTrainerDialog } from "@/components/score/practice-controls";
import { initialPractice, type PracticeState } from "@/lib/score/practice";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(practice: Partial<PracticeState> = {}) {
  const props = {
    practice: { ...initialPractice(), ...practice },
    barCount: 8,
    onLoopChange: vi.fn(),
    onRangeChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onMetronomeChange: vi.fn(),
    onCountInChange: vi.fn(),
    onOpenTrainer: vi.fn(),
    onStopTrainer: vi.fn(),
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

  it("shows the Speed Trainer's progress and stops it", async () => {
    const { user, props } = setup({
      loop: true,
      speed: 70,
      trainer: { from: 60, to: 100, step: 10, loopsPerStep: 1, loopsAtSpeed: 0 },
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
