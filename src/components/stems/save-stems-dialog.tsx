import { CheckIcon, FolderOpenIcon, SaveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DIALOG_NEON } from "@/components/ai/dialog-art";
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
import { errorText } from "@/lib/errors";
import {
  pickStemBundleDestination,
  revealInFolder,
  saveStemBundle,
  type SaveBundleResult,
  type StemSong,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Phase = "options" | "saving" | "done";

/**
 * Save stems (#186): writes a separated song to a `.sbstems` file that opens again on this or
 * another computer, with or without the original song. Small on purpose: one choice, one button.
 */
export function SaveStemsDialog({
  song,
  open,
  onOpenChange,
  onSaved,
  onCloseAutoFocus,
}: {
  song: StemSong;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file was written (the page marks the song as saved). */
  onSaved?: (path: string) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  // Closing is held back while the file is being written.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent
        size="md"
        showCloseButton={!busy}
        className={cn(DIALOG_NEON)}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        {/* Mounted only while open, so every visit starts from the defaults. */}
        {open && (
          <SaveFlow
            song={song}
            onBusy={setBusy}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SaveFlow({
  song,
  onBusy,
  onClose,
  onSaved,
}: {
  song: StemSong;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onSaved?: (path: string) => void;
}) {
  const available = song.hasOriginal;
  const [phase, setPhase] = useState<Phase>("options");
  const [includeOriginal, setIncludeOriginal] = useState(available);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SaveBundleResult | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = async () => {
    setError("");
    let dest: string | null;
    try {
      dest = await pickStemBundleDestination(song.name);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    if (!dest) return; // The native dialog was cancelled: nothing changes.
    setFraction(0);
    setPhase("saving");
    onBusy(true);
    try {
      const saved = await saveStemBundle(
        { id: song.id, dest, includeOriginal: available && includeOriginal },
        (progress) => mounted.current && setFraction(progress.fraction),
      );
      onSaved?.(saved.path);
      if (!mounted.current) return;
      setResult(saved);
      setPhase("done");
    } catch (cause) {
      if (!mounted.current) return;
      setError(errorText(cause));
      setPhase("options");
    } finally {
      onBusy(false);
    }
  };

  const wanted = available && includeOriginal;
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <DialogHeader className="px-6 pt-5">
        <DialogTitle className="text-2xl font-bold">Save stems</DialogTitle>
        <DialogDescription>
          Keep “{song.name}” as one file you can open again here, or on another computer.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 px-6">
        {phase === "options" && (
          <>
            <div
              className={cn(
                "flex items-start gap-3 rounded-xl border bg-card px-4 py-3",
                !available && "border-dashed",
              )}
            >
              <Checkbox
                id="save-stems-original"
                checked={available && includeOriginal}
                disabled={!available}
                onCheckedChange={(on) => setIncludeOriginal(on === true)}
                aria-describedby="save-stems-original-hint"
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <label htmlFor="save-stems-original" className="cursor-pointer font-semibold">
                  Include the original song
                </label>
                <p id="save-stems-original-hint" className="text-xs text-muted-foreground">
                  {available
                    ? "Adds the song itself (about 5 to 25 MB) so the file works on its own. Leave it off for a file that holds only the stems."
                    : "The original song is not on this computer any more, so the file will hold only the stems."}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Saved on this computer. Nothing is uploaded.
            </p>
          </>
        )}
        {phase === "saving" && <SaveProgress fraction={fraction} />}
        {phase === "done" && result && <Saved result={result} wanted={wanted} />}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-3 pb-5 sm:justify-between">
        <Button
          variant="outline"
          size="lg"
          className="min-w-28 bg-card"
          disabled={phase === "saving"}
          onClick={onClose}
        >
          Close
        </Button>
        {phase === "options" && (
          <Button size="lg" className="min-w-36" onClick={() => void save()}>
            <SaveIcon aria-hidden="true" data-icon="inline-start" />
            Save
          </Button>
        )}
        {phase === "done" && result && (
          <Button
            size="lg"
            className="min-w-36"
            onClick={() => revealInFolder(result.path).catch((cause) => setError(errorText(cause)))}
          >
            <FolderOpenIcon aria-hidden="true" data-icon="inline-start" />
            Show in folder
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function SaveProgress({ fraction }: { fraction: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-xl border bg-card px-4 py-3 text-sm"
    >
      <p className="font-semibold">Saving the stems…</p>
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label="Save progress"
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
    </div>
  );
}

function Saved({ result, wanted }: { result: SaveBundleResult; wanted: boolean }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-semibold">
        <CheckIcon aria-hidden="true" className="size-4 text-primary" />
        Saved
      </p>
      <p data-testid="save-stems-path" className="break-all text-muted-foreground">
        {result.path}
      </p>
      {wanted && !result.originalIncluded && (
        <p className="text-muted-foreground">
          The original song could not be added, so the file holds only the stems.
        </p>
      )}
    </div>
  );
}
