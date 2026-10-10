import type { AudioInput } from "@/lib/audio/input";

/**
 * A fake `navigator.mediaDevices` with these audio inputs (the first is the system default).
 * With `hidden`, the inputs and their names stay hidden until the microphone was opened once,
 * as in WebKit. `src/test/setup.ts` removes it after each test.
 */
export function installMediaDevices({
  inputs: initial = [],
  hidden: initiallyHidden = false,
  denied = false,
}: { inputs?: AudioInput[]; hidden?: boolean; denied?: boolean } = {}) {
  let inputs = initial;
  let hidden = initiallyHidden;
  const events = new EventTarget();
  const stop = vi.fn();
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (denied) throw new DOMException("denied", "NotAllowedError");
    const audio = typeof constraints.audio === "object" ? constraints.audio : {};
    const wanted = (audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact;
    const device = wanted === undefined ? inputs[0] : inputs.find((i) => i.deviceId === wanted);
    if (wanted !== undefined && !device) {
      throw new DOMException("No such input", "OverconstrainedError");
    }
    hidden = false;
    const track = { label: device?.label ?? "", stop };
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  });
  const enumerateDevices = vi.fn(
    async () =>
      (hidden
        ? [{ kind: "audioinput", deviceId: "", label: "", groupId: "" }]
        : inputs.map((i) => ({ kind: "audioinput", ...i, groupId: "" }))) as MediaDeviceInfo[],
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  return {
    getUserMedia,
    enumerateDevices,
    /** Called for every track the code lets go of. */
    stop,
    /** Plugs inputs in or out. */
    setInputs(next: AudioInput[]) {
      inputs = next;
      events.dispatchEvent(new Event("devicechange"));
    },
  };
}

export function removeMediaDevices() {
  Reflect.deleteProperty(navigator, "mediaDevices");
}
