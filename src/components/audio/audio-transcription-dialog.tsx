import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/telemetry";
import { Button } from "@/components/ui/button";
import { AudioDropArea } from "@/components/audio/audio-drop-area";
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
import { AI_DIALOG_FRAME } from "@/components/ai/dialog-frame";
import { PoweredByMuscriptor } from "@/components/ai/powered-by-muscriptor";
import { canRun, openInstaller, refreshAi, rightsDetail, useAiState } from "@/lib/ai/ai-store";
import { sizeInfo } from "@/lib/ai/muscriptor-sizes";
import {
  validateAudio,
  type AudioTranscriptionProvider,
  type TranscriptionProgress,
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
type Phase = "select" | "transcribing" | "complete";
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
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<TranscriptionProgress | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const ai = useAiState();
  // The model is downloaded and the terms are accepted; until then the dialog offers the download.
  const ready = canRun(ai);
  const needsModel = configured === true && ai.ready && !ready;
  const busy = phase === "transcribing";
  const locked = busy || phase === "complete" || saving || importing;
  const candidates = provider.instruments
    .map((id) => ({ id, score: scoreInstrument(id, query) }))
    .filter((v) => v.score > 0 && !selected.includes(v.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

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
  const reset = () => {
    setFile(null);
    setResult(null);
    setSelected([]);
    setQuery("");
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
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent size="xl" className={AI_DIALOG_FRAME} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Import from Audio</DialogTitle>
          <DialogDescription>
            Transcribe a recording with {provider.name}, preview the generated MIDI, then open it in
            Smart Beat.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            {needsModel && (
              <div
                className="flex flex-col items-start gap-3 rounded-md border p-4 text-sm"
                data-testid="audio-needs-model"
              >
                <p className="font-medium">Download MuScriptor to transcribe recordings</p>
                <p>
                  Import from Audio runs the MuScriptor AI model on this computer. Download it once
                  ({sizeInfo(ai.size).label}, about {sizeInfo(ai.size).megabytes} MB); a guided
                  setup walks you through the terms. Your recordings never leave this computer.
                </p>
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    openInstaller("audio");
                  }}
                >
                  Download MuScriptor
                </Button>
                <PoweredByMuscriptor />
              </div>
            )}
            {!needsModel && (
              <div className="rounded-md border p-3 text-sm">
                <p>{provider.privacy}</p>
                <p className="mt-2">
                  Limit: {provider.maxBytes / 1024 / 1024} MiB and {provider.maxDurationMs / 60_000}{" "}
                  minutes. {provider.credit} Non-commercial use only, and only on music you have the
                  rights to.
                </p>
              </div>
            )}
            {configured === false && (
              <p className="text-sm text-muted-foreground">
                Audio transcription is available in the desktop app.
              </p>
            )}
            {!needsModel && (
              <AudioDropArea
                extensions={provider.extensions}
                disabled={locked}
                chosen={file !== null}
                onFile={choose}
              >
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
                        choice.current++;
                        setFile(null);
                        setError("");
                        setPhase("select");
                      }}
                    >
                      Remove recording
                    </Button>
                  </div>
                )}
              </AudioDropArea>
            )}
            {!needsModel && file && phase !== "complete" && (
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
            {phase === "select" && !needsModel && (
              <Button disabled={!file || !configured || !ready} onClick={() => void transcribe()}>
                Transcribe
              </Button>
            )}
            {busy && (
              <div role="status" className="text-sm">
                <p>{progress?.message}</p>
                {typeof progress?.percent === "number" && <p>{progress.percent}%</p>}
                <Button variant="outline" className="mt-2" onClick={cancel}>
                  Cancel transcription
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {phase === "complete" && result && (
              <TranscriptionPreview result={result} active={open} />
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
              <Button variant="ghost" disabled={saving || importing} onClick={reset}>
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
