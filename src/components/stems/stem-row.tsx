import type { Dispatch } from "react";

import { StemWaveform } from "@/components/stems/stem-waveform";
import { stemLimit, stemName } from "@/components/stems/stem-labels";
import { LabeledSlider } from "@/components/labeled-slider";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { Toggle } from "@/components/ui/toggle";
import {
  gainOf,
  isSoloedOut,
  type MixerAction,
  type StemChannel,
  type StemMixer,
} from "@/lib/stems/mixer";
import type { StemLoop, StemPlayer } from "@/lib/stems/player";
import type { StemEngine } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The buttons are 44 px on a phone and 36 px with a mouse. */
const TARGET = "h-9 min-w-16 px-3 text-sm font-semibold max-sm:h-11 max-sm:min-w-20";

/** One stem: its name and limits, Mute, Solo, volume and waveform. */
export function StemRow({
  player,
  engine,
  duration,
  channel,
  mixer,
  dispatch,
  loop,
  onSeek,
  onLoop,
}: {
  player: StemPlayer;
  engine: StemEngine;
  duration: number;
  channel: StemChannel;
  mixer: StemMixer;
  dispatch: Dispatch<MixerAction>;
  loop: StemLoop | null;
  onSeek: (seconds: number) => void;
  onLoop: (loop: StemLoop) => void;
}) {
  const { kind } = channel;
  const name = stemName(kind, engine);
  const heard = gainOf(mixer, channel) > 0;
  return (
    <li
      data-testid={`stem-${kind}`}
      data-heard={heard}
      className="grid gap-3 rounded-2xl border border-foreground/10 bg-card p-3 sm:p-4 lg:grid-cols-[minmax(11rem,15rem)_auto_minmax(8rem,11rem)_minmax(0,1fr)] lg:items-center"
    >
      <div className="min-w-0">
        <h2 className="text-lg leading-tight font-bold">{name}</h2>
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold">Limits: </span>
          {stemLimit(kind, engine)}
        </p>
      </div>
      <div className="flex gap-2" role="group" aria-label={`${name} controls`}>
        <Toggle
          variant="outline"
          pressed={channel.muted}
          onPressedChange={() => dispatch({ type: "toggle-mute", kind })}
          aria-label={`Mute ${name}`}
          className={cn(TARGET, MUTE_PRESSED)}
        >
          Mute
        </Toggle>
        <Toggle
          variant="outline"
          pressed={channel.soloed}
          onPressedChange={() => dispatch({ type: "toggle-solo", kind })}
          aria-label={`Solo ${name}`}
          className={cn(TARGET, SOLO_PRESSED)}
        >
          Solo
        </Toggle>
      </div>
      <div className="flex items-center gap-2 max-sm:min-h-11">
        <LabeledSlider
          label={`Volume, ${name}`}
          valueText={`${Math.round(channel.volume * 100)}%`}
          value={channel.volume}
          step={0.05}
          onValueChange={(volume) => dispatch({ type: "set-volume", kind, volume })}
          className="min-w-0 flex-1"
        />
        <span
          aria-hidden="true"
          className="w-10 text-right text-xs text-muted-foreground tabular-nums"
        >
          {Math.round(channel.volume * 100)}%
        </span>
      </div>
      <StemWaveform
        player={player}
        kind={kind}
        duration={duration}
        loop={loop}
        quiet={!heard || isSoloedOut(mixer, channel)}
        onSeek={onSeek}
        onLoop={onLoop}
      />
    </li>
  );
}
