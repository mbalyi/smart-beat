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
import type { Updater, UpdaterState } from "@/hooks/use-updater";
import { describeProgress, type DownloadProgress, type UpdateInfo } from "@/lib/updater";

function titleOf(state: UpdaterState): string {
  switch (state.status) {
    case "checking":
      return "Checking for updates";
    case "up-to-date":
      return "You're up to date";
    case "available":
      return "Update available";
    case "downloading":
      return "Downloading the update";
    case "installing":
      return "Installing the update";
    case "error":
      return "Couldn't update Smart Beat";
    case "idle":
      return "Updates";
  }
}

function descriptionOf(state: UpdaterState): string {
  switch (state.status) {
    case "checking":
      return "Looking for a newer version of Smart Beat.";
    case "up-to-date":
      return state.version
        ? `Smart Beat ${state.version} is the latest version.`
        : "You have the latest version of Smart Beat.";
    case "available":
      return "A newer version of Smart Beat is ready to download. Nothing is installed until you say so.";
    case "downloading":
    case "installing":
      return "Smart Beat restarts when the update is installed.";
    case "error":
      return "The update didn't go through. Your songs and settings are untouched.";
    case "idle":
      return "";
  }
}

function Versions({ info }: { info: UpdateInfo }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
      <dt className="text-muted-foreground">Installed version</dt>
      <dd className="font-medium tabular-nums">{info.currentVersion}</dd>
      <dt className="text-muted-foreground">Available version</dt>
      <dd className="font-medium tabular-nums">{info.version}</dd>
    </dl>
  );
}

function ReleaseNotes({ notes }: { notes: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 id="release-notes-title" className="text-sm font-medium">
        Release notes
      </h3>
      {/* Plain text on purpose: the notes come from the network and are never rendered as HTML. */}
      <div
        role="region"
        aria-labelledby="release-notes-title"
        tabIndex={0}
        className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {notes || "No release notes were published for this version."}
      </div>
    </div>
  );
}

function DownloadBar({ progress }: { progress: DownloadProgress }) {
  const { downloaded, total } = progress;
  return (
    <div className="flex flex-col gap-2">
      <progress
        aria-label="Download progress"
        // No value while the size is unknown: the browser shows an indeterminate bar.
        value={total ? Math.min(downloaded, total) : undefined}
        max={total ?? undefined}
        className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
      />
      <p className="text-xs text-muted-foreground tabular-nums">{describeProgress(progress)}</p>
    </div>
  );
}

function BodyOf({ state }: { state: UpdaterState }) {
  switch (state.status) {
    case "checking":
      return <p role="status">Checking…</p>;
    case "available":
      return (
        <>
          <Versions info={state.info} />
          <ReleaseNotes notes={state.info.notes} />
        </>
      );
    case "downloading":
      return (
        <>
          <Versions info={state.info} />
          <DownloadBar progress={state.progress} />
        </>
      );
    case "installing":
      return (
        <>
          <Versions info={state.info} />
          <p role="status">Installing version {state.info.version}…</p>
        </>
      );
    case "error":
      return <p role="alert">{state.message}</p>;
    case "up-to-date":
    case "idle":
      return null;
  }
}

/** Help › Check for Updates… and the prompt an automatic check shows when it finds an update. */
export function UpdateDialog({ updater }: { updater: Updater }) {
  const { state, open, install, dismiss, checkNow } = updater;
  const busy = state.status === "downloading" || state.status === "installing";
  const body = BodyOf({ state });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        size="md"
        showCloseButton={!busy}
        // Closing mid-download would leave the update half done.
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{titleOf(state)}</DialogTitle>
          <DialogDescription>{descriptionOf(state)}</DialogDescription>
        </DialogHeader>
        {body && <DialogBody>{body}</DialogBody>}
        {!busy && (
          <DialogFooter>
            {state.status === "available" ? (
              <>
                <Button variant="outline" onClick={dismiss}>
                  Later
                </Button>
                <Button onClick={install}>Download &amp; Install</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={dismiss}>
                  Close
                </Button>
                {state.status === "error" && <Button onClick={checkNow}>Try again</Button>}
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
