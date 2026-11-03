import { CloudIcon, TriangleAlertIcon } from "lucide-react";

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
import { ComputerCard, StorageCard, StorageGrid, TargetArt } from "@/components/target-cards";
import type { CloudProvider } from "@/lib/cloud";

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
            <DialogTitle className="text-2xl font-bold">
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
                <ComputerCard
                  label={`${verb} this computer`}
                  onClick={() => onChoose("computer")}
                  testId="save-target-computer"
                />
                {providers.length > 0 && (
                  <StorageGrid count={providers.length}>
                    {providers.map(({ provider, label, disabled = false, hint }) => (
                      <StorageCard
                        key={provider}
                        art={
                          <CloudProviderLogo
                            provider={provider}
                            className="h-10 w-auto drop-shadow-md sm:h-12"
                          />
                        }
                        verb={verb}
                        label={label}
                        hint={hint}
                        disabled={disabled}
                        onClick={() => onChoose(provider)}
                        testId={`save-target-${provider}`}
                      />
                    ))}
                  </StorageGrid>
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
                Save to this computer
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
