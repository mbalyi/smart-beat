import { AudioWaveformIcon, ScissorsLineDashedIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { DIALOG_NEON, DialogArt } from "@/components/ai/dialog-art";
import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
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
import { Input } from "@/components/ui/input";
import { findClip } from "@/lib/audio-lanes/edits";
import { activeTake } from "@/lib/audio-lanes/model";
import {
  removeSilence,
  silencePreview,
  silenceSkipReason,
  skippedMessage,
} from "@/lib/audio-lanes/silence";
import { errorText } from "@/lib/errors";
import { audioSilentRegions, type AudioLanesSettings, type SilentRegion } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** How long the settings rest before the files are measured again. */
const MEASURE_DELAY_MS = 250;

type SettingKey = "thresholdDb" | "minSilenceMs" | "padMs";

const SETTINGS: {
  key: SettingKey;
  label: string;
  unit: string;
  hint: string;
  initial: number;
  min: number;
  max: number;
  step: number;
}[] = [
  {
    key: "thresholdDb",
    label: "Quieter than",
    unit: "dB",
    hint: "Lower keeps soft playing; higher also takes out hum and room noise.",
    initial: -45,
    min: -90,
    max: -10,
    step: 1,
  },
  {
    key: "minSilenceMs",
    label: "For at least",
    unit: "ms",
    hint: "Shorter pauses, like the gaps between notes, stay.",
    initial: 300,
    min: 20,
    max: 10_000,
    step: 10,
  },
  {
    key: "padMs",
    label: "Keep around the sound",
    unit: "ms",
    hint: "A little quiet before and after each part, so notes start and ring out naturally.",
    initial: 20,
    min: 0,
    max: 1_000,
    step: 5,
  },
];

type Settings = Record<SettingKey, number>;

/** The typed values, each in its range (an empty or unreadable field counts as its default). */
function readSettings(typed: Record<SettingKey, string>): Settings {
  const entries = SETTINGS.map(({ key, initial, min, max }) => {
    const value = Number(typed[key]);
    const usable = typed[key].trim() !== "" && Number.isFinite(value);
    return [key, usable ? Math.min(max, Math.max(min, value)) : initial] as const;
  });
  return Object.fromEntries(entries) as Settings;
}

/** The files of the clips that can lose their quiet parts, one each, as one key. */
function sourcesKey(audio: AudioLanesSettings, clipIds: readonly string[]): string {
  const ids = clipIds.flatMap((id) => {
    const clip = findClip(audio, id)?.clip;
    return clip && silenceSkipReason(clip, []) === null ? [activeTake(clip).sourceId] : [];
  });
  return [...new Set(ids)].sort().join(",");
}

type Measure =
  | { state: "measuring" }
  | { state: "failed" }
  | { state: "done"; regions: ReadonlyMap<string, readonly SilentRegion[]> };

/** The quiet parts of each file with these settings, measured again when they change. */
function useSilentRegions(sources: string, settings: Settings): Measure {
  const { thresholdDb, minSilenceMs, padMs } = settings;
  const request = `${sources}|${thresholdDb}|${minSilenceMs}|${padMs}`;
  // The last answer and the request it answers: a newer request is still being measured.
  const [answer, setAnswer] = useState<{ request: string; measure: Measure } | null>(null);
  useEffect(() => {
    let current = true;
    const ids = sources ? sources.split(",") : [];
    const timer = setTimeout(() => {
      Promise.all(
        ids.map(
          async (id) =>
            [id, await audioSilentRegions(id, thresholdDb, minSilenceMs, padMs)] as const,
        ),
      )
        .then((found) => {
          if (current) setAnswer({ request, measure: { state: "done", regions: new Map(found) } });
        })
        .catch((error: unknown) => {
          if (!current) return;
          setAnswer({ request, measure: { state: "failed" } });
          toast.error("Couldn't find the quiet parts", { description: errorText(error) });
        });
    }, MEASURE_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [request, sources, thresholdDb, minSilenceMs, padMs]);
  return answer?.request === request ? answer.measure : { state: "measuring" };
}

/**
 * Remove silence: cuts the chosen clips where their audio is quiet and takes those parts out,
 * as one step to undo. The preview says how many pieces go before anything changes.
 */
export function RemoveSilenceDialog({
  open,
  onOpenChange,
  lanes,
  clipIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lanes: Pick<AudioLanesController, "audio" | "apply">;
  clipIds: readonly string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className={cn("h-[min(38rem,calc(100dvh-2rem))] sm:max-w-2xl", DIALOG_NEON)}
        data-testid="remove-silence-dialog"
      >
        {/* Mounted only while open: every visit starts from the defaults. */}
        {open && (
          <RemoveSilenceForm lanes={lanes} clipIds={clipIds} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveSilenceForm({
  lanes,
  clipIds,
  onDone,
}: {
  lanes: Pick<AudioLanesController, "audio" | "apply">;
  clipIds: readonly string[];
  onDone: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(
    () =>
      Object.fromEntries(SETTINGS.map((s) => [s.key, String(s.initial)])) as Record<
        SettingKey,
        string
      >,
  );
  const measure = useSilentRegions(sourcesKey(lanes.audio, clipIds), readSettings(typed));
  const preview = useMemo(
    () => (measure.state === "done" ? removeSilence(lanes.audio, clipIds, measure.regions) : null),
    [clipIds, lanes.audio, measure],
  );
  const skipped = preview ? skippedMessage(preview.skipped) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (measure.state !== "done" || !preview || preview.removed === 0) return;
    const { regions } = measure;
    lanes.apply((audio) => removeSilence(audio, clipIds, regions).audio);
    toast.success(
      preview.removed === 1 ? "Removed 1 quiet piece" : `Removed ${preview.removed} quiet pieces`,
    );
    onDone();
  };

  return (
    <form onSubmit={submit} className="relative isolate flex min-h-0 flex-1 flex-col">
      <DialogArt name="remove-silence" />
      <DialogHeader className="px-6 pt-2 md:px-9">
        <DialogTitle className="text-2xl font-bold">Remove silence</DialogTitle>
        <DialogDescription>
          Cuts the {clipIds.length === 1 ? "clip" : `${clipIds.length} clips`} where nothing is
          heard and takes those parts out. One undo brings them back.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 px-6 pb-6 md:px-9">
        {SETTINGS.map((s) => (
          <section
            key={s.key}
            className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-xl border bg-card p-3"
          >
            <label htmlFor={`${id}-${s.key}`} className="text-sm font-semibold">
              {s.label}
            </label>
            <span className="flex items-center gap-1.5">
              <Input
                id={`${id}-${s.key}`}
                type="number"
                inputMode="numeric"
                min={s.min}
                max={s.max}
                step={s.step}
                value={typed[s.key]}
                aria-describedby={`${id}-${s.key}-hint`}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setTyped((t) => ({ ...t, [s.key]: value }));
                }}
                className="h-9 w-24 bg-background text-right tabular-nums"
              />
              <span className="w-6 text-xs text-muted-foreground">{s.unit}</span>
            </span>
            <p id={`${id}-${s.key}-hint`} className="col-span-2 text-xs text-muted-foreground">
              {s.hint}
            </p>
          </section>
        ))}
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl border border-primary/40 bg-card p-3 text-sm font-semibold"
        >
          <AudioWaveformIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          {measure.state === "measuring"
            ? "Listening for quiet parts…"
            : measure.state === "failed"
              ? "Couldn't measure the audio. Check that its file is loaded."
              : silencePreview(preview!)}
        </p>
        {skipped && <p className="text-sm text-muted-foreground">{skipped}</p>}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-w-28 bg-card"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="lg"
          className="min-w-52 shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_60%,transparent)]"
          disabled={!preview || preview.removed === 0}
        >
          <ScissorsLineDashedIcon data-icon="inline-start" />
          Remove
        </Button>
      </DialogFooter>
    </form>
  );
}
