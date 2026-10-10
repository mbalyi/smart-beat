import { act, screen, waitFor } from "@testing-library/react";

import { TunerDialog } from "@/components/score/tuner-dialog";
import { readAudioInput, storeAudioInput } from "@/lib/audio/input";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { expectNoA11yViolations } from "@/test/axe";
import { installMediaDevices } from "@/test/media-devices";
import { renderWithProviders } from "@/test/render";

const RATE = 48_000;

const BUILT_IN = { deviceId: "built-in", label: "MacBook Pro Microphone" };
const SCARLETT = { deviceId: "scarlett", label: "Scarlett 2i2 USB" };

/** Fake audio inputs that "hear" a sine wave of `hz`. */
function installMicrophone(
  hz: number | null,
  options: Parameters<typeof installMediaDevices>[0] = {},
) {
  const devices = installMediaDevices(options);
  const close = vi.fn(async () => {});
  class FakeAudioContext {
    sampleRate = RATE;
    close = close;
    createAnalyser() {
      return {
        fftSize: 2048,
        getFloatTimeDomainData(buffer: Float32Array) {
          for (let i = 0; i < buffer.length; i++) {
            buffer[i] = hz === null ? 0 : 0.5 * Math.sin((2 * Math.PI * hz * i) / RATE);
          }
        },
      };
    }
    createMediaStreamSource() {
      return { connect: () => {} };
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return { ...devices, close };
}

function setup({ onOpenSettings }: { onOpenSettings?: (from: HTMLElement) => void } = {}) {
  const onPlay = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <TunerDialog
      open
      onOpenChange={onOpenChange}
      trackName="Guitar"
      tuning={[64, 59, 55, 50, 45, 38]}
      onPlay={onPlay}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { ...utils, onPlay, onOpenChange };
}

/** Opens the Microphone tab and starts listening. */
async function listen(user: ReturnType<typeof setup>["user"]) {
  await user.click(screen.getByRole("tab", { name: "Microphone" }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await user.click(screen.getByRole("button", { name: "Listen with the microphone" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

describe("TunerDialog (#83)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays each open string of the track's tuning, low string first", async () => {
    const { user, onPlay } = setup();
    expect(screen.getByText(/Drop D: D A D G B E/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /^Hear string/ });
    expect(buttons.map((b) => b.textContent)).toEqual(["D2", "A2", "D3", "G3", "B3", "E4"]);
    await user.click(screen.getByRole("button", { name: "Hear string 6, D2" }));
    expect(onPlay).toHaveBeenCalledWith(38);
    await expectNoA11yViolations();
  });

  it("asks for the microphone only when listening starts, and releases it", async () => {
    // 1 % flat of A2 (110 Hz) is about 17 cents.
    const mic = installMicrophone(110 * 0.99);
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    expect(mic.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("The microphone is off.");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole("button", { name: "Listen with the microphone" }));
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Listening");
    const meter = screen.getByRole("meter", { name: "Tuning" });
    expect(meter.getAttribute("aria-valuetext")).toMatch(/^1[6-8] cents flat$/);
    expect(screen.getByText("Closest string: 5 (A2)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(mic.stop).toHaveBeenCalled();
    expect(mic.close).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("The microphone is off.");
  });

  it("says when the string is in tune", async () => {
    installMicrophone(110);
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(screen.getByRole("button", { name: "Listen with the microphone" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByRole("meter", { name: "Tuning" })).toHaveAttribute(
      "aria-valuetext",
      "In tune",
    );
    await expectNoA11yViolations();
  });

  it("explains how to allow the microphone when it is blocked", async () => {
    installMicrophone(null, { denied: true });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    await user.click(screen.getByRole("button", { name: "Listen with the microphone" }));
    expect(await screen.findByText(/Privacy & Security › Microphone/)).toBeInTheDocument();
  });

  it("names the standard tuning", () => {
    renderWithProviders(
      <TunerDialog
        open
        onOpenChange={vi.fn()}
        trackName="G"
        tuning={STANDARD_GUITAR}
        onPlay={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Standard: E A D G B E$/)).toBeInTheDocument();
  });
});

describe("TunerDialog: the audio input", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("listens to the input chosen in Settings, and names it", async () => {
    storeAudioInput(SCARLETT);
    const mic = installMicrophone(110, { inputs: [BUILT_IN, SCARLETT] });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    expect(screen.getByText("Input: Scarlett 2i2 USB")).toBeInTheDocument();

    await listen(user);
    expect(mic.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: "scarlett" } }),
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Listening to Scarlett 2i2 USB. Play one string at a time.",
    );
    expect(screen.getByRole("meter", { name: "Tuning" })).toHaveAttribute(
      "aria-valuetext",
      "In tune",
    );
  });

  it("listens to the system default input until one is chosen", async () => {
    const mic = installMicrophone(110, { inputs: [BUILT_IN, SCARLETT] });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    expect(screen.getByText("Input: System default")).toBeInTheDocument();
    await listen(user);
    expect(mic.getUserMedia).toHaveBeenCalledWith({
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
    });
    expect(screen.getByRole("status")).toHaveTextContent("Listening to MacBook Pro Microphone.");
  });

  it("switches to another input chosen while listening", async () => {
    const mic = installMicrophone(110, { inputs: [BUILT_IN, SCARLETT] });
    const { user } = setup();
    await listen(user);
    expect(mic.stop).not.toHaveBeenCalled();

    act(() => storeAudioInput(SCARLETT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mic.stop).toHaveBeenCalledTimes(1);
    expect(mic.getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: "scarlett" } }),
    });
    expect(screen.getByRole("status")).toHaveTextContent("Listening to Scarlett 2i2 USB.");
    expect(screen.getByText("Input: Scarlett 2i2 USB")).toBeInTheDocument();
  });

  it("says when the chosen input is not connected", async () => {
    storeAudioInput(SCARLETT);
    installMicrophone(110, { inputs: [BUILT_IN] });
    const { user } = setup();
    await listen(user);
    expect(
      screen.getByText(
        "“Scarlett 2i2 USB” is not connected. Connect it, or choose another input in Settings.",
      ),
    ).toBeInTheDocument();
    expect(readAudioInput()).toEqual(SCARLETT);
  });

  it("opens Settings to change the input", async () => {
    installMicrophone(110);
    const onOpenSettings = vi.fn();
    const { user } = setup({ onOpenSettings });
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    const change = screen.getByRole("button", { name: "Change input…" });
    await user.click(change);
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith(change);
    await expectNoA11yViolations();
  });

  it("has no way to Settings when there is none", async () => {
    installMicrophone(110);
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    expect(screen.queryByRole("button", { name: "Change input…" })).not.toBeInTheDocument();
  });

  it("lets go of the input when listening stops before the input opened", async () => {
    const mic = installMicrophone(110, { inputs: [BUILT_IN] });
    let allow = () => {};
    const asked = new Promise<void>((resolve) => (allow = resolve));
    const open = mic.getUserMedia.getMockImplementation()!;
    mic.getUserMedia.mockImplementationOnce(async (constraints) => {
      await asked;
      return open(constraints);
    });
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Microphone" }));
    await user.click(screen.getByRole("button", { name: "Listen with the microphone" }));
    expect(screen.getByRole("status")).toHaveTextContent("Asking for the microphone…");
    await user.click(screen.getByRole("button", { name: "Stop listening" }));

    await act(async () => {
      allow();
      await asked;
    });
    await waitFor(() => expect(mic.stop).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("The microphone is off.");
  });
});
