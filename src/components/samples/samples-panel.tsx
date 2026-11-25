import {
  FolderDownIcon,
  LinkIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  Volume2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { AddSamplesDialog } from "@/components/samples/add-samples-dialog";
import { SampleList } from "@/components/samples/sample-list";
import { RemoveFolderDialog } from "@/components/samples/remove-folder-dialog";
import { useSampleLibrary } from "@/components/samples/use-sample-library";
import { sampleKey, useSamplePreview } from "@/components/samples/use-sample-preview";
import { Button } from "@/components/ui/button";
import { pickSampleFolder } from "@/lib/tauri";
import { countLabel, filterSamples } from "@/lib/samples/filter";
import type { SampleFolder, SampleFolderKind, SampleRef } from "@/lib/samples/types";
import { cn } from "@/lib/utils";

/** The pointer has to move this far (px) before a press on a row becomes a drag. */
const DRAG_THRESHOLD = 6;
/** The mouse rests this long (ms) on a waveform before it previews, so a sweep stays quiet. */
export const HOVER_PREVIEW_DELAY_MS = 150;

const KIND_ICON = { linked: LinkIcon, imported: FolderDownIcon, archive: PackageIcon } as const;
const KIND_NOTE: Record<SampleFolderKind, string> = {
  linked: "Linked: the files stay where they are.",
  imported: "Imported: a copy kept by Smart Beat.",
  archive: "Unpacked from an archive, kept by Smart Beat.",
};

export interface SamplesPanelProps {
  /** Returns false (and says why) when previews cannot play, e.g. no native engine. */
  ensureEngine: () => boolean;
  /** Where Insert puts the clip, for the button label: "0:08". */
  insertAt: string;
  /** Puts the sample on the lane open in the editor, or a new lane, at the position line. */
  onInsert: (ref: SampleRef) => void;
  /** The pointer while a row is dragged (null: the drag is over). */
  onDragPoint: (point: { x: number; y: number } | null, ref: SampleRef | null) => void;
  /** A row was dropped at this point of the window. */
  onDropSample: (ref: SampleRef, point: { x: number; y: number }) => void;
  /**
   * Whether the Add samples dialog is open, when the workspace owns that state (the lane menu
   * opens it too). Without it the panel keeps the state itself.
   */
  adding?: boolean;
  onAddingChange?: (open: boolean) => void;
}

/** The Samples tab of the Inspector: folders, search, a list to audition and insert from. */
export function SamplesPanel({
  ensureEngine,
  insertAt,
  onInsert,
  onDragPoint,
  onDropSample,
  adding: addingProp,
  onAddingChange,
}: SamplesPanelProps) {
  const library = useSampleLibrary();
  const preview = useSamplePreview(ensureEngine);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [ownAdding, setOwnAdding] = useState(false);
  const adding = addingProp ?? ownAdding;
  const setAdding = onAddingChange ?? setOwnAdding;
  const [removing, setRemoving] = useState<SampleFolder | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; name: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const { folders, folderId, items, scanning, loaded } = library;
  const shown = filterSamples(items, query, (r) => r.file);
  const selectedRef = shown.find((r) => sampleKey(r) === selected) ?? null;
  const folder = folders.find((f) => f.id === folderId) ?? null;
  const missing = folders.filter((f) => !f.available);

  const { play, stop } = preview;
  // Hover previews: the sample a hover started (null once the user chose one by click or key),
  // the intent timer, and whether the engine refused one (then hovering stays quiet until the
  // pointer leaves the list, so the "needs the native engine" notice shows once).
  const hovered = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverBlocked = useRef(false);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  /** A preview the user asked for (click, Space, arrow keys): a hover must not end it. */
  const playChosen = useCallback(
    (ref: SampleRef) => {
      clearHoverTimer();
      hovered.current = null;
      hoverBlocked.current = false;
      play(ref);
    },
    [clearHoverTimer, play],
  );
  const select = useCallback(
    (ref: SampleRef) => {
      setSelected(sampleKey(ref));
      playChosen(ref);
    },
    [playChosen],
  );

  // A drag from a row: it starts after a few pixels, follows the pointer, ends on release.
  const drag = useRef<{ ref: SampleRef; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  const onRowPointerDown = (ref: SampleRef, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-no-drag]")) return;
    drag.current = { ref, x: event.clientX, y: event.clientY, active: false };
    const move = (e: globalThis.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
      d.active = true;
      setGhost({ x: e.clientX, y: e.clientY, name: d.ref.file.name });
      onDragPoint({ x: e.clientX, y: e.clientY }, d.ref);
    };
    const end = (e: globalThis.PointerEvent | null) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      stopDrag.current = null;
      const d = drag.current;
      drag.current = null;
      setGhost(null);
      if (!d?.active) return;
      onDragPoint(null, null);
      // The click that follows the release must not select or preview.
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (e) onDropSample(d.ref, { x: e.clientX, y: e.clientY });
    };
    const cancel = () => end(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") end(null);
    };
    stopDrag.current = () => end(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  };

  const onWaveHover = (ref: SampleRef, over: boolean) => {
    const key = sampleKey(ref);
    clearHoverTimer();
    if (!over) {
      if (hovered.current === key) {
        hovered.current = null;
        stop();
      }
      return;
    }
    if (hoverBlocked.current || drag.current || key === preview.playing) return;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      if (drag.current) return;
      hovered.current = key;
      if (!play(ref)) {
        hovered.current = null;
        hoverBlocked.current = true;
      }
    }, HOVER_PREVIEW_DELAY_MS);
  };
  const { ensureProbed } = library;
  const onVisible = useCallback(
    (refs: readonly SampleRef[]) => {
      ensureProbed(refs);
      // A row scrolled out of the window takes its pointer events with it: end its hover preview.
      const current = hovered.current;
      if (current !== null && !refs.some((r) => sampleKey(r) === current)) {
        hovered.current = null;
        stop();
      }
    },
    [ensureProbed, stop],
  );

  const relink = async (target: SampleFolder) => {
    const path = await pickSampleFolder(`Where is “${target.name}” now?`).catch(() => null);
    if (path) await library.relinkFolder(target.id, path);
  };

  const empty = loaded && folders.length === 0;
  const countText = scanning
    ? "Reading folders…"
    : `${countLabel(shown.length)}${query ? ` of ${countLabel(items.length)}` : ""}`;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="samples-panel">
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-1">
        <h3 className="flex-1 text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
          Samples
        </h3>
        <Button variant="outline" size="xs" data-tour="samples-add" onClick={() => setAdding(true)}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add samples
        </Button>
      </div>

      {empty ? (
        <div
          className="flex flex-1 flex-col items-start gap-2 p-3 text-sm"
          data-testid="samples-empty"
        >
          <p className="font-medium">No samples yet</p>
          <p className="text-muted-foreground">
            Link a folder, import a folder or import a zip or 7z sample pack. Then audition the
            files here and put them on a lane.
          </p>
          <Button size="sm" onClick={() => setAdding(true)}>
            Add samples
          </Button>
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label="Sample folders"
            className="flex gap-1.5 overflow-x-auto px-3 pt-1 pb-2"
          >
            <FolderChip pressed={folderId === null} onClick={() => library.selectFolder(null)}>
              All
            </FolderChip>
            {folders.map((f) => {
              const Icon = KIND_ICON[f.kind];
              return (
                <FolderChip
                  key={f.id}
                  pressed={folderId === f.id}
                  warn={!f.available}
                  onClick={() => library.selectFolder(f.id)}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {f.name}
                </FolderChip>
              );
            })}
          </div>

          {folder && (
            <div className="mx-3 mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <p className="min-w-0 flex-1">{KIND_NOTE[folder.kind]}</p>
              <Button variant="ghost" size="xs" onClick={() => setRemoving(folder)}>
                Remove
              </Button>
            </div>
          )}

          {missing.length > 0 && (folderId === null || folder?.available === false) && (
            <div className="mx-3 mb-2 flex flex-col gap-1 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
              {missing.map((f) => (
                <div key={f.id} className="flex items-center gap-2">
                  <p className="min-w-0 flex-1">
                    <strong>{f.name}</strong> was not found. An external drive may be unplugged.
                  </p>
                  {f.kind === "linked" && (
                    <Button variant="outline" size="xs" onClick={() => void relink(f)}>
                      Locate…
                    </Button>
                  )}
                  <Button variant="ghost" size="xs" onClick={() => setRemoving(f)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}

          <label
            data-tour="samples-search"
            className="mx-3 mb-2 flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
          >
            <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search by name"
              aria-label="Search samples"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>

          {shown.length === 0 && !scanning ? (
            <p
              className="flex-1 border-y p-3 text-sm text-muted-foreground"
              data-testid="samples-none"
            >
              {query ? "Nothing matches." : "This folder has no audio files."}
            </p>
          ) : (
            <SampleList
              items={shown}
              selected={selected}
              playing={preview.playing}
              playingSince={preview.startedAt}
              onSelect={(ref) => {
                if (suppressClick.current) return;
                select(ref);
              }}
              onToggle={(ref) => {
                setSelected(sampleKey(ref));
                // Stopping or starting by hand: a hover must not end it later.
                clearHoverTimer();
                hovered.current = null;
                hoverBlocked.current = false;
                preview.toggle(ref);
              }}
              onInsert={(ref) => {
                preview.stop();
                onInsert(ref);
              }}
              onVisible={onVisible}
              onRowPointerDown={onRowPointerDown}
              onWaveHover={onWaveHover}
              onPointerLeaveList={() => {
                hoverBlocked.current = false;
              }}
              onScrolled={clearHoverTimer}
            />
          )}

          <div className="flex flex-col gap-2 p-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Volume2Icon className="size-3.5" aria-hidden="true" />
              <span className="sr-only">Preview volume</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(preview.volume * 100)}
                aria-label="Preview volume"
                onChange={(e) => preview.setVolume(Number(e.target.value) / 100)}
                className="min-w-0 flex-1 accent-primary"
              />
              <span className="w-9 text-right font-mono">{Math.round(preview.volume * 100)}%</span>
            </label>
            <Button
              size="sm"
              data-tour="samples-insert"
              disabled={!selectedRef}
              onClick={() => {
                if (!selectedRef) return;
                preview.stop();
                onInsert(selectedRef);
              }}
            >
              Insert at {insertAt}
            </Button>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {countText}
            </p>
          </div>
        </>
      )}

      <AddSamplesDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(f) => library.addFolder(f)}
      />
      <RemoveFolderDialog
        folder={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void library.removeFolder(removing.id, true);
          setRemoving(null);
        }}
      />
      {ghost && (
        <div
          aria-hidden="true"
          data-testid="sample-drag-ghost"
          className="pointer-events-none fixed z-[70] max-w-56 truncate rounded-md border bg-popover px-2 py-1 text-xs font-medium shadow-md"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          {ghost.name}
        </div>
      )}
    </div>
  );
}

function FolderChip({
  pressed,
  warn,
  onClick,
  children,
}: {
  pressed: boolean;
  warn?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs",
        pressed && "border-primary bg-primary/10",
        warn && "border-amber-500/70 text-amber-700 dark:text-amber-400",
      )}
    >
      {children}
    </button>
  );
}
