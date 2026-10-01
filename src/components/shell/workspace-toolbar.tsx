import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  FolderOpenIcon,
  KeyboardMusicIcon,
  PanelRightIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Redo2Icon,
  SkipBackIcon,
  SkipForwardIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";

import { LcdDisplay } from "@/components/shell/lcd-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Layout, PlaybackPosition } from "@/lib/score/player";
import { ZOOM_STEPS } from "@/lib/score/zoom";
import type { NotationView, ScoreSummary, TrackView } from "@/lib/score/score";

const NOTATIONS: { value: NotationView; label: string; needsTab: boolean }[] = [
  { value: "score-tab", label: "Score + tab", needsTab: true },
  { value: "score", label: "Score", needsTab: false },
  { value: "tab", label: "Tab", needsTab: true },
];

const LAYOUTS: { value: Layout; label: string }[] = [
  { value: "page", label: "Page" },
  { value: "horizontal", label: "Continuous" },
];

/**
 * Pressed Edit stands out in blue, the colour of the edit cursor. Radix sets
 * both `data-state=on` and `aria-pressed`, so both are overridden.
 */
const EDIT_PRESSED =
  "data-[state=on]:border-sky-700 data-[state=on]:bg-sky-700 aria-pressed:bg-sky-700 data-[state=on]:text-white data-[state=on]:hover:bg-sky-800 data-[state=on]:hover:text-white";

const isNotation = (value: string): value is NotationView =>
  NOTATIONS.some((n) => n.value === value);
const isLayout = (value: string): value is Layout => LAYOUTS.some((l) => l.value === value);

/**
 * The top of an open song: file actions, undo and redo, the transport with
 * the LCD display, view options (notation, layout, zoom), practice tools and
 * the switches for the edit mode, the fretboard, the inspector and the mixer.
 */
export function WorkspaceToolbar({
  title,
  summary,
  trackIndex,
  onTrackChange,
  view,
  onViewChange,
  layout,
  onLayoutChange,
  zoom,
  onZoomChange,
  onOpen,
  actions,
  editing,
  onToggleEditing,
  edited,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  ready,
  playing,
  position,
  bar,
  barCount,
  onPlayPause,
  onStop,
  onSeekBar,
  practice,
  instrumentView,
  instrumentLabel,
  onToggleInstrumentView,
  inspectorOpen,
  onToggleInspector,
  mixerOpen,
  onToggleMixer,
  headerSlot,
  active = true,
}: {
  /** The song's title, the page's main heading. */
  title: string;
  summary: ScoreSummary;
  trackIndex: number;
  onTrackChange: (index: number) => void;
  view: TrackView;
  onViewChange: (view: TrackView) => void;
  layout: Layout;
  onLayoutChange: (layout: Layout) => void;
  /** Percent. */
  zoom: number;
  onZoomChange: (percent: number) => void;
  onOpen: () => void;
  /** File and tools menus. */
  actions?: ReactNode;
  editing: boolean;
  onToggleEditing: () => void;
  /** The song was changed since it was opened. */
  edited: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  ready: boolean;
  playing: boolean;
  position: PlaybackPosition;
  bar: number;
  barCount: number;
  onPlayPause: () => void;
  onStop: () => void;
  onSeekBar: (barIndex: number) => void;
  /** Practice tools (loop, speed, metronome…). */
  practice?: ReactNode;
  instrumentView: boolean;
  /** "Fretboard", "Keyboard" or "Drum pads", for the shown track. */
  instrumentLabel: string;
  onToggleInstrumentView: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  mixerOpen: boolean;
  onToggleMixer: () => void;
  /** Where the main controls go: the app header's centre. Without it they sit above the view options. */
  headerSlot?: HTMLElement | null;
  /** The song is shown (hidden songs leave the header to the shown one). */
  active?: boolean;
}) {
  const hasTab = summary.tracks[trackIndex]?.canShowTab ?? false;
  const zoomIndex = Math.max(0, ZOOM_STEPS.indexOf(zoom as (typeof ZOOM_STEPS)[number]));

  const inHeader = headerSlot !== null && headerSlot !== undefined && active;
  const mainControls = (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={onOpen} title="Open…">
          <FolderOpenIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">Open…</span>
        </Button>
        {actions}
        <div className="flex gap-1" role="group" aria-label="History">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onUndo}
            disabled={!undoLabel}
            aria-label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
            title={undoLabel ? `Undo ${undoLabel}` : "Nothing to undo"}
          >
            <Undo2Icon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onRedo}
            disabled={!redoLabel}
            aria-label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
            title={redoLabel ? `Redo ${redoLabel}` : "Nothing to redo"}
          >
            <Redo2Icon />
          </Button>
        </div>
        {edited && (
          <Badge variant="secondary" className="shrink-0">
            Edited
          </Badge>
        )}
      </div>

      <div
        className="flex flex-wrap items-center justify-center gap-2"
        role="group"
        aria-label="Transport"
      >
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSeekBar(0)}
            disabled={!ready}
            aria-label="First bar"
            title="First bar"
            className="max-2xl:hidden"
          >
            <SkipBackIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSeekBar(Math.max(0, bar - 1))}
            disabled={!ready}
            aria-label="Previous bar"
            title="Previous bar"
          >
            <ChevronsLeftIcon />
          </Button>
          <Button
            size="icon-lg"
            onClick={onPlayPause}
            disabled={!ready}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            className="rounded-full"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onStop}
            disabled={!ready}
            aria-label="Stop"
            title="Stop"
          >
            <SquareIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSeekBar(Math.min(barCount - 1, bar + 1))}
            disabled={!ready}
            aria-label="Next bar"
            title="Next bar"
          >
            <ChevronsRightIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onSeekBar(barCount - 1)}
            disabled={!ready}
            aria-label="Last bar"
            title="Last bar"
            className="max-2xl:hidden"
          >
            <SkipForwardIcon />
          </Button>
        </div>
        <LcdDisplay
          tracks={summary.tracks}
          trackIndex={trackIndex}
          onTrackChange={onTrackChange}
          position={position}
          bar={bar}
          barCount={barCount}
          ready={ready}
          onSeekBar={onSeekBar}
        />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Toggle
          variant="outline"
          size="sm"
          pressed={editing}
          onPressedChange={onToggleEditing}
          title="Edit mode: write notes with the keyboard and mouse"
          className={EDIT_PRESSED}
        >
          <PencilIcon data-icon="inline-start" />
          Edit
        </Toggle>
        <Toggle
          variant="outline"
          size="sm"
          pressed={instrumentView}
          onPressedChange={onToggleInstrumentView}
        >
          <KeyboardMusicIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">{instrumentLabel}</span>
        </Toggle>
        <Toggle
          variant="outline"
          size="sm"
          pressed={mixerOpen}
          onPressedChange={onToggleMixer}
          aria-label="Mixer"
          title="Show or hide the track list and mixer"
        >
          <SlidersHorizontalIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">Mixer</span>
        </Toggle>
        <Toggle
          variant="outline"
          size="sm"
          pressed={inspectorOpen}
          onPressedChange={onToggleInspector}
          aria-label="Inspector"
          title="Show or hide the inspector"
        >
          <PanelRightIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">Inspector</span>
        </Toggle>
      </div>
    </div>
  );

  return (
    <>
      {inHeader && createPortal(mainControls, headerSlot)}
      <header className="sticky top-0 z-30 flex shrink-0 flex-col gap-2 border-b bg-card px-3 py-2">
        <h1 className="sr-only">{title}</h1>
        {!inHeader && mainControls}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Notation"
            value={view.notation}
            onValueChange={(value) =>
              isNotation(value) && onViewChange({ ...view, notation: value })
            }
          >
            {NOTATIONS.map((n) => (
              <ToggleGroupItem key={n.value} value={n.value} disabled={n.needsTab && !hasTab}>
                {n.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Toggle
            variant="outline"
            size="sm"
            pressed={view.rhythm}
            disabled={!hasTab || view.notation === "score"}
            onPressedChange={(rhythm) => onViewChange({ ...view, rhythm })}
          >
            Rhythm on tab
          </Toggle>

          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Layout"
            value={layout}
            onValueChange={(value) => isLayout(value) && onLayoutChange(value)}
          >
            {LAYOUTS.map((l) => (
              <ToggleGroupItem key={l.value} value={l.value}>
                {l.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div role="group" aria-label="Zoom" className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={zoomIndex === 0}
              onClick={() => onZoomChange(ZOOM_STEPS[zoomIndex - 1]!)}
            >
              <ZoomOutIcon />
            </Button>
            <span aria-live="polite" className="w-11 text-center text-sm tabular-nums">
              {ZOOM_STEPS[zoomIndex]}%
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              onClick={() => onZoomChange(ZOOM_STEPS[zoomIndex + 1]!)}
            >
              <ZoomInIcon />
            </Button>
          </div>

          {practice}
        </div>
      </header>
    </>
  );
}
