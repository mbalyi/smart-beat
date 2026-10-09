import { HeadphonesIcon } from "lucide-react";
import { useId } from "react";

import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import { ACTIVE_BRAND } from "@/components/ui/mixer-toggle-styles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  FOCUS_CUT_MIN_DB,
  FOCUS_CUT_PRESETS,
  practiceMode,
  type MixerChange,
} from "@/lib/score/mixer";
import type { TrackSummary } from "@/lib/score/score";
import type { FocusMode, MixerSettings } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type Mode = FocusMode | "normal";

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "normal", label: "Normal mix", hint: "Your mix as you set it" },
  { value: "othersDown", label: "Others turned down", hint: "Everything, quieter around you" },
  { value: "onlyMe", label: "Hear only me", hint: "Just the track you practise" },
  { value: "backing", label: "Backing only", hint: "Everything but your track: play it yourself" },
];

/** The words for a mode on the button. */
const modeLabel = (mode: Mode) => MODES.find((m) => m.value === mode)!.label;

/**
 * Quick practice mixes (#83): which track you practise, and whether you hear the normal mix,
 * the others turned down (and by how much), only your track, or everything but it. The mixer's
 * own faders, mutes and solos are never changed, so "Normal mix" brings them back as they were.
 */
export function PracticeMix({
  tracks,
  shown,
  mix,
  onChange,
  cutDb,
  onCutChange,
}: {
  tracks: TrackSummary[];
  /** The track shown in the score: the one practised when none is chosen yet. */
  shown: number;
  mix: MixerSettings;
  onChange: MixerChange;
  /** How far "Others turned down" turns them down (dB). */
  cutDb: number;
  onCutChange: (db: number) => void;
}) {
  const trackLabelId = useId();
  const cutLabelId = useId();
  const mode = practiceMode(mix);
  const practised = mix.focus ?? shown;
  const name = tracks[practised]?.name ?? "";
  const setMode = (next: Mode) =>
    onChange(
      next === "normal"
        ? { type: "focus", track: null }
        : { type: "focus", track: practised, mode: next },
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Practice mix: hear only your track, or everything but it"
          aria-label={`Practice mix: ${modeLabel(mode)}${mode === "normal" ? "" : `, ${name}`}`}
          className={cn(mode !== "normal" && ACTIVE_BRAND)}
        >
          <HeadphonesIcon data-icon="inline-start" />
          <span className="max-2xl:sr-only">
            {mode === "normal" ? "Practice mix" : modeLabel(mode)}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-3" aria-label="Practice mix">
        <p className="text-sm font-medium">Practice mix</p>
        <div className="flex items-center justify-between gap-2">
          <span id={trackLabelId} className="text-sm">
            Practising
          </span>
          <Select
            value={String(practised)}
            onValueChange={(v) =>
              onChange({
                type: "focus",
                track: Number(v),
                ...(mode !== "normal" && { mode }),
              })
            }
          >
            <SelectTrigger size="sm" aria-labelledby={trackLabelId} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tracks.map((t, i) => (
                <SelectItem key={i} value={String(i)}>
                  {i + 1}. {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ToggleGroup
          type="single"
          orientation="vertical"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as Mode)}
          aria-label="What you hear"
          className="flex w-full flex-col items-stretch"
        >
          {MODES.map((m) => (
            <ToggleGroupItem
              key={m.value}
              value={m.value}
              className="h-auto justify-start py-1.5 text-left whitespace-normal"
            >
              <span className="flex flex-col">
                <span>{m.label}</span>
                <span className="text-xs font-normal">{m.hint}</span>
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {mode === "othersDown" && (
          <div className="flex flex-col gap-2">
            <span id={cutLabelId} className="text-sm">
              Turn the others down by {Math.abs(cutDb)} dB
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={String(cutDb)}
              onValueChange={(v) => v && onCutChange(Number(v))}
              aria-labelledby={cutLabelId}
            >
              {FOCUS_CUT_PRESETS.map((p) => (
                <ToggleGroupItem key={p.db} value={String(p.db)}>
                  {p.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <LabeledSlider
              label="Others turned down by"
              valueText={`${Math.abs(cutDb)} dB`}
              value={cutDb}
              min={FOCUS_CUT_MIN_DB}
              max={0}
              step={1}
              onValueChange={onCutChange}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
