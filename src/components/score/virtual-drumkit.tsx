import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SearchIcon } from "lucide-react";

import { Tip } from "@/components/ui/tip";
import { Input } from "@/components/ui/input";
import { DRUM_CATEGORIES } from "@/lib/score/drum-map";
import { filterKit, type KitEntry } from "@/lib/score/instrument-view";
import { cn } from "@/lib/utils";

/**
 * The GP8-style Virtual Drumkit: every drum articulation by name and number,
 * grouped. A click (or Enter) plays it and, while editing, enters it at the
 * cursor; Shift+click (or Shift+Enter) replaces the drum under the cursor.
 * The drums being played or under the cursor are highlighted. Arrow keys,
 * Home and End move between the drums.
 */
export function VirtualDrumkit({
  kit,
  active,
  cursorSound,
  editing,
  onInsert,
  onReplace,
  onPreview,
}: {
  kit: KitEntry[];
  /** Drum numbers sounding (or on the beat under the edit cursor). */
  active: number[];
  /** The drum the edit cursor is on. */
  cursorSound: number | null;
  editing: boolean;
  onInsert: (sound: number) => void;
  onReplace: (sound: number) => void;
  onPreview: (sound: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [focusIndex, setFocusIndex] = useState(0);
  const searchId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = useMemo(() => filterKit(kit, query), [kit, query]);
  const groups = [
    { category: "This track's kit", entries: shown.filter((e) => e.own) },
    ...DRUM_CATEGORIES.map((category) => ({
      category,
      entries: shown.filter((e) => !e.own && e.category === category),
    })),
  ].filter((g) => g.entries.length > 0);
  const order = groups.flatMap((g) => g.entries);
  const current = Math.min(focusIndex, Math.max(0, order.length - 1));

  const pick = (entry: KitEntry, replace: boolean) => {
    onPreview(entry.id);
    if (!editing) return;
    if (replace) onReplace(entry.id);
    else onInsert(entry.id);
  };

  const onKey = (event: KeyboardEvent, entry: KitEntry, index: number) => {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      pick(entry, true);
      return;
    }
    const last = order.length - 1;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? Math.min(last, index + 1)
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative max-w-64">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <label htmlFor={searchId} className="sr-only">
          Find a drum by name or number
        </label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocusIndex(0);
          }}
          placeholder="Find a drum (38, ride…)"
          className="h-7 pl-7 text-xs"
        />
      </div>
      <div
        role="group"
        aria-label={
          editing
            ? "Virtual drumkit: Enter adds the drum at the cursor, Shift+Enter replaces the one there"
            : "Virtual drumkit: Enter plays the drum"
        }
        data-testid="virtual-drumkit"
        className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-2"
      >
        {order.length === 0 && (
          <p className="text-sm text-muted-foreground">No drum matches “{query}”.</p>
        )}
        {groups.map(({ category, entries }) => (
          <section key={category} aria-label={category} className="flex flex-col gap-0.5">
            <p
              aria-hidden="true"
              className="text-[0.65rem] font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {category}
            </p>
            {entries.map((entry) => {
              const index = order.indexOf(entry);
              const sounding = active.includes(entry.id);
              const atCursor = cursorSound === entry.id;
              return (
                <Tip
                  key={entry.id}
                  label={`${entry.name} · ${entry.id}${entry.notehead ? ` · ${entry.notehead} notehead` : ""}`}
                >
                  <button
                    ref={(el) => {
                      buttons.current[index] = el;
                    }}
                    type="button"
                    tabIndex={index === current ? 0 : -1}
                    aria-label={`${entry.name}, ${entry.id}`}
                    aria-pressed={sounding}
                    aria-current={atCursor ? "true" : undefined}
                    onFocus={() => setFocusIndex(index)}
                    onClick={(event) => pick(entry, event.shiftKey)}
                    onKeyDown={(event) => onKey(event, entry, index)}
                    data-testid="kit-entry"
                    className={cn(
                      "flex items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs outline-none hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-sky-900",
                      sounding && "bg-sky-700 text-white hover:bg-sky-800 dark:hover:bg-sky-800",
                      atCursor && "ring-2 ring-amber-500",
                    )}
                  >
                    <span className="w-7 shrink-0 font-mono tabular-nums">
                      {String(entry.id).padStart(3, "0")}
                    </span>
                    <span className="truncate">{entry.name}</span>
                  </button>
                </Tip>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
