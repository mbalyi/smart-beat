import { useId, type Ref } from "react";
import {
  FolderOpenIcon,
  KeyboardMusicIcon,
  ListMusicIcon,
  PencilIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Layout } from "@/lib/score/player";
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

const isNotation = (value: string): value is NotationView =>
  NOTATIONS.some((n) => n.value === value);
const isLayout = (value: string): value is Layout => LAYOUTS.some((l) => l.value === value);

export function ScoreToolbar({
  name,
  summary,
  trackIndex,
  view,
  layout,
  onOpen,
  onTrackChange,
  onViewChange,
  onLayoutChange,
  onToggleMixer,
  mixerOpen = false,
  mixerButtonRef,
  editing = false,
  onToggleEditing,
  edited = false,
  onOpenTracks,
  tracksButtonRef,
  instrumentView = false,
  instrumentLabel = "Fretboard",
  onToggleInstrumentView,
}: {
  /** File name, shown when the song has no title. */
  name: string;
  summary: ScoreSummary;
  trackIndex: number;
  view: TrackView;
  layout: Layout;
  onOpen: () => void;
  onTrackChange: (index: number) => void;
  onViewChange: (view: TrackView) => void;
  onLayoutChange: (layout: Layout) => void;
  onToggleMixer: () => void;
  mixerOpen?: boolean;
  /** Where focus returns when the mixer closes. */
  mixerButtonRef?: Ref<HTMLButtonElement>;
  /** Edit mode is on. */
  editing?: boolean;
  onToggleEditing?: () => void;
  /** The song was changed since it was opened. */
  edited?: boolean;
  onOpenTracks?: () => void;
  /** Where focus returns when the tracks panel closes. */
  tracksButtonRef?: Ref<HTMLButtonElement>;
  /** The fretboard (keyboard, drum pads) is shown. */
  instrumentView?: boolean;
  /** "Fretboard", "Keyboard" or "Drum pads", for the shown track. */
  instrumentLabel?: string;
  onToggleInstrumentView?: () => void;
}) {
  const trackLabelId = useId();
  const track = summary.tracks[trackIndex];
  const hasTab = track?.hasTablature ?? false;

  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-heading text-lg font-semibold sm:text-xl">
              {summary.title || name}
            </h1>
            {edited && (
              <Badge variant="secondary" className="shrink-0">
                Edited
              </Badge>
            )}
          </div>
          {summary.artist && (
            <p className="truncate text-sm text-muted-foreground">{summary.artist}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-1.5 sm:gap-2">
          <Button variant="outline" onClick={onOpen} title="Open…">
            <FolderOpenIcon data-icon="inline-start" />
            <span className="sr-only md:not-sr-only">Open…</span>
          </Button>
          {onToggleEditing && (
            <Toggle
              variant="outline"
              pressed={editing}
              onPressedChange={onToggleEditing}
              title="Edit mode: write notes with the keyboard and mouse"
              className="data-[state=on]:border-sky-600 data-[state=on]:bg-sky-600 data-[state=on]:text-white"
            >
              <PencilIcon data-icon="inline-start" />
              Edit
            </Toggle>
          )}
          {onOpenTracks && (
            <Button ref={tracksButtonRef} variant="outline" onClick={onOpenTracks} title="Tracks">
              <ListMusicIcon data-icon="inline-start" />
              <span className="sr-only md:not-sr-only">Tracks</span>
            </Button>
          )}
          <Button
            ref={mixerButtonRef}
            variant="outline"
            aria-expanded={mixerOpen}
            onClick={onToggleMixer}
            title="Mixer"
          >
            <SlidersHorizontalIcon data-icon="inline-start" />
            <span className="sr-only md:not-sr-only">Mixer</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <span id={trackLabelId} className="text-sm font-medium">
            Track
          </span>
          <Select
            value={String(trackIndex)}
            onValueChange={(value) => onTrackChange(Number(value))}
          >
            <SelectTrigger aria-labelledby={trackLabelId} className="max-w-56 min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {summary.tracks.map((t) => (
                <SelectItem key={t.index} value={String(t.index)}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Notation"
          value={view.notation}
          onValueChange={(value) => isNotation(value) && onViewChange({ ...view, notation: value })}
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

        {onToggleInstrumentView && (
          <Toggle
            variant="outline"
            size="sm"
            pressed={instrumentView}
            onPressedChange={onToggleInstrumentView}
          >
            <KeyboardMusicIcon data-icon="inline-start" />
            {instrumentLabel}
          </Toggle>
        )}
      </div>
    </div>
  );
}
