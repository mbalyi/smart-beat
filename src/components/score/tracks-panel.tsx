import type { RefObject } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  DrumIcon,
  GuitarIcon,
  PianoIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { describeInstrument } from "@/lib/score/instrument-view";
import type { TrackSummary } from "@/lib/score/score";
import { cn } from "@/lib/utils";

function TrackIcon({ track }: { track: TrackSummary }) {
  const Icon =
    track.kind === "drums" ? DrumIcon : track.kind === "stringed" ? GuitarIcon : PianoIcon;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

export interface TrackActions {
  onShow: (index: number) => void;
  onMove: (index: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onSettings: (index: number) => void;
  onAdd: () => void;
}

/** The song's tracks: add, remove, reorder, duplicate and open their settings. */
export function TracksPanel({
  open,
  onOpenChange,
  tracks,
  shown,
  actions,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tracks: TrackSummary[];
  /** Index of the track shown in the score. */
  shown: number;
  actions: TrackActions;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const last = tracks.length - 1;
  const restoreFocus = (event: Event) => {
    const target = returnFocusTo?.current;
    if (target?.isConnected) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-md"
        onCloseAutoFocus={restoreFocus}
      >
        <SheetHeader className="border-b">
          <SheetTitle>Tracks</SheetTitle>
          <SheetDescription>Changes can be undone with Undo.</SheetDescription>
        </SheetHeader>
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {tracks.map((track) => {
            const i = track.index;
            return (
              <li
                key={`${i}-${track.name}`}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-3",
                  i === shown && "border-primary/60 bg-primary/5",
                )}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <TrackIcon track={track} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium">
                      {i + 1}. {track.name}
                      {i === shown && <span className="sr-only">{" (shown)"}</span>}
                    </h3>
                    <p className="truncate text-xs text-muted-foreground">
                      {describeInstrument(track)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => actions.onShow(i)}
                    disabled={i === shown}
                  >
                    Show
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() => actions.onMove(i, i - 1)}
                    disabled={i === 0}
                    aria-label={`Move ${track.name} up`}
                    title="Move up"
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() => actions.onMove(i, i + 1)}
                    disabled={i === last}
                    aria-label={`Move ${track.name} down`}
                    title="Move down"
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() => actions.onDuplicate(i)}
                    aria-label={`Duplicate ${track.name}`}
                    title="Duplicate"
                  >
                    <CopyIcon />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-xs"
                    onClick={() => actions.onRemove(i)}
                    disabled={tracks.length === 1}
                    aria-label={`Remove ${track.name}`}
                    title={tracks.length === 1 ? "A song needs at least one track" : "Remove"}
                  >
                    <Trash2Icon />
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => actions.onSettings(i)}
                    aria-label={`Settings… for ${track.name}`}
                  >
                    <Settings2Icon data-icon="inline-start" />
                    Settings…
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <SheetFooter className="border-t">
          <Button onClick={actions.onAdd}>
            <PlusIcon data-icon="inline-start" />
            Add track…
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
