import {
  ArrowLeftRightIcon,
  AudioWaveformIcon,
  CheckIcon,
  DrumIcon,
  FolderOpenIcon,
  GuitarIcon,
  LayersIcon,
  MicIcon,
  MusicIcon,
  PianoIcon,
  PlusIcon,
  SplitIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import logo from "@/assets/export-stems/logo.webp";
import { DIALOG_NEON, DialogArt, DialogLogo } from "@/components/ai/dialog-art";
import { STEM_HINTS, stemName } from "@/components/stems/stem-labels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorText } from "@/lib/errors";
import { STEM_COLOR_HEX } from "@/lib/stems/colors";
import { songKinds } from "@/lib/stems/song-player";
import {
  cancelStemSeparation,
  exportStemsBatch,
  exportStemsMixed,
  isStemFileStopped,
  pickStemExportFile,
  pickStemExportFolder,
  revealInFolder,
  type StemExportFormat,
  type StemExportResult,
  type StemKindId,
  type StemSong,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** What the dialog does with the chosen stems. */
type Action = "mix" | "batch" | "tab";
type Phase = "options" | "working" | "done";

/** An open tab the stems can be added to. */
export interface StemTabTarget {
  id: number;
  name: string;
}

/** What the page says after the stems were added: where, and how many. */
export interface StemsAdded {
  tab: string;
  count: number;
}

/** The target of "Add to a tab": an open tab, or a new one. */
export type StemTabChoice = number | "new";

const NEW_TAB = "new";
const CHOICE_BUTTON =
  "h-9 gap-2 rounded-md border border-border bg-card px-4 text-sm font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-[0_0_14px_color-mix(in_oklab,var(--primary)_55%,transparent)]";

/** The picture of each stem on its card. */
const STEM_ICONS: Record<StemKindId, LucideIcon> = {
  drums: DrumIcon,
  bass: GuitarIcon,
  vocals: MicIcon,
  guitar: GuitarIcon,
  piano: PianoIcon,
  panned: ArrowLeftRightIcon,
  other: AudioWaveformIcon,
};

/** The heading of a part of the dialog. */
const HEADING = "text-lg font-bold";

/** What the user sees when nothing is chosen. */
export const NO_STEMS_MESSAGE = "Choose at least one stem to export.";

const ACTIONS: { value: Action; label: string; hint: string; icon: typeof LayersIcon }[] = [
  {
    value: "mix",
    label: "One mixed file",
    hint: "The chosen stems are added up into one audio file.",
    icon: LayersIcon,
  },
  {
    value: "batch",
    label: "One file per stem",
    hint: "Every chosen stem gets its own file, in a new folder.",
    icon: SplitIcon,
  },
  {
    value: "tab",
    label: "Add to a tab",
    hint: "Every chosen stem becomes an audio track of a tab.",
    icon: MusicIcon,
  },
];

/**
 * Export stems (#223): the chosen stems go out as audio files (mixed into one, or one file per
 * stem, WAV or FLAC) or into a tab as audio tracks (an open tab or a new one). Every separation
 * variant offers the same choices. Closing is held back while a file is being written.
 */
export function ExportStemsDialog({
  song,
  open,
  onOpenChange,
  tabs = [],
  onAddToTab,
  initialKinds,
  onCloseAutoFocus,
}: {
  song: StemSong;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The stems that are chosen when the dialog opens (the stem a row's button is on); all when missing. */
  initialKinds?: readonly StemKindId[];
  /** The open tabs the stems can be added to. */
  tabs?: readonly StemTabTarget[];
  /** Adds the stems to a tab as audio tracks; without it the dialog only exports files. */
  onAddToTab?: (
    target: StemTabChoice,
    song: StemSong,
    kinds: readonly StemKindId[],
  ) => Promise<StemsAdded>;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent
        size="xl"
        showCloseButton={!busy}
        data-testid="export-stems-dialog"
        className={cn(DIALOG_NEON, "max-h-[calc(100dvh-2rem)] sm:max-w-3xl")}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        {/* Mounted only while open, so every visit starts from the defaults. */}
        {open && (
          <ExportFlow
            song={song}
            tabs={tabs}
            onAddToTab={onAddToTab}
            initialKinds={initialKinds}
            onBusy={setBusy}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Done = { kind: "files"; result: StemExportResult } | { kind: "tab"; added: StemsAdded };

function ExportFlow({
  song,
  tabs,
  onAddToTab,
  initialKinds,
  onBusy,
  onClose,
}: {
  song: StemSong;
  tabs: readonly StemTabTarget[];
  initialKinds?: readonly StemKindId[];
  onAddToTab?: (
    target: StemTabChoice,
    song: StemSong,
    kinds: readonly StemKindId[],
  ) => Promise<StemsAdded>;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const available = songKinds(song);
  const [phase, setPhase] = useState<Phase>("options");
  const [chosen, setChosen] = useState<ReadonlySet<StemKindId>>(() => {
    const first = initialKinds?.filter((kind) => available.includes(kind)) ?? [];
    return new Set(first.length > 0 ? first : available);
  });
  const [action, setAction] = useState<Action>("mix");
  const [format, setFormat] = useState<StemExportFormat>("wav");
  // The tab the stems go to: the open tab that was shown last is not known here, so a new tab
  // is the default when there is no open tab, else the first one.
  const [target, setTarget] = useState<string>(tabs[0] ? String(tabs[0].id) : NEW_TAB);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const picked = available.filter((kind) => chosen.has(kind));
  const none = picked.length === 0;
  const all = picked.length === available.length;
  const actions = onAddToTab ? ACTIONS : ACTIONS.filter((a) => a.value !== "tab");
  const toggle = (kind: StemKindId, on: boolean) =>
    setChosen((now) => {
      const next = new Set(now);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  const run = async () => {
    if (none) return;
    setError("");
    try {
      if (action === "tab") {
        if (!onAddToTab) return;
        setFraction(0);
        setPhase("working");
        onBusy(true);
        const choice: StemTabChoice = target === NEW_TAB ? "new" : Number(target);
        const added = await onAddToTab(choice, song, picked);
        if (!mounted.current) return;
        setDone({ kind: "tab", added });
        setPhase("done");
        return;
      }
      const place =
        action === "mix"
          ? await pickStemExportFile(`${song.name} (mix)`, format)
          : await pickStemExportFolder();
      if (!place) return; // The native dialog was cancelled: nothing changes.
      setFraction(0);
      setPhase("working");
      onBusy(true);
      const onProgress = (progress: { fraction: number }) =>
        mounted.current && setFraction(progress.fraction);
      const result =
        action === "mix"
          ? await exportStemsMixed({ id: song.id, kinds: picked, format, dest: place }, onProgress)
          : await exportStemsBatch({ id: song.id, kinds: picked, format, dir: place }, onProgress);
      if (!mounted.current) return;
      setDone({ kind: "files", result });
      setPhase("done");
    } catch (cause) {
      if (!mounted.current) return;
      // Cancel is the person's own choice: back to the options without an error.
      setError(isStemFileStopped(cause) ? "" : errorText(cause));
      setPhase("options");
    } finally {
      onBusy(false);
    }
  };

  const verb = action === "mix" ? "Export mix" : action === "batch" ? "Export files" : "Add to tab";
  const selected = ACTIONS.find((a) => a.value === action)!;

  return (
    <form
      className="relative isolate flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <DialogArt name="export-stems" />
      <DialogHeader className="gap-2 px-6 pt-3 md:flex-row md:items-center md:gap-6 md:px-9">
        <DialogLogo src={logo} testId="export-stems-logo" className="h-[104px] md:h-[116px]" />
        <DialogTitle className="sr-only">Export stems</DialogTitle>
        <DialogDescription className="text-sm md:max-w-[19rem] md:pr-12 md:text-base">
          {phase === "options"
            ? `Take “${song.name}” into your music software, or into a tab as audio tracks.`
            : phase === "working"
              ? action === "tab"
                ? "Adding the stems…"
                : "Exporting the stems…"
              : "Done."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-4 px-6 pb-6 md:px-9">
        {phase === "options" && (
          <>
            <fieldset className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <legend className={HEADING}>Stems</legend>
                <div className="flex gap-4" role="group" aria-label="Choose stems">
                  {[
                    { label: "All", on: all, set: () => setChosen(new Set(available)) },
                    { label: "None", on: none, set: () => setChosen(new Set<StemKindId>()) },
                  ].map(({ label, on, set }) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={set}
                      className={cn(
                        "rounded-sm px-1 text-base font-semibold underline-offset-8 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/60",
                        on
                          ? "text-brand underline decoration-2 dark:text-[#e29bff]"
                          : "text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2">
                {available.map((kind) => {
                  const Icon = STEM_ICONS[kind];
                  return (
                    <li
                      key={kind}
                      className="flex items-center gap-3 rounded-xl border bg-card/85 px-3 py-2.5 transition-colors has-[[data-state=checked]]:border-primary/70 has-[[data-state=checked]]:shadow-[0_0_14px_color-mix(in_oklab,var(--primary)_30%,transparent)]"
                    >
                      <Checkbox
                        id={`export-stem-${kind}`}
                        data-testid={`export-stem-${kind}`}
                        checked={chosen.has(kind)}
                        onCheckedChange={(on) => toggle(kind, on === true)}
                      />
                      <label
                        htmlFor={`export-stem-${kind}`}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                      >
                        <Icon
                          aria-hidden="true"
                          strokeWidth={1.5}
                          className="size-9 shrink-0 text-foreground"
                          style={kind === "other" ? { color: STEM_COLOR_HEX.other } : undefined}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="font-semibold">{stemName(kind, song.engine)}</span>
                          <span className="text-xs text-muted-foreground">{STEM_HINTS[kind]}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {none && (
                <p
                  role="status"
                  data-testid="export-stems-none"
                  className="text-sm text-muted-foreground"
                >
                  {NO_STEMS_MESSAGE}
                </p>
              )}
            </fieldset>

            <div className="flex flex-col gap-2">
              <span id="export-stems-what" className={HEADING}>
                What to make
              </span>
              <ToggleGroup
                type="single"
                variant="default"
                spacing={2}
                aria-labelledby="export-stems-what"
                value={action}
                onValueChange={(value) => value && setAction(value as Action)}
                className="flex-wrap self-start"
              >
                {actions.map(({ value, label, icon: Icon }) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className={CHOICE_BUTTON}
                    data-testid={`export-action-${value}`}
                  >
                    <Icon aria-hidden="true" />
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">{selected.hint}</p>
            </div>

            {action !== "tab" ? (
              <div className="flex flex-col gap-2">
                <span id="export-stems-format" className={HEADING}>
                  File format
                </span>
                <ToggleGroup
                  type="single"
                  variant="default"
                  spacing={2}
                  aria-labelledby="export-stems-format"
                  value={format}
                  onValueChange={(value) => value && setFormat(value as StemExportFormat)}
                  className="self-start"
                >
                  <ToggleGroupItem value="wav" className={CHOICE_BUTTON}>
                    WAV
                  </ToggleGroupItem>
                  <ToggleGroupItem value="flac" className={CHOICE_BUTTON}>
                    FLAC
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  Both keep every detail. WAV opens everywhere; FLAC is about half the size.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span id="export-stems-tab" className={HEADING}>
                  Which tab
                </span>
                <ToggleGroup
                  type="single"
                  variant="default"
                  spacing={2}
                  aria-labelledby="export-stems-tab"
                  value={target}
                  onValueChange={(value) => value && setTarget(value)}
                  className="max-h-40 flex-wrap self-start overflow-y-auto"
                >
                  {tabs.map((tab) => (
                    <ToggleGroupItem
                      key={tab.id}
                      value={String(tab.id)}
                      className={CHOICE_BUTTON}
                      data-testid={`export-tab-${tab.id}`}
                    >
                      <span className="max-w-56 truncate">{tab.name}</span>
                    </ToggleGroupItem>
                  ))}
                  <ToggleGroupItem
                    value={NEW_TAB}
                    className={CHOICE_BUTTON}
                    data-testid="export-tab-new"
                  >
                    <PlusIcon aria-hidden="true" />A new tab
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  Each stem becomes its own audio track, starting at the beginning of the tab. The
                  notes and the other tracks stay as they are.
                </p>
              </div>
            )}
          </>
        )}
        {phase === "working" && (
          <WorkingProgress
            fraction={fraction}
            adding={action === "tab"}
            onCancel={
              action === "tab" ? undefined : () => void cancelStemSeparation().catch(() => {})
            }
          />
        )}
        {phase === "done" && done && (
          <Finished done={done} onError={(cause) => setError(errorText(cause))} />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 max-sm:bg-popover/95 max-sm:backdrop-blur-sm md:px-9">
        {phase === "done" ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-w-24 bg-card sm:min-w-28"
              onClick={() => {
                setDone(null);
                setPhase("options");
              }}
            >
              Back
            </Button>
            <Button type="button" size="lg" className="min-w-32 sm:min-w-40" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="min-w-24 bg-card sm:min-w-28"
              disabled={phase === "working"}
              onClick={onClose}
            >
              Close
            </Button>
            <Button
              type="submit"
              size="lg"
              className="min-w-40 rounded-xl bg-[#d81b7a] text-base text-white shadow-[0_0_18px_color-mix(in_oklab,#ff2fa0_60%,transparent)] ring-[3px] ring-black hover:bg-[#e6208a] sm:min-w-52"
              disabled={none || phase === "working"}
              data-testid="export-stems-run"
            >
              {action === "tab" ? (
                <PlusIcon aria-hidden="true" data-icon="inline-start" />
              ) : (
                <UploadIcon aria-hidden="true" data-icon="inline-start" />
              )}
              {verb}
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}

function WorkingProgress({
  fraction,
  adding,
  onCancel,
}: {
  fraction: number;
  adding: boolean;
  onCancel?: () => void;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-xl border bg-card/85 px-4 py-3 text-sm"
    >
      <p className="font-semibold">
        {adding ? "Adding the stems to the tab…" : "Writing the files…"}
      </p>
      {!adding && (
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="Export progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="w-12 text-right font-semibold">{percent}%</span>
        </div>
      )}
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          className="mt-1 self-start bg-card"
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

function Finished({ done, onError }: { done: Done; onError: (cause: unknown) => void }) {
  if (done.kind === "tab") {
    const { tab, count } = done.added;
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-xl border bg-card/85 px-4 py-3 text-sm"
      >
        <p className="flex items-center gap-2 font-semibold">
          <CheckIcon aria-hidden="true" className="size-4 text-primary" />
          {count === 1 ? "Added 1 audio track" : `Added ${count} audio tracks`}
        </p>
        <p data-testid="export-stems-added" className="break-all text-muted-foreground">
          To “{tab}”. Undo takes them back in one step. Save the tab to keep them in its file.
        </p>
      </div>
    );
  }
  const { result } = done;
  const where = result.folder ?? result.paths[0] ?? "";
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border bg-card/85 px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-2 font-semibold">
        <CheckIcon aria-hidden="true" className="size-4 text-primary" />
        {result.folder
          ? result.paths.length === 1
            ? "Exported 1 file"
            : `Exported ${result.paths.length} files`
          : "Exported the mix"}
      </p>
      <p data-testid="export-stems-path" className="break-all text-muted-foreground">
        {where}
      </p>
      {result.clipped && (
        <p className="text-muted-foreground">
          The sum was louder than the highest level a file can hold, so the loudest peaks were
          limited. Export fewer stems, or lower them in your music software, for a cleaner mix.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="mt-1 self-start bg-card"
        onClick={() => revealInFolder(result.paths[0] ?? where).catch(onError)}
      >
        <FolderOpenIcon aria-hidden="true" data-icon="inline-start" />
        Show in folder
      </Button>
    </div>
  );
}
