import { act, renderHook } from "@testing-library/react";

import {
  AUDIO_INPUT_CHANNEL_STORAGE_KEY,
  AUDIO_INPUT_STORAGE_KEY,
  AudioInputMissingError,
  audioInputErrorText,
  listAudioInputs,
  looksBuiltIn,
  openAudioInput,
  readAudioInput,
  readAudioInputChannel,
  revealAudioInputs,
  storeAudioInput,
  storeAudioInputChannel,
  useAudioInput,
  useAudioInputChannel,
} from "@/lib/audio/input";
import { installMediaDevices } from "@/test/media-devices";

const BUILT_IN = { deviceId: "built-in", label: "MacBook Pro Microphone" };
const SCARLETT = { deviceId: "scarlett", label: "Scarlett 2i2 USB" };

describe("the chosen audio input", () => {
  it("is the system default until one is chosen, and is remembered", () => {
    expect(readAudioInput()).toBeNull();
    storeAudioInput(SCARLETT);
    expect(readAudioInput()).toEqual(SCARLETT);
    expect(JSON.parse(localStorage.getItem(AUDIO_INPUT_STORAGE_KEY)!)).toEqual(SCARLETT);
    storeAudioInput(null);
    expect(readAudioInput()).toBeNull();
    expect(localStorage.getItem(AUDIO_INPUT_STORAGE_KEY)).toBeNull();
  });

  it.each([
    "not json",
    "null",
    '{"label":"No id"}',
    '{"deviceId":"","label":"x"}',
    '{"deviceId":1}',
  ])("ignores a damaged saved value: %s", (raw) => {
    localStorage.setItem(AUDIO_INPUT_STORAGE_KEY, raw);
    expect(readAudioInput()).toBeNull();
  });

  it("tells every listener when the choice changes", () => {
    const { result } = renderHook(() => useAudioInput());
    expect(result.current).toBeNull();
    act(() => storeAudioInput(SCARLETT));
    expect(result.current).toEqual(SCARLETT);
    const before = result.current;
    act(() => storeAudioInput(SCARLETT));
    expect(result.current).toBe(before);
    act(() => storeAudioInput(null));
    expect(result.current).toBeNull();
  });
});

describe("listAudioInputs", () => {
  it("lists the audio inputs with their names, without stand-ins and other devices", async () => {
    const devices = installMediaDevices();
    devices.enumerateDevices.mockResolvedValueOnce([
      { kind: "audioinput", deviceId: "default", label: "Default - Scarlett 2i2 USB" },
      { kind: "audioinput", deviceId: "communications", label: "Communications" },
      { kind: "audioinput", ...BUILT_IN },
      { kind: "audioinput", ...SCARLETT },
      { kind: "audiooutput", deviceId: "speakers", label: "MacBook Pro Speakers" },
      { kind: "videoinput", deviceId: "camera", label: "FaceTime HD Camera" },
    ] as MediaDeviceInfo[]);
    expect(await listAudioInputs()).toEqual({
      available: true,
      inputs: [BUILT_IN, SCARLETT],
      namesHidden: false,
    });
  });

  it("says when the names are hidden until the microphone may be used", async () => {
    installMediaDevices({ inputs: [BUILT_IN, SCARLETT], hidden: true });
    expect(await listAudioInputs()).toEqual({ available: true, inputs: [], namesHidden: true });
    await revealAudioInputs();
    expect(await listAudioInputs()).toEqual({
      available: true,
      inputs: [BUILT_IN, SCARLETT],
      namesHidden: false,
    });
  });

  it("is unavailable without media devices", async () => {
    expect(await listAudioInputs()).toEqual({ available: false, inputs: [], namesHidden: false });
  });
});

describe("revealAudioInputs", () => {
  it("lets go of the microphone straight away", async () => {
    const devices = installMediaDevices({ inputs: [BUILT_IN], hidden: true });
    await revealAudioInputs();
    expect(devices.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(devices.stop).toHaveBeenCalledTimes(1);
  });
});

describe("openAudioInput", () => {
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

  it("opens the system default input without voice processing", async () => {
    const devices = installMediaDevices({ inputs: [BUILT_IN, SCARLETT] });
    const stream = await openAudioInput(null);
    expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: raw });
    expect(stream.getAudioTracks()[0]!.label).toBe(BUILT_IN.label);
  });

  it("opens exactly the chosen input", async () => {
    const devices = installMediaDevices({ inputs: [BUILT_IN, SCARLETT] });
    const stream = await openAudioInput(SCARLETT);
    expect(devices.getUserMedia).toHaveBeenCalledWith({
      audio: { ...raw, deviceId: { exact: "scarlett" } },
    });
    expect(stream.getAudioTracks()[0]!.label).toBe(SCARLETT.label);
  });

  it("finds an input whose id changed by its name, and remembers the new id", async () => {
    installMediaDevices({ inputs: [BUILT_IN, { deviceId: "scarlett-2", label: SCARLETT.label }] });
    storeAudioInput(SCARLETT);
    const stream = await openAudioInput(SCARLETT);
    expect(stream.getAudioTracks()[0]!.label).toBe(SCARLETT.label);
    expect(readAudioInput()).toEqual({ deviceId: "scarlett-2", label: SCARLETT.label });
  });

  it("says so when the chosen input is not connected", async () => {
    installMediaDevices({ inputs: [BUILT_IN] });
    const error = await openAudioInput(SCARLETT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AudioInputMissingError);
    expect(audioInputErrorText(error)).toBe(
      "“Scarlett 2i2 USB” is not connected. Connect it, or choose another input in Settings.",
    );
  });

  it("explains how to allow the microphone when it is blocked", async () => {
    installMediaDevices({ inputs: [SCARLETT], denied: true });
    const error = await openAudioInput(SCARLETT).catch((e: unknown) => e);
    expect(audioInputErrorText(error)).toMatch(/Privacy & Security › Microphone/);
  });

  it("explains other errors, also when media devices are missing", async () => {
    const error = await openAudioInput(null).catch((e: unknown) => e);
    expect(audioInputErrorText(error)).toBe(
      "The microphone could not be opened: No microphone here.",
    );
  });
});

describe("looksBuiltIn", () => {
  it.each([
    "MacBook Pro Microphone",
    "MacBook Air Microphone",
    "Built-in Microphone",
    "Built-in Audio Analog Stereo",
    "Internal Microphone",
    "iMac Microphone",
    "Microphone Array (Realtek High Definition Audio)",
  ])("recognises %s", (label) => {
    expect(looksBuiltIn(label)).toBe(true);
  });

  it.each(["Scarlett 2i2 USB", "Focusrite USB Audio", "AirPods Pro", "Rocksmith Real Tone Cable"])(
    "does not take %s for one",
    (label) => {
      expect(looksBuiltIn(label)).toBe(false);
    },
  );

  it("does not guess when the name is hidden", () => {
    expect(looksBuiltIn("")).toBe(false);
    expect(looksBuiltIn(null)).toBe(false);
    expect(looksBuiltIn(undefined)).toBe(false);
  });
});

describe("the chosen input channel (the monitor track's)", () => {
  it("is the first one until another is chosen, and is remembered", () => {
    expect(readAudioInputChannel()).toBe(0);
    storeAudioInputChannel(1);
    expect(readAudioInputChannel()).toBe(1);
    storeAudioInputChannel(null);
    expect(readAudioInputChannel()).toBeNull();
    expect(localStorage.getItem(AUDIO_INPUT_CHANNEL_STORAGE_KEY)).toBe("all");
    storeAudioInputChannel(0);
    expect(localStorage.getItem(AUDIO_INPUT_CHANNEL_STORAGE_KEY)).toBeNull();
  });

  it.each(["-1", "1.5", "x", "999"])("falls back to the first one for %j", (raw) => {
    localStorage.setItem(AUDIO_INPUT_CHANNEL_STORAGE_KEY, raw);
    expect(readAudioInputChannel()).toBe(0);
  });

  it("keeps hooks up to date", () => {
    const { result } = renderHook(() => useAudioInputChannel());
    expect(result.current).toBe(0);
    act(() => storeAudioInputChannel(1));
    expect(result.current).toBe(1);
  });
});
