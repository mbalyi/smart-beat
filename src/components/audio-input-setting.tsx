import { MicIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { track } from "@/lib/telemetry";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { nativeEngineAvailable } from "@/lib/audio/engine-preference";
import {
  audioInputErrorText,
  listAudioInputs,
  revealAudioInputs,
  storeAudioInput,
  storeAudioInputChannel,
  useAudioInput,
  useAudioInputChannel,
  type AudioInput,
  type AudioInputList,
} from "@/lib/audio/input";
import { errorText } from "@/lib/errors";
import { engineInputChannels } from "@/lib/tauri";

/** The select's value for the system's default input (input ids are long hashes). */
const SYSTEM_DEFAULT = "system-default";

const UNAVAILABLE: AudioInputList = { available: false, inputs: [], namesHidden: false };

/** The inputs, listed again when one is plugged in or out, and whenever `version` changes. */
function useAudioInputList(version: number) {
  const [list, setList] = useState<AudioInputList | null>(null);
  useEffect(() => {
    let active = true;
    const devices = navigator.mediaDevices;
    const load = () => {
      listAudioInputs().then(
        (next) => active && setList(next),
        () => active && setList(UNAVAILABLE),
      );
    };
    load();
    devices?.addEventListener?.("devicechange", load);
    return () => {
      active = false;
      devices?.removeEventListener?.("devicechange", load);
    };
  }, [version]);
  return list;
}

/** The select's value for all channels mixed. */
const ALL_CHANNELS = "all";

/**
 * Which channel of the input the monitor track plays (desktop app only): input 1 or input 2 of
 * an audio interface, or all of them mixed. Hidden for an input with one channel.
 */
function InputChannelSetting({ input }: { input: AudioInput | null }) {
  const labelId = useId();
  const descriptionId = useId();
  const channel = useAudioInputChannel();
  const device = input?.label ?? null;
  const [count, setCount] = useState<{ device: string | null; channels: number } | null>(null);
  const [error, setError] = useState<{ device: string | null; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    engineInputChannels(device).then(
      (channels) => active && setCount({ device, channels }),
      (e: unknown) => active && setError({ device, text: errorText(e) }),
    );
    return () => {
      active = false;
    };
  }, [device]);

  if (error?.device === device) {
    return (
      <p className="text-sm text-muted-foreground">
        The input's channels can't be listed: {error.text}
      </p>
    );
  }
  const channels = count?.device === device ? count.channels : 0;
  if (channels < 2) return null;
  const value = channel === null ? ALL_CHANNELS : String(Math.min(channel, channels - 1));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span id={labelId} className="font-medium">
          Channel
        </span>
        <Select
          value={value}
          onValueChange={(v) => storeAudioInputChannel(v === ALL_CHANNELS ? null : Number(v))}
        >
          <SelectTrigger
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            className="w-64 max-w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: channels }, (_, i) => (
              <SelectItem key={i} value={String(i)}>
                Input {i + 1}
              </SelectItem>
            ))}
            <SelectItem value={ALL_CHANNELS}>All inputs mixed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        What the monitor track plays. Choose the input your instrument is plugged into.
      </p>
    </div>
  );
}

/** Which input Smart Beat listens to, for the whole app (Settings). */
export function AudioInputSetting({
  stacked = false,
  showChannel = true,
  showDiscovery = true,
}: {
  stacked?: boolean;
  /** The channel of a multi-channel interface. Record to Tab leaves it to Settings. */
  showChannel?: boolean;
  /** The "Show all inputs" prompt and its permission error. Record to Tab leaves them to Settings. */
  showDiscovery?: boolean;
} = {}) {
  const labelId = useId();
  const descriptionId = useId();
  const chosen = useAudioInput();
  const [version, setVersion] = useState(0);
  const list = useAudioInputList(version);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!list) {
    return (
      <p role="status" className="text-muted-foreground">
        Looking for audio inputs…
      </p>
    );
  }
  if (!list.available) {
    return <p className="text-muted-foreground">Audio inputs are not available here.</p>;
  }

  // An input whose id changed is still the same input when its name matches.
  const match =
    chosen &&
    (list.inputs.find((i) => i.deviceId === chosen.deviceId) ??
      list.inputs.find((i) => i.label === chosen.label));
  const missing = chosen && !match ? chosen : null;
  const options = missing ? [...list.inputs, missing] : list.inputs;

  const choose = (value: string) => {
    setError(null);
    const next = options.find((i) => i.deviceId === value) ?? null;
    // Another input starts on its first channel.
    if (next?.label !== chosen?.label) storeAudioInputChannel(0);
    if (next?.deviceId !== chosen?.deviceId) track("audio_input_change");
    storeAudioInput(next);
  };

  const reveal = async () => {
    setAsking(true);
    setError(null);
    try {
      await revealAudioInputs();
      setVersion((v) => v + 1);
    } catch (e) {
      setError(audioInputErrorText(e));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className={
          stacked
            ? "flex flex-col gap-2"
            : "flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
        }
      >
        <span
          id={labelId}
          className={
            stacked
              ? "text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase"
              : "font-medium"
          }
        >
          Input
        </span>
        <Select
          value={match?.deviceId ?? missing?.deviceId ?? SYSTEM_DEFAULT}
          onValueChange={choose}
        >
          <SelectTrigger
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            className={stacked ? "w-full rounded-md" : "w-64 max-w-full"}
          >
            {stacked && <MicIcon className="size-5 text-muted-foreground" aria-hidden="true" />}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
            {options.map((input) => (
              <SelectItem key={input.deviceId} value={input.deviceId}>
                {input === missing && !list.namesHidden
                  ? `${input.label} (not connected)`
                  : input.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        What the tuner and the monitor track listen to. If your instrument is plugged into an audio
        interface, choose the interface.
      </p>
      {showChannel && nativeEngineAvailable() && (
        <InputChannelSetting input={match || missing || null} />
      )}
      {showDiscovery && list.namesHidden && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-sm text-muted-foreground">
            Your other inputs show once Smart Beat may use the microphone.
          </p>
          <Button variant="outline" size="sm" disabled={asking} onClick={() => void reveal()}>
            Show all inputs
          </Button>
        </div>
      )}
      {showDiscovery && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
