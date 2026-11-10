import { FlagIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import type { AudioLanesController } from "@/components/audio-lanes/use-audio-lanes";
import type { MarkerControls } from "@/components/audio-lanes/use-markers";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { formatMs } from "@/lib/audio/audio-track";
import {
  MAX_MARKER_NAME,
  markersOf,
  moveMarker,
  regionsOf,
  removeMarker,
  removeRegion,
  renameMarker,
  renameRegion,
} from "@/lib/audio-lanes/markers";
import type { AudioMarker, AudioRegion } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** How far the pointer moves before a press on a marker becomes a drag, in px. */
const DRAG_THRESHOLD_PX = 3;
/** The narrowest a region band is drawn, in px, so a short one can still be hit. */
const MIN_BAND_PX = 6;

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** An inline name field: Enter or leaving it keeps the name, Escape drops it. */
function NameField({
  label,
  value,
  className,
  onDone,
}: {
  label: string;
  value: string;
  className?: string;
  onDone: (name: string | null) => void;
}) {
  const done = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  // The field opens on a user's request (Shift+M, Rename, a double-click): it takes the focus.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      aria-label={label}
      defaultValue={value}
      ref={field}
      maxLength={MAX_MARKER_NAME}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      className={cn(
        "h-5 w-32 rounded border bg-background px-1 text-xs text-foreground",
        className,
      )}
    />
  );
}

/** A right-click menu of commands on one marker or region. */
function ItemMenu({
  children,
  items,
}: {
  children: ReactElement;
  items: readonly { label: string; run: () => void }[];
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {items.map((item) => (
          <ContextMenuItem key={item.label} onSelect={item.run}>
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TimelineScale {
  toX: (ms: number) => number;
  toMs: (x: number) => number;
}

/** Moves a marker with the pointer (snapped); undo takes the whole drag back in one step. */
function useMarkerDrag(lanes: AudioLanesController, { toMs }: TimelineScale) {
  const dragged = useRef(false);
  const start = (marker: AudioMarker) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.altKey) return;
    event.stopPropagation();
    const startX = event.clientX;
    dragged.current = false;
    const move = (e: globalThis.PointerEvent) => {
      const dx = e.clientX - startX;
      if (!dragged.current && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      if (!dragged.current) lanes.beginGesture();
      dragged.current = true;
      lanes.applyQuiet((a) => moveMarker(a, marker.id, lanes.snapTo(marker.ms + toMs(dx))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** Whether the press that just ended moved the marker (its click is then not a "go to"). */
  const wasDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };
  return { start, wasDrag };
}

function MarkerFlag({
  lanes,
  controls,
  marker,
  number,
  scale,
  compact,
}: {
  lanes: AudioLanesController;
  controls: MarkerControls;
  marker: AudioMarker;
  number: number;
  scale: TimelineScale;
  compact: boolean;
}) {
  const drag = useMarkerDrag(lanes, scale);
  const remove = () => lanes.apply((a) => removeMarker(a, marker.id));
  const rename = () => controls.setRenaming({ kind: "marker", id: marker.id, place: "ruler" });
  const editing =
    controls.renaming?.kind === "marker" &&
    controls.renaming.id === marker.id &&
    controls.renaming.place === "ruler";
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") remove();
    else if (e.key === "F2") rename();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <span className="absolute top-0 bottom-0 z-10" style={{ left: scale.toX(marker.ms) }}>
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
      {editing ? (
        <NameField
          label={`Name of ${marker.name}`}
          value={marker.name}
          className="absolute top-0.5 left-0.5"
          onDone={(name) => {
            if (name !== null) lanes.apply((a) => renameMarker(a, marker.id, name));
            controls.setRenaming(null);
          }}
        />
      ) : (
        <ItemMenu
          items={[
            { label: "Rename", run: rename },
            { label: "Go to", run: () => controls.goTo(marker.ms) },
            { label: "Delete", run: remove },
          ]}
        >
          <button
            type="button"
            data-testid={`marker-${marker.id}`}
            aria-label={`Marker ${number}: ${marker.name}, ${formatMs(marker.ms)}`}
            title="Click: go to · Drag: move · Double-click: rename · ⌥-click or Delete: remove"
            className={cn(
              "absolute top-0.5 left-0 flex max-w-40 cursor-grab items-center gap-0.5 truncate rounded-r bg-primary px-1 text-primary-foreground active:cursor-grabbing",
              compact ? "h-4 text-[10px]" : "h-5 text-xs",
              FOCUS_RING,
            )}
            onPointerDown={drag.start(marker)}
            onClick={(e) => {
              if (drag.wasDrag()) return;
              if (e.altKey) remove();
              else controls.goTo(marker.ms);
            }}
            onDoubleClick={rename}
            onKeyDown={onKeyDown}
          >
            <FlagIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{marker.name}</span>
          </button>
        </ItemMenu>
      )}
    </span>
  );
}

function RegionBand({
  lanes,
  controls,
  region,
  scale,
  compact,
}: {
  lanes: AudioLanesController;
  controls: MarkerControls;
  region: AudioRegion;
  scale: TimelineScale;
  compact: boolean;
}) {
  const remove = () => lanes.apply((a) => removeRegion(a, region.id));
  const rename = () => controls.setRenaming({ kind: "region", id: region.id, place: "ruler" });
  const select = () => controls.selectSpan(region);
  const editing =
    controls.renaming?.kind === "region" &&
    controls.renaming.id === region.id &&
    controls.renaming.place === "ruler";
  const left = scale.toX(region.startMs);
  const width = Math.max(MIN_BAND_PX, scale.toX(region.endMs) - left);
  const box = cn("absolute bottom-0", compact ? "h-3" : "h-3.5");
  if (editing)
    return (
      <span className={box} style={{ left }}>
        <NameField
          label={`Name of ${region.name}`}
          value={region.name}
          className="absolute bottom-0 left-0"
          onDone={(name) => {
            if (name !== null) lanes.apply((a) => renameRegion(a, region.id, name));
            controls.setRenaming(null);
          }}
        />
      </span>
    );
  return (
    <ItemMenu
      items={[
        { label: "Rename", run: rename },
        { label: "Go to the start", run: () => controls.goTo(region.startMs) },
        { label: "Select the span", run: select },
        { label: "Delete", run: remove },
      ]}
    >
      <button
        type="button"
        data-testid={`region-${region.id}`}
        aria-label={`Region ${region.name}, ${formatMs(region.startMs)} to ${formatMs(region.endMs)}`}
        title="Double-click or Enter: select the span · ⌥-click or Delete: remove"
        className={cn(
          box,
          "truncate rounded-sm border-x-2 border-chart-2 bg-chart-2/25 px-1 text-left text-[10px] leading-3 text-foreground",
          FOCUS_RING,
        )}
        style={{ left, width }}
        onClick={(e) => {
          if (e.altKey) remove();
        }}
        onDoubleClick={select}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") remove();
          else if (e.key === "F2") rename();
          else if (e.key === "Enter") select();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {region.name}
      </button>
    </ItemMenu>
  );
}

/**
 * The user's markers (flags) and regions (bands) along the timeline. Right-click the row to add
 * one; right-click a marker or region for its commands.
 */
export function MarkerRuler({
  lanes,
  controls,
  toX,
  toMs,
  compact = false,
}: {
  lanes: AudioLanesController;
  controls: MarkerControls;
  toX: (ms: number) => number;
  toMs: (x: number) => number;
  /** The lane editor's slimmer row. */
  compact?: boolean;
}) {
  const scale = { toX, toMs };
  const markers = markersOf(lanes.audio);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="group"
          aria-label="Markers and regions"
          data-testid="marker-ruler"
          className={cn("relative flex-1", compact ? "h-6 border-b" : "h-8")}
        >
          {regionsOf(lanes.audio).map((region) => (
            <RegionBand
              key={region.id}
              lanes={lanes}
              controls={controls}
              region={region}
              scale={scale}
              compact={compact}
            />
          ))}
          {markers.map((marker, i) => (
            <MarkerFlag
              key={marker.id}
              lanes={lanes}
              controls={controls}
              marker={marker}
              number={i + 1}
              scale={scale}
              compact={compact}
            />
          ))}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuItem onSelect={() => controls.addAtLine(false)}>
          Add a marker at the position line
        </ContextMenuItem>
        <ContextMenuItem disabled={!controls.regionSpan} onSelect={controls.addRegionFromSelection}>
          {controls.regionLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Buttons that add a marker at the position line and a region from the selection. */
export function MarkerToolbar({ controls }: { controls: MarkerControls }) {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-1.5 text-xs"
        title="Add a marker at the position line (M)"
        onClick={() => controls.addAtLine(false)}
      >
        <FlagIcon /> Marker
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-1.5 text-xs"
        disabled={!controls.regionSpan}
        title={
          controls.regionSpan
            ? controls.regionLabel
            : "Select a time range or clips to make a region"
        }
        aria-label={controls.regionLabel}
        onClick={controls.addRegionFromSelection}
      >
        <PlusIcon /> Region
      </Button>
    </div>
  );
}

/** One row of the list: go to, rename and delete, or the name field while renaming. */
function ListRow({
  name,
  detail,
  editing,
  onGoTo,
  onRename,
  onRenamed,
  onDelete,
}: {
  name: string;
  detail: string;
  editing: boolean;
  onGoTo: () => void;
  onRename: () => void;
  onRenamed: (name: string | null) => void;
  onDelete: () => void;
}) {
  return (
    <li className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent">
      {editing ? (
        <NameField label={`Name of ${name}`} value={name} className="flex-1" onDone={onRenamed} />
      ) : (
        <button
          type="button"
          aria-label={`Go to ${name}, ${detail}`}
          className={cn("flex min-w-0 flex-1 items-baseline gap-2 rounded text-left", FOCUS_RING)}
          onClick={onGoTo}
          onDoubleClick={onRename}
        >
          <span className="truncate text-sm">{name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {detail}
          </span>
        </button>
      )}
      <Button variant="ghost" size="icon-xs" aria-label={`Rename ${name}`} onClick={onRename}>
        <PencilIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label={`Delete ${name}`} onClick={onDelete}>
        <Trash2Icon />
      </Button>
    </li>
  );
}

/** The studio side panel's list of markers and regions. */
export function MarkerList({
  lanes,
  controls,
}: {
  lanes: AudioLanesController;
  controls: MarkerControls;
}) {
  const { apply } = lanes;
  const markers = markersOf(lanes.audio);
  const regions = regionsOf(lanes.audio);
  const [open, setOpen] = useState(true);
  const editing = (kind: "marker" | "region", id: string) =>
    controls.renaming?.kind === kind &&
    controls.renaming.id === id &&
    controls.renaming.place === "list";
  const renamed = (kind: "marker" | "region", id: string) => (name: string | null) => {
    if (name !== null)
      apply((a) => (kind === "marker" ? renameMarker(a, id, name) : renameRegion(a, id, name)));
    controls.setRenaming(null);
  };
  return (
    <aside
      aria-labelledby="marker-list-heading"
      className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l bg-card p-3"
      data-testid="marker-list"
    >
      <div className="flex items-center gap-1">
        <h3 id="marker-list-heading" className="flex-1 text-sm font-semibold">
          Markers and regions
        </h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-expanded={open}
          aria-controls="marker-list-items"
          aria-label={open ? "Hide the markers" : "Show the markers"}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "▾" : "▸"}
        </Button>
      </div>
      <div id="marker-list-items" hidden={!open} className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">Markers</h4>
        {markers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Press M to add a marker at the position line.
          </p>
        ) : (
          <ol aria-label="Markers" className="flex flex-col">
            {markers.map((m) => (
              <ListRow
                key={m.id}
                name={m.name}
                detail={formatMs(m.ms)}
                editing={editing("marker", m.id)}
                onGoTo={() => controls.goTo(m.ms)}
                onRename={() => controls.setRenaming({ kind: "marker", id: m.id, place: "list" })}
                onRenamed={renamed("marker", m.id)}
                onDelete={() => apply((a) => removeMarker(a, m.id))}
              />
            ))}
          </ol>
        )}
        <h4 className="text-xs font-medium text-muted-foreground">Regions</h4>
        {regions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Select a time range or clips, then add a region.
          </p>
        ) : (
          <ol aria-label="Regions" className="flex flex-col">
            {regions.map((r) => (
              <ListRow
                key={r.id}
                name={r.name}
                detail={`${formatMs(r.startMs)}–${formatMs(r.endMs)}`}
                editing={editing("region", r.id)}
                onGoTo={() => controls.selectSpan(r)}
                onRename={() => controls.setRenaming({ kind: "region", id: r.id, place: "list" })}
                onRenamed={renamed("region", r.id)}
                onDelete={() => apply((a) => removeRegion(a, r.id))}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
