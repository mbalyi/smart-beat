import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** What the Inspector calls the switch behind this notice (Track › Sounds). */
export const ENGINE_SWITCH_LABEL = "Native engine with effects";

const WORDS = {
  effects: {
    off: "Effects are not audible yet",
    it: "They are",
    on: "Effects playback is on. You hear your changes as you play.",
  },
  "drum mixer": {
    off: "The drum mixer is not audible yet",
    it: "It is",
    on: "Drum mixer playback is on. You hear your changes as you play.",
  },
};

/**
 * Says whether the effects (or the drum mixer) can be heard. They are only played by the native
 * audio engine; they are saved either way. Off, it is a call to action rather than a note to
 * read, so nobody edits pedals believing they are already audible.
 */
export function EffectsPlaybackNotice({
  subject = "effects",
  engineOn,
  onEnable,
}: {
  /** What is not heard without the engine. */
  subject?: keyof typeof WORDS;
  /** Whether the native engine is on. */
  engineOn: boolean;
  /** Missing when the engine cannot be used here (browser). */
  onEnable?: () => void;
}) {
  const words = WORDS[subject];
  if (engineOn) {
    return (
      <p
        role="status"
        data-testid="effects-playback"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <CircleCheckIcon className="size-4 shrink-0 text-green-600" aria-hidden="true" />
        {words.on}
      </p>
    );
  }
  return (
    <div
      role="status"
      data-testid="effects-playback"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-48 flex-1">
        <p className="font-medium">{words.off}</p>
        <p>
          {onEnable
            ? `${words.it} heard only with the native audio engine: the “${ENGINE_SWITCH_LABEL}” switch in the Inspector (Track › Sounds). Your changes are saved either way.`
            : `${words.it} heard only in the Smart Beat desktop app. Your changes are saved with the song either way.`}
        </p>
      </div>
      {onEnable && (
        <Button size="sm" onClick={onEnable}>
          Enable effects playback
        </Button>
      )}
    </div>
  );
}
