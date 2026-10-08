import { act, screen } from "@testing-library/react";

import { TunerDialog } from "@/components/score/tuner-dialog";
import { STANDARD_GUITAR } from "@/lib/score/music";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const RATE = 48_000;

/** A fake microphone that "hears" a sine wave of `hz`. */
function installMicrophone(hz: number | null, { denied = false } = {}) {
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => {
    if (denied) throw new DOMException("denied", "NotAllowedError");
    return { getTracks: () => [{ stop }] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
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
  return { getUserMedia, stop, close };
}

function setup() {
  const onPlay = vi.fn();
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <TunerDialog
      open
      onOpenChange={onOpenChange}
      trackName="Guitar"
      tuning={[64, 59, 55, 50, 45, 38]}
      onPlay={onPlay}
    />,
  );
  return { ...utils, onPlay, onOpenChange };
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
