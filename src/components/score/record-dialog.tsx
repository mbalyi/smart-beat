import {
  AudioLinesIcon,
  CircleIcon,
  DownloadIcon,
  FileAudioIcon,
  HeadphonesIcon,
  Music2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import betaBadge from "@/assets/record-to-tab/beta-badge.webp";
import crown from "@/assets/record-to-tab/crown.webp";
import hero from "@/assets/record-to-tab/hero.webp";
import iconBass from "@/assets/record-to-tab/icon-bass.webp";
import iconDrums from "@/assets/record-to-tab/icon-drums.webp";
import iconGuitar from "@/assets/record-to-tab/icon-guitar.webp";
import iconPiano from "@/assets/record-to-tab/icon-piano.webp";
import logo from "@/assets/record-to-tab/logo.webp";
import sparklesLeft from "@/assets/record-to-tab/sparkles-left.webp";
import sparklesRight from "@/assets/record-to-tab/sparkles-right.webp";
import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import { AudioInputSetting } from "@/components/audio-input-setting";
import { AudioDropArea } from "@/components/audio/audio-drop-area";
import { LiveWaveform } from "@/components/audio/live-waveform";
import { recordToTabBetaNote } from "@/components/record-to-tab-notes";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { canRun, chooseSize, openInstaller, refreshAi, useAiState } from "@/lib/ai/ai-store";
import { sizeInfo } from "@/lib/ai/muscriptor-sizes";
import type { MuscriptorSize } from "@/lib/tauri";
import { isEnabled } from "@/lib/features";
import { useInputLevel } from "@/hooks/use-input-level";
import type { PianoModel } from "@/hooks/use-piano-model";
import { isTakeFile, TAKE_FILE_EXTENSIONS } from "@/lib/audio/decode-take";
import { looksBuiltIn, useAudioInput } from "@/lib/audio/input";
import {
  RECORD_BASS_STRING_COUNTS,
  RECORD_STRING_COUNTS,
  readAlignToBeat,
  readInstrument,
  readAiMode,
  readPianoEngine,
  readPlayOthers,
  readTuningChoice,
  standardTuningChoice,
  storeAlignToBeat,
  storeInstrument,
  storeAiMode,
  storePianoEngine,
  storePlayOthers,
  storeTuningChoice,
  tuningOf,
  type PianoEngine,
  type RecordEngine,
  type RecordInstrument,
  type TuningChoice,
} from "@/lib/audio/record-prefs";
import { pitchName, tuningPresets } from "@/lib/score/music";
import { cn } from "@/lib/utils";

export type RecordMode = "click" | "free";
/** What the dialog turns into tab: a take in one of the modes, or an existing recording. */
type Source = RecordMode | "file";

/** What the player chose. */
export interface RecordSetup {
  mode: RecordMode;
  /** Click mode: the track the take goes on (an index), or null for a new track. */
  track: number | null;
  /** Click mode: the bar to start at (0-based). */
  startBar: number;
  /** Click mode: the song's other tracks play along. */
  playOthers: boolean;
  /** Click mode: shift the take by up to 80 ms so that it lines up with the beat. */
  alignToBeat: boolean;
  /** The tuning of a new track, or of the new song in free mode. Unused for a piano. */
  tuning: number[];
  instrument: RecordInstrument;
  /** A piano: the built-in note finder, or the downloaded high-accuracy model. "muscriptor" is the AI tab. */
  engine: RecordEngine;
}

/** An audio file dropped on the window while the dialog is open. */
export interface DroppedTake {
  file: File;
  nonce: number;
}

/** A track a take can go on. */
export interface RecordTarget {
  index: number;
  name: string;
  /** Strings take a guitar or bass take, pitched tracks (piano and the like) a piano take, drum tracks a drum take. */
  kind: "stringed" | "pitched" | "drums";
}

const NEW_TRACK = "new";

/** Megabytes of a download, rounded up to a whole number. */
const megabytes = (bytes: number) => Math.ceil(bytes / 1_000_000);

/** The small capitals above a group of controls. */
function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span
      id={id}
      className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase"
    >
      {children}
    </span>
  );
}

/** The crown of the choice that is on. */
function Crown({ className }: { className?: string }) {
  return (
    <img
      src={crown}
      alt=""
      aria-hidden="true"
      data-crown=""
      className={cn("pointer-events-none size-5 object-contain", className)}
    />
  );
}

/** The graffiti around the dialog: behind everything, never in the way, hidden from readers. */
function RecordArt() {
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
      <img src={hero} alt="" className="absolute top-1 right-2 hidden w-[41%] md:block" />
    </div>
  );
}

/**
 * An instrument to choose: a small button with its picture (which may reach out of the button)
 * and name, and a crown over the name when it is the one.
 */
const INSTRUMENT_BUTTON =
  "relative h-[54px] min-w-0 gap-1.5 rounded-lg border border-border bg-card px-1.5 pr-3 text-[15px] font-semibold hover:bg-card data-[state=on]:border-brand data-[state=on]:bg-card! data-[state=on]:text-foreground! data-[state=on]:shadow-[0_0_16px_color-mix(in_oklab,var(--brand)_60%,transparent)] data-[state=on]:ring-2 data-[state=on]:ring-brand/70 data-[state=on]:inset-ring-0";
/** A recording mode to choose: filled purple when it is the one. */
const MODE_BUTTON =
  "h-9 gap-2 rounded-md border border-border bg-card px-4 text-sm font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-[0_0_14px_color-mix(in_oklab,var(--primary)_55%,transparent)]";
/** One side of a joined button group: only the outer ends are round. */
const SEGMENT_BUTTON =
  "h-9 gap-1.5 border border-border bg-card px-5 text-sm font-semibold group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-md group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-md data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-[0_0_14px_color-mix(in_oklab,var(--primary)_55%,transparent)]";

function Field({ label, children, id }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Record to Tab: what to record and where it goes. Shows the level of the input chosen in
 * Settings while it is open, so the player can check that the instrument is heard.
 */
export function RecordDialog({
  open,
  onOpenChange,
  targets,
  defaultTrack,
  defaultBar,
  barCount,
  supported,
  onRecord,
  onRecordFile,
  droppedFile = null,
  pianoModel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The song's stringed and pitched tracks. */
  targets: readonly RecordTarget[];
  /** The track to record on (an index into the song's tracks), if it is one of `targets`. */
  defaultTrack: number | null;
  /** The bar of the edit cursor (0-based). */
  defaultBar: number;
  barCount: number;
  /** False in a plain browser: recording needs the desktop app. */
  supported: boolean;
  onRecord: (setup: RecordSetup) => void;
  /** Turns an existing recording into tab or staves, as a new song with this tuning. */
  onRecordFile: (
    file: File,
    tuning: number[],
    instrument: RecordInstrument,
    engine: RecordEngine,
  ) => void;
  droppedFile?: DroppedTake | null;
  /** The high-accuracy piano model. Without it, the dialog offers only the built-in one. */
  pianoModel?: PianoModel;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className="h-[min(48rem,calc(100dvh-2rem))] sm:max-w-4xl"
        data-tour="record-dialog"
      >
        {/* Mounted only while open: it starts from the defaults and remembered choices again. */}
        {open && (
          <RecordForm
            targets={targets}
            defaultTrack={defaultTrack}
            defaultBar={defaultBar}
            barCount={barCount}
            supported={supported}
            onCancel={() => onOpenChange(false)}
            onRecord={onRecord}
            onRecordFile={onRecordFile}
            droppedFile={droppedFile}
            pianoModel={pianoModel}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecordForm({
  targets,
  defaultTrack,
  defaultBar,
  barCount,
  supported,
  onCancel,
  onRecord,
  onRecordFile,
  droppedFile,
  pianoModel,
}: {
  targets: readonly RecordTarget[];
  defaultTrack: number | null;
  defaultBar: number;
  barCount: number;
  supported: boolean;
  onCancel: () => void;
  onRecord: (setup: RecordSetup) => void;
  onRecordFile: (
    file: File,
    tuning: number[],
    instrument: RecordInstrument,
    engine: RecordEngine,
  ) => void;
  droppedFile: DroppedTake | null;
  pianoModel: PianoModel | undefined;
}) {
  const ids = {
    track: useId(),
    bar: useId(),
    strings: useId(),
    tuning: useId(),
    others: useId(),
    align: useId(),
    engine: useId(),
    mode: useId(),
  };
  const [instrument, setInstrument] = useState<RecordInstrument>(readInstrument);
  const piano = instrument === "piano";
  const [chosenEngine, setEngine] = useState<PianoEngine>(readPianoEngine);
  // The choice only exists where the model can be looked up: the desktop app.
  const offersModel = piano && pianoModel?.ready === true;
  const pianoEngine: PianoEngine = offersModel ? chosenEngine : "standard";
  // The AI tab (MuScriptor, #150): offered in the desktop app, where the model status is known.
  const ai = useAiState();
  const offersAi = isEnabled("muscriptor-record") && ai.ready;
  const [chosenAi, setAi] = useState(readAiMode);
  const aiOn = offersAi && chosenAi;
  const aiReady = canRun(ai);
  const engine: RecordEngine = aiOn && aiReady ? "muscriptor" : pianoEngine;
  const needsAiModel = aiOn && !aiReady;
  const needsModel =
    needsAiModel || (!aiOn && offersModel && pianoEngine === "accurate" && !pianoModel.installed);
  useEffect(() => {
    void refreshAi();
  }, []);
  const [mode, setMode] = useState<Source>("click");
  const fromFile = mode === "file";
  const input = useAudioInput();
  // An existing recording needs no input.
  const heard = useInputLevel(!fromFile, input);
  const [chosenTrack, setTrack] = useState<string>(
    defaultTrack !== null && targets.some((t) => t.index === defaultTrack)
      ? String(defaultTrack)
      : targets[0]
        ? String(targets[0].index)
        : NEW_TRACK,
  );
  // Only the tracks that suit the instrument; the choice falls back when it was for the other one.
  const drums = instrument === "drums";
  const kind = drums ? "drums" : piano ? "pitched" : "stringed";
  const shown = targets.filter((t) => t.kind === kind);
  const track =
    chosenTrack === NEW_TRACK || shown.some((t) => String(t.index) === chosenTrack)
      ? chosenTrack
      : shown[0]
        ? String(shown[0].index)
        : NEW_TRACK;
  // Text, so that the field can be emptied while a number is typed.
  const [bar, setBar] = useState(
    String(Math.min(Math.max(defaultBar, 0), Math.max(barCount - 1, 0)) + 1),
  );
  const [playOthers, setPlayOthers] = useState(readPlayOthers);
  const [alignToBeat, setAlignToBeat] = useState(readAlignToBeat);
  const family = instrument === "bass" ? "bass" : "guitar";
  const [tunings, setTunings] = useState<Record<"guitar" | "bass", TuningChoice>>(() => ({
    guitar: readTuningChoice("guitar"),
    bass: readTuningChoice("bass"),
  }));
  const tuningChoice = tunings[family];
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");

  const chooseFile = (next: File | undefined) => {
    if (!next) return;
    if (!isTakeFile(next.name)) {
      setFileError("Choose an MP3, WAV, FLAC or OGG file.");
      return;
    }
    setFileError("");
    setFile(next);
    setMode("file");
  };
  // A file dropped on the window while the dialog is open.
  const seenDrop = useRef(droppedFile?.nonce ?? null);
  useEffect(() => {
    if (!droppedFile || droppedFile.nonce === seenDrop.current) return;
    seenDrop.current = droppedFile.nonce;
    chooseFile(droppedFile.file);
  }, [droppedFile]);

  const newTrack = mode === "click" && track === NEW_TRACK;
  const askTuning = !piano && !drums && (mode !== "click" || newTrack);
  const presets = tuningPresets(tuningChoice.strings);
  // The microphone of a laptop hears the click from its speakers.
  const builtIn = looksBuiltIn(input?.label ?? (heard.kind === "listening" ? heard.device : null));
  const level = heard.kind === "listening" ? heard.level : 0;

  const changeTuning = (next: TuningChoice) => {
    setTunings((all) => ({ ...all, [family]: next }));
    storeTuningChoice(next, family);
  };
  const changeInstrument = (value: RecordInstrument) => {
    setInstrument(value);
    storeInstrument(value);
  };
  const changeAi = (value: boolean) => {
    setAi(value);
    storeAiMode(value);
  };
  const changeEngine = (value: PianoEngine) => {
    setEngine(value);
    storePianoEngine(value);
  };
  const changeOthers = (value: boolean) => {
    setPlayOthers(value);
    storePlayOthers(value);
  };
  const changeAlign = (value: boolean) => {
    setAlignToBeat(value);
    storeAlignToBeat(value);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (fromFile) {
      if (file) onRecordFile(file, tuningOf(tuningChoice), instrument, engine);
      return;
    }
    onRecord({
      mode,
      track: mode === "click" && track !== NEW_TRACK ? Number(track) : null,
      startBar: Math.min(Math.max(Number.parseInt(bar, 10) || 1, 1), Math.max(barCount, 1)) - 1,
      playOthers,
      alignToBeat,
      tuning: tuningOf(tuningChoice),
      instrument,
      engine,
    });
  };

  const description = {
    click: "Play along with the click. Your take replaces the bars it covers on the track.",
    free: "Play freely. Smart Beat finds the tempo and opens your take as a new song.",
    file: `Choose a ${piano ? "piano" : drums ? "drum" : "guitar"} recording. Smart Beat finds the tempo and opens it as a new song.`,
  }[mode];

  const instruments = [
    { value: "guitar", label: "Guitar", icon: iconGuitar },
    { value: "bass", label: "Bass", icon: iconBass },
    { value: "piano", label: "Piano", icon: iconPiano },
    { value: "drums", label: "Drums", icon: iconDrums },
  ] as const;
  const modes = [
    { value: "click", label: "Click", icon: WandSparklesIcon },
    { value: "free", label: "Free", icon: AudioLinesIcon },
    { value: "file", label: "File", icon: FileAudioIcon },
  ] as const;

  // The click is heard in a recording unless the player wears headphones, which we cannot tell.
  // The warning stays until the input is known to be an interface or another outside microphone.
  // The system's default input may be anything, and a hidden name says nothing: only an input
  // that was picked by name and is not a built-in microphone is taken to be an outside one.
  const showHeadphones = mode === "click" && (!input?.label || builtIn);

  return (
    <form onSubmit={submit} className="relative isolate flex min-h-0 flex-1 flex-col">
      <RecordArt />
      <DialogHeader className="px-6 md:px-10 md:pr-[48%]">
        <DialogTitle className="-mt-2 -mb-3 flex items-center">
          <img
            src={logo}
            alt=""
            aria-hidden="true"
            className="-ml-[4%] w-[270px] max-w-[70%] shrink-0 sm:w-[320px]"
          />
          <span className="sr-only">Record to Tab</span>
          <img
            src={betaBadge}
            alt="Beta"
            className="mt-3 -mr-8 -ml-6 w-[104px] shrink-0 sm:-ml-9 sm:w-[120px]"
          />
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <p role="note" className="text-sm text-muted-foreground" data-tour="record-limits">
          {aiOn
            ? `Beta. AI mode: MuScriptor by Kyutai and Mirelo listens for ${instrument === "drums" ? "drum hits" : `the ${instrument}`} on this computer. Non-commercial use only, and only on music you have the rights to. Review the result and correct it.`
            : recordToTabBetaNote(instrument, pianoEngine)}
        </p>
      </DialogHeader>
      <DialogBody className="gap-3 px-6 pb-6 md:px-10">
        <Tabs
          value={aiOn ? "ai" : "default"}
          onValueChange={(value) => changeAi(value === "ai")}
          className="gap-3"
        >
          <TabsContent
            value={aiOn ? "ai" : "default"}
            className="flex flex-col gap-3 overflow-visible"
          >
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
              <ToggleGroup
                type="single"
                variant="default"
                spacing={2}
                aria-label="Instrument"
                data-tour="record-instrument"
                value={instrument}
                onValueChange={(value) => value && changeInstrument(value as RecordInstrument)}
                className="flex-wrap gap-2.5 pt-2"
              >
                {instruments.map(({ value, label, icon }) => (
                  <ToggleGroupItem key={value} value={value} className={INSTRUMENT_BUTTON}>
                    <img
                      src={icon}
                      alt=""
                      aria-hidden="true"
                      className="-mt-2 -mb-1 size-[58px] shrink-0 object-contain"
                    />
                    <span className="relative flex flex-col items-center justify-end self-stretch pt-4 pb-3">
                      {instrument === value && (
                        <Crown className="absolute top-0.5 left-1/2 size-6 -translate-x-1/2" />
                      )}
                      {label}
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {offersAi && (
                <TabsList
                  aria-label="Transcription engine"
                  data-tour="record-ai-tabs"
                  className="w-44 shrink-0 self-end sm:mb-1"
                >
                  <TabsTrigger value="default">Default</TabsTrigger>
                  <TabsTrigger value="ai">AI</TabsTrigger>
                </TabsList>
              )}
            </div>

            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-[1fr_1px_1fr]">
              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-2" data-tour="record-mode">
                  <SectionLabel id={ids.mode}>Recording mode</SectionLabel>
                  <ToggleGroup
                    type="single"
                    variant="default"
                    spacing={2}
                    aria-labelledby={ids.mode}
                    value={mode}
                    onValueChange={(value) => value && setMode(value as Source)}
                    className="self-start"
                  >
                    {modes.map(({ value, label, icon: Icon }) => (
                      <ToggleGroupItem key={value} value={value} className={MODE_BUTTON}>
                        <Icon aria-hidden="true" />
                        {label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                {fromFile ? (
                  <AudioDropArea
                    extensions={TAKE_FILE_EXTENSIONS}
                    disabled={!supported}
                    chosen={file !== null}
                    onFile={chooseFile}
                  >
                    {file && (
                      <p className="mt-3 flex items-center gap-2 text-sm">
                        <AudioLinesIcon className="size-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">{file.name}</span>
                      </p>
                    )}
                    {fileError && (
                      <p role="alert" className="mt-3 text-sm text-destructive">
                        {fileError}
                      </p>
                    )}
                  </AudioDropArea>
                ) : (
                  <>
                    <AudioInputSetting stacked />
                    <div className="flex flex-col gap-1.5">
                      <LiveWaveform level={level} className="h-9" />
                      {heard.kind === "asking" && (
                        <p role="status" className="text-sm text-muted-foreground">
                          Asking for the microphone…
                        </p>
                      )}
                      {heard.kind === "blocked" && (
                        <p
                          role="alert"
                          className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
                        >
                          {heard.message}
                        </p>
                      )}
                    </div>
                    {showHeadphones && (
                      <div className="relative px-6 py-1">
                        {/* The rays sit outside the box, one set on each side. */}
                        <img
                          src={sparklesLeft}
                          alt=""
                          aria-hidden="true"
                          data-sparkles=""
                          className="pointer-events-none absolute top-1/2 left-0 h-9 w-auto -translate-y-1/2"
                        />
                        <img
                          src={sparklesRight}
                          alt=""
                          aria-hidden="true"
                          data-sparkles=""
                          className="pointer-events-none absolute top-1/2 right-0 h-9 w-auto -translate-y-1/2"
                        />
                        <p
                          role="note"
                          className="flex items-center gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-2 text-[15px] text-amber-950 dark:bg-amber-950/80 dark:text-amber-100"
                        >
                          <HeadphonesIcon
                            className="size-6 shrink-0 text-amber-500"
                            aria-hidden="true"
                          />
                          <span>Use headphones, or the click will be heard in the recording.</span>
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div aria-hidden="true" className="hidden bg-border sm:block" data-divider="" />

              <div className="flex min-w-0 flex-col gap-4 sm:pb-14" data-tour="record-track">
                {mode === "click" && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-[1fr_6rem]">
                      <Field label="Track" id={ids.track}>
                        <Select value={track} onValueChange={setTrack}>
                          <SelectTrigger id={ids.track} className="w-full rounded-md">
                            <Music2Icon
                              className="size-5 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {shown.map((target) => (
                              <SelectItem key={target.index} value={String(target.index)}>
                                {target.name}
                              </SelectItem>
                            ))}
                            <SelectItem value={NEW_TRACK}>New track</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Start bar" id={ids.bar}>
                        <Input
                          id={ids.bar}
                          className="rounded-md"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={Math.max(barCount, 1)}
                          value={bar}
                          onChange={(event) => setBar(event.target.value)}
                        />
                      </Field>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={ids.others}
                        checked={playOthers}
                        onCheckedChange={(checked) => changeOthers(checked === true)}
                      />
                      <label htmlFor={ids.others} className="text-sm">
                        Play other tracks
                      </label>
                    </div>
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id={ids.align}
                        checked={alignToBeat}
                        onCheckedChange={(checked) => changeAlign(checked === true)}
                        className="mt-0.5"
                      />
                      <label htmlFor={ids.align} className="text-sm">
                        Line up with the beat
                        <span className="block text-muted-foreground">
                          Moves the take by up to 80 ms. Turn off if you play behind or ahead of the
                          beat on purpose.
                        </span>
                      </label>
                    </div>
                  </>
                )}

                {aiOn && (
                  <div className="flex flex-col gap-3" data-tour="record-ai">
                    <SectionLabel>AI model</SectionLabel>
                    {aiReady ? (
                      <>
                        <ToggleGroup
                          type="single"
                          variant="outline"
                          spacing={0}
                          aria-label="AI model size"
                          value={ai.size}
                          onValueChange={(value) => value && chooseSize(value as MuscriptorSize)}
                          className="self-start"
                        >
                          {ai.status?.sizes
                            .filter((entry) => entry.installed)
                            .map((entry) => (
                              <ToggleGroupItem
                                key={entry.size}
                                value={entry.size}
                                className={SEGMENT_BUTTON}
                              >
                                {sizeInfo(entry.size).label}
                                {ai.size === entry.size && <Crown />}
                              </ToggleGroupItem>
                            ))}
                        </ToggleGroup>
                        <p className="text-sm text-muted-foreground">
                          Runs MuScriptor by Kyutai and Mirelo on this computer. Finds several
                          instruments and drum hits; the instrument you picked limits what it
                          listens for.
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="self-start"
                          onClick={() => {
                            onCancel();
                            openInstaller("record");
                          }}
                        >
                          <DownloadIcon data-icon="inline-start" />
                          Add another size
                        </Button>
                      </>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm">
                          The AI mode uses MuScriptor by Kyutai and Mirelo, a model you download
                          once ({sizeInfo(ai.size).megabytes} MB for {sizeInfo(ai.size).label}). A
                          guided setup walks you through the terms and brings you back here. Your
                          recordings are never uploaded.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="self-start"
                          onClick={() => {
                            onCancel();
                            openInstaller("record");
                          }}
                        >
                          <DownloadIcon data-icon="inline-start" />
                          Download MuScriptor
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {!aiOn && offersModel && (
                  <div className="flex flex-col gap-2" data-tour="record-piano-model">
                    <SectionLabel id={ids.engine}>Piano model</SectionLabel>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      spacing={0}
                      aria-labelledby={ids.engine}
                      value={engine}
                      onValueChange={(value) => value && changeEngine(value as PianoEngine)}
                      className="self-start"
                    >
                      <ToggleGroupItem value="standard" className={SEGMENT_BUTTON}>
                        Standard
                        {engine === "standard" && <Crown />}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="accurate" className={SEGMENT_BUTTON}>
                        High accuracy
                        {engine === "accurate" && <Crown />}
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <p className="text-sm text-muted-foreground">
                      {engine === "standard"
                        ? "Built in and fast. Finds most notes."
                        : "Finds nearly every note. Runs on this computer, but takes about half as long as the recording."}
                    </p>
                    {needsModel && (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm">
                          The model is a one-time download of {megabytes(pianoModel.bytes)} MB. Your
                          recordings are never uploaded.
                        </p>
                        {pianoModel.progress === null ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="self-start"
                            onClick={pianoModel.download}
                          >
                            <DownloadIcon data-icon="inline-start" />
                            Download the model
                          </Button>
                        ) : (
                          <p role="status" className="text-sm">
                            Downloading… {Math.round(pianoModel.progress * 100)}%
                          </p>
                        )}
                        {pianoModel.error && (
                          <p role="alert" className="text-sm text-destructive">
                            {pianoModel.error}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {askTuning && (
                  <div className="grid grid-cols-[7rem_1fr] gap-4">
                    <Field label="Strings" id={ids.strings}>
                      <Select
                        key={family}
                        value={String(tuningChoice.strings)}
                        onValueChange={(value) => changeTuning(standardTuningChoice(Number(value)))}
                      >
                        <SelectTrigger id={ids.strings} className="w-full rounded-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(family === "bass"
                            ? RECORD_BASS_STRING_COUNTS
                            : RECORD_STRING_COUNTS
                          ).map((count) => (
                            <SelectItem key={count} value={String(count)}>
                              {count} strings
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Tuning" id={ids.tuning}>
                      <Select
                        key={`${family}-${tuningChoice.strings}`}
                        value={tuningChoice.name}
                        onValueChange={(name) =>
                          name && changeTuning({ strings: tuningChoice.strings, name })
                        }
                      >
                        <SelectTrigger id={ids.tuning} className="w-full rounded-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {presets.map((preset) => (
                            <SelectItem key={preset.name} value={preset.name}>
                              {preset.name} (
                              {preset.tuning.map((p) => pitchName(p, { octave: false })).join(" ")})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                )}
              </div>
            </div>

            {!supported && (
              <p role="status" className="text-sm text-muted-foreground">
                Record to Tab needs the Smart Beat desktop app.
              </p>
            )}
          </TabsContent>
        </Tabs>
      </DialogBody>
      <DialogFooter
        data-tour="record-start"
        className="mt-0 border-t-0 bg-transparent px-6 pt-2 sm:absolute sm:right-10 sm:bottom-5 sm:p-0"
      >
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10 rounded-lg bg-card px-6"
          onClick={onCancel}
        >
          Cancel
        </Button>
        {fromFile ? (
          <Button type="submit" size="lg" disabled={!supported || file === null || needsModel}>
            <AudioLinesIcon data-icon="inline-start" />
            Make tab
          </Button>
        ) : (
          <Button
            type="submit"
            size="lg"
            className="h-10 rounded-xl px-7 text-base shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_60%,transparent)] ring-[3px] ring-black"
            disabled={!supported || heard.kind === "blocked" || needsModel}
          >
            <CircleIcon data-icon="inline-start" className="fill-red-500 text-red-500" />
            Record
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
