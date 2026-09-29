import { useId, type RefObject } from "react";
import { DrumIcon, GuitarIcon, PianoIcon, RotateCcwIcon } from "lucide-react";

import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Toggle } from "@/components/ui/toggle";
import { describePan, describeVolume, isAudible, type MixerAction } from "@/lib/score/mixer";
import type { TrackSummary } from "@/lib/score/score";
import { isSoundFontId, SOUNDFONTS, type SoundFontId } from "@/lib/score/soundfonts";
import type { MixerSettings } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Pan changes regenerate the MIDI, so they're applied when the user lets go. */
export type MixerChange = (action: MixerAction, options?: { commit: boolean }) => void;

/**
 * Pressed Mute (red) and Solo (yellow) use mixing-desk colours, fixed in both
 * themes, so they stand out from the muted strip background. Radix sets both
 * `data-state=on` and `aria-pressed`, so both are overridden.
 */
const MUTE_PRESSED =
  "data-[state=on]:border-red-700 data-[state=on]:bg-red-700 aria-pressed:bg-red-700 data-[state=on]:text-white data-[state=on]:hover:bg-red-800 data-[state=on]:hover:text-white";
const SOLO_PRESSED =
  "data-[state=on]:border-amber-400 data-[state=on]:bg-amber-400 aria-pressed:bg-amber-400 data-[state=on]:text-black data-[state=on]:hover:bg-amber-300 data-[state=on]:hover:text-black";

function TrackIcon({ track }: { track: TrackSummary }) {
  const Icon = track.isPercussion ? DrumIcon : track.hasTablature ? GuitarIcon : PianoIcon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function TrackStrip({
  track,
  mix,
  audible,
  onChange,
}: {
  track: TrackSummary;
  mix: MixerSettings["tracks"][number];
  audible: boolean;
  onChange: MixerChange;
}) {
  const index = track.index;

  return (
    <li className={cn("flex flex-col gap-2 rounded-lg border p-3", !audible && "bg-muted/50")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <TrackIcon track={track} />
          <span className="truncate">{track.name}</span>
        </h3>
        <div className="flex shrink-0 gap-1">
          <Toggle
            size="sm"
            variant="outline"
            pressed={mix.mute}
            onPressedChange={(value) => onChange({ type: "mute", track: index, value })}
            aria-label={`Mute ${track.name}`}
            title="Mute"
            className={MUTE_PRESSED}
          >
            M
          </Toggle>
          <Toggle
            size="sm"
            variant="outline"
            pressed={mix.solo}
            onPressedChange={(value) => onChange({ type: "solo", track: index, value })}
            aria-label={`Solo ${track.name}`}
            title="Solo"
            className={SOLO_PRESSED}
          >
            S
          </Toggle>
        </div>
      </div>
      <div className="grid grid-cols-[3.5rem_1fr_3.5rem] items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">Volume</span>
        <LabeledSlider
          label={`Volume, ${track.name}`}
          valueText={describeVolume(mix.volume)}
          value={mix.volume}
          onValueChange={(value) => onChange({ type: "volume", track: index, value })}
        />
        <span className="text-right tabular-nums">{describeVolume(mix.volume)}</span>
        <span className="text-muted-foreground">Pan</span>
        <LabeledSlider
          label={`Pan, ${track.name}`}
          valueText={describePan(mix.pan)}
          value={mix.pan}
          min={-1}
          max={1}
          step={0.125}
          onValueChange={(value) =>
            onChange({ type: "pan", track: index, value }, { commit: false })
          }
          onValueCommit={(value) => onChange({ type: "pan", track: index, value })}
        />
        <span className="text-right tabular-nums">{describePan(mix.pan)}</span>
      </div>
    </li>
  );
}

export function MixerPanel({
  open,
  onOpenChange,
  tracks,
  mix,
  onChange,
  onReset,
  soundFont,
  onSoundFontChange,
  saved,
  returnFocusTo,
  soundsReady = true,
  playing = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tracks: TrackSummary[];
  mix: MixerSettings;
  onChange: MixerChange;
  onReset: () => void;
  soundFont: SoundFontId;
  onSoundFontChange: (id: SoundFontId) => void;
  /** Whether changes are saved for this song (desktop app only). */
  saved: boolean;
  /** Focused when the panel closes (the button that opened it). */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** False while instrument sounds load: switching again is disabled. */
  soundsReady?: boolean;
  /** Pan is applied at the next pause during playback (see ScorePlayer.setMix). */
  playing?: boolean;
}) {
  const soundLabelId = useId();

  const restoreFocus = (event: Event) => {
    const target = returnFocusTo?.current;
    if (target?.isConnected) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    // Not modal: keep playing, stopping and scrolling the score while mixing.
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-sm"
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={restoreFocus}
      >
        <SheetHeader className="border-b">
          <SheetTitle>Mixer</SheetTitle>
          <SheetDescription>
            {saved
              ? "Changes are saved for this song."
              : "Changes last until you open another song."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          <div className="grid grid-cols-[3.5rem_1fr_3.5rem] items-center gap-2 text-sm">
            <span className="font-medium">Master</span>
            <LabeledSlider
              label="Master volume"
              valueText={describeVolume(mix.master)}
              value={mix.master}
              onValueChange={(value) => onChange({ type: "master", value })}
            />
            <span className="text-right tabular-nums">{describeVolume(mix.master)}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={soundLabelId} className="text-sm font-medium">
              Instrument sounds
            </span>
            <Select
              value={soundFont}
              disabled={!soundsReady}
              onValueChange={(value) => isSoundFontId(value) && onSoundFontChange(value)}
            >
              <SelectTrigger aria-labelledby={soundLabelId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOUNDFONTS.map((font) => (
                  <SelectItem key={font.id} value={font.id}>
                    {font.label}
                    <span className="text-muted-foreground"> · {font.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <section aria-labelledby={`${soundLabelId}-tracks`} className="flex flex-col gap-2">
            <h2 id={`${soundLabelId}-tracks`} className="text-sm font-medium">
              Tracks
            </h2>
            {playing && (
              <p className="text-xs text-muted-foreground">
                Pan changes are applied when you pause, so the music never stutters.
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {tracks.map((track) => {
                const trackMix = mix.tracks[track.index];
                if (!trackMix) return null;
                return (
                  <TrackStrip
                    key={track.index}
                    track={track}
                    mix={trackMix}
                    audible={isAudible(mix, track.index)}
                    onChange={onChange}
                  />
                );
              })}
            </ul>
          </section>
        </div>

        <SheetFooter className="border-t">
          <Button variant="outline" onClick={onReset}>
            <RotateCcwIcon data-icon="inline-start" />
            Reset to the file's mix
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
