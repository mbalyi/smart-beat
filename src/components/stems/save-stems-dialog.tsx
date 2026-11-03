import { CheckIcon, CloudIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { formatBytes } from "@/components/stems/stem-labels";
import { ComputerCard, StorageCard, StorageGrid, TargetArt } from "@/components/target-cards";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/errors";
import {
  estimateStemBundle,
  getCloudFolder,
  isCommandError,
  pickStemBundleDestination,
  revealInFolder,
  saveStemBundle,
  stemsCloudSavePath,
  type SaveBundleResult,
  type StemSong,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Phase = "options" | "saving" | "done";
/** Where the file goes: the linked cloud folder, or a place picked in the computer's dialog. */
type Place = "cloud" | "computer";

/** The last part of a folder path ("Dropbox" for `/Users/me/Dropbox`). */
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/** What the Save dialog tells the user when the cloud folder is gone. */
const CLOUD_FOLDER_GONE =
  "The cloud folder could not be found. Is the drive offline? Check your connection or the sync app, or save to this computer instead.";

/**
 * Save stems (#186): writes a separated song to a `.sbstems` file that opens again on this or
 * another computer, with or without the original song. It works like Save As for songs: the
 * choice of where to save is a row of cards (this computer, the linked cloud folder), and
 * clicking one saves right away, so there is no footer.
 */
export function SaveStemsDialog({
  song,
  open,
  onOpenChange,
  onSaved,
  onOpenCloudSettings,
  onCloseAutoFocus,
}: {
  song: StemSong;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file was written (the page marks the song as saved). */
  onSaved?: (path: string) => void;
  /** Shows Settings on the cloud folder section; the hint has no link without it. */
  onOpenCloudSettings?: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  // Closing is held back while the file is being written.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent
        size="xl"
        showCloseButton={!busy}
        data-testid="save-stems-dialog"
        className={cn(DIALOG_NEON, "max-h-[calc(100dvh-2rem)] sm:max-w-3xl")}
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
            onOpenCloudSettings={onOpenCloudSettings}
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
  onOpenCloudSettings,
}: {
  song: StemSong;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onSaved?: (path: string) => void;
  onOpenCloudSettings?: () => void;
}) {
  const available = song.hasOriginal;
  const [phase, setPhase] = useState<Phase>("options");
  const [includeOriginal, setIncludeOriginal] = useState(available);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SaveBundleResult | null>(null);
  // The linked cloud folder: undefined while it is being read, null when none is linked.
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
  const [saved, setSaved] = useState<Place>("computer");
  // About how big the file will be (nothing is shown when the estimate is not available).
  const [estimate, setEstimate] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    getCloudFolder().then(
      (found) => alive && setFolder(found),
      () => alive && setFolder(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  const wanted = available && includeOriginal;
  useEffect(() => {
    let alive = true;
    estimateStemBundle(song.id, wanted).then(
      (size) => alive && setEstimate(size.bytes),
      () => alive && setEstimate(null),
    );
    return () => {
      alive = false;
    };
  }, [song.id, wanted]);

  const save = async (where: Place) => {
    setError("");
    let dest: string | null;
    try {
      if (where === "cloud") {
        try {
          dest = await stemsCloudSavePath(song.name);
        } catch (cause) {
          setError(
            isCommandError(cause) && cause.kind === "not-found"
              ? CLOUD_FOLDER_GONE
              : errorText(cause),
          );
          return;
        }
      } else {
        dest = await pickStemBundleDestination(song.name);
      }
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    if (!dest) return; // The native dialog was cancelled: nothing changes.
    setSaved(where);
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

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
      <TargetArt />
      <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
        <DialogTitle className="text-2xl font-bold">Save stems</DialogTitle>
        <DialogDescription className="text-sm sm:text-base">
          {phase === "options"
            ? `Keep “${song.name}” as one file you can open again here, or on another computer.`
            : phase === "saving"
              ? `Saving “${song.name}”.`
              : `“${song.name}” is saved.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 overflow-visible px-6 pb-6 md:px-9">
        {phase === "options" && (
          <>
            <div
              className={cn(
                "flex items-start gap-3 rounded-xl border bg-card/85 px-4 py-3",
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
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <label htmlFor="save-stems-original" className="cursor-pointer font-semibold">
                  Include the original song
                </label>
                <p id="save-stems-original-hint" className="text-xs text-muted-foreground">
                  {available
                    ? "Adds the song itself (about 5 to 25 MB) so the file works on its own. Leave it off for a file that holds only the stems."
                    : "The original song is not on this computer any more, so the file will hold only the stems."}
                </p>
              </div>
              {estimate !== null && (
                <span
                  data-testid="save-stems-estimate"
                  className="shrink-0 text-sm font-semibold text-muted-foreground"
                >
                  About {formatBytes(estimate)}
                </span>
              )}
            </div>
            <ComputerCard
              label="Save to this computer"
              hint="Choose a folder. Nothing is uploaded."
              onClick={() => void save("computer")}
              testId="save-stems-computer"
            />
            {folder !== undefined && (
              <StorageGrid count={1}>
                {folder ? (
                  <StorageCard
                    art={
                      <CloudIcon className="size-10 text-primary sm:size-12" aria-hidden="true" />
                    }
                    verb="Save to"
                    label={`Cloud folder · ${folderName(folder)}`}
                    hint="Your drive app uploads the file. Smart Beat does not upload anything."
                    describeHint
                    onClick={() => void save("cloud")}
                    testId="save-stems-cloud"
                  />
                ) : (
                  <StorageCard
                    art={
                      <CloudIcon className="size-10 text-primary sm:size-12" aria-hidden="true" />
                    }
                    verb="Set up"
                    label="Cloud storage"
                    hint="Link a cloud folder in Settings to keep stems in your cloud."
                    describeHint
                    disabled={!onOpenCloudSettings}
                    onClick={() => {
                      onClose();
                      onOpenCloudSettings?.();
                    }}
                    testId="save-stems-setup"
                  />
                )}
              </StorageGrid>
            )}
          </>
        )}
        {phase === "saving" && <SaveProgress fraction={fraction} />}
        {phase === "done" && result && (
          <Saved
            result={result}
            wanted={wanted}
            inCloud={saved === "cloud"}
            onError={(cause) => setError(errorText(cause))}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogBody>
    </div>
  );
}

function SaveProgress({ fraction }: { fraction: number }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-xl border bg-card/85 px-4 py-3 text-sm"
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

function Saved({
  result,
  wanted,
  inCloud,
  onError,
}: {
  result: SaveBundleResult;
  wanted: boolean;
  inCloud: boolean;
  onError: (cause: unknown) => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border bg-card/85 px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-2 font-semibold">
        <CheckIcon aria-hidden="true" className="size-4 text-primary" />
        Saved
      </p>
      <p data-testid="save-stems-path" className="break-all text-muted-foreground">
        {result.path}
      </p>
      {inCloud && (
        <p className="text-muted-foreground">
          Saved in your cloud folder. Your drive app uploads it; Smart Beat does not upload
          anything.
        </p>
      )}
      {wanted && !result.originalIncluded && (
        <p className="text-muted-foreground">
          The original song could not be added, so the file holds only the stems.
        </p>
      )}
      <Button
        variant="outline"
        className="mt-1 self-start bg-card"
        onClick={() => revealInFolder(result.path).catch(onError)}
      >
        <FolderOpenIcon aria-hidden="true" data-icon="inline-start" />
        Show in folder
      </Button>
    </div>
  );
}
