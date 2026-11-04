import {
  ArrowLeftIcon,
  CloudIcon,
  CloudOffIcon,
  LayersIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { CloudProviderLogo } from "@/components/cloud-provider-logos";
import { CloudStemCard } from "@/components/cloud-stems";
import { formatBytes } from "@/components/stems/stem-labels";
import { useCloudStemList } from "@/components/stems/use-cloud-stem-list";
import { useConnectedDrives, type ConnectedDrive } from "@/components/stems/use-connected-drives";
import { ComputerCard, StorageCard, StorageGrid, TargetArt } from "@/components/target-cards";
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
import { cloudErrorText } from "@/lib/cloud-items";
import { errorText } from "@/lib/errors";
import {
  cancelStemSeparation,
  getCloudFolder,
  isStemFileStopped,
  listCloudStemFiles,
  openStemBundleFromCloud,
  type BundleProgress,
  type CloudStemFile,
  type StemSong,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The last part of a folder path ("Dropbox" for `/Users/me/Dropbox`). */
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/**
 * Open saved stems (#186): works like Open for songs. It asks where the `.sbstems` file is: on
 * this computer (the native file dialog, after this one has closed), in one of the connected
 * cloud accounts (listed here; the file is downloaded while this dialog stays open) or in the
 * linked cloud folder, whose saved stems are listed here. With neither an account nor a folder a
 * card leads to Settings. For this computer and the folder the dialog closes before the choice
 * is handed over.
 */
export function OpenStemsDialog({
  open,
  onOpenChange,
  onPickComputer,
  onOpenStem,
  onSetupCloud,
  onOpenedSong,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Open from this computer": the caller shows the native file dialog. */
  onPickComputer: () => void;
  /** A saved stems file of the cloud folder was picked. */
  onOpenStem: (path: string) => void;
  /** "Set up cloud storage": the caller shows Settings on the cloud folder section. */
  onSetupCloud: () => void;
  /**
   * A saved stems file of a connected account was downloaded and opened here: show its page. The
   * accounts are offered only when this is given.
   */
  onOpenedSong?: (song: StemSong) => void;
}) {
  // Closing is held back while a file is being downloaded.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent
        size="xl"
        showCloseButton={!busy}
        data-testid="open-stems-dialog"
        className={`${DIALOG_NEON} max-h-[calc(100dvh-2rem)] sm:max-w-3xl`}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        {/* Mounted only while open, so every visit starts at the choice. */}
        {open && (
          <OpenFlow
            onClose={() => onOpenChange(false)}
            onPickComputer={onPickComputer}
            onOpenStem={onOpenStem}
            onSetupCloud={onSetupCloud}
            onOpenedSong={onOpenedSong}
            onBusy={setBusy}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function OpenFlow({
  onClose,
  onPickComputer,
  onOpenStem,
  onSetupCloud,
  onOpenedSong,
  onBusy,
}: {
  onClose: () => void;
  onPickComputer: () => void;
  onOpenStem: (path: string) => void;
  onSetupCloud: () => void;
  onOpenedSong?: (song: StemSong) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [view, setView] = useState<"choose" | "cloud" | ConnectedDrive>("choose");
  // The connected accounts (undefined while they are read); none are offered without a way to
  // show the song that comes back.
  const connected = useConnectedDrives();
  const drives = onOpenedSong ? connected : [];
  // The linked cloud folder: undefined while it is being read, null when none is linked.
  const [folder, setFolder] = useState<string | null | undefined>(undefined);
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

  if (typeof view === "object" && onOpenedSong) {
    return (
      <DriveStemsView
        drive={view}
        onBack={() => setView("choose")}
        onBusy={onBusy}
        onOpened={(song) => {
          onClose();
          onOpenedSong(song);
        }}
      />
    );
  }
  if (view === "cloud" && folder) {
    return (
      <CloudStemsView
        folder={folder}
        onBack={() => setView("choose")}
        onOpen={(path) => {
          onClose();
          onOpenStem(path);
        }}
      />
    );
  }
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
      <TargetArt />
      <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
        <DialogTitle className="text-2xl font-bold">Open saved stems</DialogTitle>
        <DialogDescription className="text-sm sm:text-base">
          Pick a saved stems file on this computer, or one in your cloud storage.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 overflow-visible px-6 pb-6 md:px-9">
        <ComputerCard
          label="Open from this computer"
          onClick={() => {
            onClose();
            onPickComputer();
          }}
          testId="open-stems-computer"
        />
        {folder !== undefined && drives !== undefined && (
          <StorageGrid count={drives.length + (folder || drives.length === 0 ? 1 : 0)}>
            {drives.map((item) => (
              <StorageCard
                key={item.provider}
                art={
                  <CloudProviderLogo
                    provider={item.provider}
                    className="h-10 w-auto drop-shadow-md sm:h-12"
                  />
                }
                verb="Open from"
                label={item.label}
                hint={item.account}
                describeHint
                onClick={() => setView(item)}
                testId={`open-stems-${item.provider}`}
              />
            ))}
            {folder ? (
              <StorageCard
                art={<CloudIcon className="size-10 text-primary sm:size-12" aria-hidden="true" />}
                verb="Open from"
                label={`Cloud folder · ${folderName(folder)}`}
                hint="The stems you saved there, on any of your computers."
                describeHint
                onClick={() => setView("cloud")}
                testId="open-stems-cloud"
              />
            ) : (
              drives.length === 0 && (
                <StorageCard
                  art={<CloudIcon className="size-10 text-primary sm:size-12" aria-hidden="true" />}
                  verb="Set up"
                  label="Cloud storage"
                  hint="Connect an account or link a cloud folder in Settings to open stems from your cloud."
                  describeHint
                  onClick={() => {
                    onClose();
                    onSetupCloud();
                  }}
                  testId="open-stems-setup"
                />
              )
            )}
          </StorageGrid>
        )}
      </DialogBody>
    </div>
  );
}

/** The saved stems of the cloud folder, newest first, with the drive app's "waiting" state. */
function CloudStemsView({
  folder,
  onBack,
  onOpen,
}: {
  folder: string;
  onBack: () => void;
  onOpen: (path: string) => void;
}) {
  const { list, downloading, refresh } = useCloudStemList();
  const label = `Cloud folder · ${folderName(folder)}`;
  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
      <TargetArt />
      <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
        <DialogTitle className="flex items-center gap-2.5 text-2xl font-bold">
          <CloudIcon className="size-6 shrink-0 text-primary" aria-hidden="true" />
          Open from {label}
        </DialogTitle>
        <DialogDescription className="text-sm sm:text-base">
          These are the stems saved in your cloud folder. Pick one to open it.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 px-6 md:px-9">
        {list.status === "loading" && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-xl border bg-card/85 p-4 text-sm text-muted-foreground dark:bg-card/80"
          >
            <Loader2Icon
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Loading the saved stems…
          </p>
        )}
        {list.status === "error" && (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-card/85 p-4 text-sm dark:bg-card/80"
          >
            <p className="flex items-start gap-2">
              <CloudOffIcon
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <span>{list.message}</span>
            </p>
            <Button variant="outline" onClick={refresh} className="bg-card">
              <RefreshCwIcon data-icon="inline-start" />
              Retry
            </Button>
          </div>
        )}
        {list.status === "ready" && list.files.length === 0 && (
          <p className="rounded-xl border bg-card/85 p-4 text-sm text-muted-foreground dark:bg-card/80">
            No saved stems in your cloud folder yet. Use Save stems on a separated song to add one.
          </p>
        )}
        {list.status === "ready" && list.files.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Saved stems in your cloud folder">
            {list.files.map((file, index) => (
              <li key={file.path} className="min-w-0">
                <CloudStemCard
                  file={file}
                  index={index}
                  fetching={downloading.has(file.path)}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
        <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="bg-card"
          onClick={refresh}
          disabled={list.status === "loading"}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </DialogFooter>
    </div>
  );
}

/** "Neon Nights" for `Neon Nights.sbstems`. */
const stemName = (file: string) => file.replace(/\.sbstems$/i, "");

/** The saved stems of a connected account, newest first. A click downloads and opens one. */
function DriveStemsView({
  drive,
  onBack,
  onBusy,
  onOpened,
}: {
  drive: ConnectedDrive;
  onBack: () => void;
  onBusy: (busy: boolean) => void;
  onOpened: (song: StemSong) => void;
}) {
  type List =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; files: CloudStemFile[] };
  const [list, setList] = useState<List>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The file being opened, with how far it is.
  const [opening, setOpening] = useState<{
    name: string;
    stage: BundleProgress["stage"];
    fraction: number;
  } | null>(null);
  const [failure, setFailure] = useState("");

  const refresh = useCallback(() => {
    setList({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    listCloudStemFiles(drive.provider).then(
      (files) =>
        active &&
        setList({
          status: "ready",
          files: [...files].sort((a, b) => b.modified_ms - a.modified_ms),
        }),
      (error: unknown) =>
        active &&
        setList({
          status: "error",
          message: cloudErrorText(error, drive.provider) ?? errorText(error),
        }),
    );
    return () => {
      active = false;
    };
  }, [drive.provider, attempt]);

  const open = async (file: CloudStemFile) => {
    setFailure("");
    setOpening({ name: stemName(file.name), stage: "downloading", fraction: 0 });
    onBusy(true);
    try {
      const song = await openStemBundleFromCloud(file.id, (progress) =>
        setOpening((now) =>
          now ? { ...now, stage: progress.stage, fraction: progress.fraction } : now,
        ),
      );
      onBusy(false);
      onOpened(song);
    } catch (cause) {
      onBusy(false);
      setOpening(null);
      // Cancel is the person's own choice: back to the list without an error.
      if (!isStemFileStopped(cause)) {
        setFailure(cloudErrorText(cause, drive.provider) ?? errorText(cause));
      }
    }
  };

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
      <TargetArt />
      <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
        <DialogTitle className="flex items-center gap-2.5 text-2xl font-bold">
          <CloudProviderLogo provider={drive.provider} className="h-6 w-auto max-w-8 shrink-0" />
          Open from {drive.label}
        </DialogTitle>
        <DialogDescription className="text-sm sm:text-base">
          These are the stems saved to {drive.label}. Pick one to open it.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 px-6 md:px-9">
        {opening && <OpenProgress opening={opening} />}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        {!opening && list.status === "loading" && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-xl border bg-card/85 p-4 text-sm text-muted-foreground dark:bg-card/80"
          >
            <Loader2Icon
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Loading the saved stems from {drive.label}…
          </p>
        )}
        {!opening && list.status === "error" && (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-card/85 p-4 text-sm dark:bg-card/80"
          >
            <p className="flex items-start gap-2">
              <CloudOffIcon
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <span>{list.message}</span>
            </p>
            <Button variant="outline" onClick={refresh} className="bg-card">
              <RefreshCwIcon data-icon="inline-start" />
              Retry
            </Button>
          </div>
        )}
        {!opening && list.status === "ready" && list.files.length === 0 && (
          <p className="rounded-xl border bg-card/85 p-4 text-sm text-muted-foreground dark:bg-card/80">
            No saved stems in {drive.label} yet. Use Save stems on a separated song to add one.
          </p>
        )}
        {!opening && list.status === "ready" && list.files.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={`Saved stems in ${drive.label}`}>
            {list.files.map((file, index) => (
              <li key={file.id} className="min-w-0">
                <button
                  type="button"
                  className="group flex min-h-[64px] w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-xl border bg-card/85 px-4 py-3 text-left transition-[border-color,background-color] duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none dark:bg-card/80"
                  onClick={() => void open(file)}
                  title={file.name}
                  data-testid="drive-stem"
                >
                  <LayersIcon
                    aria-hidden="true"
                    className={cn(
                      "size-[22px] shrink-0",
                      index % 2 === 0 ? "text-brand-yellow" : "text-brand",
                    )}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-base font-bold">{stemName(file.name)}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {[
                        formatBytes(file.size),
                        file.modified_ms ? new Date(file.modified_ms).toLocaleDateString() : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
        <Button
          variant="outline"
          size="lg"
          className="min-w-28 bg-card"
          onClick={onBack}
          disabled={opening !== null}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          Back
        </Button>
        {opening ? (
          <Button
            variant="outline"
            size="lg"
            className="bg-card"
            onClick={() => void cancelStemSeparation().catch(() => {})}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            className="bg-card"
            onClick={refresh}
            disabled={list.status === "loading"}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

/** The file being downloaded and read: "Downloading… 40%", then "Opening…". */
function OpenProgress({
  opening,
}: {
  opening: { name: string; stage: BundleProgress["stage"]; fraction: number };
}) {
  const percent = Math.round(Math.min(1, Math.max(0, opening.fraction)) * 100);
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-xl border bg-card/85 px-4 py-3 text-sm"
    >
      <p className="font-semibold">
        {opening.stage === "downloading" ? "Downloading…" : "Opening…"}{" "}
        <span className="font-normal text-muted-foreground">{opening.name}</span>
      </p>
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label="Open progress"
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
