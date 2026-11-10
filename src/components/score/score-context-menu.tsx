import { useState, type ReactNode } from "react";
import {
  BetweenVerticalEndIcon,
  BetweenVerticalStartIcon,
  ClipboardCopyIcon,
  ClipboardPasteIcon,
  GaugeIcon,
  PlayIcon,
  PlusIcon,
  Repeat2Icon,
  RepeatIcon,
  ScissorsIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Beat } from "@/lib/score/model";
import { describeRange } from "@/lib/score/practice";
import { sectionAt, type SongSection } from "@/lib/score/structure";

export interface ScoreMenuActions {
  /** Starts playing at the start of a bar (0-based). */
  onPlayFrom: (bar: number) => void;
  onLoopBar: (bar: number) => void;
  onLoopStart: (bar: number) => void;
  onLoopEnd: (bar: number) => void;
  onPracticeSection: (section: SongSection) => void;
  /** Opens the Speed Trainer for these bars. */
  onTrainer: (range: { start: number; end: number }) => void;
  /** The selected beats (Shift+click extends a selection; #92). */
  onCopy: () => void;
  onCut: () => void;
  onDelete: () => void;
  onLoopSelection: () => void;
  onPracticeSelection: () => void;
  onPlaySelection: () => void;
  /** Edit Mode: whole bars (0-based), in every track, undoable. */
  onInsertBarBefore: (bar: number) => void;
  onInsertBarAfter: (bar: number) => void;
  onCopyBar: (bar: number) => void;
  onCutBar: (bar: number) => void;
  onDeleteBar: (bar: number) => void;
  /** Inserts the copied bars as new bars after this one. */
  onPasteBarsAfter: (bar: number) => void;
  /**
   * Edit Mode: a rest before or after the beat that was right-clicked (null: the edit cursor's
   * beat), as long as the note value the palette shows (#228).
   */
  onInsertRest: (where: "before" | "after", beat: Beat | null) => void;
  /** Edit Mode: ends a repeat at the bar that plays `count` times; 0 removes it (#228). */
  onRepeatEnd: (bar: number, count: number) => void;
}

/** The repeat counts the menu offers; another count in the file is offered too. */
const REPEAT_COUNTS = [2, 3, 4, 5, 6, 7, 8];

/** The bars a score selection covers (0-based, inclusive). */
export interface SelectionBars {
  start: number;
  end: number;
}

/**
 * Smart Beat's own right-click menu on the score (#83), in place of the web view's (Reload,
 * Inspect…): play, loop and practise from the bar under the pointer. Text fields and dialogs
 * keep their usual menus.
 */
export function ScoreContextMenu({
  children,
  barAt,
  beatAt = () => null,
  repeatCountAt = () => 0,
  sections,
  actions,
  selection = null,
  editing = false,
  canPaste = false,
}: {
  children: ReactNode;
  /** The bar (0-based) under a point of the window, or null. */
  barAt: (clientX: number, clientY: number) => number | null;
  /** The beat under a point of the window, or null (alphaTab only reports left clicks). */
  beatAt?: (clientX: number, clientY: number) => Beat | null;
  /** How many times the repeat ending at a bar plays (0: none). */
  repeatCountAt?: (bar: number) => number;
  sections: readonly SongSection[];
  actions: ScoreMenuActions;
  /** The selected range: its actions are offered while there is one. */
  selection?: SelectionBars | null;
  /** Cut and Delete change the score, so they need Edit Mode. */
  editing?: boolean;
  /** Something is on the clipboard: the bar menu offers to paste it. */
  canPaste?: boolean;
}) {
  const [bar, setBar] = useState<number | null>(null);
  const [beat, setBeat] = useState<Beat | null>(null);
  const section = bar === null ? null : sectionAt(sections, bar);
  const on = bar !== null;
  const repeatCount = bar === null ? 0 : repeatCountAt(bar);
  const counts =
    repeatCount > 0 && !REPEAT_COUNTS.includes(repeatCount)
      ? [...REPEAT_COUNTS, repeatCount].sort((a, b) => a - b)
      : REPEAT_COUNTS;
  const run = (action: (bar: number) => void) => () => {
    if (bar !== null) action(bar);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // Which bar was clicked, before the menu opens.
        onContextMenu={(event) => {
          setBar(barAt(event.clientX, event.clientY));
          setBeat(beatAt(event.clientX, event.clientY));
        }}
      >
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Score actions">
        {selection && (
          <>
            <ContextMenuLabel>{`Selection · ${describeRange(selection)}`}</ContextMenuLabel>
            <ContextMenuItem onSelect={actions.onCopy}>
              <ClipboardCopyIcon />
              Copy
            </ContextMenuItem>
            <ContextMenuItem disabled={!editing} onSelect={actions.onCut}>
              <ScissorsIcon />
              Cut
            </ContextMenuItem>
            <ContextMenuItem disabled={!editing} onSelect={actions.onDelete}>
              <Trash2Icon />
              Delete
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={actions.onLoopSelection}>
              <Repeat2Icon />
              Loop Selection
            </ContextMenuItem>
            <ContextMenuItem onSelect={actions.onPracticeSelection}>
              <TargetIcon />
              Practice Selection
            </ContextMenuItem>
            <ContextMenuItem onSelect={actions.onPlaySelection}>
              <PlayIcon />
              Play Selection
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuLabel>
          {on
            ? `Bar ${bar + 1}${section ? ` · ${section.name}` : ""}`
            : "Right-click a bar for its actions"}
        </ContextMenuLabel>
        {editing && on && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => actions.onInsertRest("before", beat)}>
              <BetweenVerticalStartIcon />
              Insert rest before
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onInsertRest("after", beat)}>
              <BetweenVerticalEndIcon />
              Insert rest after
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <RepeatIcon />
                Repeat end
              </ContextMenuSubTrigger>
              <ContextMenuSubContent aria-label="Repeat end">
                <ContextMenuRadioGroup value={String(repeatCount)}>
                  {[0, ...counts].map((count) => (
                    <ContextMenuRadioItem
                      key={count}
                      value={String(count)}
                      onSelect={run((at) => actions.onRepeatEnd(at, count))}
                    >
                      {count === 0 ? "No repeat end" : `Play ${count} times`}
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onSelect={run(actions.onInsertBarBefore)}>
              <PlusIcon />
              Insert bar before
            </ContextMenuItem>
            <ContextMenuItem onSelect={run(actions.onInsertBarAfter)}>
              <PlusIcon />
              Insert bar after
            </ContextMenuItem>
            <ContextMenuItem onSelect={run(actions.onCopyBar)}>
              <ClipboardCopyIcon />
              Copy bar
            </ContextMenuItem>
            <ContextMenuItem onSelect={run(actions.onCutBar)}>
              <ScissorsIcon />
              Cut bar
            </ContextMenuItem>
            {canPaste && (
              <ContextMenuItem onSelect={run(actions.onPasteBarsAfter)}>
                <ClipboardPasteIcon />
                Paste bar after
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={run(actions.onDeleteBar)}>
              <Trash2Icon />
              Delete bar
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!on} onSelect={run(actions.onPlayFrom)}>
          <PlayIcon />
          Play from here
        </ContextMenuItem>
        <ContextMenuItem disabled={!on} onSelect={run(actions.onLoopBar)}>
          <Repeat2Icon />
          Loop this bar
        </ContextMenuItem>
        <ContextMenuItem disabled={!on} onSelect={run(actions.onLoopStart)}>
          <RepeatIcon />
          Set loop start here
        </ContextMenuItem>
        <ContextMenuItem disabled={!on} onSelect={run(actions.onLoopEnd)}>
          <RepeatIcon />
          Set loop end here
        </ContextMenuItem>
        {section && (
          <ContextMenuItem onSelect={() => actions.onPracticeSection(section)}>
            <TargetIcon />
            Practise “{section.name}” (bars {section.start + 1}–{section.end + 1})
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!on}
          onSelect={run((b) =>
            actions.onTrainer(
              section ? { start: section.start, end: section.end } : { start: b, end: b },
            ),
          )}
        >
          <GaugeIcon />
          Start Speed Trainer here
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
