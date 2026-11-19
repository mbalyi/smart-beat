import { CircleIcon } from "lucide-react";
import { useContext } from "react";

import { LaneRecordContext } from "@/components/audio-lanes/lane-record-context";
import { Button } from "@/components/ui/button";
import type { AudioLane } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * The record icon of an audio lane: off, armed (ready, the input is heard through the lane's
 * effects) or recording. Pressing it arms the lane; pressing the armed lane starts the take, and
 * pressing it during the take stops it. Nothing is shown outside the desktop app (no controls).
 */
export function LaneRecordButton({
  lane,
  className,
  size = "icon-xs",
}: {
  lane: Pick<AudioLane, "id" | "name" | "folder">;
  className?: string;
  size?: "icon-xs" | "icon-sm";
}) {
  const controls = useContext(LaneRecordContext);
  if (!controls || lane.folder) return null;
  const armed = controls.armedId === lane.id;
  const recording = armed && controls.recording;
  const title = recording
    ? "Stop recording"
    : armed
      ? "Start recording (the lane is armed)"
      : "Arm this lane for recording";
  return (
    <Button
      variant="ghost"
      size={size}
      aria-pressed={armed}
      aria-label={`Record on the lane ${lane.name}`}
      title={title}
      disabled={controls.recording && !armed}
      onClick={() => controls.toggle(lane.id)}
      data-tour="lane-record"
      data-state={recording ? "recording" : armed ? "armed" : "off"}
      className={className}
    >
      <CircleIcon
        aria-hidden="true"
        className={cn(
          "text-muted-foreground",
          armed && "fill-destructive/30 text-destructive",
          recording && "animate-pulse fill-destructive",
        )}
      />
    </Button>
  );
}
