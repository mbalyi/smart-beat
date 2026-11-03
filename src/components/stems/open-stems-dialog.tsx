import { ArrowLeftIcon, CloudIcon, CloudOffIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { CloudStemCard } from "@/components/cloud-stems";
import { useCloudStemList } from "@/components/stems/use-cloud-stem-list";
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
import { getCloudFolder } from "@/lib/tauri";

/** The last part of a folder path ("Dropbox" for `/Users/me/Dropbox`). */
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/**
 * Open saved stems (#186): works like Open for songs. It asks where the `.sbstems` file is: on
 * this computer (the native file dialog, after this one has closed) or in the linked cloud
 * folder, whose saved stems are listed here. Without a linked folder a card leads to Settings.
 * The dialog closes before the choice is handed over.
 */
export function OpenStemsDialog({
  open,
  onOpenChange,
  onPickComputer,
  onOpenStem,
  onSetupCloud,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Open from this computer": the caller shows the native file dialog. */
  onPickComputer: () => void;
  /** A saved stems file of the cloud folder was picked. */
  onOpenStem: (path: string) => void;
  /** "Set up cloud storage": the caller shows Settings on the cloud folder section. */
  onSetupCloud: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        data-testid="open-stems-dialog"
        className={`${DIALOG_NEON} max-h-[calc(100dvh-2rem)] sm:max-w-3xl`}
      >
        {/* Mounted only while open, so every visit starts at the choice. */}
        {open && (
          <OpenFlow
            onClose={() => onOpenChange(false)}
            onPickComputer={onPickComputer}
            onOpenStem={onOpenStem}
            onSetupCloud={onSetupCloud}
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
}: {
  onClose: () => void;
  onPickComputer: () => void;
  onOpenStem: (path: string) => void;
  onSetupCloud: () => void;
}) {
  const [view, setView] = useState<"choose" | "cloud">("choose");
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
          Pick a saved stems file on this computer, or one in your cloud folder.
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
        {folder !== undefined && (
          <StorageGrid count={1}>
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
              <StorageCard
                art={<CloudIcon className="size-10 text-primary sm:size-12" aria-hidden="true" />}
                verb="Set up"
                label="Cloud storage"
                hint="Link a cloud folder in Settings to open stems from your cloud."
                describeHint
                onClick={() => {
                  onClose();
                  onSetupCloud();
                }}
                testId="open-stems-setup"
              />
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
