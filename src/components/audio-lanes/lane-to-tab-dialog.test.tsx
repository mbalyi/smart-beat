import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LaneToTabDialog,
  type LaneToTabDialogProps,
} from "@/components/audio-lanes/lane-to-tab-dialog";
import type { LaneToTabHost } from "@/hooks/use-lane-to-tab";
import { resetAiStore } from "@/lib/ai/ai-store";
import { EMPTY_AUDIO, newClip, newLane } from "@/lib/audio-lanes/model";
import type { LaneToTabRequest } from "@/lib/audio-lanes/lane-transcribe-request";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import { registerPartDropTarget } from "@/lib/score/part-drop-registry";
import { appendMasterBar } from "@/lib/score/model";
import { createSong } from "@/lib/score/tracks";
import type * as TauriModule from "@/lib/tauri";
import { transcribeLane } from "@/lib/tauri";
import { track } from "@/lib/telemetry";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriModule>()),
  transcribeLane: vi.fn(),
  cancelLaneTranscription: vi.fn().mockResolvedValue(undefined),
}));
// The real alphaTab cannot lay out in jsdom: the preview is covered in the browser tests.
vi.mock("@/components/score/score-preview", () => ({
  ScorePreview: () => <div data-testid="score-preview" />,
}));
vi.mock("@/lib/audio-transcription/preview", () => ({
  NotePreview: class {
    play() {
      return Promise.resolve();
    }
    stop() {}
    position() {
      return 0;
    }
  },
  decodeOriginal: vi.fn().mockResolvedValue(null),
}));

/** 60 bpm in 4/4: 4 s a bar, 32 bars. */
const grid: SongGrid = {
  barTimes: Array.from({ length: 32 }, (_, i) => i * 4000),
  beats: Array(32).fill(4),
};

function audioWith(options: { mute?: boolean; length?: number } = {}) {
  const lane = newLane("Lead guitar", "lane");
  const clip = newClip("src", "take", 48_000, options.length ?? 42_000, "clip");
  clip.mute = options.mute ?? false;
  lane.clips = [clip];
  return { ...EMPTY_AUDIO, lanes: [lane] };
}

const NOTES = [
  { start: 48.5, end: 49, pitch: 40, velocity: 90 },
  { start: 50, end: 50.5, pitch: 43, velocity: 90 },
];

function setup(
  options: {
    request?: Partial<LaneToTabRequest>;
    audio?: ReturnType<typeof audioWith>;
    host?: Partial<LaneToTabHost>;
    props?: Partial<LaneToTabDialogProps>;
  } = {},
) {
  const score = createSong();
  while (score.masterBars.length < 32) appendMasterBar(score);
  const request: LaneToTabRequest = {
    laneId: "lane",
    clipIds: ["clip"],
    range: null,
    origin: "clip",
    ...options.request,
  };
  const host: LaneToTabHost = {
    request,
    nonce: 1,
    open: vi.fn(),
    close: vi.fn(),
    place: vi.fn(() => ({
      track: 0,
      warnings: [],
      firstBar: 12,
      lastBar: 17,
      appended: 0,
    })),
    newTab: vi.fn(() => true),
    undo: vi.fn(),
    ...options.host,
  };
  const onUnmuteClip = vi.fn();
  const props: LaneToTabDialogProps = {
    host,
    audio: options.audio ?? audioWith(),
    grid,
    missing: new Set(),
    score,
    tracks: [{ index: 0, name: "Guitar", kind: "stringed" }],
    cursorTrack: 0,
    onUnmuteClip,
    revision: 0,
    ...options.props,
  };
  const ui = renderWithProviders(<LaneToTabDialog {...props} />);
  return { ...ui, host, onUnmuteClip, score };
}

beforeEach(() => {
  vi.mocked(transcribeLane).mockReset();
  vi.mocked(transcribeLane).mockResolvedValue({
    notes: NOTES,
    startMs: 48_000,
    endMs: 90_000,
    clipIds: ["clip"],
  });
  vi.mocked(track).mockClear();
  resetAiStore();
});

const find = () => screen.getByRole("button", { name: /Find the notes/ });

describe("Sheet from an audio lane", () => {
  it("has the logo, a real title for screen readers and four steps", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Sheet from an audio lane" })).toBeInTheDocument();
    const logo = screen.getByTestId("lane-to-tab-logo");
    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(steps).toHaveTextContent("Source");
    expect(steps).toHaveTextContent("Instrument");
    expect(steps).toHaveTextContent("Place");
    expect(steps).toHaveTextContent("Result");
  });

  it("opens on Instrument with the clip shown collapsed, and Change opens the Source", async () => {
    const { user } = setup();
    expect(screen.getByRole("heading", { name: "What is playing?" })).toBeInTheDocument();
    expect(screen.getByTestId("lane-to-tab-source-summary")).toHaveTextContent(
      "Lead guitar, clip 1, 0:48 to 1:30",
    );
    // The lane's name says it is a guitar.
    expect(screen.getByRole("radio", { name: "Guitar" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("heading", { name: "Choose the audio" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Whole track" })).toBeInTheDocument();
  });

  it("opens on Source for a whole lane", () => {
    setup({ request: { clipIds: [], origin: "lane" } });
    expect(screen.getByRole("heading", { name: "Choose the audio" })).toBeInTheDocument();
    expect(screen.getByText("Lead guitar, 0:48 to 1:30")).toBeInTheDocument();
  });

  it("finds the notes, places them at the clip's bar and adds them in one call", async () => {
    const { user, host } = setup();
    await user.click(find());
    expect(transcribeLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane",
        clipId: "clip",
        instrument: "guitar",
      }),
      expect.any(Function),
    );
    expect(track).toHaveBeenCalledWith("lane_transcribe", "guitar");
    expect(
      await screen.findByRole("heading", { name: "Where do the notes go?" }),
    ).toBeInTheDocument();
    // 0:48 at 60 bpm in 4/4 is bar 13.
    expect(screen.getByLabelText("Start bar")).toHaveValue(13);
    expect(screen.getByText("Same bar as the audio.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("placement-caption")).toHaveTextContent(/Adds bars? 13/),
    );
    expect(screen.getByTestId("note-count")).toHaveTextContent("2 notes");
    await user.click(screen.getByRole("button", { name: "Add to score" }));
    expect(host.place).toHaveBeenCalledTimes(1);
    const [part, target, options] = vi.mocked(host.place).mock.calls[0]!;
    expect(target).toEqual({ track: 0, bar: 12 });
    expect(options).toEqual({ toast: false });
    expect(part.notes).toEqual(NOTES);
    // The take is relative to bar 13: the first note is 0.5 s after the downbeat.
    expect(part.take[0]!.start).toBeCloseTo(0.5, 6);
    expect(screen.getByRole("heading", { name: "Your sheet is ready" })).toBeInTheDocument();
    expect(screen.getByTestId("lane-to-tab-result")).toHaveTextContent(
      "Added Guitar to “Guitar”, bars 13 to 18.",
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(host.undo).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Undone. The tab is as it was.")).toBeInTheDocument();
  });

  it("changing the bar updates the caption, after the choices settle", async () => {
    const { user, host } = setup();
    await user.click(find());
    await screen.findByLabelText("Start bar");
    await waitFor(() => expect(screen.getByTestId("placement-caption")).toHaveTextContent("13"));
    await user.clear(screen.getByLabelText("Start bar"));
    await user.type(screen.getByLabelText("Start bar"), "5");
    await waitFor(() =>
      expect(screen.getByTestId("placement-caption")).toHaveTextContent(/bars? 5/),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Add to score" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add to score" }));
    const [, target] = vi.mocked(host.place).mock.calls[0]!;
    expect(target).toEqual({ track: 0, bar: 4 });
  });

  it("writes a new tab through the host", async () => {
    const { user, host } = setup();
    await user.click(find());
    await screen.findByLabelText("Start bar");
    await user.click(screen.getByRole("radio", { name: "New tab" }));
    const open = screen.getByRole("button", { name: "Open as a new tab" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    expect(host.newTab).toHaveBeenCalledTimes(1);
    expect(host.close).toHaveBeenCalled();
  });

  it("says so when no notes were heard", async () => {
    vi.mocked(transcribeLane).mockResolvedValue({
      notes: [],
      startMs: 48_000,
      endMs: 90_000,
      clipIds: ["clip"],
    });
    const { user } = setup();
    await user.click(find());
    expect(await screen.findByText(/No notes were heard/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What is playing?" })).toBeInTheDocument();
  });

  it("shows a failure and lets the player try again", async () => {
    vi.mocked(transcribeLane).mockRejectedValueOnce({ kind: "ai", message: "The model failed." });
    const { user } = setup();
    await user.click(find());
    expect(await screen.findByRole("alert")).toHaveTextContent("The model failed.");
    await user.click(find());
    expect(
      await screen.findByRole("heading", { name: "Where do the notes go?" }),
    ).toBeInTheDocument();
  });

  it("shows progress while running and can be stopped", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof transcribeLane>>) => void;
    vi.mocked(transcribeLane).mockImplementation(
      (_request, onProgress) =>
        new Promise((done) => {
          onProgress?.(0.4);
          resolve = done;
        }),
    );
    const { user } = setup();
    await user.click(find());
    expect(await screen.findByTestId("lane-to-tab-progress")).toHaveTextContent("40%");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await act(async () => resolve({ notes: NOTES, startMs: 48_000, endMs: 90_000, clipIds: [] }));
  });

  it("explains a muted clip and unmutes it on request", async () => {
    const { user, onUnmuteClip } = setup({ audio: audioWith({ mute: true }) });
    expect(screen.getByRole("alert")).toHaveTextContent("This clip is muted");
    expect(find()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Unmute it" }));
    expect(onUnmuteClip).toHaveBeenCalledWith("clip");
  });

  it("offers the first ten minutes for a longer span", async () => {
    const { user } = setup({
      audio: audioWith({ length: 700_000 }),
      request: { clipIds: [], origin: "lane" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("up to 10 minutes");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use the first 10 minutes" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("keeps the span and says so when the clip is split away", async () => {
    const view = setup();
    const { user } = view;
    const lane = newLane("Lead guitar", "lane");
    lane.clips = [
      newClip("src", "take", 48_000, 20_000, "left"),
      newClip("src", "take", 68_000, 22_000, "right"),
    ];
    view.rerender(
      <LaneToTabDialog
        host={view.host}
        audio={{ ...EMPTY_AUDIO, lanes: [lane] }}
        grid={grid}
        missing={new Set()}
        score={view.score}
        tracks={[{ index: 0, name: "Guitar", kind: "stringed" }]}
        cursorTrack={0}
        onUnmuteClip={vi.fn()}
        revision={0}
      />,
    );
    // The clip got new ids: the dialog goes on with its span, in range mode, and says so.
    expect(
      await screen.findByText(/time span it had \(0:48 to 1:30\) is used instead/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("radio", { name: "A time span" })).toBeChecked();
    expect(screen.getByLabelText("From")).toHaveValue("0:48.0");
    expect(screen.getByLabelText("To")).toHaveValue("1:30.0");
  });

  it("has no accessibility violations on any step", async () => {
    const { user } = setup();
    await expectNoA11yViolations();
    await user.click(find());
    await screen.findByLabelText("Start bar");
    await waitFor(() => expect(screen.getByTestId("placement-caption")).toHaveTextContent("13"));
    await expectNoA11yViolations();
    document.documentElement.classList.add("dark");
    await expectNoA11yViolations();
    document.documentElement.classList.remove("dark");
  });
});

describe("carrying the sheet to the score", () => {
  /** A score with one guitar track of four bars drawn, and a drum track. */
  const rects = [0, 1, 2, 3].map((bar) => ({
    track: 0,
    bar,
    rect: { x: bar * 100, y: 0, w: 90, h: 50 },
  }));
  function target(drop = vi.fn((_spot: unknown, _part: unknown) => true)) {
    const show = vi.fn();
    const unregister = registerPartDropTarget({
      active: () => true,
      rects: () => rects,
      spotAt: () => null,
      kindOf: (i) => (i === 0 ? "stringed" : "drums"),
      nameOf: () => "Guitar",
      barCount: () => 32,
      show,
      drop,
      viewport: () => null,
      scrollBy: vi.fn(),
      reveal: vi.fn(),
    });
    return { drop, show, unregister };
  }

  async function atPlace() {
    const view = setup();
    await view.user.click(find());
    await screen.findByTestId("part-drag-grip");
    return view;
  }

  it("picks up with Space, moves with the arrows, announces, and drops with Enter", async () => {
    const { drop, unregister } = target();
    const { host } = await atPlace();
    const grip = screen.getByTestId("part-drag-grip");
    grip.focus();
    fireEvent.keyDown(grip, { key: " " });
    await waitFor(() =>
      expect(screen.getByTestId("lane-to-tab-live")).toHaveTextContent(/Picked up/),
    );
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(screen.getByTestId("lane-to-tab-live")).toHaveTextContent(/to Guitar, bars? 3/),
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(drop).mock.calls[0]![0]).toEqual({ track: 0, bar: 2 });
    expect(host.close).toHaveBeenCalled();
    unregister();
  });

  it("Escape cancels the carry and leaves the dialog open", async () => {
    const { drop, unregister } = target();
    const { host } = await atPlace();
    const grip = screen.getByTestId("part-drag-grip");
    fireEvent.keyDown(grip, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("part-drag-hud")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("part-drag-hud")).not.toBeInTheDocument());
    expect(drop).not.toHaveBeenCalled();
    expect(host.close).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    unregister();
  });

  it("says so when no track takes the part", async () => {
    await atPlace();
    const grip = screen.getByTestId("part-drag-grip");
    fireEvent.keyDown(grip, { key: " " });
    expect(screen.getByTestId("lane-to-tab-live")).toHaveTextContent(/Add to score button/);
  });

  it("starts a pointer drag only after a few pixels", async () => {
    const { drop, show, unregister } = target();
    await atPlace();
    const grip = screen.getByTestId("part-drag-grip");
    fireEvent.pointerDown(grip, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 11, clientY: 10, pointerId: 1, buttons: 1 });
    expect(screen.queryByTestId("part-drag-chip")).not.toBeInTheDocument();
    fireEvent.pointerMove(window, { clientX: 40, clientY: 10, pointerId: 1, buttons: 1 });
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toHaveAttribute("data-placing", "true");
    // Released over no bar: nothing is written and the dialog comes back.
    fireEvent.pointerUp(window, { clientX: 40, clientY: 10, pointerId: 1 });
    expect(drop).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("dialog")).not.toHaveAttribute("data-placing"));
    unregister();
  });
});
