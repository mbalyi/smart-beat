import { useState, type ReactNode } from "react";
import { GaugeIcon, PlayIcon, Repeat2Icon, RepeatIcon, TargetIcon } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
}

/**
 * Smart Beat's own right-click menu on the score (#83), in place of the web view's (Reload,
 * Inspect…): play, loop and practise from the bar under the pointer. Text fields and dialogs
 * keep their usual menus.
 */
export function ScoreContextMenu({
  children,
  barAt,
  sections,
  actions,
}: {
  children: ReactNode;
  /** The bar (0-based) under a point of the window, or null. */
  barAt: (clientX: number, clientY: number) => number | null;
  sections: readonly SongSection[];
  actions: ScoreMenuActions;
}) {
  const [bar, setBar] = useState<number | null>(null);
  const section = bar === null ? null : sectionAt(sections, bar);
  const on = bar !== null;
  const run = (action: (bar: number) => void) => () => {
    if (bar !== null) action(bar);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // Which bar was clicked, before the menu opens.
        onContextMenu={(event) => setBar(barAt(event.clientX, event.clientY))}
      >
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Score actions">
        <ContextMenuLabel>
          {on
            ? `Bar ${bar + 1}${section ? ` · ${section.name}` : ""}`
            : "Right-click a bar for its actions"}
        </ContextMenuLabel>
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
          Start Speed Trainer here…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
