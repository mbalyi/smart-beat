import { useId } from "react";

import { ColorSwatches, type Swatch } from "@/components/color/color-swatches";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { STEM_LABELS } from "@/components/stems/stem-labels";
import { STEM_COLOR_HEX, STEM_COLOR_ORDER } from "@/lib/stems/colors";
import { TRACK_PALETTE, isTrackColor, laneColor } from "@/lib/score/track-colors";

/** The stem colours first (the default lane colours), named after their part. */
const STEM_SWATCHES: readonly Swatch[] = STEM_COLOR_ORDER.map((kind) => ({
  name: STEM_LABELS[kind],
  hex: STEM_COLOR_HEX[kind],
}));

/**
 * The colour chip of a lane and the popover it opens: stem colours, more colours, any colour of
 * the system picker, or back to the default (the stem colour of the lane's position).
 */
export function LaneColorPopover({
  laneName,
  index,
  color,
  onChange,
}: {
  laneName: string;
  /** The lane's position, which decides its default colour. */
  index: number;
  color: string | null;
  onChange: (color: string | null) => void;
}) {
  const pickerId = useId();
  const chosen = isTrackColor(color) ? color.toLowerCase() : null;
  const shown = laneColor(index, chosen);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Colour of ${laneName}`}
          title="Lane colour"
          data-tour="lane-color"
        >
          <span
            aria-hidden="true"
            className="size-3 rounded-full ring-1 ring-border"
            style={{ backgroundColor: shown }}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end" aria-label={`Colour of ${laneName}`}>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">Lane colour</p>
          <p className="text-xs text-muted-foreground">Stem colours</p>
          <ColorSwatches
            label="Stem colours"
            swatches={STEM_SWATCHES}
            chosen={chosen}
            onChoose={onChange}
            display={(hex) => laneColor(index, hex)}
            columns={7}
            size="sm"
          />
          <p className="text-xs text-muted-foreground">More colours</p>
          <ColorSwatches
            label="More colours"
            swatches={TRACK_PALETTE}
            chosen={chosen}
            onChoose={onChange}
            display={(hex) => laneColor(index, hex)}
            columns={7}
            size="sm"
          />
          <div className="flex items-center gap-2">
            <label htmlFor={pickerId} className="text-sm">
              Custom
            </label>
            <input
              id={pickerId}
              type="color"
              value={chosen ?? "#8d8d8d"}
              onChange={(event) => onChange(event.target.value)}
              className="h-8 w-12 cursor-pointer rounded border bg-transparent p-0.5"
            />
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={!chosen}
              onClick={() => onChange(null)}
            >
              Default colour
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
