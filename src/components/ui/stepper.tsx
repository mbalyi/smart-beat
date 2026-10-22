import { CheckIcon } from "lucide-react";
import { cn } from "cn";

/**
 * A horizontal stepper in the shadcn style: an indicator and a title per step, joined by a line.
 * The steps share the width in equal columns and sit centred in them, and each line runs from
 * the centre of one indicator to the centre of the next, behind the indicators, so the line and
 * the indicators always touch. Done steps are ticked, the current one is filled with a glow.
 */
function Stepper({
  steps,
  current,
  start = 1,
  className,
}: {
  steps: readonly string[];
  /** Index into `steps` of the step that is on. */
  current: number;
  /** The number shown on the first step; 0 for a step before the first. */
  start?: number;
  className?: string;
}) {
  return (
    <ol data-slot="stepper" aria-label="Steps" className={cn("flex w-full items-start", className)}>
      {steps.map((title, index) => {
        const done = index < current;
        const on = index === current;
        return (
          <li
            key={title}
            data-slot="stepper-item"
            data-state={done ? "done" : on ? "active" : "pending"}
            aria-current={on ? "step" : undefined}
            className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5"
          >
            {index > 0 && (
              <span
                data-slot="stepper-separator"
                aria-hidden="true"
                className={cn(
                  "absolute top-4 right-1/2 left-[-50%] h-0.5 -translate-y-1/2 transition-colors",
                  index <= current ? "bg-primary" : "bg-border",
                )}
              />
            )}
            <span
              data-slot="stepper-indicator"
              className={cn(
                "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors",
                done || on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground",
                on && "shadow-[0_0_12px_color-mix(in_oklab,var(--primary)_70%,transparent)]",
              )}
            >
              {done ? (
                <CheckIcon aria-hidden="true" className="size-4" />
              ) : (
                <span aria-hidden="true">{index + start}</span>
              )}
            </span>
            <span
              data-slot="stepper-title"
              className={cn(
                "max-w-full px-1 text-center text-xs leading-tight",
                on ? "font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {title}
              <span className="sr-only">{done ? " (done)" : on ? " (current step)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export { Stepper };
