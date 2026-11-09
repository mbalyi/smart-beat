import type { KeyboardEvent } from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import { updateClip } from "@/lib/audio-lanes/edits";
import { findClip } from "@/lib/audio-lanes/edits";

/** The clip shortcuts, as the shortcut list shows them. */
export const CLIP_SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: "← →", action: "Nudge by a beat (Shift: a bar)" },
  { keys: "S", action: "Split at the edit cursor" },
  { keys: "G", action: "Glue the selected clips" },
  { keys: "M", action: "Mute or unmute" },
  { keys: "L", action: "Lock or unlock the position" },
  { keys: "R", action: "Reverse" },
  { keys: "⌘D", action: "Duplicate" },
  { keys: "⌘C ⌘V", action: "Copy, paste at the edit cursor" },
  { keys: "Delete", action: "Delete" },
  { keys: "Enter", action: "Open the lane editor" },
];

/**
 * Keyboard commands on a focused clip. `laneId` is where a paste goes; `open` opens the editor.
 * Returns whether the key was used.
 */
export function handleClipKey(
  event: KeyboardEvent<HTMLElement>,
  lanes: AudioLanesController,
  clipId: string,
  laneId: string,
  open: () => void,
): boolean {
  const mod = event.metaKey || event.ctrlKey;
  const ensureSelected = () => {
    if (!lanes.selection.includes(clipId)) lanes.select([clipId]);
  };
  const toggle = (field: "mute" | "locked" | "reversed") =>
    lanes.apply((a) => {
      const found = findClip(a, clipId);
      return found ? updateClip(a, clipId, { [field]: !found.clip[field] }) : a;
    });
  let used = true;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    ensureSelected();
    lanes.commands.nudge(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey);
  } else if (event.key === "Delete" || event.key === "Backspace") lanes.commands.remove();
  else if (mod && event.key.toLowerCase() === "d") lanes.commands.duplicate();
  else if (mod && event.key.toLowerCase() === "c") lanes.commands.copy();
  else if (mod && event.key.toLowerCase() === "v") lanes.commands.paste(laneId);
  else if (mod) used = false;
  else if (event.key.toLowerCase() === "s") lanes.commands.split();
  else if (event.key.toLowerCase() === "g") lanes.commands.glue();
  else if (event.key.toLowerCase() === "m") toggle("mute");
  else if (event.key.toLowerCase() === "l") toggle("locked");
  else if (event.key.toLowerCase() === "r") toggle("reversed");
  else if (event.key === "Enter") open();
  else used = false;
  if (used) {
    event.preventDefault();
    event.stopPropagation();
  }
  return used;
}
