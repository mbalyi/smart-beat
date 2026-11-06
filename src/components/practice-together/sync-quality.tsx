import { UsersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { errorText, type SyncQuality } from "@/lib/practice-together/clock-sync";
import type { SessionState } from "@/lib/practice-together/session";
import { cn } from "@/lib/utils";

const WORDS = {
  none: "Syncing",
  excellent: "Excellent",
  good: "Good",
  unstable: "Unstable",
} as const;

const DOTS = {
  none: "bg-muted-foreground",
  excellent: "bg-emerald-500",
  good: "bg-amber-500",
  unstable: "bg-destructive",
} as const;

/** The sync-quality indicator: a coloured dot, the expected error and a word for it. */
export function SyncQualityBadge({ quality }: { quality: SyncQuality }) {
  return (
    <Badge variant="outline" className="h-6 gap-1.5 px-2.5 text-sm" data-bucket={quality.bucket}>
      <span aria-hidden="true" className={cn("size-2 rounded-full", DOTS[quality.bucket])} />
      <span className="tabular-nums">{errorText(quality)}</span>
      <span>{WORDS[quality.bucket]}</span>
    </Badge>
  );
}

/** The toolbar chip of a running session: who, how well synchronized. Opens the dialog. */
export function TogetherChip({
  state,
  onOpen,
}: {
  state: SessionState | null;
  onOpen: () => void;
}) {
  if (!state || state.phase === "closed") return null;
  const quality = state.role === "host" ? peerQuality(state) : state.quality;
  const synced = state.phase === "synchronized";
  const label = synced
    ? `Practice together: synchronized with ${state.peerName ?? "the other player"}, ${errorText(quality)}, ${WORDS[quality.bucket]}`
    : state.phase === "reconnecting"
      ? "Practice together: connection lost, reconnecting"
      : state.phase === "failed"
        ? "Practice together: the session ended"
        : "Practice together: connecting";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      data-tour="practice-together"
      data-testid="together-chip"
      data-phase={state.phase}
      className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-card px-2 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <UsersIcon aria-hidden="true" className="size-3.5" />
      <span aria-hidden="true" className={cn("size-2 rounded-full", chipDot(state, quality))} />
      <span aria-hidden="true" className="tabular-nums max-xl:sr-only">
        {synced ? errorText(quality) : state.phase === "failed" ? "Ended" : "…"}
      </span>
    </button>
  );
}

/** What the host knows about the sync: the guest's own estimate. */
function peerQuality(state: SessionState): SyncQuality {
  const error = state.peer?.errorMs;
  if (error === undefined) return { errorMs: Infinity, bucket: "none" };
  return { errorMs: error, bucket: error <= 5 ? "excellent" : error <= 15 ? "good" : "unstable" };
}

function chipDot(state: SessionState, quality: SyncQuality): string {
  if (
    state.phase === "failed" ||
    state.phase === "reconnecting" ||
    state.problem?.kind === "poor"
  ) {
    return "bg-destructive";
  }
  return DOTS[quality.bucket];
}
