import { MicIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  audioInputErrorText,
  listAudioInputs,
  revealAudioInputs,
  storeAudioInput,
  useAudioInput,
  type AudioInputList,
} from "@/lib/audio/input";

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

/** Which input Smart Beat listens to, for the whole app (Settings). */
export function AudioInputSetting({ stacked = false }: { stacked?: boolean } = {}) {
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
    storeAudioInput(options.find((i) => i.deviceId === value) ?? null);
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
        What the tuner listens to. If your instrument is plugged into an audio interface, choose the
        interface.
      </p>
      {list.namesHidden && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-sm text-muted-foreground">
            Your other inputs show once Smart Beat may use the microphone.
          </p>
          <Button variant="outline" size="sm" disabled={asking} onClick={() => void reveal()}>
            Show all inputs
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
