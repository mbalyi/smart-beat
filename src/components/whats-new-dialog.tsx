import { PlayIcon } from "lucide-react";

import type { AppDialogProps } from "@/components/app-dialogs";
import hero from "@/assets/whats-new/hero.webp";
import icon1 from "@/assets/whats-new/icon-1.webp";
import icon2 from "@/assets/whats-new/icon-2.webp";
import icon3 from "@/assets/whats-new/icon-3.webp";
import splashLeft from "@/assets/whats-new/splash-bottom-left.webp";
import splashRight from "@/assets/whats-new/splash-bottom-right.webp";
import title from "@/assets/whats-new/title.webp";
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

/** The icons above the cards, used one after the other in this order. */
const ICONS = [icon1, icon2, icon3] as const;
const iconFor = (index: number) => ICONS[index % ICONS.length]!;

/** The graffiti around the dialog: behind everything, never in the way, hidden from readers. */
function WhatsNewArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        src={splashLeft}
        alt=""
        className="absolute bottom-0 left-0 w-[38%] opacity-50 dark:opacity-90"
      />
      <img
        src={splashRight}
        alt=""
        className="absolute right-0 bottom-0 w-[30%] opacity-50 dark:opacity-90"
      />
    </div>
  );
}

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
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        size="xl"
        className="shadow-[0_0_32px_color-mix(in_oklab,var(--brand)_45%,transparent)] ring-2 ring-brand/80 sm:max-w-4xl"
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <WhatsNewArt />
          <DialogHeader className="flex-row items-center gap-4 px-6 pt-2 pb-0 md:px-10">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle className="mt-[-8px] ml-[-32px] flex items-start">
                <img
                  src={title}
                  alt=""
                  aria-hidden="true"
                  className="w-[300px] max-w-full sm:w-[420px]"
                />
                <span className="sr-only">What’s new in {version}</span>
              </DialogTitle>
              <DialogDescription className="text-base">
                New and changed features in version {version}. “Show me” opens a short tour of the
                feature.
              </DialogDescription>
            </div>
            <img
              src={hero}
              alt=""
              aria-hidden="true"
              className="mt-[-16px] mr-[-32px] hidden w-[40%] max-w-[360px] shrink-0 md:block"
            />
          </DialogHeader>
          <DialogBody className="mt-[-8px] px-6 pt-0 pb-6 md:px-10">
            <ul
              aria-label="New features"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            >
              {features.map((feature, index) => (
                <li
                  key={feature.id}
                  data-testid="whats-new-card"
                  className="flex flex-col items-center gap-0.5 rounded-xl border bg-card/85 px-2 pt-1 pb-2.5 text-center dark:bg-card/80"
                >
                  <img
                    src={iconFor(index)}
                    alt=""
                    aria-hidden="true"
                    className="-mb-1 size-32 shrink-0 object-contain"
                  />
                  <h3 className="mt-[-8px] text-base font-semibold">{feature.title}</h3>
                  <p className="mb-2 text-sm text-muted-foreground">{feature.summary}</p>
                  {feature.tour && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-auto h-9 gap-2 border-2 border-sky-500 bg-transparent px-5 text-sm font-semibold text-foreground hover:bg-sky-500/15 dark:border-sky-500 dark:bg-transparent"
                      aria-label={`Show me: ${feature.title}`}
                      onClick={() => {
                        onOpenChange(false);
                        onShowMe(feature.tour!);
                      }}
                    >
                      <PlayIcon aria-hidden="true" fill="currentColor" />
                      Show me
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}
