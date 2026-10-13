import { AudioLinesIcon, CircleIcon, DownloadIcon, HeadphonesIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { AudioInputSetting } from "@/components/audio-input-setting";
import { AudioDropArea } from "@/components/audio/audio-drop-area";
import { LiveWaveform } from "@/components/audio/live-waveform";
import { BetaBadge } from "@/components/beta-badge";
import { RECORD_TO_TAB_BETA_NOTE } from "@/components/record-to-tab-notes";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useInputLevel } from "@/hooks/use-input-level";
import type { PianoModel } from "@/hooks/use-piano-model";
import { isTakeFile, TAKE_FILE_EXTENSIONS } from "@/lib/audio/decode-take";
import { looksBuiltIn, useAudioInput } from "@/lib/audio/input";
import {
  RECORD_STRING_COUNTS,
  readAlignToBeat,
  readInstrument,
  readPianoEngine,
  readPlayOthers,
  readTuningChoice,
  standardTuningChoice,
  storeAlignToBeat,
  storeInstrument,
  storePianoEngine,
  storePlayOthers,
  storeTuningChoice,
  tuningOf,
  type PianoEngine,
  type RecordInstrument,
  type TuningChoice,
} from "@/lib/audio/record-prefs";
import { pitchName, tuningPresets } from "@/lib/score/music";

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
  /** A piano: the built-in note finder, or the downloaded high-accuracy model. */
  engine: PianoEngine;
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
  /** Strings take a guitar or bass take, pitched tracks (piano and the like) a piano take. */
  kind: "stringed" | "pitched";
}

const NEW_TRACK = "new";

/** Megabytes of a download, rounded up to a whole number. */
const megabytes = (bytes: number) => Math.ceil(bytes / 1_000_000);

function Field({ label, children, id }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
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
    engine: PianoEngine,
  ) => void;
  droppedFile?: DroppedTake | null;
  /** The high-accuracy piano model. Without it, the dialog offers only the built-in one. */
  pianoModel?: PianoModel;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
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
    engine: PianoEngine,
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
  };
  const [instrument, setInstrument] = useState<RecordInstrument>(readInstrument);
  const piano = instrument === "piano";
  const [chosenEngine, setEngine] = useState<PianoEngine>(readPianoEngine);
  // The choice only exists where the model can be looked up: the desktop app.
  const offersModel = piano && pianoModel?.ready === true;
  const engine: PianoEngine = offersModel ? chosenEngine : "standard";
  const needsModel = offersModel && engine === "accurate" && !pianoModel.installed;
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
  const kind = piano ? "pitched" : "stringed";
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
  const [tuningChoice, setTuningChoice] = useState<TuningChoice>(readTuningChoice);
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
  const askTuning = !piano && (mode !== "click" || newTrack);
  const presets = tuningPresets(tuningChoice.strings);
  // The microphone of a laptop hears the click from its speakers.
  const builtIn = looksBuiltIn(input?.label ?? (heard.kind === "listening" ? heard.device : null));
  const level = heard.kind === "listening" ? heard.level : 0;

  const changeTuning = (next: TuningChoice) => {
    setTuningChoice(next);
    storeTuningChoice(next);
  };
  const changeInstrument = (value: RecordInstrument) => {
    setInstrument(value);
    storeInstrument(value);
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
    file: `Choose a ${piano ? "piano" : "guitar"} recording. Smart Beat finds the tempo and opens it as a new song.`,
  }[mode];

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          Record to Tab
          <BetaBadge />
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <p role="note" className="text-sm text-muted-foreground">
          {RECORD_TO_TAB_BETA_NOTE}
        </p>
      </DialogHeader>
      <DialogBody>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Instrument"
          value={instrument}
          onValueChange={(value) => value && changeInstrument(value as RecordInstrument)}
          className="self-start"
        >
          <ToggleGroupItem value="guitar">Guitar or bass</ToggleGroupItem>
          <ToggleGroupItem value="piano">Piano</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Mode"
          value={mode}
          onValueChange={(value) => value && setMode(value as Source)}
          className="self-start"
        >
          <ToggleGroupItem value="click">Click</ToggleGroupItem>
          <ToggleGroupItem value="free">Free</ToggleGroupItem>
          <ToggleGroupItem value="file">File</ToggleGroupItem>
        </ToggleGroup>

        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
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
                <AudioInputSetting />
                <div className="flex flex-col gap-1.5">
                  <LiveWaveform level={level} />
                  <p role="status" className="min-h-5 text-sm text-muted-foreground">
                    {heard.kind === "asking" && "Asking for the microphone…"}
                    {heard.kind === "listening" && "Play a few notes to check the level."}
                  </p>
                  {heard.kind === "blocked" && (
                    <p
                      role="alert"
                      className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-sm"
                    >
                      {heard.message}
                    </p>
                  )}
                </div>
                {builtIn && (
                  <p
                    role="note"
                    className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
                  >
                    <HeadphonesIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>Use headphones, or the click will be heard in the recording.</span>
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {mode === "click" && (
              <>
                <div className="grid gap-4 sm:grid-cols-[1fr_6rem]">
                  <Field label="Track" id={ids.track}>
                    <Select value={track} onValueChange={setTrack}>
                      <SelectTrigger id={ids.track} className="w-full">
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

            {offersModel && (
              <div className="flex flex-col gap-2">
                <span id={ids.engine} className="text-sm font-medium">
                  Piano model
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-labelledby={ids.engine}
                  value={engine}
                  onValueChange={(value) => value && changeEngine(value as PianoEngine)}
                  className="self-start"
                >
                  <ToggleGroupItem value="standard">Standard</ToggleGroupItem>
                  <ToggleGroupItem value="accurate">High accuracy</ToggleGroupItem>
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
                    value={String(tuningChoice.strings)}
                    onValueChange={(value) => changeTuning(standardTuningChoice(Number(value)))}
                  >
                    <SelectTrigger id={ids.strings} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RECORD_STRING_COUNTS.map((count) => (
                        <SelectItem key={count} value={String(count)}>
                          {count} strings
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Tuning" id={ids.tuning}>
                  <Select
                    value={tuningChoice.name}
                    onValueChange={(name) => changeTuning({ strings: tuningChoice.strings, name })}
                  >
                    <SelectTrigger id={ids.tuning} className="w-full">
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
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {fromFile ? (
          <Button type="submit" disabled={!supported || file === null || needsModel}>
            <AudioLinesIcon data-icon="inline-start" />
            Make tab
          </Button>
        ) : (
          <Button type="submit" disabled={!supported || heard.kind === "blocked" || needsModel}>
            <CircleIcon data-icon="inline-start" className="fill-current text-destructive" />
            Record
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}
