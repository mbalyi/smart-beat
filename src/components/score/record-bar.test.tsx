import { screen } from "@testing-library/react";

import { RecordBar } from "@/components/score/record-bar";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

describe("RecordBar", () => {
  it("shows nothing when idle", () => {
    const { container } = renderWithProviders(
      <RecordBar phase={{ kind: "idle" }} level={0} onStop={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the count-in, then the time and level, with a Stop button", async () => {
    const onStop = vi.fn();
    const { user, rerender } = renderWithProviders(
      <RecordBar
        phase={{ kind: "recording", mode: "click", countingIn: true, elapsed: 0 }}
        level={0.4}
        onStop={onStop}
        onCancel={vi.fn()}
      />,
    );
    const bar = screen.getByRole("region", { name: "Recording" });
    expect(bar).toHaveTextContent("Count-in…");
    expect(bar).toHaveTextContent("Escape to throw this take away");
    await expectNoA11yViolations(bar);

    rerender(
      <RecordBar
        phase={{ kind: "recording", mode: "click", countingIn: false, elapsed: 75 }}
        level={0.4}
        onStop={onStop}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Recording");
    expect(screen.getByLabelText("Time recorded")).toHaveTextContent("1:15");
    expect(screen.getByRole("meter", { name: "Input level" })).toHaveAttribute(
      "aria-valuetext",
      "Good",
    );
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows the progress of the transcription, with Cancel", async () => {
    const onCancel = vi.fn();
    const { user } = renderWithProviders(
      <RecordBar
        phase={{ kind: "transcribing", fraction: 0.25 }}
        level={0}
        onStop={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing…");
    expect(screen.getByRole("progressbar", { name: "Transcription progress" })).toHaveValue(0.25);
    await expectNoA11yViolations(screen.getByRole("region", { name: "Recording" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
