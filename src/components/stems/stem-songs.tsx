import { CheckIcon, LayersIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { engineLabel } from "@/components/stems/stem-engines";
import { formatTime } from "@/components/stems/stem-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { StemSong } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * A separated song in the Recent grid: it opens on the stem page at once. Deleting asks first.
 * `index` is its place in the grid, which sets the hover colour.
 */
export function StemRecentCard({
  song,
  index,
  onOpen,
  onDelete,
}: {
  song: StemSong;
  index: number;
  onOpen: (song: StemSong) => void;
  onDelete: (song: StemSong) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div
      className={cn(
        "flex min-h-[76px] min-w-0 items-center gap-2 overflow-hidden rounded-2xl border bg-card pr-2 transition-[border-color] duration-150 motion-reduce:transition-none",
        index % 2 === 0 ? "hover:border-brand-yellow/60" : "hover:border-brand/60",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(song)}
        className="flex min-w-0 flex-1 items-center gap-3.5 py-3 pl-4 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <LayersIcon
          aria-hidden="true"
          className={cn(
            "size-[22px] shrink-0",
            index % 2 === 0 ? "text-brand-yellow" : "text-brand",
          )}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[17px] font-bold">{song.name}</span>
            <Badge variant="outline" className="shrink-0">
              Stems
            </Badge>
            {song.savedPath && (
              <Badge variant="secondary" className="shrink-0" title={song.savedPath}>
                <CheckIcon aria-hidden="true" />
                Saved
              </Badge>
            )}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {formatTime(song.durationSeconds)} · {song.stems.length} parts ·{" "}
            {engineLabel(song.engine)}
          </span>
        </span>
      </button>
      {asking ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="destructive"
            size="sm"
            // The light theme's red on its 10 % tint is under 4.5:1; a darker red keeps the look.
            className="text-[oklch(0.45_0.2_27)] dark:text-destructive"
            aria-label={`Delete the stems of ${song.name}`}
            onClick={() => void onDelete(song).finally(() => setAsking(false))}
          >
            Delete
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAsking(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label={`Delete ${song.name}`}
          onClick={() => setAsking(true)}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
