import {
  CircleIcon,
  MicIcon,
  RepeatIcon,
  ScissorsIcon,
  SettingsIcon,
  TimerIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import hero from "@/assets/record-to-tab/hero.webp";
import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import type { RecordAudioSetup } from "@/components/audio-lanes/use-record-audio";
import { DIALOG_NEON } from "@/components/ai/dialog-art";
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
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RecordMode } from "@/lib/audio-lanes/takes";
import { cn } from "@/lib/utils";

/** A choice in a group: filled with the primary colour when it is the one (as in Record to tab). */
const CHOICE =
  "h-9 gap-2 rounded-md border border-border bg-card px-4 text-sm font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-[0_0_14px_color-mix(in_oklab,var(--primary)_55%,transparent)]";

const MODES: { value: RecordMode; label: string; hint: string; icon: typeof CircleIcon }[] = [
  {
    value: "playhead",
    label: "From the playhead",
    hint: "Records from the bar the playhead is in until you stop.",
    icon: CircleIcon,
  },
  {
    value: "punch",
    label: "Punch in the selection",
    hint: "Plays from before the selected bars and keeps only them.",
    icon: ScissorsIcon,
  },
  {
    value: "loop",
    label: "Loop, one take a pass",
    hint: "Loops the selected bars; every pass becomes a take to choose from.",
    icon: RepeatIcon,
  },
];

/** The splashes and the recording picture behind the dialog (the Record to tab family). */
function RecordAudioArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        src={splashLeft}
        alt=""
        className="absolute bottom-0 left-0 w-[40%] opacity-50 dark:opacity-90"
      />
      <img
        src={splashRight}
        alt=""
        className="absolute right-0 bottom-0 w-[20%] opacity-50 dark:opacity-90"
      />
      <img
        src={hero}
        alt=""
        data-hero="record-audio"
        className="absolute top-1 right-2 hidden w-[36%] md:block"
      />
    </div>
  );
}

/**
 * Record audio: a plain take on a lane, no tab. Choose the lane, how to record (from the
 * playhead, a punch into the selected bars, or a loop with a take per pass), the count-in and the
 * pre-roll. The input and its delay come from Settings.
 */
export function RecordAudioDialog({
  open,
  onOpenChange,
  lanes,
  defaultLane,
  inputName,
  latency,
  hasSelection,
  onStart,
  onInputSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lanes a take can go on. */
  lanes: readonly { id: string; name: string }[];
  defaultLane: string | null;
  inputName: string;
  /** "about 11 ms delay" */
  latency: string;
  hasSelection: boolean;
  onStart: (setup: RecordAudioSetup) => void;
  onInputSettings: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className={cn("h-[min(42rem,calc(100dvh-2rem))] sm:max-w-3xl", DIALOG_NEON)}
        data-tour="record-audio-dialog"
      >
        {open && (
          <RecordAudioForm
            lanes={lanes}
            defaultLane={defaultLane}
            inputName={inputName}
            latency={latency}
            hasSelection={hasSelection}
            onCancel={() => onOpenChange(false)}
            onStart={(setup) => {
              onOpenChange(false);
              onStart(setup);
            }}
            onInputSettings={onInputSettings}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecordAudioForm({
  lanes,
  defaultLane,
  inputName,
  latency,
  hasSelection,
  onCancel,
  onStart,
  onInputSettings,
}: {
  lanes: readonly { id: string; name: string }[];
  defaultLane: string | null;
  inputName: string;
  latency: string;
  hasSelection: boolean;
  onCancel: () => void;
  onStart: (setup: RecordAudioSetup) => void;
  onInputSettings: () => void;
}) {
  const [laneId, setLaneId] = useState<string>(defaultLane ?? "new");
  const [mode, setMode] = useState<RecordMode>("playhead");
  const [countIn, setCountIn] = useState(true);
  const [preRoll, setPreRoll] = useState(1);
  const needsSelection = mode !== "playhead" && !hasSelection;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (needsSelection) return;
    onStart({
      laneId: laneId === "new" ? null : laneId,
      mode,
      countIn,
      preRollBars: mode === "playhead" ? 0 : preRoll,
    });
  };
  const hint = MODES.find((m) => m.value === mode)!.hint;
  return (
    <form onSubmit={submit} className="relative isolate flex min-h-0 flex-1 flex-col">
      <RecordAudioArt />
      <DialogHeader className="px-6 pt-2 md:px-10 md:pr-[40%]">
        <DialogTitle className="text-2xl font-bold">Record audio</DialogTitle>
        <DialogDescription>
          A plain take, saved as a clip on a lane. No tab is written, and the score is not changed.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 px-6 pb-6 md:px-10 md:pr-[40%]">
        <section
          className="flex items-center gap-3 rounded-xl border bg-card p-3"
          aria-label="Input"
        >
          <MicIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{inputName}</p>
            <p className="text-xs text-muted-foreground">{latency}: the take is moved back by it</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onInputSettings}>
            <SettingsIcon data-icon="inline-start" /> Input
          </Button>
        </section>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Record to
          <select
            value={laneId}
            onChange={(e) => setLaneId(e.currentTarget.value)}
            className="h-9 rounded-md border bg-card px-2 font-normal"
          >
            <option value="new">A new lane</option>
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-semibold">How</legend>
          <ToggleGroup
            type="single"
            spacing={2}
            value={mode}
            onValueChange={(v) => v && setMode(v as RecordMode)}
            aria-label="How to record"
            className="flex-wrap"
          >
            {MODES.map(({ value, label, icon: Icon }) => (
              <ToggleGroupItem key={value} value={value} className={CHOICE}>
                <Icon aria-hidden="true" />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-sm text-muted-foreground">{hint}</p>
          {needsSelection && (
            <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
              Select the bars first: drag across them in the score or on the editor's time ruler.
            </p>
          )}
        </fieldset>
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3 text-sm font-semibold">
            <span className="flex items-center gap-2">
              <TimerIcon className="size-4" aria-hidden="true" /> Count-in
            </span>
            <Switch checked={countIn} onCheckedChange={setCountIn} aria-label="Count-in" />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3 text-sm font-semibold">
            <span id="pre-roll-label">Pre-roll</span>
            <ToggleGroup
              type="single"
              spacing={1}
              value={String(preRoll)}
              onValueChange={(v) => v && setPreRoll(Number(v))}
              aria-labelledby="pre-roll-label"
              disabled={mode === "playhead"}
            >
              {[0, 1, 2].map((bars) => (
                <ToggleGroupItem
                  key={bars}
                  value={String(bars)}
                  className={cn(CHOICE, "px-3")}
                  aria-label={`${bars} bars before`}
                >
                  {bars}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </section>
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-w-28 bg-card"
          onClick={onCancel}
        >
          Close
        </Button>
        <Button
          type="submit"
          size="lg"
          className="min-w-52 shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_60%,transparent)]"
          disabled={needsSelection}
        >
          <CircleIcon data-icon="inline-start" className="fill-red-500 text-red-500" />
          Start recording
        </Button>
      </DialogFooter>
    </form>
  );
}
