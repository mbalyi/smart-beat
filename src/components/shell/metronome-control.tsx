import { useId } from "react";
import { Settings2Icon, TimerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { CLICK_SOUNDS, MAX_METRONOME_VOLUME, type ClickSoundId } from "@/lib/score/practice";

/**
 * The Metronome button with its gear (click sound and volume), shared by the song's practice
 * controls and the stem page. The gear shows only while the metronome is on and the caller
 * handles the volume.
 */
export function MetronomeControl({
  on,
  onChange,
  sound,
  onSoundChange,
  volume,
  onVolumeChange,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  sound: ClickSoundId;
  onSoundChange?: (sound: ClickSoundId) => void;
  /** 1 = as loud as the master volume, up to {@link MAX_METRONOME_VOLUME}. */
  volume: number;
  onVolumeChange?: (volume: number) => void;
  disabled?: boolean;
  /** The button's tooltip. */
  title?: string;
}) {
  const soundId = useId();
  const volumeId = useId();
  return (
    <span className="inline-flex items-center" role="group" aria-label="Metronome">
      <Toggle
        variant="outline"
        size="sm"
        pressed={on}
        onPressedChange={onChange}
        disabled={disabled}
        title={title}
        className={on && onVolumeChange ? "rounded-r-none" : undefined}
      >
        <TimerIcon data-icon="inline-start" />
        <span className="max-xl:sr-only">Metronome</span>
      </Toggle>
      {on && onVolumeChange && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="-ml-px rounded-l-none"
              aria-label="Click sound and volume"
              title="Click sound and volume"
            >
              <Settings2Icon />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="flex w-64 flex-col gap-3"
            align="start"
            aria-label="Metronome click"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={soundId} className="text-sm font-medium">
                Click sound
              </label>
              <Select
                value={sound}
                onValueChange={(value) => onSoundChange?.(value as ClickSoundId)}
              >
                <SelectTrigger id={soundId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLICK_SOUNDS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={volumeId} className="flex justify-between text-sm font-medium">
                <span>Click volume</span>
                <span className="tabular-nums" aria-hidden="true">
                  {Math.round(volume * 100)}%
                </span>
              </label>
              <input
                id={volumeId}
                type="range"
                min={0}
                max={MAX_METRONOME_VOLUME}
                step={0.05}
                value={volume}
                onChange={(event) => onVolumeChange(Number(event.target.value))}
                aria-valuetext={`${Math.round(volume * 100)} percent`}
                className="w-full accent-primary"
              />
              <p className="text-xs text-muted-foreground">
                100% is as loud as the master volume; the click can go above it.
              </p>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}
