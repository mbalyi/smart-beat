import { PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { SamplePlayhead, SampleWaveform } from "@/components/samples/sample-waveform";
import { sampleKey } from "@/components/samples/use-sample-preview";
import { sampleMeta } from "@/lib/samples/filter";
import type { SampleRef } from "@/lib/samples/types";
import { scrollToRow, visibleRange } from "@/lib/samples/windowing";
import { cn } from "@/lib/utils";

/** Height of one row in px. The list draws only the rows in view, so every row has this height. */
export const ROW_HEIGHT = 52;
const DEFAULT_VIEWPORT = 312;
/** The pause after scrolling before the rows in view are measured. */
const PROBE_DELAY_MS = 120;

interface SampleListProps {
  items: readonly SampleRef[];
  /** Key of the selected sample. */
  selected: string | null;
  playing: string | null;
  /** `performance.now()` when the playing sample began, for the playhead (null: not known yet). */
  playingSince?: number | null;
  /** Click or arrow key: selects the sample (and previews it). */
  onSelect: (ref: SampleRef) => void;
  /** The play button of a row, or Space. */
  onToggle: (ref: SampleRef) => void;
  /** Double-click or Enter. */
  onInsert: (ref: SampleRef) => void;
  /** Rows scrolled into view, for measuring. */
  onVisible: (refs: readonly SampleRef[]) => void;
  /** A press on a row that may turn into a drag onto a lane. */
  onRowPointerDown: (ref: SampleRef, event: PointerEvent<HTMLElement>) => void;
  /** A mouse pointer came onto or left a row's waveform (never touch or pen). */
  onWaveHover?: (ref: SampleRef, over: boolean) => void;
  /** The pointer left the whole list. */
  onPointerLeaveList?: () => void;
  /** The list scrolled. */
  onScrolled?: () => void;
  className?: string;
}

/**
 * A long list of samples. Only the rows in view are drawn (thousands scroll smoothly). It is one
 * listbox: Up and Down move, Space plays or stops, Enter inserts.
 */
export function SampleList({
  items,
  selected,
  playing,
  playingSince = null,
  onSelect,
  onToggle,
  onInsert,
  onVisible,
  onRowPointerDown,
  onWaveHover,
  onPointerLeaveList,
  onScrolled,
  className,
}: SampleListProps) {
  const box = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setViewport(el.clientHeight || DEFAULT_VIEWPORT));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const { start, end } = visibleRange(scrollTop, viewport, ROW_HEIGHT, items.length);
  const shown = items.slice(start, end);

  useEffect(() => {
    const timer = setTimeout(() => onVisible(items.slice(start, end)), PROBE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [items, start, end, onVisible]);

  const selectedIndex = selected === null ? -1 : items.findIndex((r) => sampleKey(r) === selected);

  const move = (index: number) => {
    const ref = items[Math.min(items.length - 1, Math.max(0, index))];
    if (!ref) return;
    onSelect(ref);
    const next = scrollToRow(
      Math.min(items.length - 1, Math.max(0, index)),
      box.current?.scrollTop ?? 0,
      viewport,
      ROW_HEIGHT,
    );
    if (next !== null && box.current) box.current.scrollTop = next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items[selectedIndex];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(selectedIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(selectedIndex < 0 ? 0 : selectedIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(items.length - 1);
        break;
      case " ":
        event.preventDefault();
        if (current) onToggle(current);
        break;
      case "Enter":
        event.preventDefault();
        if (current) onInsert(current);
        break;
    }
  };

  return (
    <div
      ref={box}
      role="listbox"
      tabIndex={0}
      aria-label="Samples"
      aria-activedescendant={selectedIndex >= 0 ? `sample-${selectedIndex}` : undefined}
      data-tour="samples-list"
      data-testid="sample-list"
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop);
        onScrolled?.();
      }}
      onPointerLeave={onPointerLeaveList}
      onKeyDown={onKeyDown}
      className={cn(
        "relative min-h-0 flex-1 overflow-y-auto border-y bg-background outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
        className,
      )}
    >
      <div style={{ height: items.length * ROW_HEIGHT }} className="relative">
        {shown.map((ref, offset) => {
          const index = start + offset;
          const key = sampleKey(ref);
          const isSelected = key === selected;
          const isPlaying = key === playing;
          return (
            // The listbox owns the keyboard (aria-activedescendant), so a row is not a tab stop.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={key}
              tabIndex={-1}
              id={`sample-${index}`}
              role="option"
              aria-selected={isSelected}
              aria-posinset={index + 1}
              aria-setsize={items.length}
              data-playing={isPlaying}
              data-testid="sample-row"
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              onClick={() => onSelect(ref)}
              onDoubleClick={() => onInsert(ref)}
              onPointerDown={(e) => onRowPointerDown(ref, e)}
              className={cn(
                "absolute inset-x-0 grid cursor-default grid-cols-[1.625rem_1fr_4.5rem] items-center gap-2 border-b px-2.5 select-none",
                isSelected && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
              )}
            >
              {/* A mouse shortcut only: an option holds no controls, the keys do the same. */}
              <span
                aria-hidden="true"
                data-no-drag
                data-testid="sample-play"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(ref);
                  onToggle(ref);
                }}
                className={cn(
                  "grid size-[1.625rem] place-items-center rounded-full border bg-card",
                  isPlaying && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {isPlaying ? (
                  <SquareIcon className="size-3 fill-current" />
                ) : (
                  <PlayIcon className="size-3 fill-current" />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{ref.file.name}</p>
                <p
                  className={cn(
                    "truncate font-mono text-[0.7rem] text-muted-foreground",
                    // The selected row is tinted: the muted grey is too faint on it.
                    isSelected && "text-foreground/80",
                  )}
                >
                  {sampleMeta(ref.file)}
                </p>
              </div>
              <span
                data-testid="sample-wave"
                onPointerEnter={(e) => e.pointerType === "mouse" && onWaveHover?.(ref, true)}
                onPointerLeave={(e) => e.pointerType === "mouse" && onWaveHover?.(ref, false)}
                className="relative block h-[1.875rem] w-[4.5rem]"
              >
                <SampleWaveform
                  peaks={ref.file.peaks}
                  className="block h-full w-full text-stem-other"
                />
                {isPlaying && playingSince !== null && ref.file.durationMs ? (
                  <SamplePlayhead startedAt={playingSince} durationMs={ref.file.durationMs} />
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
