import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  InfoIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/telemetry";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ExternalLink } from "@/components/external-link";
import { InstrumentSelect } from "@/components/audio/instrument-select";
import { DIALOG_NEON, DialogArt, DialogLogo, DialogStepper } from "@/components/ai/dialog-art";
import logo from "@/assets/import-audio/logo.webp";
import heroSelect from "@/assets/import-audio/hero.webp";
import heroAbout from "@/assets/ai-installer/hero-about.webp";
import heroModel from "@/assets/ai-installer/hero-model.webp";
import { cn } from "@/lib/utils";
import { MUSCRIPTOR } from "@/lib/credits";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TranscriptionPreview } from "./transcription-preview";
import { AI_DIALOG_FRAME } from "@/components/ai/dialog-frame";
import {
  canRun,
  chooseSize,
  isInstalled,
  openInstaller,
  refreshAi,
  rightsDetail,
  useAiState,
} from "@/lib/ai/ai-store";
import { SIZES, sizeInfo } from "@/lib/ai/muscriptor-sizes";
import {
  validateAudio,
  type AudioTranscriptionProvider,
  type TranscriptionProgress,
  type TranscriptionResult,
} from "@/lib/audio-transcription/provider";
import { audioDurationMs } from "@/lib/audio-transcription/duration";
import { errorText } from "@/lib/errors";
import type { MuscriptorSize } from "@/lib/tauri";

export interface DroppedRecording {
  file?: File;
  path?: string;
  nonce: number;
}
type Phase = "select" | "transcribing" | "complete";
const STEP_LABELS = ["Upload", "Transcribe", "Preview"] as const;
/** Before the model is on this computer, the download is a step of its own, numbered 0. */
const DOWNLOAD_STEP = "Download MuScriptor";
const STEP_OF: Record<Phase, number> = { select: 0, transcribing: 1, complete: 2 };
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const durationText = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function AudioTranscriptionDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  provider,
  droppedRecording,
  onImport,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  provider: AudioTranscriptionProvider;
  droppedRecording?: DroppedRecording | null;
  onImport: (midi: Uint8Array<ArrayBuffer>, name: string) => Promise<void>;
  onSave: (midi: Uint8Array<ArrayBuffer>, name: string) => Promise<void>;
}) {
  const seenDrop = useRef<number | null>(null);
  // Counts recording choices. A dropped file that finishes reading after a newer choice,
  // or after Transcribe, is stale and never replaces the recording.
  const choice = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [measured, setMeasured] = useState<{ file: File; ms: number } | null>(null);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [phase, setPhase] = useState<Phase>("select");
  const [error, setError] = useState("");
  // null while the dialog asks whether this build can transcribe.
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [progress, setProgress] = useState<TranscriptionProgress | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const ai = useAiState();
  // The model is downloaded and the terms are accepted; until then the dialog offers the download.
  const ready = canRun(ai);
  const needsModel = configured === true && ai.ready && !ready;
  const busy = phase === "transcribing";
  const locked = busy || phase === "complete" || saving || importing;

  useEffect(() => {
    if (!open) return;
    void refreshAi();
    let alive = true;
    provider.configured().then(
      (access) => {
        if (alive) setConfigured(access);
      },
      (cause) => {
        if (alive) {
          setConfigured(false);
          setError(errorText(cause));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [open, provider]);
  useEffect(() => () => operation.current?.abort(), []);
  // Shows the duration before upload. A file the webview cannot measure fails
  // when it is transcribed instead, with the reason.
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    audioDurationMs(file, controller.signal).then(
      (ms) => setMeasured({ file, ms }),
      () => {},
    );
    return () => controller.abort();
  }, [file]);
  useEffect(() => {
    if (!open || !droppedRecording || locked || seenDrop.current === droppedRecording.nonce) return;
    seenDrop.current = droppedRecording.nonce;
    let alive = true;
    const token = ++choice.current;
    const current = () => alive && token === choice.current;
    const read = droppedRecording.file
      ? Promise.resolve(droppedRecording.file)
      : provider.readFile(droppedRecording.path!);
    read
      .then((next) => {
        if (current()) {
          validateAudio(next, provider);
          setFile(next);
          setError("");
          setPhase("select");
        }
      })
      .catch((cause) => {
        if (current()) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
    // Only a new drop selects a recording, never a later phase transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedRecording, open, provider]);

  const choose = (next?: File) => {
    if (!next || locked) return;
    choice.current++;
    try {
      validateAudio(next, provider);
      setFile(next);
      setError("");
      setPhase("select");
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const options = () => {
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    // Every way to stop aborts: Cancel, Close, another dialog, unmounting. The dialog then
    // shows the recording again.
    controller.signal.addEventListener("abort", () =>
      setPhase((current) => (current === "transcribing" ? "select" : current)),
    );
    return {
      signal: controller.signal,
      onProgress: (next: TranscriptionProgress) => {
        if (!controller.signal.aborted) setProgress(next);
      },
    };
  };
  const transcribe = async () => {
    if (!file || busy) return;
    choice.current++;
    const opts = options();
    setError("");
    setPhase("transcribing");
    setProgress({ phase: "processing", message: "Reading recording…" });
    // Counted at every start, with whether the rights confirmation is on file (#150).
    track("ai_transcribe_file", rightsDetail());
    try {
      const next = await provider.transcribe(file, selected, opts);
      if (!opts.signal.aborted) {
        track("audio_transcribe");
        setResult(next);
        setPhase("complete");
      }
    } catch (cause) {
      if (!opts.signal.aborted) {
        setPhase("select");
        setError(errorText(cause));
      }
    }
  };
  const cancel = () => operation.current?.abort();
  const close = () => {
    if (saving || importing) return;
    onOpenChange(false);
  };
  // Close, Escape and another dialog opened from the native menu all hide this one. Hiding
  // it stops the transcription.
  useEffect(() => {
    if (!open) operation.current?.abort();
  }, [open]);
  // Edit and Back: the recording and the chosen instruments stay, the result goes.
  const backToUpload = () => {
    setResult(null);
    setError("");
    setPhase("select");
  };
  const reset = () => {
    setFile(null);
    setResult(null);
    setSelected([]);
    setPhase("select");
    setError("");
  };
  const shownDuration = measured?.file === file ? measured.ms : null;
  const name = `${file?.name.replace(/\.[^.]+$/, "") || "Transcription"}.mid`;
  const importMidi = async () => {
    if (!result) return;
    setImporting(true);
    setError("");
    try {
      await onImport(result.midi, name);
      reset();
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setImporting(false);
    }
  };
  const saveMidi = async () => {
    if (!result) return;
    setSaving(true);
    setError("");
    try {
      await onSave(result.midi, name);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  const hero = needsModel
    ? { src: heroAbout, place: "top-[22%] right-3 w-[24%]" }
    : phase === "select"
      ? { src: heroSelect, place: "top-[23%] right-5 w-[14%]" }
      : phase === "transcribing"
        ? { src: heroModel, place: "top-[20%] right-2 w-[24%]" }
        : null;
  const phaseTitle = needsModel
    ? "Install MuScriptor to use Import from Audio"
    : phase === "transcribing"
      ? "Transcribing your audio…"
      : "Import from Audio";
  const description = needsModel
    ? "Import from Audio runs MuScriptor, an AI model, on this computer. Download it once; a guided setup walks you through the terms."
    : phase === "transcribing"
      ? `${provider.name} is analyzing your recording and generating MIDI. This may take a few minutes.`
      : phase === "complete"
        ? "Listen to the result and adjust instruments before importing into Smart Beat."
        : `Transcribe a recording with ${provider.name}, preview the generated MIDI, then open it in Smart Beat.`;
  const busyAction = saving || importing;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        size="xl"
        className={cn(AI_DIALOG_FRAME, DIALOG_NEON, "h-[min(46rem,calc(100dvh-2rem))]")}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <DialogArt hero={hero} name={needsModel ? "needs-model" : phase} />
          <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
            <DialogLogo src={logo} />
            <DialogStepper
              labels={needsModel ? [DOWNLOAD_STEP, ...STEP_LABELS] : STEP_LABELS}
              current={needsModel ? 0 : STEP_OF[phase]}
              start={needsModel ? 0 : 1}
            />
            {/* The accessible name stays "Import from Audio" in every phase. */}
            <DialogTitle className="sr-only">Import from Audio</DialogTitle>
            {phase !== "complete" && (
              <h2 aria-hidden="true" className="text-2xl font-bold">
                {phaseTitle}
              </h2>
            )}
            <DialogDescription className={cn(phase === "complete" ? "sr-only" : "md:pr-[20%]")}>
              {description}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="px-6 pb-4 md:px-9">
            <div className="flex flex-col gap-5">
              {needsModel && (
                <NeedsModel
                  size={ai.size}
                  onDownload={() => {
                    onOpenChange(false);
                    openInstaller("audio");
                  }}
                />
              )}
              {configured === true && ai.unsupported && (
                <p className="text-sm text-muted-foreground" data-testid="audio-unsupported">
                  Audio transcription with MuScriptor is not available on this platform yet.
                </p>
              )}
              {configured === false && (
                <p className="text-sm text-muted-foreground">
                  Audio transcription is available in the desktop app.
                </p>
              )}
              {!needsModel && phase === "select" && (
                <>
                  <div className="flex gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm">
                    <InfoIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                    <div>
                      <p>{provider.privacy}</p>
                      <p className="mt-1 text-muted-foreground">
                        Limit: {provider.maxBytes / 1024 / 1024} MiB and{" "}
                        {provider.maxDurationMs / 60_000} minutes. {provider.credit} Non-commercial
                        use only, and only on music you have the rights to.
                      </p>
                    </div>
                  </div>
                  <RecordingDropzone
                    extensions={provider.extensions}
                    disabled={locked}
                    file={file}
                    duration={shownDuration}
                    onFile={choose}
                    onRemove={() => {
                      choice.current++;
                      setFile(null);
                      setError("");
                      setPhase("select");
                    }}
                  />
                  {file && (
                    <div className="flex flex-col gap-1.5">
                      <span id="expected-instruments" className="text-sm font-medium">
                        Expected instruments (optional)
                      </span>
                      <InstrumentSelect
                        aria-describedby="expected-instruments-hint"
                        instruments={provider.instruments}
                        value={selected}
                        onChange={setSelected}
                        disabled={locked}
                      />
                      <p id="expected-instruments-hint" className="text-xs text-muted-foreground">
                        Leave empty for automatic detection. Specify every instrument playing. The
                        list restricts the output and may improve consistency; missing instruments
                        may be omitted.
                      </p>
                    </div>
                  )}
                  {file && (
                    <div className="flex flex-col gap-1.5">
                      <span id="model-size-label" className="text-sm font-medium">
                        Model
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={ai.size}
                          onValueChange={(next) => chooseSize(next as MuscriptorSize)}
                          disabled={locked}
                        >
                          <SelectTrigger
                            aria-labelledby="model-size-label"
                            className="h-9 min-w-64 flex-1 sm:flex-none"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SIZES.map((row) => {
                              const here = isInstalled(ai, row.size);
                              return (
                                <SelectItem key={row.size} value={row.size} disabled={!here}>
                                  {row.label} · {row.megabytes} MB · {row.gpuFactor}×
                                  {here ? "" : " (not downloaded)"}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={locked}
                          onClick={() => {
                            onOpenChange(false);
                            openInstaller("audio");
                          }}
                        >
                          Download or manage models…
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        A smaller model is faster, a larger one is more accurate. The installer
                        brings you back here when you close it.
                      </p>
                    </div>
                  )}
                </>
              )}
              {busy && <Progress file={file} duration={shownDuration} progress={progress} />}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {phase === "complete" && result && (
                <TranscriptionPreview
                  result={result}
                  active={open}
                  file={file}
                  onEdit={backToUpload}
                />
              )}
            </div>
          </DialogBody>
          <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-2 pb-5 sm:justify-between md:px-9">
            {phase === "complete" ? (
              <>
                <Button
                  variant="outline"
                  size="lg"
                  className="bg-card"
                  disabled={busyAction}
                  onClick={backToUpload}
                >
                  <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
                  Back
                </Button>
                <div className="contents sm:flex sm:gap-2">
                  <Button
                    variant="outline"
                    size="lg"
                    className="bg-card"
                    disabled={busyAction}
                    onClick={() => void saveMidi()}
                  >
                    {saving ? "Saving…" : "Save MIDI As…"}
                  </Button>
                  <Button size="lg" disabled={busyAction} onClick={() => void importMidi()}>
                    {importing ? "Importing…" : "Import MIDI into Smart Beat"}
                    <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                  </Button>
                </div>
              </>
            ) : busy ? (
              <Button variant="outline" size="lg" className="bg-card" onClick={cancel}>
                <SquareIcon aria-hidden="true" data-icon="inline-start" className="fill-current" />
                Cancel transcription
              </Button>
            ) : (
              <>
                <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={close}>
                  Close
                </Button>
                {!needsModel && (
                  <Button
                    size="lg"
                    className="min-w-44"
                    disabled={!file || !configured || !ready || ai.unsupported}
                    onClick={() => void transcribe()}
                  >
                    Transcribe
                    <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The model is not on this computer: what it is, what it costs, and where to read more. */
function NeedsModel({ size, onDownload }: { size: MuscriptorSize; onDownload: () => void }) {
  const info = sizeInfo(size);
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="audio-needs-model">
      <div className="flex flex-col items-start gap-2 md:max-w-[62%]">
        <Button size="lg" onClick={onDownload}>
          Download MuScriptor
        </Button>
        <p className="text-muted-foreground">
          {info.label} model, about {info.megabytes} MB, downloaded once. Your recordings never
          leave this computer.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card/60">
        <table className="w-full text-left">
          <caption className="px-3 pt-2 text-left font-semibold">
            Model sizes and performance
          </caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Model
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Download
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Speed
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Memory
              </th>
            </tr>
          </thead>
          <tbody>
            {SIZES.map((row) => (
              <tr
                key={row.size}
                data-selected={row.size === size}
                className={cn("border-t", row.size === size && "bg-primary/15 font-semibold")}
              >
                <th scope="row" className="px-3 py-1.5 text-left font-[inherit]">
                  {row.label}
                  {row.size === size && <span className="sr-only"> (selected)</span>}
                </th>
                <td className="px-3 py-1.5">{row.megabytes} MB</td>
                <td className="px-3 py-1.5">{row.gpuFactor}×</td>
                <td className="px-3 py-1.5">{row.ramGb} GB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section
        className="rounded-xl border bg-card/60 px-4 py-3"
        aria-label="Learn more about MuScriptor"
      >
        <p className="mb-2 font-semibold">Learn more about MuScriptor</p>
        <ul className="flex flex-wrap gap-2">
          {MUSCRIPTOR.links.map((link) => (
            <li key={link.url}>
              <ExternalLink
                href={link.url}
                className="inline-flex rounded-md border bg-card px-2.5 py-1 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {link.label}
              </ExternalLink>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Where the recording is chosen or dropped. A chosen one shows as a card to play or remove. */
function RecordingDropzone({
  extensions,
  disabled,
  file,
  duration,
  onFile,
  onRemove,
}: {
  extensions: readonly string[];
  disabled: boolean;
  file: File | null;
  duration: number | null;
  onFile: (file: File | undefined) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // A new recording, or leaving the step, silences the old one.
  useEffect(
    () => () => {
      audio.current?.pause();
      if (audio.current) URL.revokeObjectURL(audio.current.src);
      audio.current = null;
      setPlaying(false);
    },
    [file],
  );
  const toggle = () => {
    if (!file) return;
    try {
      if (!audio.current) {
        audio.current = new Audio(URL.createObjectURL(file));
        audio.current.onended = () => setPlaying(false);
      }
      if (playing) {
        audio.current.pause();
        setPlaying(false);
      } else {
        void audio.current.play()?.catch(() => setPlaying(false));
        setPlaying(true);
      }
    } catch {
      setPlaying(false);
    }
  };
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) onFile(event.dataTransfer.files[0]);
  };
  return (
    // The whole box takes a dropped file; the button below is the keyboard way in.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="region"
      aria-label="Audio drop area"
      onDragOver={(event) => event.preventDefault()}
      onDrop={drop}
      className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/50 bg-card/40 p-4"
    >
      <p className="text-sm text-muted-foreground">
        Drop an audio file here, or browse. {extensions.join(", ").toUpperCase()}.
      </p>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label="Choose an audio recording"
        accept={extensions.map((ext) => `.${ext}`).join(",")}
        disabled={disabled}
        onChange={(event) => {
          onFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {file && (
        <div className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
          <Button
            variant="outline"
            size="icon"
            aria-label={playing ? "Pause recording" : "Play recording"}
            onClick={toggle}
          >
            {playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-muted-foreground">
              {megabytes(file.size)}
              {duration ? ` · ${durationText(duration)}` : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label="Remove recording"
            onClick={onRemove}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
      >
        {file ? "Replace recording…" : "Choose recording…"}
      </Button>
    </div>
  );
}

/** What the transcription is doing: three honest stages and a card with the progress. */
function Progress({
  file,
  duration,
  progress,
}: {
  file: File | null;
  duration: number | null;
  progress: TranscriptionProgress | null;
}) {
  const percent = typeof progress?.percent === "number" ? Math.round(progress.percent) : null;
  const stages = [
    {
      name: "Recording read",
      detail: file
        ? `${file.name} (${megabytes(file.size)}${duration ? ` · ${durationText(duration)}` : ""})`
        : "",
      state: "done",
    },
    {
      name: "Transcribing with MuScriptor",
      detail: progress?.message ?? "Starting…",
      state: "active",
    },
    { name: "Building the preview", detail: "Almost there…", state: "pending" },
  ] as const;
  const stateText = { done: " (done)", active: " (in progress)", pending: "" } as const;
  return (
    <div role="status" className="flex flex-col gap-4 text-sm">
      <ol className="flex flex-col gap-3 md:pr-[28%]">
        {stages.map((stage) => (
          <li key={stage.name} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                stage.state === "done" && "border-primary bg-primary text-primary-foreground",
                stage.state === "active" && "animate-pulse border-primary",
                stage.state === "pending" && "border-border",
              )}
            >
              {stage.state === "done" && <CheckIcon className="size-3.5" />}
            </span>
            <span>
              <span className="block font-semibold">
                {stage.name}
                <span className="sr-only">{stateText[stage.state]}</span>
              </span>
              <span className="block text-muted-foreground">{stage.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3 rounded-xl border bg-card/70 px-4 py-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-primary/50 bg-primary/15 text-primary">
          <MusicIcon aria-hidden="true" className="size-6" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="font-semibold">Generating MIDI preview…</p>
          <p className="text-muted-foreground">
            This lets you preview the result before importing.
          </p>
          <div
            role="progressbar"
            aria-label="Transcription progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-2.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full bg-primary",
                percent === null ? "w-1/3 animate-pulse" : "transition-[width]",
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </div>
        {percent !== null && <span className="w-12 text-right font-semibold">{percent}%</span>}
      </div>
    </div>
  );
}
