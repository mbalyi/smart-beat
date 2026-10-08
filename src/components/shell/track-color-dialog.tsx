import { CheckIcon } from "lucide-react";
import { useId } from "react";

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
import { cn } from "@/lib/utils";

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
          <div role="group" aria-label="Colours" className="grid grid-cols-6 gap-2">
            {TRACK_PALETTE.map((swatch) => {
              const on = chosen === swatch.hex;
              return (
                <button
                  key={swatch.hex}
                  type="button"
                  aria-pressed={on}
                  aria-label={swatch.name}
                  title={swatch.name}
                  onClick={() => onChange(swatch.hex)}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md border-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    on ? "border-foreground" : "border-transparent hover:border-muted-foreground",
                  )}
                  style={{ backgroundColor: trackColor(index, swatch.hex) }}
                >
                  {/* The tick shows the choice without relying on the colours. */}
                  {on && <CheckIcon className="size-5 text-black" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
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
