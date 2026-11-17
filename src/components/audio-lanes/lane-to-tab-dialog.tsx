import {
  ArrowLeftIcon,
  ArrowRightIcon,
  AudioLinesIcon,
  CheckIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
  SquareIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import iconBass from "@/assets/record-to-tab/icon-bass.webp";
import iconDrums from "@/assets/record-to-tab/icon-drums.webp";
import iconGuitar from "@/assets/record-to-tab/icon-guitar.webp";
import iconPiano from "@/assets/record-to-tab/icon-piano.webp";
import logo from "@/assets/lane-to-tab/logo.webp";
import { PartDragChip } from "@/components/audio/part-drag-chip";
import { PartDragHud } from "@/components/audio/part-drag-hud";
import { usePartDrag } from "@/components/audio/use-part-drag";
import { DIALOG_NEON, DialogArt, DialogLogo, DialogStepper } from "@/components/ai/dialog-art";
import { PartPreview } from "@/components/audio-lanes/lane-transcribe/part-preview";
import { RangeStrip } from "@/components/audio-lanes/lane-transcribe/range-strip";
import { usePartPreview } from "@/components/audio-lanes/lane-transcribe/use-part-preview";
import {
  Crown,
  INSTRUMENT_BUTTON,
  MODE_BUTTON,
  SectionLabel,
} from "@/components/score/record-dialog";
import type { RecordTarget } from "@/components/score/record-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTheme } from "@/hooks/use-theme";
import { useLaneTranscription, type LaneFound, type LaneToTabHost } from "@/hooks/use-lane-to-tab";
import { canRun, refreshAi, useAiState } from "@/lib/ai/ai-store";
import {
  analyseSource,
  buildPart,
  clock,
  compatibleTracks,
  defaultPlace,
  describeBars,
  describeSource,
  firstEmptyBar,
  firstTenMinutes,
  instrumentFromName,
  INSTRUMENT_LABEL,
  laneEndOf,
  samePlace,
  startBarFor,
  type LanePart,
  type PlaceChoice,
} from "@/lib/audio-lanes/lane-transcribe";
import {
  resolveClipRequest,
  type LaneRange,
  type LaneToTabRequest,
} from "@/lib/audio-lanes/lane-transcribe-request";
import type { SongGrid } from "@/lib/audio-lanes/sync";
import {
  readAiMode,
  readInstrument,
  readPianoEngine,
  readTuningChoice,
  storeInstrument,
  tuningOf,
  type RecordEngine,
  type RecordInstrument,
} from "@/lib/audio/record-prefs";
import type { PlacedTake } from "@/lib/import/place-take";
import { recordingSpan } from "@/lib/import/recording";
import { isEnabled } from "@/lib/features";
import type { Score } from "@/lib/score/model";
import type { AudioLanesSettings } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const STEPS = ["Source", "Instrument", "Place", "Result"] as const;
type StepIndex = 0 | 1 | 2 | 3;

const HEADINGS: Record<StepIndex, { title: string; description: string }> = {
  0: {
    title: "Choose the audio",
    description: "Pick the audio track, and the part of it, to turn into sheet music.",
  },
  1: {
    title: "What is playing?",
    description: "Smart Beat listens to the audio on this computer and finds the notes.",
  },
  2: {
    title: "Where do the notes go?",
    description: "Choose the track and the bar. The preview shows what will be written.",
  },
  3: {
    title: "Your sheet is ready",
    description: "The notes are in your tab.",
  },
};

const INSTRUMENTS = [
  { value: "guitar", label: "Guitar", icon: iconGuitar },
  { value: "bass", label: "Bass", icon: iconBass },
  { value: "piano", label: "Piano", icon: iconPiano },
  { value: "drums", label: "Drums", icon: iconDrums },
] as const;

/** What the dialog needs to know about the tab it sits in. */
export interface LaneToTabDialogProps {
  host: LaneToTabHost;
  audio: AudioLanesSettings;
  grid: SongGrid;
  /** Ids of the audio files that cannot be found. */
  missing: ReadonlySet<string>;
  /** The live song (never drawn here), or null when there is none. */
  score: Score | null;
  /** The song's stringed, pitched and drum tracks. */
  tracks: readonly RecordTarget[];
  /** The track of the edit cursor, if it is one of `tracks`. */
  cursorTrack: number | null;
  /** Unmutes a clip, as an undoable edit of the lanes. */
  onUnmuteClip: (clipId: string) => void;
  /** Changes with every edit of the song (the song is changed in place). */
  revision: number;
  /** The high-accuracy piano model, when it is installed. */
  pianoInstalled?: boolean;
}

/**
 * "Sheet from an audio lane" (#235): turns an audio track, a clip or a time span into notes and
 * writes them into the tab. Four steps: Source, Instrument, Place, Result.
 */
export function LaneToTabDialog(props: LaneToTabDialogProps) {
  const { host } = props;
  // While a part is carried to the score the dialog is see-through (and stays mounted, so the
  // pointer capture and every choice survive).
  const [placing, setPlacing] = useState(false);
  return (
    <Dialog open={host.request !== null} onOpenChange={(open) => !open && host.close()}>
      <DialogContent
        size="xl"
        data-tour="lane-to-tab-dialog"
        data-placing={placing || undefined}
        overlayClassName={
          placing ? "bg-transparent supports-backdrop-filter:backdrop-blur-none" : undefined
        }
        className={cn(
          DIALOG_NEON,
          "h-[min(48rem,calc(100dvh-2rem))] sm:max-w-4xl",
          placing && "pointer-events-none opacity-0",
        )}
      >
        {/* Mounted only while open: every visit starts from the defaults. */}
        {host.request && (
          <LaneToTabForm
            key={host.nonce}
            request={host.request}
            onPlacing={setPlacing}
            {...props}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A lane's audio on the timeline: from its first clip to its last (null for an empty lane). */
function laneExtent(audio: AudioLanesSettings, laneId: string | null): LaneRange | null {
  const lane = audio.lanes.find((l) => l.id === laneId);
  if (!lane || lane.clips.length === 0) return null;
  return {
    startMs: Math.min(...lane.clips.map((c) => c.startMs)),
    endMs: laneEndOf(lane),
  };
}

/** What a run was made from, to tell whether the audio changed under it. */
const audioSignature = (
  clips: readonly {
    id: string;
    startMs: number;
    lengthMs: number;
    playrate: number;
    take: number;
    reversed: boolean;
    mute: boolean;
  }[],
) =>
  JSON.stringify(
    clips.map((c) => [c.id, c.startMs, c.lengthMs, c.playrate, c.take, c.reversed, c.mute]),
  );

function LaneToTabForm({
  request,
  host,
  audio,
  grid,
  missing,
  score,
  tracks,
  cursorTrack,
  onUnmuteClip,
  revision,
  pianoInstalled = false,
  onPlacing,
}: LaneToTabDialogProps & { request: LaneToTabRequest; onPlacing: (placing: boolean) => void }) {
  const { resolvedTheme } = useTheme();
  const barCount = score?.masterBars.length ?? 0;

  // --- Source -----------------------------------------------------------------------------
  const [stepState, setStep] = useState<StepIndex>(request.clipIds.length > 0 ? 1 : 0);
  const [source, setSource] = useState({
    laneId: request.laneId,
    clipIds: request.clipIds,
    range: request.range,
  });
  const [collapsed, setCollapsed] = useState(request.clipIds.length > 0);
  const [notice, setNotice] = useState<string | null>(null);
  const [initialClips] = useState(request.clipIds);
  const resolved = resolveClipRequest(audio.lanes, source);
  const report = analyseSource(audio, resolved, missing);
  // The last span a clip had, kept for when the clip is split away while the dialog is open.
  const lastSpan = useRef<LaneRange | null>(request.range);
  useEffect(() => {
    if (resolved.clipIds.length > 0 && resolved.range) lastSpan.current = resolved.range;
  });
  const gone = resolved.notice !== null && source.clipIds.length > 0;
  useEffect(() => {
    if (!gone) return;
    const span = lastSpan.current;
    setSource((s) => ({ ...s, clipIds: [], range: span }));
    setNotice(
      span
        ? `The clip was changed, so the time span it had (${clock(span.startMs)} to ${clock(span.endMs)}) is used instead.`
        : "The clip was changed, so the whole track is used instead.",
    );
    // Only when the clips vanish.
  }, [gone]);

  const scope: "lane" | "clips" | "span" =
    source.clipIds.length > 0 ? "clips" : source.range ? "span" : "lane";
  const extent = laneExtent(audio, source.laneId);
  const lanes = audio.lanes.filter((l) => !l.folder);
  const laneName = report.lane?.name ?? "Audio track";

  const chooseLane = (laneId: string) => {
    setSource({ laneId, clipIds: [], range: null });
    setNotice(null);
  };
  const chooseScope = (value: string) => {
    if (value === "lane") setSource((s) => ({ ...s, clipIds: [], range: null }));
    else if (value === "clips") setSource((s) => ({ ...s, clipIds: initialClips, range: null }));
    else {
      setSource((s) => ({ ...s, clipIds: [], range: report.span ?? extent }));
    }
  };

  // --- Instrument -------------------------------------------------------------------------
  const [instrument, setInstrument] = useState<RecordInstrument>(
    () =>
      instrumentFromName(audio.lanes.find((l) => l.id === request.laneId)?.name ?? "") ??
      readInstrument(),
  );
  const ai = useAiState();
  const offersAi = isEnabled("muscriptor-record") && ai.ready && canRun(ai);
  const [aiOn, setAiOn] = useState(readAiMode);
  useEffect(() => {
    void refreshAi();
  }, []);
  const engine: RecordEngine =
    offersAi && aiOn
      ? "muscriptor"
      : instrument === "piano" && pianoInstalled && readPianoEngine() === "accurate"
        ? "accurate"
        : "standard";
  const pickInstrument = (value: RecordInstrument) => {
    setInstrument(value);
    storeInstrument(value);
  };

  // --- Finding the notes ------------------------------------------------------------------
  const { job, run, stop, clear } = useLaneTranscription();
  const [found, setFound] = useState<{
    part: LanePart;
    runKey: string;
    audioKey: string;
    laneId: string;
  } | null>(null);
  const runKey = JSON.stringify([source.laneId, report.span, resolved.clipIds, instrument, engine]);
  const audioKey = audioSignature(report.clips);
  // A result is valid only for what it was made from: the same source and settings, and the same
  // audio (another player may switch the take or reverse a clip without touching its ids or span).
  const fresh = found !== null && found.runKey === runKey && found.audioKey === audioKey;
  const changedAfter = found !== null && found.runKey === runKey && found.audioKey !== audioKey;
  // Notes that went stale while the Place step was open: back to the step that finds them again.
  const step: StepIndex = stepState === 2 && !fresh ? 1 : stepState;

  const [noNotes, setNoNotes] = useState(false);
  const findNotes = async () => {
    if (!report.lane || !report.span || report.problem) return;
    const input = {
      laneId: report.lane.id,
      clipId: resolved.clipIds.length === 1 ? resolved.clipIds[0] : undefined,
      span: scope === "lane" ? null : report.span,
      instrument,
      engine,
    };
    const family = instrument === "bass" ? "bass" : "guitar";
    const result: LaneFound | null = await run(input);
    if (!result) return;
    if (result.notes.length === 0) {
      setFound(null);
      setNoNotes(true);
      return;
    }
    setNoNotes(false);
    const part = buildPart(audio, grid, result, {
      instrument,
      tuning: tuningOf(readTuningChoice(family)),
      laneName,
      barCount,
    });
    setFound({ part, runKey, audioKey, laneId: report.lane.id });
    setTouchedPlace(false);
    setTouchedBar(false);
    setStep(2);
  };
  // --- Place ------------------------------------------------------------------------------
  const compatible = useMemo(() => compatibleTracks(tracks, instrument), [tracks, instrument]);
  const defaultChoice = defaultPlace({
    laneName,
    instrument,
    tracks: score ? tracks : null,
    cursorTrack,
  });
  const [touchedPlace, setTouchedPlace] = useState(false);
  const [chosenPlace, setChosenPlace] = useState<PlaceChoice>(defaultChoice);
  const place: PlaceChoice = touchedPlace ? chosenPlace : defaultChoice;
  const start = report.span
    ? startBarFor(audio, grid, report.span.startMs, barCount)
    : { bar: 0, midBar: false, beforeFirst: false, pastEnd: false };
  const [touchedBar, setTouchedBar] = useState(false);
  const [chosenBar, setChosenBar] = useState(start.bar);
  const bar = Math.min(
    Math.max(touchedBar ? chosenBar : (found?.part.originBar ?? start.bar), 0),
    barCount,
  );
  const setBar = (value: number) => {
    setTouchedBar(true);
    setChosenBar(Math.min(Math.max(value, 0), barCount));
  };
  const choosePlace = (value: PlaceChoice) => {
    setTouchedPlace(true);
    setChosenPlace(value);
  };

  const part = fresh ? found.part : null;
  const preview = usePartPreview(score, part, place, bar, step === 2 && part !== null, revision);
  const drag = usePartDrag({
    part,
    barsAt: (at) => (score && part ? recordingSpan(score, part.take, at).bars : 0),
    want: { track: place.kind === "track" ? place.index : null, bar },
    onDropped: host.close,
  });
  useEffect(() => {
    onPlacing(drag.placing);
    return () => onPlacing(false);
  }, [drag.placing, onPlacing]);
  const targetName =
    place.kind === "track"
      ? (tracks.find((t) => t.index === place.index)?.name ?? "the track")
      : place.kind === "new-track"
        ? "a new track"
        : "a new tab";

  // --- Writing ----------------------------------------------------------------------------
  const [done, setDone] = useState<{ placed: PlacedTake; part: LanePart; undone: boolean } | null>(
    null,
  );
  const commit = () => {
    if (!part) return;
    if (place.kind === "new-tab") {
      if (host.newTab(part)) host.close();
      return;
    }
    const placed = host.place(
      part,
      { track: place.kind === "track" ? place.index : null, bar },
      { toast: false },
    );
    if (placed) {
      setDone({ placed, part, undone: false });
      setStep(3);
    }
  };

  const running = job.kind === "running";
  const heading = HEADINGS[step];
  const nextDisabled = step === 0 && (report.problem !== null || !report.span);

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <DialogArt hero={null} name="lane-to-tab" />
      <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
        <DialogLogo src={logo} testId="lane-to-tab-logo" />
        <DialogStepper labels={STEPS} current={step} />
        <DialogTitle className="sr-only">Sheet from an audio lane</DialogTitle>
        <h2 className="text-2xl font-bold">{heading.title}</h2>
        <DialogDescription>{heading.description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-4 px-6 pb-4 md:px-9">
        {step === 0 && (
          <SourceStep
            collapsed={collapsed}
            onExpand={() => setCollapsed(false)}
            summary={describeSource(report, resolved)}
            lanes={lanes}
            laneId={source.laneId}
            onLane={chooseLane}
            scope={scope}
            hasClips={initialClips.length > 0}
            onScope={chooseScope}
            extent={extent}
            range={scope === "span" ? (source.range ?? report.span) : null}
            onRange={(range) => setSource((s) => ({ ...s, range }))}
            notice={notice ?? resolved.notice}
            report={report}
            onFix={(fix) => {
              if (fix === "first-10-minutes" && report.span) {
                setSource((s) => ({ ...s, clipIds: [], range: firstTenMinutes(report.span!) }));
              } else if (fix === "unmute-clip" && resolved.clipIds[0]) {
                onUnmuteClip(resolved.clipIds[0]);
              }
            }}
          />
        )}
        {step === 1 && (
          <>
            {collapsed && (
              <SourceSummary
                summary={describeSource(report, resolved)}
                onChange={() => {
                  setCollapsed(false);
                  setStep(0);
                }}
              />
            )}
            {notice && (
              <p role="status" className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
                {notice}
              </p>
            )}
            {changedAfter && (
              <p
                role="alert"
                data-testid="lane-to-tab-stale"
                className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
              >
                The audio was changed after the notes were found. Find the notes again.
              </p>
            )}
            {report.problem && (
              <ProblemNote
                problem={report.problem}
                onFix={(fix) => {
                  if (fix === "first-10-minutes" && report.span) {
                    setSource((s) => ({ ...s, clipIds: [], range: firstTenMinutes(report.span!) }));
                  } else if (fix === "unmute-clip" && resolved.clipIds[0]) {
                    onUnmuteClip(resolved.clipIds[0]);
                  }
                }}
              />
            )}
            <InstrumentStep
              instrument={instrument}
              onInstrument={pickInstrument}
              offersAi={offersAi}
              aiOn={aiOn && offersAi}
              onAi={(value) => setAiOn(value)}
              advisories={report.advisories}
              disabled={running}
            />
            {running && (
              <div
                role="status"
                data-testid="lane-to-tab-progress"
                className="flex flex-col gap-2 rounded-xl border bg-card p-4"
              >
                <p className="flex items-center gap-2 font-medium">
                  <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                  Finding the notes… {Math.round(job.fraction * 100)}%
                </p>
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${Math.round(job.fraction * 100)}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  This runs on this computer. You can stop it at any time.
                </p>
              </div>
            )}
            {job.kind === "failed" && (
              <p
                role="alert"
                className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm"
              >
                Couldn&apos;t find the notes: {job.message}
              </p>
            )}
            {noNotes && !running && (
              <p
                role="status"
                className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
              >
                No notes were heard. Choose a part where the instrument is clear and loud enough, or
                try another instrument.
              </p>
            )}
          </>
        )}
        {step === 2 && part && (
          <PlaceStep
            tracks={compatible}
            place={place}
            onPlace={choosePlace}
            showNewTab
            bar={bar}
            onBar={setBar}
            barCount={barCount}
            defaultBar={found?.part.originBar ?? start.bar}
            start={start}
            firstEmpty={place.kind === "track" && score ? firstEmptyBar(score, place.index) : null}
          >
            <PartPreview
              part={part}
              result={preview.result}
              pending={preview.pending}
              error={preview.error}
              trackName={targetName}
              theme={resolvedTheme}
              grip={<PartGrip drag={drag} />}
            />
          </PlaceStep>
        )}
        {step === 3 && done && (
          <ResultStep
            done={done}
            trackName={score?.tracks[done.placed.track]?.name ?? targetName}
            theme={resolvedTheme}
            onUndo={() => {
              host.undo();
              setDone({ ...done, undone: true });
            }}
            preview={preview}
            part={done.part}
          />
        )}
      </DialogBody>
      <div role="status" aria-live="polite" className="sr-only" data-testid="lane-to-tab-live">
        {drag.announcement}
      </div>
      <PartDragChip view={drag.view} />
      <PartDragHud view={drag.view} />
      <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-2 pb-5 sm:justify-between md:px-9">
        {step === 0 && (
          <>
            <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={host.close}>
              Close
            </Button>
            <Button
              size="lg"
              className="min-w-52"
              disabled={nextDisabled}
              onClick={() => setStep(1)}
            >
              Next
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
        {step === 1 && (
          <>
            {running ? (
              <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={stop}>
                <SquareIcon aria-hidden="true" data-icon="inline-start" className="fill-current" />
                Stop
              </Button>
            ) : (
              <Button
                variant="outline"
                size="lg"
                className="min-w-28 bg-card"
                onClick={() => {
                  clear();
                  setStep(0);
                }}
              >
                <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
                Back
              </Button>
            )}
            <Button
              size="lg"
              className="min-w-52"
              disabled={running || report.problem !== null}
              onClick={() => {
                if (fresh) setStep(2);
                else void findNotes();
              }}
              data-testid="lane-to-tab-find"
            >
              {fresh ? "Next" : "Find the notes"}
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
        {step === 2 && (
          <>
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              onClick={() => setStep(1)}
            >
              <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
              Back
            </Button>
            <Button
              size="lg"
              className="min-w-52"
              disabled={!part || preview.pending || preview.result === null}
              onClick={commit}
              data-testid="lane-to-tab-add"
            >
              <CheckIcon aria-hidden="true" data-icon="inline-start" />
              {place.kind === "new-tab" ? "Open as a new tab" : "Add to score"}
            </Button>
          </>
        )}
        {step === 3 && (
          <>
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              disabled={done?.undone}
              onClick={() => {
                if (!done) return;
                host.undo();
                setDone({ ...done, undone: true });
              }}
            >
              <Undo2Icon aria-hidden="true" data-icon="inline-start" />
              Undo
            </Button>
            <Button size="lg" className="min-w-52" onClick={host.close}>
              Done
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

// --- Parts -----------------------------------------------------------------------------

function SourceSummary({ summary, onChange }: { summary: string; onChange: () => void }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3"
      data-testid="lane-to-tab-source-summary"
    >
      <AudioLinesIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate font-medium">{summary}</p>
      <Button type="button" variant="outline" size="sm" onClick={onChange}>
        Change
      </Button>
    </div>
  );
}

function ProblemNote({
  problem,
  onFix,
}: {
  problem: { message: string; fix: "unmute-clip" | "first-10-minutes" | null };
  onFix: (fix: "unmute-clip" | "first-10-minutes") => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1">{problem.message}</span>
      {problem.fix && (
        <Button type="button" variant="outline" size="sm" onClick={() => onFix(problem.fix!)}>
          {problem.fix === "unmute-clip" ? "Unmute it" : "Use the first 10 minutes"}
        </Button>
      )}
    </div>
  );
}

function SourceStep({
  collapsed,
  onExpand,
  summary,
  lanes,
  laneId,
  onLane,
  scope,
  hasClips,
  onScope,
  extent,
  range,
  onRange,
  notice,
  report,
  onFix,
}: {
  collapsed: boolean;
  onExpand: () => void;
  summary: string;
  lanes: readonly { id: string; name: string }[];
  laneId: string | null;
  onLane: (id: string) => void;
  scope: "lane" | "clips" | "span";
  hasClips: boolean;
  onScope: (scope: string) => void;
  extent: LaneRange | null;
  range: LaneRange | null;
  onRange: (range: LaneRange) => void;
  notice: string | null;
  report: ReturnType<typeof analyseSource>;
  onFix: (fix: "unmute-clip" | "first-10-minutes") => void;
}) {
  const laneField = useId();
  const scopeLabel = useId();
  return (
    <div className="flex flex-col gap-4" data-tour="lane-to-tab-lane">
      {collapsed ? (
        <SourceSummary summary={summary} onChange={onExpand} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={laneField}>
              <SectionLabel>Audio track</SectionLabel>
            </label>
            <Select value={laneId ?? undefined} onValueChange={onLane}>
              <SelectTrigger id={laneField} className="w-full max-w-sm rounded-md">
                <AudioLinesIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                <SelectValue placeholder="Choose an audio track" />
              </SelectTrigger>
              <SelectContent>
                {lanes.map((lane) => (
                  <SelectItem key={lane.id} value={lane.id}>
                    {lane.name || "Audio track"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <SectionLabel id={scopeLabel}>Which part</SectionLabel>
            <ToggleGroup
              type="single"
              variant="default"
              spacing={2}
              aria-labelledby={scopeLabel}
              value={scope}
              onValueChange={(value) => value && onScope(value)}
              className="self-start"
            >
              <ToggleGroupItem value="lane" className={MODE_BUTTON}>
                Whole track
              </ToggleGroupItem>
              {hasClips && (
                <ToggleGroupItem value="clips" className={MODE_BUTTON}>
                  The clip
                </ToggleGroupItem>
              )}
              <ToggleGroupItem value="span" className={MODE_BUTTON}>
                A time span
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {scope === "span" && extent && range && (
            <RangeStrip extent={extent} value={range} onChange={onRange} />
          )}
          {report.span && (
            <p className="text-sm text-muted-foreground" data-testid="lane-to-tab-summary">
              {summary}
            </p>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {report.problem && <ProblemNote problem={report.problem} onFix={onFix} />}
      {!report.problem &&
        report.advisories.map((text) => (
          <p key={text} role="note" className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
            {text}
          </p>
        ))}
    </div>
  );
}

function InstrumentStep({
  instrument,
  onInstrument,
  offersAi,
  aiOn,
  onAi,
  advisories,
  disabled,
}: {
  instrument: RecordInstrument;
  onInstrument: (value: RecordInstrument) => void;
  offersAi: boolean;
  aiOn: boolean;
  onAi: (value: boolean) => void;
  advisories: readonly string[];
  disabled: boolean;
}) {
  const label = useId();
  const engineLabel = useId();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SectionLabel id={label}>Instrument</SectionLabel>
        <ToggleGroup
          type="single"
          variant="default"
          spacing={2}
          aria-labelledby={label}
          data-tour="lane-to-tab-instrument"
          value={instrument}
          disabled={disabled}
          onValueChange={(value) => value && onInstrument(value as RecordInstrument)}
          className="flex-wrap gap-2"
        >
          {INSTRUMENTS.map(({ value, label: text, icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              aria-label={text}
              className={INSTRUMENT_BUTTON}
            >
              <img
                src={icon}
                alt=""
                aria-hidden="true"
                className="-mt-2 -mb-1 size-[50px] shrink-0 object-contain"
              />
              <span className="relative flex flex-col items-center justify-end self-stretch pt-4 pb-3">
                {instrument === value && (
                  <Crown className="absolute top-0.5 left-1/2 size-6 -translate-x-1/2" />
                )}
                {text}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {offersAi && (
        <div className="flex flex-col gap-2">
          <SectionLabel id={engineLabel}>Note finder</SectionLabel>
          <ToggleGroup
            type="single"
            variant="default"
            spacing={2}
            aria-labelledby={engineLabel}
            value={aiOn ? "ai" : "standard"}
            disabled={disabled}
            onValueChange={(value) => value && onAi(value === "ai")}
            className="self-start"
          >
            <ToggleGroupItem value="standard" className={MODE_BUTTON}>
              Standard
            </ToggleGroupItem>
            <ToggleGroupItem value="ai" className={MODE_BUTTON}>
              AI (MuScriptor)
            </ToggleGroupItem>
          </ToggleGroup>
          {aiOn && (
            <p className="text-sm text-muted-foreground">
              MuScriptor by Kyutai and Mirelo runs on this computer. Non-commercial use only, and
              only on music you have the rights to. Review the result and correct it.
            </p>
          )}
        </div>
      )}
      {advisories.map((text) => (
        <p key={text} role="note" className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {text}
        </p>
      ))}
      <p className="text-sm text-muted-foreground">
        The result is a start, not a finished score. Check it against the audio and correct it.
      </p>
    </div>
  );
}

function PlaceStep({
  tracks,
  place,
  onPlace,
  showNewTab,
  bar,
  onBar,
  barCount,
  defaultBar,
  start,
  firstEmpty,
  children,
}: {
  tracks: readonly { index: number; name: string }[];
  place: PlaceChoice;
  onPlace: (value: PlaceChoice) => void;
  showNewTab: boolean;
  bar: number;
  onBar: (bar: number) => void;
  barCount: number;
  defaultBar: number;
  start: { midBar: boolean; beforeFirst: boolean; pastEnd: boolean };
  firstEmpty: number | null;
  children: ReactNode;
}) {
  const group = useId();
  const barId = useId();
  const choices: { key: string; label: string; value: PlaceChoice }[] = [
    ...tracks.map((t) => ({
      key: `t${t.index}`,
      label: t.name,
      value: { kind: "track", index: t.index } as PlaceChoice,
    })),
    { key: "new-track", label: "New track in this tab", value: { kind: "new-track" } },
    ...(showNewTab
      ? [{ key: "new-tab", label: "New tab", value: { kind: "new-tab" } as PlaceChoice }]
      : []),
  ];
  const isDefault = bar === defaultBar;
  return (
    <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)]" data-tour="lane-to-tab-place">
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-labelledby={group} className="flex flex-col gap-2">
          <SectionLabel id={group}>Track</SectionLabel>
          {choices.map((choice) => {
            const on = samePlace(choice.value, place);
            return (
              <label
                key={choice.key}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  on && "border-primary ring-2 ring-primary/70",
                )}
              >
                <input
                  type="radio"
                  name={group}
                  className="accent-primary"
                  checked={on}
                  onChange={() => onPlace(choice.value)}
                />
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              </label>
            );
          })}
        </div>
        {place.kind !== "new-tab" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={barId}>
              <SectionLabel>Start bar</SectionLabel>
            </label>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Earlier bar"
                disabled={bar <= 0}
                onClick={() => onBar(bar - 1)}
              >
                <MinusIcon aria-hidden="true" />
              </Button>
              <BarField id={barId} bar={bar} max={barCount} onBar={onBar} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Later bar"
                disabled={bar >= barCount}
                onClick={() => onBar(bar + 1)}
              >
                <PlusIcon aria-hidden="true" />
              </Button>
            </div>
            {isDefault && <p className="text-sm text-muted-foreground">Same bar as the audio.</p>}
            {isDefault && start.midBar && (
              <p className="text-sm text-muted-foreground">
                The audio starts in the middle of a bar. Notes are placed from bar {bar + 1}.
              </p>
            )}
            {isDefault && start.beforeFirst && (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                The audio starts before bar 1. Notes before it are left out.
              </p>
            )}
            {bar >= barCount && (
              <p className="text-sm text-muted-foreground">The tab will grow to make room.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {!isDefault && (
                <Button type="button" variant="ghost" size="sm" onClick={() => onBar(defaultBar)}>
                  Same bar as the audio
                </Button>
              )}
              {firstEmpty !== null && firstEmpty !== bar && (
                <Button type="button" variant="ghost" size="sm" onClick={() => onBar(firstEmpty)}>
                  Use first empty bar
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </div>
  );
}

function ResultStep({
  done,
  trackName,
  theme,
  preview,
  part,
}: {
  done: { placed: PlacedTake; part: LanePart; undone: boolean };
  trackName: string;
  theme: "light" | "dark";
  onUndo: () => void;
  preview: ReturnType<typeof usePartPreview>;
  part: LanePart;
}) {
  const { placed } = done;
  return (
    <div className="flex flex-col gap-3" data-testid="lane-to-tab-result">
      <p
        role="status"
        className="flex items-start gap-2 rounded-xl border bg-card p-4 text-base font-medium"
      >
        <CheckIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        {done.undone
          ? "Undone. The tab is as it was."
          : `Added ${INSTRUMENT_LABEL[done.part.instrument]} to “${trackName}”, ${describeBars(placed.firstBar, placed.lastBar)}.${placed.appended > 0 ? ` The tab grew by ${placed.appended} ${placed.appended === 1 ? "bar" : "bars"}.` : ""}`}
      </p>
      {placed.warnings.length > 0 && (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
          {placed.warnings.join(" ")}
        </p>
      )}
      {!done.undone && (
        <PartPreview
          part={part}
          result={preview.result}
          pending={preview.pending}
          error={preview.error}
          trackName={trackName}
          theme={theme}
        />
      )}
    </div>
  );
}

/** The handle to carry the preview to the score: by pointer, or Space and the arrow keys. */
function PartGrip({ drag }: { drag: ReturnType<typeof usePartDrag> }) {
  const help = useId();
  return (
    <>
      <button
        type="button"
        data-testid="part-drag-grip"
        aria-describedby={help}
        aria-pressed={drag.placing}
        onPointerDown={drag.onGripPointerDown}
        onKeyDown={drag.onGripKeyDown}
        className="inline-flex h-8 touch-none items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm font-medium select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing [&:not(:active)]:cursor-grab"
      >
        <GripVerticalIcon className="size-4" aria-hidden="true" />
        Drag to the score
      </button>
      <span id={help} className="sr-only">
        Press Space to pick the sheet up, then move it over the score with the arrow keys, drop it
        with Enter or cancel with Escape. The Add to score button does the same without dragging.
      </span>
    </>
  );
}

/** The start bar, 1-based. Takes what is typed (it may be empty on the way) and settles on blur. */
function BarField({
  id,
  bar,
  max,
  onBar,
}: {
  id: string;
  bar: number;
  max: number;
  onBar: (bar: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={1}
      max={max + 1}
      className="w-20 rounded-md text-center"
      value={text ?? String(bar + 1)}
      onChange={(event) => {
        setText(event.target.value);
        const next = Number.parseInt(event.target.value, 10);
        if (Number.isFinite(next)) onBar(next - 1);
      }}
      onBlur={() => setText(null)}
    />
  );
}
