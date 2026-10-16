/**
 * The audio input Smart Beat listens to: the built-in microphone, or an audio interface with an
 * instrument plugged in. One choice for the whole app, made in Settings; the tuner uses it, and
 * so will anything else that listens.
 */
import { useMemo, useSyncExternalStore } from "react";

export const AUDIO_INPUT_STORAGE_KEY = "smart-beat:audio-input";
export const AUDIO_INPUT_CHANNEL_STORAGE_KEY = "smart-beat:audio-input-channel";

/**
 * An input. `deviceId` is the web view's id for it. `label` is its name ("Scarlett 2i2 USB"):
 * it finds the input again when the id changes, shows the choice while macOS hides the names,
 * and is the name the native engine sees for the same device.
 */
export interface AudioInput {
  deviceId: string;
  label: string;
}

/** The inputs this computer has. */
export interface AudioInputList {
  /** False when this web view can't use audio inputs at all. */
  available: boolean;
  inputs: AudioInput[];
  /** macOS hides the inputs (and their names) until Smart Beat may use the microphone. */
  namesHidden: boolean;
}

/** An instrument as it sounds: none of the processing meant for voice calls. */
const RAW_SOUND = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** Chromium's stand-ins for whatever the system default is; Settings has its own. */
const ALIASES = new Set(["default", "communications"]);

export const MICROPHONE_BLOCKED =
  "Smart Beat may not use the microphone. Allow it in System Settings › Privacy & Security › Microphone, then try again.";

/** The chosen input is not connected (and no connected input has its name). */
export class AudioInputMissingError extends Error {
  readonly input: AudioInput;
  constructor(input: AudioInput) {
    super(`“${input.label}” is not connected.`);
    this.name = "AudioInputMissingError";
    this.input = input;
  }
}

const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return localStorage.getItem(AUDIO_INPUT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): AudioInput | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AudioInput> | null;
    if (typeof value?.deviceId !== "string" || !value.deviceId) return null;
    if (typeof value.label !== "string") return null;
    return { deviceId: value.deviceId, label: value.label };
  } catch {
    return null;
  }
}

/** The chosen input, or null for the system's default input. */
export function readAudioInput(): AudioInput | null {
  return parse(readRaw());
}

/** Chooses an input for the whole app; null goes back to the system's default input. */
export function storeAudioInput(input: AudioInput | null) {
  try {
    if (input) {
      localStorage.setItem(
        AUDIO_INPUT_STORAGE_KEY,
        JSON.stringify({ deviceId: input.deviceId, label: input.label }),
      );
    } else {
      localStorage.removeItem(AUDIO_INPUT_STORAGE_KEY);
    }
  } catch {
    // Not remembered: the system's default input is used.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The chosen input (null: the system's default), kept up to date when the choice changes. */
export function useAudioInput(): AudioInput | null {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  return useMemo(() => parse(raw), [raw]);
}

function readRawChannel(): string | null {
  try {
    return localStorage.getItem(AUDIO_INPUT_CHANNEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parseChannel(raw: string | null): number | null {
  if (raw === "all") return null;
  const channel = Number(raw ?? 0);
  return Number.isInteger(channel) && channel >= 0 && channel < 64 ? channel : 0;
}

/**
 * The channel of the input that the monitor track plays: 0 for the first one (input 1 of an
 * audio interface), or null for all channels mixed. The first one unless chosen otherwise.
 */
export function readAudioInputChannel(): number | null {
  return parseChannel(readRawChannel());
}

export function storeAudioInputChannel(channel: number | null) {
  try {
    if (channel === 0) localStorage.removeItem(AUDIO_INPUT_CHANNEL_STORAGE_KEY);
    else localStorage.setItem(AUDIO_INPUT_CHANNEL_STORAGE_KEY, String(channel ?? "all"));
  } catch {
    // Not remembered: the first channel is used.
  }
  for (const listener of listeners) listener();
}

/** The chosen channel (see {@link readAudioInputChannel}), kept up to date. */
export function useAudioInputChannel(): number | null {
  return parseChannel(useSyncExternalStore(subscribe, readRawChannel, () => null));
}

export async function listAudioInputs(): Promise<AudioInputList> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { available: false, inputs: [], namesHidden: false };
  }
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "audioinput" && !ALIASES.has(d.deviceId),
  );
  return {
    available: true,
    inputs: devices
      .filter((d) => d.deviceId && d.label)
      .map((d) => ({ deviceId: d.deviceId, label: d.label })),
    namesHidden: devices.some((d) => !d.label),
  };
}

/** Asks for the microphone once, so that the inputs and their names show, and lets go of it. */
export async function revealAudioInputs(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("No microphone here.");
  // Without voice processing, which on macOS turns other sound down while it runs.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_SOUND });
  stream.getTracks().forEach((track) => track.stop());
}

/** An error's name. WebKit's OverconstrainedError is not always an Error. */
const errorName = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";

const isMissingDevice = (error: unknown) =>
  errorName(error) === "OverconstrainedError" || errorName(error) === "NotFoundError";

const exactly = (input: AudioInput) => ({
  audio: { ...RAW_SOUND, deviceId: { exact: input.deviceId } },
});

/**
 * Opens an input (null: the system's default) for listening. An input whose id changed is found
 * again by its name, and remembered with the new id. Stop the stream's tracks to let go of it.
 */
export async function openAudioInput(input: AudioInput | null): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("No microphone here.");
  if (!input) return navigator.mediaDevices.getUserMedia({ audio: RAW_SOUND });
  try {
    return await navigator.mediaDevices.getUserMedia(exactly(input));
  } catch (error) {
    if (!isMissingDevice(error)) throw error;
  }
  const { inputs } = await listAudioInputs();
  const found = inputs.find((i) => i.label === input.label);
  if (!found) throw new AudioInputMissingError(input);
  const stream = await navigator.mediaDevices.getUserMedia(exactly(found));
  storeAudioInput(found);
  return stream;
}

/**
 * An audio context for listening to `stream`, running at the input's own sample rate. WebKit
 * does not always resample an input whose rate differs from the context's: an interface at
 * 44.1 kHz heard by a 48 kHz context reads every note about 150 cents sharp.
 */
export function listeningContext(stream: MediaStream): AudioContext {
  const sampleRate = stream.getAudioTracks()[0]?.getSettings?.().sampleRate;
  if (sampleRate) {
    try {
      return new AudioContext({ sampleRate });
    } catch {
      // A rate this web view can't run at: its own rate, as before.
    }
  }
  return new AudioContext();
}

/** What to tell the player when an input can't be opened. */
export function audioInputErrorText(error: unknown): string {
  if (error instanceof AudioInputMissingError) {
    return `${error.message} Connect it, or choose another input in Settings.`;
  }
  if (errorName(error) === "NotAllowedError") return MICROPHONE_BLOCKED;
  return `The microphone could not be opened: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Whether an input looks like a laptop's own microphone, from its name ("MacBook Pro
 * Microphone", "Built-in Microphone", "Microphone Array"). Its pickup hears the speakers, so
 * the click would be in a recording. An unknown (empty) name is not a built-in microphone.
 */
export function looksBuiltIn(label: string | null | undefined): boolean {
  return /built-?in|internal|macbook|imac|mac (mini|studio)|microphone array/i.test(label ?? "");
}
