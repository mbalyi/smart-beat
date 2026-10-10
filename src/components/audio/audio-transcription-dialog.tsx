import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  TranscriptionError,
  validateAudio,
  type AudioTranscriptionProvider,
  type TranscriptionProgress,
  type TranscriptionQuote,
  type TranscriptionResult,
} from "@/lib/audio-transcription/provider";
import { audioDurationMs } from "@/lib/audio-transcription/duration";
import { label, scoreInstrument } from "@/lib/audio-transcription/upstream/instruments";
import { errorText } from "@/lib/errors";

export interface DroppedRecording {
  file?: File;
  path?: string;
  nonce: number;
}
type Phase = "select" | "quoting" | "quoted" | "transcribing" | "paused" | "complete";
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
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [measured, setMeasured] = useState<{ file: File; ms: number } | null>(null);
  const [quote, setQuote] = useState<TranscriptionQuote | null>(null);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [phase, setPhase] = useState<Phase>("select");
  const [error, setError] = useState("");
  // null while the dialog asks whether this build can transcribe.
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<TranscriptionProgress | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [verified, setVerified] = useState(false);
  const busy = phase === "quoting" || phase === "transcribing";
  const locked = busy || phase === "paused" || phase === "complete" || saving || importing;
  const candidates = provider.instruments
    .map((id) => ({ id, score: scoreInstrument(id, query) }))
    .filter((v) => v.score > 0 && !selected.includes(v.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([provider.configured(), provider.pending()])
      .then(([access, pending]) => {
        if (!alive) return;
        setConfigured(access);
        if (pending && !quote && !result) {
          setQuote(pending);
          setPhase("paused");
        }
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
  }, [open, provider, quote, result]);
  useEffect(() => () => operation.current?.abort(), []);
  // Shows the duration before upload. A file the webview cannot measure fails
  // at the cost check instead, with the reason.
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
    const read = droppedRecording.file
      ? Promise.resolve(droppedRecording.file)
      : provider.readFile(droppedRecording.path!);
    read
      .then((next) => {
        if (alive) {
          validateAudio(next, provider);
          setFile(next);
          setQuote(null);
          setError("");
          setPhase("select");
        }
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
    // Only a new drop selects a recording, never a later phase transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedRecording, open, provider]);

  const choose = (next?: File) => {
    if (!next || locked) return;
    try {
      validateAudio(next, provider);
      setFile(next);
      setQuote(null);
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
    return {
      signal: controller.signal,
      onProgress: (next: TranscriptionProgress) => {
        if (!controller.signal.aborted) setProgress(next);
      },
    };
  };
  const upload = async () => {
    if (!file || busy) return;
    const opts = options();
    setError("");
    setPhase("quoting");
    setProgress({ phase: "quoting", message: "Reading recording…" });
    try {
      const next = await provider.quote(file, opts);
      if (!opts.signal.aborted) {
        setQuote(next);
        setPhase("quoted");
      }
    } catch (cause) {
      if (!opts.signal.aborted) {
        setPhase("select");
        setError(errorText(cause));
      }
    }
  };
  const transcribe = async (resume = false) => {
    if (!quote || busy) return;
    const opts = options();
    setError("");
    setPhase("transcribing");
    setProgress({
      phase: "processing",
      message: resume ? "Checking the saved job…" : "Starting transcription…",
    });
    try {
      const next = await (resume
        ? provider.resume(opts)
        : provider.transcribe(quote, selected, opts));
      if (!opts.signal.aborted) {
        setResult(next);
        setPhase("complete");
      }
    } catch (cause) {
      if (!opts.signal.aborted) {
        const recover = cause instanceof TranscriptionError ? cause.recoverable : true;
        setPhase(recover ? "paused" : "quoted");
        setError(errorText(cause));
      }
    }
  };
  const stop = () => {
    operation.current?.abort();
    setPhase(phase === "transcribing" ? "paused" : "select");
  };
  const close = () => {
    if (saving || importing) return;
    if (busy) stop();
    onOpenChange(false);
  };
  const reset = async () => {
    try {
      await provider.discardPending();
      setFile(null);
      setQuote(null);
      setResult(null);
      setSelected([]);
      setQuery("");
      setPhase("select");
      setError("");
      setVerified(false);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const shownDuration = quote?.durationMs ?? (measured?.file === file ? measured.ms : null);
  const name = `${file?.name.replace(/\.[^.]+$/, "") || "Recovered transcription"}.mid`;
  const importMidi = async () => {
    if (!result) return;
    setImporting(true);
    setError("");
    try {
      await onImport(result.midi, name);
      await reset();
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
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="xl" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Import from Audio</DialogTitle>
          <DialogDescription>
            Upload a recording to {provider.name}, preview the generated MIDI, then open it in Smart
            Beat.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            <div className="rounded-md border p-3 text-sm">
              <p>
                Your recording will be uploaded to {provider.name}. {provider.retention}
              </p>
              <p className="mt-2">
                Limit: {provider.maxBytes / 1024 / 1024} MiB and {provider.maxDurationMs / 60_000}{" "}
                minutes.
              </p>
              <p className="mt-2 flex flex-wrap gap-x-4">
                {(
                  [
                    ["privacy", "Provider privacy policy"],
                    ["terms", "Provider terms"],
                  ] as const
                ).map(([page, text]) => (
                  <Button
                    key={page}
                    variant="link"
                    className="h-6 px-0 text-foreground underline"
                    onClick={() =>
                      void provider.openPage(page).catch((cause) => setError(errorText(cause)))
                    }
                  >
                    {text}
                  </Button>
                ))}
              </p>
            </div>
            {configured === false && (
              <p className="text-sm text-muted-foreground">
                Audio transcription is not available in this build.
              </p>
            )}
            <div
              className="rounded-md border border-dashed p-4"
              role="region"
              aria-label="Audio drop area"
            >
              <p className="mb-3 text-sm">
                Drop an audio file here, or browse. {provider.extensions.join(", ").toUpperCase()}.
              </p>
              <input
                ref={input}
                type="file"
                className="sr-only"
                aria-label="Choose an audio recording"
                accept={provider.extensions.map((ext) => `.${ext}`).join(",")}
                disabled={locked}
                onChange={(e) => {
                  choose(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
              <Button
                variant="outline"
                disabled={locked}
                onClick={() => input.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  choose(e.dataTransfer.files[0]);
                }}
              >
                {file ? "Replace recording…" : "Choose recording…"}
              </Button>
              {file && (
                <div className="mt-3 text-sm">
                  <p>{file.name}</p>
                  <p className="text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MiB
                    {shownDuration ? ` · ${durationText(shownDuration)}` : ""}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={() => {
                      setFile(null);
                      setQuote(null);
                      setError("");
                      setPhase("select");
                    }}
                  >
                    Remove recording
                  </Button>
                </div>
              )}
            </div>
            {file && phase !== "complete" && (
              <fieldset disabled={locked} className="flex flex-col gap-3">
                <legend className="text-sm font-medium">Expected instruments, optional</legend>
                <p className="text-xs text-muted-foreground">
                  Leave empty for automatic detection. Specify every instrument playing. The list
                  restricts the output and may improve consistency; missing instruments may be
                  omitted.
                </p>
                <div className="flex flex-wrap gap-2">
                  {selected.map((id) => (
                    <Button
                      key={id}
                      size="sm"
                      variant="secondary"
                      onClick={() => setSelected(selected.filter((v) => v !== id))}
                      aria-label={`Remove ${label(id)}`}
                    >
                      {label(id)} ×
                    </Button>
                  ))}
                </div>
                <Input
                  aria-label="Search instruments"
                  placeholder="Search instruments, families, or aliases…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div
                  className="flex max-h-32 flex-wrap gap-2 overflow-y-auto"
                  aria-label="Available instruments"
                >
                  {candidates.map(({ id }) => (
                    <Button
                      key={id}
                      size="sm"
                      variant="outline"
                      onClick={() => setSelected([...selected, id])}
                    >
                      {label(id)}
                    </Button>
                  ))}
                  {!candidates.length && <p className="text-sm">No matching instruments.</p>}
                </div>
              </fieldset>
            )}
            {phase === "select" && (
              <Button disabled={!file || !configured} onClick={() => void upload()}>
                Upload recording
              </Button>
            )}
            {busy && (
              <div role="status" className="text-sm">
                <p>{progress?.message}</p>
                {progress?.percent !== undefined && <p>Provider estimate: {progress.percent}%</p>}
                <Button variant="outline" className="mt-2" onClick={stop}>
                  Stop waiting
                </Button>
                <p className="mt-1 text-xs text-muted-foreground">
                  Stopping or closing does not cancel a job at the provider. You can resume the same
                  job.
                </p>
              </div>
            )}
            {quote && (
              <p className="text-sm">{durationText(quote.durationMs)} recording uploaded</p>
            )}
            {phase === "quoted" && (
              <Button disabled={!configured} onClick={() => void transcribe()}>
                Transcribe
              </Button>
            )}
            {phase === "paused" && (
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  A job may still be running. Resume checks the saved job and never submits a new
                  transcription.
                </p>
                <Button disabled={!configured} onClick={() => void transcribe(true)}>
                  Resume saved job
                </Button>
                <label className="text-xs">
                  <input
                    type="checkbox"
                    checked={verified}
                    onChange={(e) => setVerified(e.target.checked)}
                  />{" "}
                  I understand the saved job may still be running, and want to dismiss it.
                </label>
                <Button variant="outline" disabled={!verified} onClick={() => void reset()}>
                  Dismiss saved attempt
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {phase === "complete" && result && (
              <TranscriptionPreview key={quote?.assetId} result={result} active={open} />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          {phase === "complete" && (
            <>
              <Button
                variant="outline"
                disabled={saving || importing}
                onClick={() => void saveMidi()}
              >
                {saving ? "Saving…" : "Save MIDI As…"}
              </Button>
              <Button disabled={saving || importing} onClick={() => void importMidi()}>
                {importing ? "Importing…" : "Import MIDI into Smart Beat"}
              </Button>
              <Button variant="ghost" disabled={saving || importing} onClick={() => void reset()}>
                New transcription
              </Button>
            </>
          )}
          <Button variant="outline" onClick={close} disabled={saving || importing}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
