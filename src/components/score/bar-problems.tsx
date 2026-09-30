import { TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describeProblem, isShort, type BarProblem } from "@/lib/score/bar-duration";

/** How many bars are named before the list says "and N more". */
const LISTED = 4;

/**
 * Warns that bars of the shown track do not add up to their time signature,
 * and offers to fix them. Guitar Pro calls these "incomplete bars".
 */
export function BarProblems({
  problems,
  onFix,
  onGoTo,
}: {
  problems: BarProblem[];
  onFix: () => void;
  /** Moves the cursor to a bar (0-based). */
  onGoTo: (bar: number) => void;
}) {
  if (problems.length === 0) return null;
  const bars = [...new Set(problems.map((p) => p.bar))];
  const first = problems[0]!;
  const listed = bars.slice(0, LISTED).map((bar) => bar + 1);
  const more = bars.length - listed.length;
  const summary =
    bars.length === 1
      ? describeProblem(first)
      : `${bars.length} bars have the wrong length: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return (
    <div
      role="status"
      aria-label="Bar lengths"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-950 sm:px-6 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {summary}
        {bars.length === 1 &&
          (isShort(first) ? " — it can be filled with rests." : " — it can be trimmed.")}
      </span>
      <Button size="sm" variant="outline" onClick={() => onGoTo(first.bar)}>
        Go to bar {first.bar + 1}
      </Button>
      <Button size="sm" onClick={onFix}>
        {bars.length === 1 ? "Fix bar" : "Fix all"}
      </Button>
    </div>
  );
}
