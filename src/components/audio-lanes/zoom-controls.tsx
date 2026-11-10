import {
  ScanSearchIcon,
  UnfoldHorizontalIcon,
  ZoomInIcon,
  ZoomOutIcon,
  type LucideIcon,
} from "lucide-react";

import { ZOOM_KEYS, type TimelineZoom } from "@/components/audio-lanes/use-timeline-zoom";
import { Button } from "@/components/ui/button";
import { ControlTip } from "@/components/ui/tip";

/** The wheel gestures, named in the zoom in and out tooltips. */
const WHEEL_HINT = "⌘/Ctrl + wheel zooms at the pointer";

interface ZoomCommand {
  label: string;
  hint?: string;
  /** Says why the command does nothing now. */
  disabledLabel?: string;
  keys: string;
  icon: LucideIcon;
  run: () => void;
  disabled: boolean;
}

function commandsOf(zoom: TimelineZoom): ZoomCommand[] {
  return [
    {
      label: "Zoom out",
      hint: WHEEL_HINT,
      keys: ZOOM_KEYS.zoomOut,
      icon: ZoomOutIcon,
      run: zoom.zoomOut,
      disabled: !zoom.canZoomOut,
    },
    {
      label: "Zoom in",
      hint: WHEEL_HINT,
      keys: ZOOM_KEYS.zoomIn,
      icon: ZoomInIcon,
      run: zoom.zoomIn,
      disabled: !zoom.canZoomIn,
    },
    {
      label: "Zoom to fit the song",
      keys: ZOOM_KEYS.fit,
      icon: UnfoldHorizontalIcon,
      run: zoom.zoomToFit,
      disabled: false,
    },
    {
      label: "Zoom to the selection",
      disabledLabel: "Select clips or a time range to zoom to them",
      keys: ZOOM_KEYS.selection,
      icon: ScanSearchIcon,
      run: zoom.zoomToSelection,
      disabled: !zoom.hasSelection,
    },
  ];
}

/**
 * The zoom buttons of a timeline: out, in (both around the position line), fit the song and fit
 * the selection. Each tooltip names its key and the wheel gestures.
 */
export function ZoomControls({ zoom }: { zoom: TimelineZoom }) {
  return (
    <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
      {commandsOf(zoom).map((c) => {
        const Icon = c.icon;
        const tip =
          c.disabled && c.disabledLabel
            ? c.disabledLabel
            : `${c.label} (${c.keys}${c.hint ? `; ${c.hint}` : ""})`;
        return (
          <ControlTip key={c.label} label={tip} disabled={c.disabled}>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={c.label}
              aria-keyshortcuts={c.keys}
              disabled={c.disabled}
              onClick={c.run}
            >
              <Icon />
            </Button>
          </ControlTip>
        );
      })}
    </div>
  );
}
