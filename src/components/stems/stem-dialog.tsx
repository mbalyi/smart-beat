import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  InfoIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import heroSelect from "@/assets/stem-separation/hero.webp";
import logo from "@/assets/stem-separation/logo.webp";
import { DIALOG_NEON, DialogArt, DialogLogo, DialogStepper } from "@/components/ai/dialog-art";
import { AI_DIALOG_FRAME } from "@/components/ai/dialog-frame";
import { BetaBadge } from "@/components/beta-badge";
import { EngineChoice, ModelSetup } from "@/components/stems/engine-choice";
import { engineInfo } from "@/components/stems/stem-engines";
import { useEngineModels, type EngineModels } from "@/components/stems/use-engine-models";
import { STEM_HINTS, STEM_LABELS } from "@/components/stems/stem-labels";
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
import { isEnabled } from "@/lib/features";
import { baseName } from "@/lib/score/format";
import {
  AUDIO_EXTENSIONS,
  cancelStemSeparation,
  isStemsStopped,
  isTauri,
  pickStemFile,
  separateStems,
  type StemEngine,
  type StemKindId,
  type StemProgress,
  type StemSong,
} from "@/lib/tauri";
import { overallProgress, STAGES } from "@/lib/stems/progress";
import { cn } from "@/lib/utils";

/** A file dropped on the window while the dialog is open (the app passes it on). */
export interface DroppedSong {
  path: string;
  nonce: number;
}

type Phase = "file" | "options" | "running";
const STEPS = ["Song", "Options", "Separate"] as const;
const STEP_OF: Record<Phase, number> = { file: 0, options: 1, running: 2 };

/** The parts the user can ask for; "other" is always made. */
const CHOICES = ["drums", "bass", "vocals", "panned"] as const satisfies readonly StemKindId[];

const EXTENSION_TEXT = "MP3, WAV, FLAC, OGG or AIFF";
const hasAudioExtension = (path: string) =>
  (AUDIO_EXTENSIONS as readonly string[]).includes(path.split(".").pop()?.toLowerCase() ?? "");

/** Stem separation (#186): choose a song, choose what to separate, wait, then open the page. */
export function StemDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  droppedSong,
  onSeparated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  droppedSong?: DroppedSong | null;
  /** The song is separated: the app shows its page. */
  onSeparated: (song: StemSong) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className={cn(AI_DIALOG_FRAME, DIALOG_NEON, "h-[min(46rem,calc(100dvh-2rem))]")}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {/* Mounted only while open, so every visit starts from the defaults. */}
        {open && (
          <StemFlow
            droppedSong={droppedSong ?? null}
            onClose={() => onOpenChange(false)}
            onSeparated={onSeparated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StemFlow({
  droppedSong,
  onClose,
  onSeparated,
}: {
  droppedSong: DroppedSong | null;
  onClose: () => void;
  onSeparated: (song: StemSong) => void;
}) {
  const neuralOffered = isEnabled("stem-separation-neural");
  const desktop = isTauri();
  const [phase, setPhase] = useState<Phase>("file");
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [kinds, setKinds] = useState<StemKindId[]>([...CHOICES]);
  const [engine, setEngine] = useState<StemEngine>("fast");
  const [strongDrums, setStrongDrums] = useState(false);
  const [progress, setProgress] = useState<StemProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const mounted = useRef(true);
  const running = useRef(false);
  const seenDrop = useRef<number | null>(null);

  // Closing the dialog, by any route, stops a job that is running.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (running.current) void cancelStemSeparation();
    };
  }, []);

  const accept = (next: string) => {
    if (!hasAudioExtension(next)) {
      setError(`Choose ${EXTENSION_TEXT} audio.`);
      return;
    }
    setPath(next);
    setError("");
    setPhase("file");
  };

  // A song dropped on the window while this is open is the chosen song.
  useEffect(() => {
    if (!droppedSong || seenDrop.current === droppedSong.nonce) return;
    seenDrop.current = droppedSong.nonce;
    if (running.current) return;
    accept(droppedSong.path);
  }, [droppedSong]);

  const choose = async () => {
    try {
      const picked = await pickStemFile();
      if (picked && mounted.current) accept(picked);
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    }
  };

  const models = useEngineModels(neuralOffered);
  const ready = engine === "fast" ? kinds.length > 0 : models.isReady(engine);

  const separate = async () => {
    if (!path || running.current) return;
    running.current = true;
    setError("");
    setStopping(false);
    setProgress({ stage: "reading", fraction: 0 });
    setPhase("running");
    try {
      const song = await separateStems(
        {
          path,
          kinds: engine === "fast" ? kinds : ["drums", "bass", "vocals"],
          engine,
          strongDrums: engine === "fast" && strongDrums,
        },
        (next) => {
          if (mounted.current) setProgress(next);
        },
      );
      running.current = false;
      if (mounted.current) onSeparated(song);
    } catch (cause) {
      running.current = false;
      if (!mounted.current) return;
      setPhase("options");
      if (!isStemsStopped(cause)) setError(errorText(cause));
    }
  };
  const cancel = () => {
    setStopping(true);
    void cancelStemSeparation();
  };

  const description =
    phase === "running"
      ? "Splitting the song into parts. Nothing leaves this computer, and a long song can take a minute."
      : phase === "options"
        ? "Choose which parts to pull out. You can mute, solo and slow each one on the next screen."
        : "Split a song into drums, bass, vocals and more, so you can play along with the rest.";
  const hero = phase === "file" ? { src: heroSelect, place: "top-[23%] right-3 w-[24%]" } : null;

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <DialogArt hero={hero} name={phase} />
      <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
        <DialogLogo src={logo} />
        <DialogStepper labels={STEPS} current={STEP_OF[phase]} />
        <DialogTitle className="sr-only">Stem separation</DialogTitle>
        <h2 aria-hidden="true" className="flex items-center gap-3 text-2xl font-bold">
          Stem separation
          <BetaBadge />
        </h2>
        <DialogDescription className={phase === "file" ? "md:pr-[30%]" : "md:pr-[20%]"}>
          {description}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="px-6 pb-4 md:px-9">
        <div className="flex flex-col gap-5">
          {!desktop && (
            <p className="text-sm text-muted-foreground">
              Stem separation is available in the desktop app.
            </p>
          )}
          {phase === "file" && desktop && (
            <SongStep path={path} onChoose={() => void choose()} onRemove={() => setPath(null)} />
          )}
          {phase === "options" && (
            <OptionsStep
              path={path}
              neuralOffered={neuralOffered}
              models={models}
              engine={engine}
              onEngine={setEngine}
              kinds={kinds}
              onKinds={setKinds}
              strongDrums={strongDrums}
              onStrongDrums={setStrongDrums}
            />
          )}
          {phase === "running" && <Running progress={progress} stopping={stopping} path={path} />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-2 pb-5 sm:justify-between md:px-9">
        {phase === "running" ? (
          <Button
            variant="outline"
            size="lg"
            className="bg-card"
            disabled={stopping}
            onClick={cancel}
          >
            <SquareIcon aria-hidden="true" data-icon="inline-start" className="fill-current" />
            {stopping ? "Stopping…" : "Cancel"}
          </Button>
        ) : phase === "options" ? (
          <>
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              disabled={models.busy}
              onClick={() => setPhase("file")}
            >
              <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
              Back
            </Button>
            <Button
              size="lg"
              className="min-w-52"
              disabled={!ready || models.busy}
              onClick={() => void separate()}
            >
              Separate
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={onClose}>
              Close
            </Button>
            <Button
              size="lg"
              className="min-w-52"
              disabled={!path || !desktop}
              onClick={() => setPhase("options")}
            >
              Next
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

/** Step 1: the privacy line and the song. */
function SongStep({
  path,
  onChoose,
  onRemove,
}: {
  path: string | null;
  onChoose: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-5 md:pr-[28%]">
      <div className="flex gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
        <p>Runs on this computer. Nothing is uploaded.</p>
      </div>
      <div
        role="region"
        aria-label="Song to separate"
        className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/50 bg-card/40 p-4"
      >
        <p className="text-sm text-muted-foreground">
          Drop a song on this window, or choose one. {EXTENSION_TEXT}.
        </p>
        {path && (
          <div className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" data-testid="stem-file-name">
                {baseName(path)}
              </p>
              <p className="truncate text-muted-foreground">{path}</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Remove song" onClick={onRemove}>
              <XIcon aria-hidden="true" />
            </Button>
          </div>
        )}
        <Button type="button" variant="outline" onClick={onChoose}>
          {path ? "Choose another song…" : "Choose a song…"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Use music you have the rights to. The parts are saved on this computer, up to 2 GB, and the
        oldest are removed first.
      </p>
    </div>
  );
}

/** Step 2: the engine, the parts and the drum removal. */
function OptionsStep({
  path,
  neuralOffered,
  models,
  engine,
  onEngine,
  kinds,
  onKinds,
  strongDrums,
  onStrongDrums,
}: {
  path: string | null;
  neuralOffered: boolean;
  models: EngineModels;
  engine: StemEngine;
  onEngine: (engine: StemEngine) => void;
  kinds: StemKindId[];
  onKinds: (kinds: StemKindId[]) => void;
  strongDrums: boolean;
  onStrongDrums: (strong: boolean) => void;
}) {
  if (models.setup) return <ModelSetup models={models} />;
  const toggle = (kind: StemKindId, on: boolean) =>
    onKinds(CHOICES.filter((choice) => (choice === kind ? on : kinds.includes(choice))));
  return (
    <>
      {path && (
        <p className="truncate text-sm text-muted-foreground">
          Song: <span className="font-semibold text-foreground">{baseName(path)}</span>
        </p>
      )}
      {neuralOffered && <EngineChoice engine={engine} onEngine={onEngine} models={models} />}
      {engine === "fast" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Parts to separate</legend>
          <p className="text-xs text-muted-foreground">
            Choose from this list; the app does not guess which instruments are in the song.
          </p>
          {CHOICES.map((kind) => (
            <label
              key={kind}
              htmlFor={`stem-kind-${kind}`}
              className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card/70 px-4 py-2.5 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
            >
              <Checkbox
                id={`stem-kind-${kind}`}
                checked={kinds.includes(kind)}
                onCheckedChange={(on) => toggle(kind, on === true)}
                className="mt-0.5"
              />
              <span>
                <span className="block font-semibold">
                  {STEM_LABELS[kind]}
                  {kind === "panned" && " (panned parts)"}
                </span>
                <span className="block text-xs text-muted-foreground">{STEM_HINTS[kind]}</span>
              </span>
            </label>
          ))}
          <div className="flex items-start gap-3 rounded-xl border border-dashed bg-card/40 px-4 py-2.5">
            <Checkbox checked disabled className="mt-0.5" aria-label="Other, not separated" />
            <span>
              <span className="block font-semibold">
                Other <span className="font-normal text-muted-foreground">· not separated</span>
              </span>
              <span className="block text-xs text-muted-foreground">
                Always on: everything that is not pulled out above stays here.
              </span>
            </span>
          </div>
        </fieldset>
      ) : (
        <p className="rounded-xl border bg-card/70 px-4 py-3 text-sm">
          {engineInfo(engine).label} separates <strong>drums</strong>, <strong>bass</strong>,{" "}
          <strong>vocals</strong> and <strong>other</strong>.
        </p>
      )}
      {engine === "fast" && kinds.includes("drums") && (
        <div className="flex flex-col gap-2">
          <span id="stem-drums-label" className="text-sm font-medium">
            Drum removal
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            aria-labelledby="stem-drums-label"
            value={strongDrums ? "strong" : "gentle"}
            onValueChange={(value) => value && onStrongDrums(value === "strong")}
          >
            <ToggleGroupItem value="gentle" size="lg" className="px-4 font-semibold">
              Gentle
            </ToggleGroupItem>
            <ToggleGroupItem value="strong" size="lg" className="px-4 font-semibold">
              Strong
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {strongDrums
              ? "Takes the drums down about twice as far, and some of the bass and guitar attacks with them."
              : "Keeps the other parts clean; more of the drums can stay in."}
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        A mono file cannot be split into vocals and panned parts; the page tells you if that
        happened.
      </p>
    </>
  );
}

/** Step 3: what is happening, and how far it is. */
function Running({
  progress,
  stopping,
  path,
}: {
  progress: StemProgress | null;
  stopping: boolean;
  path: string | null;
}) {
  const percent = Math.round(overallProgress(progress) * 100);
  const current = STAGES.findIndex(({ stage }) => stage === progress?.stage);
  return (
    <div role="status" className="flex flex-col gap-4 text-sm">
      <ol className="flex flex-col gap-3 md:pr-[40%]">
        {STAGES.map(({ name }, index) => {
          const state = index < current ? "done" : index === current ? "active" : "pending";
          return (
            <li key={name} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                  state === "done" && "border-primary bg-primary text-primary-foreground",
                  state === "active" && "border-primary motion-safe:animate-pulse",
                  state === "pending" && "border-border",
                )}
              >
                {state === "done" && <CheckIcon className="size-3.5" />}
              </span>
              <span className="block font-semibold">
                {name}
                <span className="sr-only">
                  {state === "done" ? " (done)" : state === "active" ? " (in progress)" : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-col gap-1.5 rounded-xl border bg-card/70 px-4 py-3">
        <p className="truncate font-semibold">{path ? baseName(path) : "Your song"}</p>
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="Separation progress"
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
        {stopping && <p className="text-muted-foreground">Stopping…</p>}
      </div>
    </div>
  );
}
