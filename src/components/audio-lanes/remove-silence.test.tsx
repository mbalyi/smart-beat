import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RemoveSilenceDialog } from "@/components/audio-lanes/remove-silence-dialog";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings } from "@/lib/tauri";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const SOURCE = { id: "a".repeat(64), name: "take.wav", ext: "wav", embedded: true };

function song(clip: AudioClip = newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a")) {
  return {
    ...EMPTY_AUDIO,
    sources: [SOURCE],
    lanes: [{ ...newLane("Vocals", "lane-a"), clips: [clip] }],
  } satisfies AudioLanesSettings;
}

function renderDialog(audio: AudioLanesSettings = song()) {
  const apply = vi.fn();
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <RemoveSilenceDialog
      open
      onOpenChange={onOpenChange}
      lanes={{ audio, apply }}
      clipIds={["clip-a"]}
    />,
  );
  return { ...view, apply, onOpenChange, dialog: screen.getByRole("dialog") };
}

describe("RemoveSilenceDialog", () => {
  let calls: ReturnType<typeof mockTauri>;
  beforeEach(() => {
    vi.clearAllMocks();
    calls = mockTauri();
  });

  it("previews the quiet pieces and removes them in one edit", async () => {
    const { user, apply, onOpenChange, dialog } = renderDialog();
    expect(within(dialog).getByRole("heading", { name: "Remove silence" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Quieter than")).toHaveValue(-45);
    expect(within(dialog).getByLabelText("For at least")).toHaveValue(300);
    expect(within(dialog).getByLabelText("Keep around the sound")).toHaveValue(20);
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "1 quiet piece will be removed from 1 clip.",
      ),
    );
    expect(calls.find((c) => c.cmd === "audio_silent_regions")?.args).toEqual({
      sourceId: SOURCE.id,
      thresholdDb: -45,
      minSilenceMs: 300,
      padMs: 20,
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(apply).toHaveBeenCalledTimes(1);
    const edited = apply.mock.calls[0]![0](song()) as AudioLanesSettings;
    expect(edited.lanes[0]!.clips.map((c) => [c.startMs, c.lengthMs])).toEqual([
      [2000, 1000],
      [4000, 2000],
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Removed 1 quiet piece");
  });

  it("measures again with the new settings", async () => {
    const { user, dialog } = renderDialog();
    const threshold = within(dialog).getByLabelText("Quieter than");
    await user.clear(threshold);
    await user.type(threshold, "-30");
    await waitFor(() =>
      expect(calls.some((c) => (c.args as { thresholdDb?: number })?.thresholdDb === -30)).toBe(
        true,
      ),
    );
  });

  it("explains a stretched clip and offers nothing to remove", async () => {
    const stretched = {
      ...newClip(SOURCE.id, "take.wav", 2000, 4000, "clip-a"),
      stretch: [{ clipMs: 1000, sourceMs: 1500 }],
    };
    const { dialog } = renderDialog(song(stretched));
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent("No quiet parts found"),
    );
    expect(within(dialog).getByText(/1 stretched clip/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("says when the audio cannot be measured", async () => {
    calls = mockTauri({
      audio_silent_regions: () => {
        throw { kind: "audio", message: "The audio file is not loaded" };
      },
    });
    const { dialog } = renderDialog();
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent("Couldn't measure the audio"),
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't find the quiet parts", {
      description: "The audio file is not loaded",
    });
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("has no accessibility problems", async () => {
    const { dialog } = renderDialog();
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("quiet"));
    await expectNoA11yViolations();
  });
});
