import { useContext, useEffect, useId, useRef, type ReactNode } from "react";
import type { TooltipRenderProps } from "react-joyride";

import { CoachActionsContext } from "@/hooks/use-tour";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What a step hands its coach mark besides the text (react-joyride's `step.data`). */
export interface CoachData {
  /** Asked when the card is drawn: is there an earlier step to go back to? */
  canGoBack: () => boolean;
  /** The last step of the main tour offers the other tours. */
  choices?: readonly { id: string; title: string; description: string }[];
}

export interface CoachCardProps {
  index: number;
  size: number;
  title: ReactNode;
  body: ReactNode;
  isLast: boolean;
  canGoBack: boolean;
  choices?: CoachData["choices"];
  onChoose?: (id: string) => void;
  onBack?: () => void;
  onNext?: () => void;
  onSkip?: () => void;
  /** Spread on the container (react-joyride's tooltip props). */
  containerProps?: Record<string, unknown>;
  /** Inside a dialog: a full-width strip at its bottom instead of a floating card. */
  inline?: boolean;
  nextProps?: Record<string, unknown>;
  backProps?: Record<string, unknown>;
  skipProps?: Record<string, unknown>;
}

/**
 * The tour's coach card (#84): a short title and sentence, the step count, Back, Next and Skip.
 * It is a non-modal group, so the rest of the page stays reachable by keyboard; focus moves to
 * Next when a step opens so Enter carries on, and Escape closes the tour.
 */
export function CoachCard({
  index,
  size,
  title,
  body,
  isLast,
  canGoBack,
  choices,
  onChoose,
  onBack,
  onNext,
  onSkip,
  containerProps,
  inline = false,
  nextProps,
  backProps,
  skipProps,
}: CoachCardProps) {
  const titleId = useId();
  const bodyId = useId();
  const next = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    next.current?.focus({ preventScroll: true });
  }, [index]);

  return (
    <div
      {...containerProps}
      role="dialog"
      aria-modal={false}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="coach-mark"
      data-tour-coach=""
      className={cn(
        "border-foreground/15 bg-popover p-4 text-popover-foreground",
        inline
          ? "mx-3 mb-3 max-h-[45vh] shrink-0 overflow-y-auto rounded-xl border-2 border-ring/60"
          : "w-[min(22rem,calc(100vw-2rem))] rounded-xl border shadow-lg ring-1 ring-foreground/5",
      )}
    >
      <p className="mb-1 text-xs font-medium text-muted-foreground" aria-live="polite">
        Step {index + 1} of {size}
      </p>
      <h2 id={titleId} className="font-heading text-base font-semibold">
        {title}
      </h2>
      <p id={bodyId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {body}
      </p>
      {choices && choices.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {choices.map((choice) => (
            <li key={choice.id}>
              <Button
                variant="outline"
                size="sm"
                className="h-auto w-full flex-col items-start gap-0 py-1.5 text-left whitespace-normal"
                onClick={() => onChoose?.(choice.id)}
              >
                <span className="font-medium">{choice.title}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {choice.description}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onSkip}
          {...skipProps}
          title={undefined}
          className="text-muted-foreground"
        >
          Skip
        </Button>
        <div className="flex gap-2">
          {canGoBack && (
            <Button variant="outline" size="sm" onClick={onBack} {...backProps} title={undefined}>
              Back
            </Button>
          )}
          <Button ref={next} size="sm" onClick={onNext} {...nextProps} title={undefined}>
            {isLast ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** react-joyride's tooltip: the card, wired to joyride's own buttons. */
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
  const data = step.data as Partial<CoachData> | undefined;
  const { onChoose } = useContext(CoachActionsContext);
  return (
    <CoachCard
      index={index}
      size={size}
      title={step.title}
      body={step.content}
      isLast={isLastStep}
      canGoBack={data?.canGoBack?.() ?? false}
      choices={data?.choices}
      onChoose={onChoose}
      containerProps={tooltipProps}
      nextProps={primaryProps}
      backProps={backProps}
      skipProps={skipProps}
    />
  );
}
