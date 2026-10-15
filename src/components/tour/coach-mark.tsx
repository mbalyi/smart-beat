import { useEffect, useId, useRef } from "react";
import type { TooltipRenderProps } from "react-joyride";

import { Button } from "@/components/ui/button";

/**
 * The tour's coach mark (#84): a short title and sentence, the step count, Back, Next and Skip.
 * It is a non-modal dialog, so the rest of the page stays reachable by keyboard; focus moves
 * to Next when a step opens so Enter carries on, and Escape closes the tour (react-joyride).
 */
export function CoachMark({
  index,
  size,
  isLastStep,
  step,
  backProps,
  primaryProps,
  skipProps,
  tooltipProps,
}: TooltipRenderProps) {
  const titleId = useId();
  const bodyId = useId();
  const next = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    next.current?.focus({ preventScroll: true });
  }, [index]);

  return (
    <div
      {...tooltipProps}
      role="dialog"
      aria-modal={false}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="coach-mark"
      className="w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-foreground/15 bg-popover p-4 text-popover-foreground shadow-lg ring-1 ring-foreground/5"
    >
      <p className="mb-1 text-xs font-medium text-muted-foreground" aria-live="polite">
        Step {index + 1} of {size}
      </p>
      <h2 id={titleId} className="font-heading text-base font-semibold">
        {step.title}
      </h2>
      <p id={bodyId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {step.content}
      </p>
      <div className="mt-4 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          {...skipProps}
          title={undefined}
          className="text-muted-foreground"
        >
          Skip
        </Button>
        <div className="flex gap-2">
          {(step.data as { canGoBack?: () => boolean } | undefined)?.canGoBack?.() && (
            <Button variant="outline" size="sm" {...backProps} title={undefined}>
              Back
            </Button>
          )}
          <Button ref={next} size="sm" {...primaryProps} title={undefined}>
            {isLastStep ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
