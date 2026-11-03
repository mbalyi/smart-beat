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
import { formatBytes } from "@/components/stems/stem-labels";
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
type Place = "cloud" | "other";

/** The last part of a folder path ("Dropbox" for `/Users/me/Dropbox`). */
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/** What the Save dialog tells the user when the cloud folder is gone. */
const CLOUD_FOLDER_GONE =
  "The cloud folder could not be found. Is the drive offline? Check your connection or the sync app, or choose “Another place…”.";

/**
 * Save stems (#186): writes a separated song to a `.sbstems` file that opens again on this or
 * another computer, with or without the original song. Small on purpose: one choice, one button.
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
  const [choice, setChoice] = useState<Place | null>(null);
  const [saved, setSaved] = useState<Place>("other");
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

  const place: Place = choice ?? (folder ? "cloud" : "other");

  const save = async () => {
    setError("");
    let dest: string | null;
    let where: Place = place;
    try {
      // Pressed before the folder was read: ask now, so the cloud folder is not skipped.
      const linked = folder === undefined ? await getCloudFolder().catch(() => null) : folder;
      if (folder === undefined && choice === null && linked) where = "cloud";
      if (where === "cloud" && linked) {
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
        where = "other";
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
            {folder ? (
              <PlaceChoice folder={folder} place={place} onPlace={setChoice} />
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Saved on this computer. Nothing is uploaded.
                </p>
                {folder === null && (
                  <CloudHint
                    onOpenSettings={
                      onOpenCloudSettings &&
                      (() => {
                        onClose();
                        onOpenCloudSettings();
                      })
                    }
                  />
                )}
              </>
            )}
          </>
        )}
        {phase === "saving" && <SaveProgress fraction={fraction} />}
        {phase === "done" && result && (
          <Saved result={result} wanted={wanted} inCloud={saved === "cloud"} />
        )}
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
          <div className="flex items-center gap-3">
            {estimate !== null && (
              <span data-testid="save-stems-estimate" className="text-sm text-muted-foreground">
                About {formatBytes(estimate)}
              </span>
            )}
            <Button size="lg" className="min-w-36" onClick={() => void save()}>
              <SaveIcon aria-hidden="true" data-icon="inline-start" />
              Save
            </Button>
          </div>
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

/** "Where to save": the linked cloud folder (the default) or a place picked in a dialog. */
function PlaceChoice({
  folder,
  place,
  onPlace,
}: {
  folder: string;
  place: Place;
  onPlace: (place: Place) => void;
}) {
  const options: { id: Place; label: string; hint: string }[] = [
    {
      id: "cloud",
      label: `Cloud folder · ${folderName(folder)}`,
      hint: "Your drive app uploads the file. Smart Beat does not upload anything.",
    },
    {
      id: "other",
      label: "Another place…",
      hint: "Choose a folder on this computer. Nothing is uploaded.",
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span id="save-stems-place-label" className="text-sm font-medium">
        Where to save
      </span>
      <div
        role="radiogroup"
        aria-labelledby="save-stems-place-label"
        className="flex flex-col gap-2"
      >
        {options.map((option) => (
          <label
            key={option.id}
            htmlFor={`save-stems-place-${option.id}`}
            className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card/70 px-4 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <input
              type="radio"
              id={`save-stems-place-${option.id}`}
              name="save-stems-place"
              value={option.id}
              checked={place === option.id}
              onChange={() => onPlace(option.id)}
              aria-labelledby={`save-stems-place-${option.id}-name`}
              aria-describedby={`save-stems-place-${option.id}-hint`}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span id={`save-stems-place-${option.id}-name`} className="font-semibold break-all">
                {option.label}
              </span>
              <span
                id={`save-stems-place-${option.id}-hint`}
                className="text-xs text-foreground/75"
              >
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** Under the options when no cloud folder is linked: where to link one. */
function CloudHint({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <p className="text-sm text-muted-foreground">
      {onOpenSettings ? (
        <>
          Link a cloud folder in{" "}
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-sm font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Settings
          </button>{" "}
          to keep stems in your cloud.
        </>
      ) : (
        "Link a cloud folder in Settings to keep stems in your cloud."
      )}
    </p>
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

function Saved({
  result,
  wanted,
  inCloud,
}: {
  result: SaveBundleResult;
  wanted: boolean;
  inCloud: boolean;
}) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-sm">
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
    </div>
  );
}
