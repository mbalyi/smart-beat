import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordDialog } from "@/components/score/record-dialog";
import { resetAiStore } from "@/lib/ai/ai-store";
import { expectNoA11yViolations } from "@/test/axe";
import { installMediaDevices } from "@/test/media-devices";
import { renderWithProviders } from "@/test/render";

beforeEach(() => resetAiStore());

function setup(onFromLane: (() => void) | undefined) {
  installMediaDevices({ inputs: [{ deviceId: "mic", label: "Scarlett 2i2 USB" }] });
  const onRecord = vi.fn();
  const ui = renderWithProviders(
    <RecordDialog
      open
      onOpenChange={vi.fn()}
      targets={[{ index: 0, name: "Lead", kind: "stringed" }]}
      defaultTrack={0}
      defaultBar={0}
      barCount={8}
      supported
      onRecord={onRecord}
      onRecordFile={vi.fn()}
      onFromLane={onFromLane}
    />,
  );
  return { ...ui, onRecord };
}

describe("Record to Tab, Audio lane source", () => {
  it("has no Audio lane source where the lanes are not available", () => {
    setup(undefined);
    expect(screen.queryByRole("radio", { name: "Audio lane" })).not.toBeInTheDocument();
  });

  it("hands over to the lane dialog instead of recording", async () => {
    const onFromLane = vi.fn();
    const { user, onRecord } = setup(onFromLane);
    const form = screen.getByRole("dialog", { name: /^Record to Tab/ });
    await user.click(within(form).getByRole("radio", { name: "Audio lane" }));
    expect(within(form).getByTestId("record-lane-note")).toBeInTheDocument();
    // No microphone and no recording settings for a lane.
    expect(within(form).queryByRole("combobox", { name: "Tuning" })).not.toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: "Record" })).not.toBeInTheDocument();
    await expectNoA11yViolations(form);
    await user.click(within(form).getByRole("button", { name: "Choose the audio" }));
    expect(onFromLane).toHaveBeenCalledTimes(1);
    expect(onRecord).not.toHaveBeenCalled();
  });
});
