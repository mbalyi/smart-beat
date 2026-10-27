import { CloudIcon, HardDriveIcon } from "lucide-react";

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
import type { CloudProvider } from "@/lib/cloud";

/** The graffiti behind the dialog: behind everything, never in the way, hidden from readers. */
function TargetArt() {
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

/** Save As or Open, when an online drive is connected: this computer, or one of the drives. */
export function SaveTargetDialog({
  mode = "save",
  providers,
  open,
  onChoose,
  onCancel,
}: {
  mode?: "open" | "save";
  providers: { provider: CloudProvider; label: string }[];
  open: boolean;
  onChoose: (target: "computer" | CloudProvider) => void;
  onCancel: () => void;
}) {
  const opening = mode === "open";
  const verb = opening ? "Open from" : "Save to";
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent
        size="xl"
        data-testid="save-target-dialog"
        className={`${DIALOG_NEON} h-[min(26rem,calc(100dvh-2rem))] sm:max-w-2xl`}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <TargetArt />
          <DialogHeader className="px-6 md:px-9">
            <DialogTitle className="text-2xl font-bold">
              {opening ? "Where is the song?" : "Where do you want to save?"}
            </DialogTitle>
            <DialogDescription>
              {opening
                ? "Pick a file on this computer, or one of the songs in your online drive."
                : "Keep the song on this computer, or put it in your online drive to open it on every device."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-3 px-6 md:px-9">
            <Button
              variant="outline"
              size="lg"
              className="h-auto justify-start bg-card/85 py-3"
              onClick={() => onChoose("computer")}
              data-testid="save-target-computer"
            >
              <HardDriveIcon data-icon="inline-start" />
              {verb} this computer…
            </Button>
            {providers.map(({ provider, label }) => (
              <Button
                key={provider}
                variant="outline"
                size="lg"
                className="h-auto justify-start bg-card/85 py-3"
                onClick={() => onChoose(provider)}
                data-testid={`save-target-${provider}`}
              >
                <CloudIcon data-icon="inline-start" />
                {verb} {label}
              </Button>
            ))}
          </DialogBody>
          <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              onClick={onCancel}
              data-testid="save-target-cancel"
            >
              Cancel
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
