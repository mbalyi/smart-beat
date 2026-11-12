import { useId } from "react";

import { ColorSwatches } from "@/components/color/color-swatches";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TRACK_PALETTE, isTrackColor, trackColor } from "@/lib/score/track-colors";

/**
 * Chooses the colour of a track's strip and bars in the mixer (#83): a palette, any colour of
 * the picker, or back to the default. Whatever is picked is kept as light as the default
 * colours, so it stays visible on both themes.
 */
export function TrackColorDialog({
  open,
  onOpenChange,
  trackName,
  index,
  color,
  anyCustom,
  onChange,
  onResetAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackName: string;
  /** The track's position, which decides its default colour. */
  index: number;
  /** The chosen colour, `#rrggbb` (null: the default one). */
  color: string | null;
  /** Whether any track has a chosen colour. */
  anyCustom: boolean;
  onChange: (color: string | null) => void;
  onResetAll: () => void;
}) {
  const pickerId = useId();
  const chosen = isTrackColor(color) ? color.toLowerCase() : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Track colour: {trackName}</DialogTitle>
          <DialogDescription>
            Used for the track&apos;s strip and bars in the mixer. Pale or very dark colours are
            adjusted to stay visible.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              data-testid="track-color-preview"
              className="h-6 w-16 shrink-0 rounded"
              style={{ backgroundColor: trackColor(index, chosen) }}
            />
            <span className="text-sm text-muted-foreground">
              {chosen ? `Custom colour ${chosen}` : "Default colour"}
            </span>
          </div>
          <ColorSwatches
            label="Colours"
            swatches={TRACK_PALETTE}
            chosen={chosen}
            onChoose={onChange}
            display={(hex) => trackColor(index, hex)}
          />
          <div className="flex items-center gap-2">
            <label htmlFor={pickerId} className="text-sm">
              Another colour
            </label>
            <input
              id={pickerId}
              type="color"
              value={chosen ?? "#8d8d8d"}
              onChange={(event) => onChange(event.target.value)}
              className="h-8 w-12 cursor-pointer rounded border bg-transparent p-0.5"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={!anyCustom} onClick={onResetAll}>
            Reset all colours
          </Button>
          <Button variant="outline" disabled={!chosen} onClick={() => onChange(null)}>
            Default colour
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
