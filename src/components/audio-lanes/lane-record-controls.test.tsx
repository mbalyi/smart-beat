import { screen } from "@testing-library/react";

import { ArmedLaneBar } from "@/components/audio-lanes/armed-lane-bar";
import { LaneRecordButton } from "@/components/audio-lanes/lane-record-controls";
import {
  LaneRecordContext,
  type LaneRecordControls,
} from "@/components/audio-lanes/lane-record-context";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const lane = { id: "a", name: "Guitar", folder: false };

function renderButton(controls: Partial<LaneRecordControls> = {}, target = lane) {
  const toggle = vi.fn();
  const value: LaneRecordControls = { armedId: null, recording: false, toggle, ...controls };
  const view = renderWithProviders(
    <LaneRecordContext.Provider value={value}>
      <LaneRecordButton lane={target} />
    </LaneRecordContext.Provider>,
  );
  return { ...view, toggle };
}

describe("LaneRecordButton", () => {
  it("shows nothing without the record controls (outside the desktop app)", () => {
    const { container } = renderWithProviders(<LaneRecordButton lane={lane} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing on a folder", () => {
    const { container } = renderButton({}, { ...lane, folder: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("is off, armed or recording, and says so to screen readers and in its state", () => {
    const { rerender } = renderButton();
    const button = () => screen.getByRole("button", { name: "Record on the lane Guitar" });
    expect(button()).toHaveAttribute("aria-pressed", "false");
    expect(button()).toHaveAttribute("data-state", "off");

    const again = (controls: Partial<LaneRecordControls>) =>
      rerender(
        <LaneRecordContext.Provider
          value={{ armedId: null, recording: false, toggle: vi.fn(), ...controls }}
        >
          <LaneRecordButton lane={lane} />
        </LaneRecordContext.Provider>,
      );
    again({ armedId: "a" });
    expect(button()).toHaveAttribute("aria-pressed", "true");
    expect(button()).toHaveAttribute("data-state", "armed");
    again({ armedId: "a", recording: true });
    expect(button()).toHaveAttribute("data-state", "recording");
  });

  it("tells in its tooltip what pressing it does next", async () => {
    const { user } = renderButton({ armedId: "a" });
    await user.hover(screen.getByRole("button", { name: "Record on the lane Guitar" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Start recording (the lane is armed)",
    );
  });

  it("is only the armed lane's that is armed: another lane is off, and locked while recording", () => {
    renderButton({ armedId: "b", recording: true });
    const button = screen.getByRole("button", { name: "Record on the lane Guitar" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toBeDisabled();
  });

  it("is pressed with the mouse and with the keyboard", async () => {
    const { user, toggle } = renderButton();
    await user.click(screen.getByRole("button", { name: "Record on the lane Guitar" }));
    expect(toggle).toHaveBeenCalledWith("a");
    screen.getByRole("button", { name: "Record on the lane Guitar" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it("has no accessibility violations", async () => {
    const { container } = renderButton({ armedId: "a" });
    await expectNoA11yViolations(container);
  });
});

describe("ArmedLaneBar", () => {
  const props = {
    laneName: "Guitar",
    inputText: "Scarlett 2i2, input 1 · about 11 ms delay",
    problem: false,
    hear: true,
    warnFeedback: false,
    onHearChange: vi.fn(),
    onRecord: vi.fn(),
    onDisarm: vi.fn(),
    onInputSettings: vi.fn(),
  };

  it("names the lane and where it listens, and starts the take, lets go or opens the input settings", async () => {
    const onRecord = vi.fn();
    const onDisarm = vi.fn();
    const onInputSettings = vi.fn();
    const { user } = renderWithProviders(
      <ArmedLaneBar
        {...props}
        onRecord={onRecord}
        onDisarm={onDisarm}
        onInputSettings={onInputSettings}
      />,
    );
    const bar = screen.getByRole("region", { name: "Armed lane" });
    expect(bar).toHaveTextContent("Guitar is armed");
    expect(bar).toHaveTextContent("Scarlett 2i2, input 1 · about 11 ms delay");
    expect(screen.getByRole("meter", { name: "Input level" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(screen.getByRole("button", { name: "Disarm the lane" }));
    await user.click(screen.getByRole("button", { name: "Input settings" }));
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onDisarm).toHaveBeenCalledTimes(1);
    expect(onInputSettings).toHaveBeenCalledTimes(1);
  });

  it("switches Hear myself, and shows no input level when the input is not heard", async () => {
    const onHearChange = vi.fn();
    const { user, rerender } = renderWithProviders(
      <ArmedLaneBar {...props} onHearChange={onHearChange} />,
    );
    await user.click(screen.getByRole("switch", { name: "Hear myself" }));
    expect(onHearChange).toHaveBeenCalledWith(false);
    rerender(<ArmedLaneBar {...props} hear={false} />);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("warns about feedback with the computer's own microphone, and shows a problem as one", async () => {
    const { container } = renderWithProviders(
      <ArmedLaneBar {...props} warnFeedback problem inputText="Hearing yourself needs effects" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("use headphones");
    await expectNoA11yViolations(container);
  });
});
