import { CircleIcon, HeadphonesIcon, SettingsIcon, XIcon } from "lucide-react";

import { LevelMeter } from "@/components/audio/level-meter";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/**
 * The bar shown while a lane is armed (#249): where it listens, the input level, and the switch
 * to hear the input through the lane's effects. Recording takes over with the recording bar.
 */
export function ArmedLaneBar({
  laneName,
  inputText,
  problem,
  hear,
  warnFeedback,
  onHearChange,
  onRecord,
  onDisarm,
  onInputSettings,
}: {
  laneName: string;
  /** Where the input listens and its delay, or why it cannot. */
  inputText: string;
  problem: boolean;
  hear: boolean;
  /** The input is the computer's own microphone and the player hears it: speakers would feed back. */
  warnFeedback: boolean;
  onHearChange: (hear: boolean) => void;
  onRecord: () => void;
  onDisarm: () => void;
  onInputSettings: () => void;
}) {
  return (
    <section
      aria-label="Armed lane"
      data-testid="armed-lane-bar"
      className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-popover px-4 py-2 text-popover-foreground shadow-lg"
    >
      <CircleIcon
        aria-hidden="true"
        className="size-3 shrink-0 fill-destructive/30 text-destructive"
      />
      <p role="status" className="text-sm font-medium">
        {laneName} is armed
      </p>
      {hear && (
        <LevelMeter
          label="Input level"
          select={(m) => m.monitorInput ?? 0}
          className="h-2 min-w-16 flex-1"
        />
      )}
      <div className="flex items-center gap-2 text-sm">
        <HeadphonesIcon aria-hidden="true" className="size-4" />
        <Switch checked={hear} onCheckedChange={onHearChange} aria-labelledby="hear-myself" />
        <span id="hear-myself">Hear myself</span>
      </div>
      <Button size="sm" onClick={onRecord}>
        <CircleIcon data-icon="inline-start" className="fill-current" />
        Record
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Disarm the lane" onClick={onDisarm}>
        <XIcon />
      </Button>
      <p
        className={
          problem
            ? "basis-full text-xs text-destructive"
            : "basis-full text-xs text-muted-foreground"
        }
      >
        {inputText}{" "}
        <button
          type="button"
          onClick={onInputSettings}
          className="inline-flex items-center gap-1 underline underline-offset-2"
        >
          <SettingsIcon aria-hidden="true" className="size-3" />
          Input settings
        </button>
      </p>
      {warnFeedback && (
        <p role="alert" className="basis-full text-xs text-amber-800 dark:text-amber-400">
          The microphone of this computer is the input: use headphones, or the speakers will feed
          back into it.
        </p>
      )}
    </section>
  );
}
