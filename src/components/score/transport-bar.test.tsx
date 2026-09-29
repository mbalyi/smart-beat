import { screen } from "@testing-library/react";

import { TransportBar } from "@/components/score/transport-bar";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function setup(overrides: Partial<Parameters<typeof TransportBar>[0]> = {}) {
  const props = {
    ready: true,
    playing: false,
    position: { currentMs: 65_000, endMs: 192_000, bpm: 100 },
    bar: 3,
    barCount: 80,
    onPlayPause: vi.fn(),
    onStop: vi.fn(),
    onSeekBar: vi.fn(),
    ...overrides,
  };
  return { ...renderWithProviders(<TransportBar {...props} />), props };
}

describe("TransportBar", () => {
  it("shows the position, bar and tempo", async () => {
    setup();

    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("1:05 / 3:12");
    expect(timer).toHaveAccessibleName("Position: 1 minute 5 seconds of 3 minutes 12 seconds");
    expect(screen.getByRole("spinbutton", { name: "Bar" })).toHaveValue(4);
    expect(screen.getByText("/ 80")).toBeInTheDocument();
    expect(screen.getByText("100 BPM")).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("plays, pauses and stops", async () => {
    const { user, props, rerender } = setup();

    await user.click(screen.getByRole("button", { name: "Play" }));
    rerender(<TransportBar {...props} playing />);
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(props.onPlayPause).toHaveBeenCalledTimes(2);
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  it("waits for the instrument sounds before playback", async () => {
    setup({ ready: false, position: { currentMs: 0, endMs: 0, bpm: 0 } });

    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading instrument sounds…");
    expect(screen.queryByText(/BPM/)).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("selects the bar number when tabbing in, so typing replaces it", async () => {
    const { user } = setup();
    const select = vi.spyOn(HTMLInputElement.prototype, "select");

    await user.tab(); // Play
    await user.tab(); // Stop
    await user.tab();

    expect(screen.getByRole("spinbutton", { name: "Bar" })).toHaveFocus();
    expect(select).toHaveBeenCalledOnce();
  });

  it("starts from a typed bar number", async () => {
    const { user, props } = setup();
    const field = screen.getByRole("spinbutton", { name: "Bar" });

    await user.clear(field);
    await user.keyboard("12{Enter}");

    expect(props.onSeekBar).toHaveBeenCalledWith(11);
    expect(field).toHaveValue(4); // shows the playing bar again
  });

  it("keeps bar numbers within the song", async () => {
    const { user, props } = setup();
    const field = screen.getByRole("spinbutton", { name: "Bar" });

    await user.clear(field);
    await user.keyboard("999{Enter}");
    await user.clear(field);
    await user.keyboard("0");
    await user.tab();

    expect(vi.mocked(props.onSeekBar).mock.calls).toEqual([[79], [0]]);
  });

  it("cancels with Escape or an empty field", async () => {
    const { user, props } = setup();
    const field = screen.getByRole("spinbutton", { name: "Bar" });

    await user.click(field);
    await user.keyboard("12{Escape}");
    expect(field).toHaveValue(4);
    await user.clear(field);
    await user.tab();

    expect(props.onSeekBar).not.toHaveBeenCalled();
  });
});
