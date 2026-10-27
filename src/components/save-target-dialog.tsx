import { ChevronRightIcon, CloudIcon, LockIcon, TriangleAlertIcon } from "lucide-react";

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
  onSetupCloud,
  phase = "choose",
  target,
  fileName,
  error,
  onRetry,
}: {
  mode?: "open" | "save";
  providers: { provider: CloudProvider; label: string; disabled?: boolean; hint?: string }[];
  open: boolean;
  onChoose: (target: "computer" | CloudProvider) => void;
  onCancel: () => void;
  onSetupCloud?: () => void;
  /** Save As only: `saving` replaces the choice with the running upload, `error` offers a retry. */
  phase?: "choose" | "saving" | "error";
  target?: CloudProvider;
  fileName?: string;
  error?: string;
  onRetry?: () => void;
}) {
  const saving = phase === "saving";
  const failed = phase === "error";
  const label = providers.find((p) => p.provider === target)?.label ?? "your drive";
  const opening = mode === "open";
  const verb = opening ? "Open from" : "Save to";
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !saving && onCancel()}>
      <DialogContent
        size="xl"
        showCloseButton={!saving}
        data-testid="save-target-dialog"
        className={`${DIALOG_NEON} max-h-[calc(100dvh-2rem)] sm:max-w-3xl`}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
          <TargetArt />
          <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
            <DialogTitle className="text-3xl leading-tight font-extrabold sm:text-4xl">
              {saving
                ? `Saving to ${label}…`
                : failed
                  ? `Couldn't save to ${label}`
                  : opening
                    ? "Where is the song?"
                    : "Where do you want to save?"}
            </DialogTitle>
            <DialogDescription className="text-sm sm:text-base">
              {saving || failed
                ? (fileName ?? "")
                : opening
                  ? "Pick a file on this computer, or one of the songs in your online drive."
                  : "Keep the song on this computer, or put it in your online drive to open it on every device."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-3 overflow-visible px-6 md:px-9">
            {(saving || failed) && target ? (
              <div
                className="flex min-h-40 flex-col justify-center gap-4 rounded-2xl border border-border bg-card/85 p-5"
                role={failed ? "alert" : "status"}
                aria-live={failed ? undefined : "polite"}
                data-testid="save-target-progress"
              >
                <div className="flex items-center gap-4">
                  <CloudProviderLogo provider={target} className="h-12 w-auto drop-shadow-md" />
                  <span className="text-lg font-bold sm:text-2xl">
                    {saving ? `Saving to ${label}…` : "Not saved"}
                  </span>
                </div>
                {saving ? (
                  <div
                    className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20"
                    aria-hidden="true"
                  >
                    <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-primary" />
                  </div>
                ) : (
                  <p className="flex items-start gap-2 text-sm sm:text-base">
                    <TriangleAlertIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                    <span data-testid="save-target-error">{error}</span>
                  </p>
                )}
              </div>
            ) : (
              <>
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
                    {providers.map(({ provider, label, disabled = false, hint }) => (
                      <button
                        key={provider}
                        type="button"
                        disabled={disabled}
                        className={`${CARD} flex-row items-end border-border bg-card/85 p-3 sm:min-h-40 sm:flex-col sm:items-stretch sm:gap-1 ${
                          disabled
                            ? "cursor-not-allowed opacity-55 grayscale"
                            : "hover:border-primary/70"
                        }`}
                        onClick={() => onChoose(provider)}
                        aria-label={
                          hint ? `${verb} ${label}, ${hint.toLowerCase()}` : `${verb} ${label}`
                        }
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
                            {hint && (
                              <span className="text-xs text-muted-foreground" aria-hidden="true">
                                {hint}
                              </span>
                            )}
                          </span>
                          {disabled ? (
                            <LockIcon className="mb-1 size-5 shrink-0" aria-hidden="true" />
                          ) : (
                            <ChevronRightIcon className="mb-1 size-6 shrink-0" aria-hidden="true" />
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter className="mt-0 flex-row flex-wrap items-center justify-end gap-2 border-t-0 bg-transparent px-6 pt-4 pb-5 md:px-9">
            {failed && (
              <Button
                variant="outline"
                size="sm"
                className="relative z-10 mr-auto rounded-full border-border bg-card px-3 text-foreground shadow-sm"
                onClick={() => onChoose("computer")}
                data-testid="save-target-computer-fallback"
              >
                Save to this computer…
              </Button>
            )}
            {onSetupCloud && !saving && !failed && (
              <Button
                variant="outline"
                size="sm"
                className="relative z-10 mr-auto rounded-full border-border bg-card px-3 text-foreground shadow-sm"
                onClick={onSetupCloud}
                data-testid="save-target-setup"
              >
                <CloudIcon aria-hidden="true" />
                Set up cloud storage
              </Button>
            )}
            {failed && onRetry && (
              <Button
                size="lg"
                className="min-w-28"
                onClick={onRetry}
                data-testid="save-target-retry"
              >
                Try again
              </Button>
            )}
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              onClick={onCancel}
              disabled={saving}
              data-testid="save-target-cancel"
            >
              {failed ? "Close" : "Cancel"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
