import { FilePlusIcon } from "lucide-react";
import type { CSSProperties } from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { updateLane } from "@/lib/audio-lanes/edits";
import { laneEndMs } from "@/lib/audio-lanes/model";
import type { AudioLane } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The sends of one lane to the buses, as sliders in a popover. */
export function SendsPopover({ lanes, lane }: { lanes: AudioLanesController; lane: AudioLane }) {
  const { apply, audio } = lanes;
  const level = (bus: string) => lane.sends.find((s) => s.bus === bus)?.level ?? 0;
  const setLevel = (bus: string, value: number) =>
    apply((a) =>
      updateLane(a, lane.id, {
        sends: [
          ...lane.sends.filter((s) => s.bus !== bus),
          ...(value > 0 ? [{ bus, level: value }] : []),
        ],
      }),
    );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-1.5 text-xs"
          disabled={!audio.buses.length}
          title={audio.buses.length ? "Sends" : "Add a bus first"}
        >
          Sends
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" aria-label={`Sends of ${lane.name}`}>
        <div className="flex flex-col gap-2">
          {audio.buses.map((bus) => (
            <LabeledSlider
              key={bus.id}
              label={`Send to ${bus.name}`}
              valueText={`${Math.round(level(bus.id) * 100)}%`}
              value={level(bus.id)}
              onValueChange={(v) => setLevel(bus.id, v)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The header of an audio lane, the same in the studio and under the score's tabs: its name, a
 * group badge, the add-audio button and the mute, solo, effects, sends, range and auto-bypass
 * controls. A short lane (`compact`) shows only the name, mute and solo in one row. The host
 * places it (the studio as a sticky column, the band as a card at the left edge of the view) and
 * passes the classes and style for that.
 */
export function LaneHeader({
  lanes,
  lane,
  compact,
  onEffects,
  range,
  className,
  style,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  compact: boolean;
  /** Opens the lane's effects; without it no effects button is shown. */
  onEffects?: () => void;
  /** Whether range edits cover this lane, and the switch for it (the studio only). */
  range?: { inRange: boolean; onToggle: () => void };
  className?: string;
  style?: CSSProperties;
}) {
  const update = (patch: Partial<AudioLane>) => lanes.apply((a) => updateLane(a, lane.id, patch));
  const full = !lane.folder && !compact;
  return (
    <div
      data-testid={`lane-header-${lane.id}`}
      className={cn(
        "flex shrink-0 justify-center gap-1",
        compact ? "flex-row items-center justify-between" : "flex-col",
        lane.parent && "pl-6",
        className,
      )}
      style={style}
    >
      <div className={cn("flex min-w-0 items-center gap-1.5", full && "w-full")}>
        {lane.folder && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-expanded={!lane.collapsed}
            aria-label={`${lane.collapsed ? "Open" : "Close"} ${lane.name}`}
            onClick={() => update({ collapsed: !lane.collapsed })}
          >
            {lane.collapsed ? "▸" : "▾"}
          </Button>
        )}
        <span className="truncate text-sm font-semibold">{lane.name}</span>
        {lane.group > 0 && <span className="rounded bg-muted px-1 text-[10px]">group</span>}
        {full && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 shrink-0 px-1.5 text-xs"
            aria-label={`Add audio file to ${lane.name}`}
            onClick={() => void lanes.chooseFile(lane.id, laneEndMs(lane))}
          >
            <FilePlusIcon /> Add audio file
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Toggle
          size="sm"
          variant="outline"
          pressed={lane.mute}
          onPressedChange={(mute) => update({ mute })}
          aria-label={`Mute ${lane.name}`}
          className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
        >
          M
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={lane.solo}
          onPressedChange={(solo) => update({ solo })}
          aria-label={`Solo ${lane.name}`}
          className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
        >
          S
        </Toggle>
        {full && (
          <>
            {onEffects && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-1.5 text-xs"
                onClick={onEffects}
              >
                FX{lane.effects.length ? ` ${lane.effects.length}` : ""}
              </Button>
            )}
            <SendsPopover lanes={lanes} lane={lane} />
            {range && (
              <Toggle
                size="sm"
                variant="outline"
                pressed={range.inRange}
                onPressedChange={range.onToggle}
                aria-label={`Range: ${lane.name} in range edits`}
                className="h-6 px-1.5 text-[10px]"
              >
                Range
              </Toggle>
            )}
            <Toggle
              size="sm"
              variant="outline"
              pressed={lane.autoBypass}
              onPressedChange={(autoBypass) => update({ autoBypass })}
              aria-label={`Auto bypass: effects of ${lane.name} stop while silent`}
              title="Effects stop while the lane is silent"
              className="h-6 px-1.5 text-[10px]"
            >
              Auto
            </Toggle>
          </>
        )}
      </div>
    </div>
  );
}
