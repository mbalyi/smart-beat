import type { ReactNode } from "react";

import { DIALOG_NEON, DialogArt, DialogStepper } from "@/components/ai/dialog-art";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import hero from "@/assets/features/practice-together.png";
import logo from "@/assets/practice-together/logo.webp";

/** The frame of the dialogs: the neon ring and a height that stays put between steps. */
const FRAME = `${DIALOG_NEON} h-[min(46rem,calc(100dvh-2rem))] sm:max-w-3xl`;

/**
 * The window of Practice together, shared by the dialog of an open tab and the one of the start
 * screen: the neon frame, the logo, the description above the stepper, and the graffiti. The
 * title is the logo; screen readers get it as text.
 */
export function TogetherFrame({
  open,
  onOpenChange,
  steps,
  step,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  steps: readonly string[];
  step: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className={FRAME} data-testid={testId}>
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <DialogArt name="practice-together" />
          <DialogHeader className="gap-2 px-6 pt-3 md:px-9">
            <DialogTitle className="flex items-center">
              <img
                src={logo}
                alt=""
                aria-hidden="true"
                data-testid="together-logo"
                className="-mt-3 -ml-5 h-[84px] w-auto max-w-[80%] object-contain"
              />
              <span className="sr-only">Practice together</span>
            </DialogTitle>
            <DialogDescription className="mb-2 text-base">
              Play the same tab with someone else, in time. Each of you hears your own sound; the
              host starts and stops for both.
            </DialogDescription>
            <DialogStepper labels={steps} current={step} />
          </DialogHeader>
          {open && children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The body's content with the hero picture at its top right. The cards flow around it on wide
 * windows (the cards are flex boxes, which sit beside a float instead of under it, and are
 * as wide as the room allows); on narrow windows the picture is left out.
 */
export function TogetherContent({ children }: { children: ReactNode }) {
  return (
    <div className="flow-root">
      <img
        src={hero}
        alt=""
        aria-hidden="true"
        data-hero="practice-together"
        className="pointer-events-none float-right mb-3 ml-4 hidden w-[34%] max-w-72 md:block"
      />
      <div className="[&>*+*]:mt-4 [&>p]:flow-root">{children}</div>
    </div>
  );
}

/** A card of the dialogs. */
export const CARD = "rounded-xl border bg-card/90 p-4 dark:bg-card/85";

/** A toggle group item of the dialogs: large, filled with the primary colour when on. */
export const CHOICE =
  "h-9 gap-2 rounded-lg px-4 text-sm font-semibold data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";
