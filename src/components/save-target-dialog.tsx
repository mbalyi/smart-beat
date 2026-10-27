import { ChevronRightIcon } from "lucide-react";

import laptop from "@/assets/cloud/laptop.webp";
import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { CloudProviderLogo } from "@/components/cloud-provider-logos";
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

const CARD =
  "group relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-2xl border text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/60";

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
        className={`${DIALOG_NEON} max-h-[calc(100dvh-2rem)] sm:max-w-3xl`}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
          <TargetArt />
          <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
            <DialogTitle className="text-3xl leading-tight font-extrabold sm:text-4xl">
              {opening ? "Where is the song?" : "Where do you want to save?"}
            </DialogTitle>
            <DialogDescription className="text-sm sm:text-base">
              {opening
                ? "Pick a file on this computer, or one of the songs in your online drive."
                : "Keep the song on this computer, or put it in your online drive to open it on every device."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-3 overflow-visible px-6 md:px-9">
            <button
              type="button"
              className={`${CARD} min-h-24 border-primary/70 bg-gradient-to-r from-primary/25 via-primary/10 to-card/80 pr-4 hover:border-primary hover:from-primary/35`}
              onClick={() => onChoose("computer")}
              data-testid="save-target-computer"
            >
              <img
                src={laptop}
                alt=""
                aria-hidden="true"
                className="pointer-events-none -my-2 ml-1 h-24 w-auto shrink-0 object-contain sm:h-28"
              />
              <span className="min-w-0 flex-1 text-lg font-bold sm:text-2xl">
                {verb} this computer…
              </span>
              <ChevronRightIcon className="size-6 shrink-0" aria-hidden="true" />
            </button>
            {providers.length > 0 && (
              <div
                className={`grid grid-cols-1 gap-3 ${
                  providers.length === 1
                    ? "sm:grid-cols-1"
                    : providers.length === 2
                      ? "sm:grid-cols-2"
                      : "sm:grid-cols-3"
                }`}
              >
                {providers.map(({ provider, label }) => (
                  <button
                    key={provider}
                    type="button"
                    className={`${CARD} flex-row items-end border-border bg-card/85 p-3 hover:border-primary/70 sm:min-h-40 sm:flex-col sm:items-stretch sm:gap-1`}
                    onClick={() => onChoose(provider)}
                    aria-label={`${verb} ${label}`}
                    data-testid={`save-target-${provider}`}
                  >
                    <span className="relative flex h-16 w-20 shrink-0 items-center justify-center self-start sm:h-20 sm:w-full sm:justify-start">
                      <img
                        src={splashRight}
                        alt=""
                        aria-hidden="true"
                        className="absolute top-1/2 left-0 h-full w-20 -translate-y-1/2 object-cover opacity-70 sm:w-28"
                      />
                      <CloudProviderLogo
                        provider={provider}
                        className="relative ml-3 h-10 w-auto drop-shadow-md sm:h-12"
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 items-end justify-between gap-2">
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="text-sm text-muted-foreground">{verb}</span>
                        <span className="text-xl font-bold sm:text-2xl">{label}</span>
                      </span>
                      <ChevronRightIcon className="mb-1 size-6 shrink-0" aria-hidden="true" />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter className="mt-0 flex-row justify-end border-t-0 bg-transparent px-6 pt-4 pb-5 md:px-9">
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
