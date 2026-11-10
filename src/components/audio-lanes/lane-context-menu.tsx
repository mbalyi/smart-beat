import {
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  CopyPlusIcon,
  CropIcon,
  FileAudioIcon,
  FoldHorizontalIcon,
  LinkIcon,
  LockIcon,
  PanelBottomOpenIcon,
  RepeatIcon,
  ScissorsIcon,
  SplitIcon,
  Trash2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useState, type MouseEvent, type ReactElement } from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { findClip, updateClip } from "@/lib/audio-lanes/edits";
import { activeTake, clipEndMs } from "@/lib/audio-lanes/model";
import { describeRange } from "@/lib/audio-lanes/range-edits";
import type { AudioClip, AudioLane } from "@/lib/tauri";

/** What the menu was opened on: a clip, or a point of the lane. */
type MenuTarget = { kind: "clip"; clipId: string } | { kind: "lane"; atMs: number };

/** A shortcut shown on the right of a menu item. */
function Keys({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";

/**
 * The right-click menu on a lane's timeline. On a clip: split it at the position line, trim its
 * start or end to it, cut, copy, paste, duplicate, glue, mute, lock, reverse and delete. On empty
 * space: paste or insert an audio file at that point. `children` is the timeline element; `toMs`
 * maps a point across it (pixels from its left edge) to the audio timeline.
 */
export function LaneContextMenu({
  lanes,
  lane,
  toMs,
  onOpenEditor,
  children,
}: {
  lanes: AudioLanesController;
  lane: AudioLane;
  toMs: (x: number) => number;
  onOpenEditor?: (laneId: string) => void;
  children: ReactElement;
}) {
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const [line, setLine] = useState(0);
  // A folder holds lanes, not clips.
  if (lane.folder) return children;

  const open = (event: MouseEvent<HTMLElement>) => {
    // The score's own menu is around the lanes: this one is for the lane.
    event.stopPropagation();
    setLine(lanes.lineMs());
    const clipId = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-id]")?.dataset
      .clipId;
    if (clipId) {
      if (!lanes.selection.includes(clipId)) lanes.select([clipId]);
      setTarget({ kind: "clip", clipId });
      return;
    }
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    setTarget({ kind: "lane", atMs: lanes.snapTo(toMs(x)) });
  };

  const clip: AudioClip | null =
    target?.kind === "clip" ? (findClip(lanes.audio, target.clipId)?.clip ?? null) : null;
  // A clip the menu was opened on acts with the rest of the selection, if it is part of it.
  const ids =
    clip && lanes.selection.includes(clip.id) && lanes.selection.length > 1
      ? lanes.selection
      : clip
        ? [clip.id]
        : [];
  const lineInClip = !!clip && clip.startMs < line && clipEndMs(clip) > line;
  const toggle = (field: "mute" | "locked" | "reversed") =>
    lanes.apply((a) =>
      ids.reduce((next, id) => {
        const found = findClip(next, id);
        return found ? updateClip(next, id, { [field]: !found.clip[field] }) : next;
      }, a),
    );
  const pasteAt = target?.kind === "lane" ? target.atMs : line;
  // A file inserted from a clip goes right after it, so files line up one after another.
  const insertAt = clip ? clipEndMs(clip) : pasteAt;
  const what = ids.length > 1 ? `${ids.length} clips` : "clip";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={open}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`Lane actions: ${lane.name}`}>
        {clip ? (
          <>
            <ContextMenuLabel>
              {ids.length > 1 ? `${ids.length} clips` : activeTake(clip).name} · {lane.name}
            </ContextMenuLabel>
            <ContextMenuItem
              disabled={!lineInClip || clip.locked}
              onSelect={() => lanes.commands.split(ids, line)}
            >
              <SplitIcon />
              Split at the position line
              <Keys>S</Keys>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!lineInClip || clip.locked}
              onSelect={() => lanes.commands.trimStartToLine(ids, line)}
            >
              <ArrowRightToLineIcon />
              Trim start to the position line
              <Keys>[</Keys>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!lineInClip || clip.locked}
              onSelect={() => lanes.commands.trimEndToLine(ids, line)}
            >
              <ArrowLeftToLineIcon />
              Trim end to the position line
              <Keys>]</Keys>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => lanes.commands.cut(ids)}>
              <ScissorsIcon />
              Cut
              <Keys>{`${MOD}X`}</Keys>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => lanes.commands.copy(ids)}>
              <ClipboardCopyIcon />
              Copy
              <Keys>{`${MOD}C`}</Keys>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!lanes.canPaste}
              onSelect={() => lanes.commands.paste(lane.id, line)}
            >
              <ClipboardPasteIcon />
              Paste at the position line
              <Keys>{`${MOD}V`}</Keys>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => lanes.commands.duplicate(ids)}>
              <CopyPlusIcon />
              Duplicate
              <Keys>{`${MOD}D`}</Keys>
            </ContextMenuItem>
            <ContextMenuItem disabled={ids.length < 2} onSelect={() => lanes.commands.glue(ids)}>
              <LinkIcon />
              Glue
              <Keys>G</Keys>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => toggle("mute")}>
              <VolumeXIcon />
              {clip.mute ? "Unmute" : "Mute"}
              <Keys>M</Keys>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => toggle("locked")}>
              <LockIcon />
              {clip.locked ? "Unlock" : "Lock"}
              <Keys>L</Keys>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => toggle("reversed")}>
              <RepeatIcon />
              {clip.reversed ? "Play forwards" : "Reverse"}
              <Keys>R</Keys>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => lanes.commands.remove(ids)}
            >
              <Trash2Icon />
              {`Delete ${what}`}
              <Keys>Delete</Keys>
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuLabel>{lane.name}</ContextMenuLabel>
            <ContextMenuItem
              disabled={!lanes.canPaste}
              onSelect={() => lanes.commands.paste(lane.id, pasteAt)}
            >
              <ClipboardPasteIcon />
              Paste here
            </ContextMenuItem>
          </>
        )}
        {lanes.timeRange && <TimeRangeItems lanes={lanes} />}
        <ContextMenuItem onSelect={() => void lanes.chooseFile(lane.id, insertAt)}>
          <FileAudioIcon />
          {clip ? "Insert an audio file after this clip…" : "Insert an audio file here…"}
        </ContextMenuItem>
        {onOpenEditor && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onOpenEditor(lane.id)}>
              <PanelBottomOpenIcon />
              Open the lane editor
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The time selection's edits, shown while there is one. */
function TimeRangeItems({ lanes }: { lanes: AudioLanesController }) {
  const range = lanes.timeRange;
  if (!range) return null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuLabel className="tabular-nums">Selection {describeRange(range)}</ContextMenuLabel>
      <ContextMenuItem onSelect={lanes.commands.splitTimeRange}>
        <SplitIcon />
        Split at the selection edges
        <Keys>⇧S</Keys>
      </ContextMenuItem>
      <ContextMenuItem onSelect={lanes.commands.trimToTimeRange}>
        <CropIcon />
        Trim to the selection
      </ContextMenuItem>
      <ContextMenuItem onSelect={lanes.commands.removeTimeRange}>
        <FoldHorizontalIcon />
        Remove the selection and close the gap
      </ContextMenuItem>
      <ContextMenuItem onSelect={lanes.commands.insertSpace}>
        <ArrowRightToLineIcon />
        Insert empty space at the selection
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
