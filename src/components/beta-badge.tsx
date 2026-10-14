import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Marks Record to Tab as a beta feature, in its dialog and next to the items that open it. */
export function BetaBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full border-brand/60 bg-brand/10 px-2 py-0 text-xs font-medium text-brand dark:text-[#e29bff]",
        className,
      )}
    >
      Beta
    </Badge>
  );
}
