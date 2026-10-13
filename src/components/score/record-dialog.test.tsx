import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { RecordDialog, type RecordSetup } from "@/components/score/record-dialog";
import { storeAudioInput } from "@/lib/audio/input";
import {
  readAlignToBeat,
  readInstrument,
  readTuningChoice,
  type RecordInstrument,
} from "@/lib/audio/record-prefs";
import { expectNoA11yViolations } from "@/test/axe";
import { installMediaDevices } from "@/test/media-devices";
import { renderWithProviders } from "@/test/render";

const BUILT_IN = { deviceId: "built-in", label: "MacBook Pro Microphone" };
const SCARLETT = { deviceId: "scarlett", label: "Scarlett 2i2 USB" };

const TARGETS = [
  { index: 0, name: "Lead", kind: "stringed" as const },
  { index: 2, name: "Rhythm", kind: "stringed" as const },
  { index: 3, name: "Keys", kind: "pitched" as const },
];

function setup(
  props: Partial<Parameters<typeof RecordDialog>[0]> = {},
  devices: Parameters<typeof installMediaDevices>[0] = { inputs: [BUILT_IN, SCARLETT] },
) {
  const mic = installMediaDevices(devices);
  const onRecord = vi.fn<(setup: RecordSetup) => void>();
  const onOpenChange = vi.fn();
  const onRecordFile =
    vi.fn<(file: File, tuning: number[], instrument: RecordInstrument) => void>();
  const element = (more: Partial<Parameters<typeof RecordDialog>[0]> = {}) => (
    <RecordDialog
      open
      onOpenChange={onOpenChange}
      targets={TARGETS}
      defaultTrack={2}
      defaultBar={3}
      barCount={8}
      supported
      onRecord={onRecord}
      onRecordFile={onRecordFile}
      {...props}
      {...more}
    />
  );
  const utils = renderWithProviders(element());
  /** Renders the dialog again with some props changed. */
  const update = (more: Partial<Parameters<typeof RecordDialog>[0]>) =>
    utils.rerender(element(more));
  return { ...utils, update, mic, onRecord, onRecordFile, onOpenChange };
}

const dialog = () => screen.getByRole("dialog", { name: /^Record to Tab/ });

describe("RecordDialog", () => {
  it("starts in click mode on the shown track, at the cursor's bar", async () => {
    const { user, onRecord } = setup();
    const form = dialog();
    expect(within(form).getByRole("radio", { name: "Click" })).toBeChecked();
    expect(within(form).getByRole("combobox", { name: "Track" })).toHaveTextContent("Rhythm");
    // The UI counts bars from 1.
    expect(within(form).getByRole("spinbutton", { name: "Start bar" })).toHaveValue(4);
    expect(within(form).getByRole("checkbox", { name: "Play other tracks" })).toBeChecked();
    // A track that exists has its tuning already.
    expect(within(form).queryByRole("combobox", { name: "Tuning" })).not.toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalledWith({
      mode: "click",
      track: 2,
      startBar: 3,
      playOthers: true,
      alignToBeat: true,
      tuning: [64, 59, 55, 50, 45, 40],
      instrument: "guitar",
    });
  });

  it("records a piano: no tuning, only pitched tracks, and remembers the choice", async () => {
    const { user, onRecord } = setup();
    await user.click(screen.getByRole("radio", { name: "Piano" }));
    expect(screen.getByRole("combobox", { name: "Track" })).toHaveTextContent("Keys");
    expect(screen.queryByRole("combobox", { name: "Tuning" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Track" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Keys", "New track"]);
    await user.click(screen.getByRole("option", { name: "New track" }));
    // A new piano track has no strings to tune.
    expect(screen.queryByRole("combobox", { name: "Strings" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "click", track: null, instrument: "piano" }),
    );
    expect(readInstrument()).toBe("piano");
  });

  it("starts on the instrument used last, and hides the other instrument's tracks", () => {
    localStorage.setItem("smart-beat:record-instrument", "piano");
    setup();
    expect(screen.getByRole("radio", { name: "Piano" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Track" })).toHaveTextContent("Keys");
  });

  it("takes the first guitar track when the shown track is not one", () => {
    setup({ defaultTrack: 1 });
    expect(screen.getByRole("combobox", { name: "Track" })).toHaveTextContent("Lead");
  });

  it("offers only a new track when the song has no guitar", () => {
    setup({ targets: [], defaultTrack: null });
    expect(screen.getByRole("combobox", { name: "Track" })).toHaveTextContent("New track");
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent("Standard");
  });

  it("keeps the start bar inside the song", () => {
    setup({ defaultBar: 40 });
    expect(screen.getByRole("spinbutton", { name: "Start bar" })).toHaveValue(8);
  });

  it("asks for a tuning on a new track, with 7 and 8 strings", async () => {
    const { user, onRecord } = setup();
    await user.click(screen.getByRole("combobox", { name: "Track" }));
    await user.click(screen.getByRole("option", { name: "New track" }));

    expect(screen.getByRole("combobox", { name: "Strings" })).toHaveTextContent("6 strings");
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent(/Standard/);

    await user.click(screen.getByRole("combobox", { name: "Strings" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "6 strings",
      "7 strings",
      "8 strings",
    ]);
    await user.click(screen.getByRole("option", { name: "7 strings" }));

    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        track: null,
        tuning: [64, 59, 55, 50, 45, 40, 35],
      }),
    );
  });

  it("remembers the tuning picked", async () => {
    const { user, unmount } = setup({ targets: [], defaultTrack: null });
    await user.click(screen.getByRole("combobox", { name: "Strings" }));
    await user.click(screen.getByRole("option", { name: "8 strings" }));
    await user.click(screen.getByRole("combobox", { name: "Tuning" }));
    await user.click(screen.getAllByRole("option", { name: /^Drop/ })[0]!);
    const chosen = readTuningChoice();
    expect(chosen.strings).toBe(8);
    expect(chosen.name).toMatch(/^Drop/);
    unmount();

    setup({ targets: [], defaultTrack: null });
    expect(screen.getByRole("combobox", { name: "Strings" })).toHaveTextContent("8 strings");
    expect(screen.getByRole("combobox", { name: "Tuning" })).toHaveTextContent(chosen.name);
  });

  it("shows the tuning, and no track or bar, in free mode", async () => {
    const { user, onRecord } = setup();
    await user.click(screen.getByRole("radio", { name: "Free" }));
    expect(screen.getByRole("combobox", { name: "Tuning" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Start bar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Play other tracks" })).not.toBeInTheDocument();
    expect(dialog()).toHaveAccessibleDescription(/finds the tempo/);

    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ mode: "free", track: null }));
  });

  it("remembers whether the other tracks play", async () => {
    const { user, unmount } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Play other tracks" }));
    expect(localStorage.getItem("smart-beat:record-play-others")).toBe("0");
    unmount();

    const second = setup();
    expect(screen.getByRole("checkbox", { name: "Play other tracks" })).not.toBeChecked();
    await second.user.click(screen.getByRole("button", { name: "Record" }));
    expect(second.onRecord).toHaveBeenCalledWith(expect.objectContaining({ playOthers: false }));
  });

  it("sends the chosen start bar, counted from 0", async () => {
    const { user, onRecord } = setup();
    const bar = screen.getByRole("spinbutton", { name: "Start bar" });
    await user.clear(bar);
    await user.type(bar, "6");
    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ startBar: 5 }));
  });

  it("starts the take with Enter", async () => {
    const { user, onRecord } = setup();
    await user.type(screen.getByRole("spinbutton", { name: "Start bar" }), "{Enter}");
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape and with Cancel, without recording", async () => {
    const { user, onOpenChange, onRecord } = setup();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("changes the input for the whole app", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("combobox", { name: "Input" }));
    await user.click(await screen.findByRole("option", { name: "Scarlett 2i2 USB" }));
    expect(JSON.parse(localStorage.getItem("smart-beat:audio-input")!)).toEqual(SCARLETT);
  });

  it("listens to the input chosen in Settings while it is open", async () => {
    storeAudioInput(SCARLETT);
    const { mic, unmount } = setup();
    await waitFor(() =>
      expect(mic.getUserMedia).toHaveBeenCalledWith({
        audio: expect.objectContaining({ deviceId: { exact: "scarlett" } }),
      }),
    );
    expect(screen.getByRole("meter", { name: "Input level" })).toBeInTheDocument();
    unmount();
    // The input is let go of when the dialog closes: the recorder opens it again.
    expect(mic.stop).toHaveBeenCalled();
  });

  describe("the built-in microphone hint", () => {
    const HINT = "Use headphones, or the click will be heard in the recording.";

    it("shows for a built-in microphone", async () => {
      storeAudioInput(BUILT_IN);
      setup();
      expect(await screen.findByText(HINT)).toBeInTheDocument();
    });

    it("shows when the system default is a built-in microphone", async () => {
      setup();
      expect(await screen.findByText(HINT)).toBeInTheDocument();
    });

    it("does not show for an audio interface", async () => {
      storeAudioInput(SCARLETT);
      const { mic } = setup();
      await waitFor(() => expect(mic.getUserMedia).toHaveBeenCalled());
      await screen.findByText("Play a few notes to check the level.");
      expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    });
  });

  it("explains a blocked microphone and does not record", async () => {
    const { onRecord } = setup({}, { inputs: [BUILT_IN], denied: true });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Privacy & Security › Microphone/);
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("says when recording needs the desktop app", () => {
    setup({ supported: false });
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    expect(screen.getByText("Record to Tab needs the Smart Beat desktop app.")).toBeVisible();
  });

  it("says that it is a beta for guitar, how accurate it is, and to review the tab", () => {
    setup();
    expect(within(dialog()).getByText("Beta")).toBeVisible();
    const note = within(dialog()).getByText(/Guitar only for now/);
    expect(note).toHaveTextContent("Guitar only for now.");
    expect(note).toHaveTextContent("Roughly 7 of 10 notes are found");
    expect(note).toHaveTextContent("Review the tab and correct it.");
  });

  it("remembers whether the take is lined up with the beat", async () => {
    const { user, onRecord } = setup();
    const align = screen.getByRole("checkbox", { name: /Line up with the beat/ });
    expect(align).toBeChecked();
    await user.click(align);
    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ alignToBeat: false }));
    expect(readAlignToBeat()).toBe(false);
  });

  describe("an existing recording", () => {
    const wav = () => new File([new Uint8Array(8)], "riff.wav");

    it("turns a chosen file into tab with the tuning, without the microphone", async () => {
      const { user, onRecordFile, onRecord } = setup();
      await user.click(screen.getByRole("radio", { name: "File" }));
      expect(screen.queryByRole("meter", { name: "Input level" })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Track" })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Tuning" })).toBeInTheDocument();
      const make = screen.getByRole("button", { name: "Make tab" });
      expect(make).toBeDisabled();

      await user.upload(screen.getByLabelText("Choose an audio recording"), wav());
      expect(screen.getByText("riff.wav")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Make tab" }));
      expect(onRecordFile).toHaveBeenCalledWith(
        expect.any(File),
        [64, 59, 55, 50, 45, 40],
        "guitar",
      );
      expect(onRecord).not.toHaveBeenCalled();
    });

    it("takes a file dropped on the window, and switches to it", async () => {
      const { update } = setup();
      update({ droppedFile: { file: wav(), nonce: 1 } });
      expect(await screen.findByText("riff.wav")).toBeVisible();
      expect(screen.getByRole("radio", { name: "File" })).toBeChecked();
    });

    it("refuses a file that is not audio", async () => {
      const { user, onRecordFile } = setup();
      await user.click(screen.getByRole("radio", { name: "File" }));
      fireEvent.change(screen.getByLabelText("Choose an audio recording"), {
        target: { files: [new File(["x"], "song.gp5")] },
      });
      expect(screen.getByRole("alert")).toHaveTextContent("Choose an MP3, WAV, FLAC or OGG file.");
      expect(screen.getByRole("button", { name: "Make tab" })).toBeDisabled();
      expect(onRecordFile).not.toHaveBeenCalled();
    });
  });

  it("has no accessibility violations, in click, free and file mode", async () => {
    const { user } = setup();
    await screen.findByText("Play a few notes to check the level.");
    await expectNoA11yViolations(dialog());
    await user.click(screen.getByRole("radio", { name: "Free" }));
    await expectNoA11yViolations(dialog());
    await user.click(screen.getByRole("radio", { name: "File" }));
    await expectNoA11yViolations(dialog());
  });
});
