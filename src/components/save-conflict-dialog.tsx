import { CopyPlusIcon, RefreshCwIcon } from "lucide-react";

import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import { DIALOG_NEON } from "@/components/ai/dialog-art";
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

/** How the user settles a file that changed on disk while it was open. */
export type ConflictChoice = "copy" | "reload";

/** The graffiti behind the dialog: behind everything, never in the way, hidden from readers. */
function ConflictArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        src={splashLeft}
        alt=""
        className="absolute bottom-0 left-0 w-[40%] opacity-50 dark:opacity-90"
      />
      <img
        src={splashRight}
        alt=""
        className="absolute right-0 bottom-0 w-[20%] opacity-50 dark:opacity-90"
      />
    </div>
  );
}

/**
 * Shown when Save finds the file changed on disk since it was opened (another device synced a
 * newer version, #187). Nothing is overwritten until the user chooses.
 */
export function SaveConflictDialog({
  fileName,
  open,
  onChoose,
  onCancel,
}: {
  fileName: string;
  open: boolean;
  onChoose: (choice: ConflictChoice) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent
        size="xl"
        data-testid="save-conflict-dialog"
        className={`${DIALOG_NEON} h-[min(30rem,calc(100dvh-2rem))] sm:max-w-2xl`}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <ConflictArt />
          <DialogHeader className="px-6 md:px-9">
            <DialogTitle className="text-2xl font-bold">“{fileName}” changed on disk</DialogTitle>
            <DialogDescription>
              This file was changed after you opened it, maybe on another device that syncs with
              your cloud folder. Saving now would overwrite that newer version. Nothing has been
              overwritten yet.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-3 px-6 md:px-9">
            <div className="rounded-xl border bg-card/85 p-4 dark:bg-card/80">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <CopyPlusIcon className="size-4 text-primary" aria-hidden="true" />
                Save as a copy
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Keeps both: your changes go into a new file and the file on disk stays as it is.
              </p>
            </div>
            <div className="rounded-xl border bg-card/85 p-4 dark:bg-card/80">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <RefreshCwIcon className="size-4 text-primary" aria-hidden="true" />
                Reload from disk
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Opens the newer version again. Your unsaved changes here are lost.
              </p>
            </div>
          </DialogBody>
          <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              onClick={onCancel}
              data-testid="conflict-cancel"
            >
              Cancel
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="lg"
                className="bg-card"
                onClick={() => onChoose("reload")}
                data-testid="conflict-reload"
              >
                <RefreshCwIcon data-icon="inline-start" />
                Reload from disk
              </Button>
              <Button
                size="lg"
                className="min-w-40"
                onClick={() => onChoose("copy")}
                data-testid="conflict-copy"
              >
                <CopyPlusIcon data-icon="inline-start" />
                Save as a copy
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
