import { VolumeXIcon } from "lucide-react";

import type { LanePlayback } from "@/components/audio-lanes/use-audio-lanes";
import { Button } from "@/components/ui/button";

/** Why a lane is silent and how to change that (a bridge until every engine plays lanes). */
const EXPLANATION = "Lanes play with the native audio engine";

/**
 * Says that the lanes are silent with the engine in use, with a button to switch to the one that
 * plays them. Nothing shows while the native engine runs, or where it cannot be used. The switch
 * is the user's own pick, so it is remembered.
 *
 * `compact`: just an icon button (in a lane row, where the name column has no room for words);
 * otherwise the notice and the button.
 */
export function LanePlaybackNotice({
  playback,
  laneName,
  compact = false,
}: {
  playback: LanePlayback;
  laneName?: string;
  compact?: boolean;
}) {
  if (playback.engineOn || !playback.enable) return null;
  const enable = playback.enable;
  const subject = laneName ? `Lane ${laneName} is` : "Lanes are";
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="lane-playback-notice"
    >
      {!compact && (
        <span className="flex items-center gap-1" title={EXPLANATION}>
          <VolumeXIcon className="size-3.5" aria-hidden="true" />
          Plays with effects playback
        </span>
      )}
      <Button
        variant="outline"
        size={compact ? "icon-xs" : "xs"}
        title={`Plays with effects playback. ${EXPLANATION}.`}
        // (No "play" in the name: a button called Play must stay the only one.)
        aria-label={`${subject} silent here: switch to the native audio engine`}
        onClick={enable}
      >
        {compact ? <VolumeXIcon aria-hidden="true" /> : "Switch"}
      </Button>
    </span>
  );
}
