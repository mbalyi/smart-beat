import type { AppDialogProps } from "@/components/app-dialogs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeatureEntry, TourId } from "@/lib/tour/feature-registry";

/** What came with a release (#84), each with a "Show me" that starts the tour for it. */
export function WhatsNewDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  version,
  features,
  onShowMe,
}: AppDialogProps & {
  version: string;
  features: readonly FeatureEntry[];
  onShowMe: (tour: TourId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} size="md">
        <DialogHeader>
          <DialogTitle>What’s new in {version}</DialogTitle>
          <DialogDescription>
            New and changed features. “Show me” opens a short tour of the feature.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="flex flex-col gap-3">
            {features.map((feature) => (
              <li
                key={feature.id}
                className="flex items-start justify-between gap-3 rounded-lg border p-3"
              >
                <div>
                  <h3 className="text-sm font-medium">{feature.title}</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">{feature.summary}</p>
                </div>
                {feature.tour && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Show me: ${feature.title}`}
                    onClick={() => {
                      onOpenChange(false);
                      onShowMe(feature.tour!);
                    }}
                  >
                    Show me
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
