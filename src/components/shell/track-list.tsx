import { useMemo } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  DrumIcon,
  EyeIcon,
  GuitarIcon,
  MicVocalIcon,
  MoreVerticalIcon,
  PianoIcon,
  PlusIcon,
  RotateCcwIcon,
  Settings2Icon,
  SlidersVerticalIcon,
  Trash2Icon,
} from "lucide-react";

import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toggle } from "@/components/ui/toggle";
import { filledBars } from "@/lib/score/bar-grid";
import { describeInstrument } from "@/lib/score/instrument-view";
import { describePan, describeVolume, isAudible, type MixerChange } from "@/lib/score/mixer";
import type { Score } from "@/lib/score/model";
import type { TrackSummary } from "@/lib/score/score";
import { trackColor } from "@/lib/score/track-colors";
import type { MixerSettings } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * Pressed Mute (red) and Solo (yellow) use mixing-desk colours, fixed in both
 * themes, so they stand out from the strip background. Radix sets both
 * `data-state=on` and `aria-pressed`, so both are overridden.
 */
const MUTE_PRESSED =
  "data-[state=on]:border-red-700 data-[state=on]:bg-red-700 aria-pressed:bg-red-700 data-[state=on]:text-white data-[state=on]:hover:bg-red-800 data-[state=on]:hover:text-white";
const SOLO_PRESSED =
  "data-[state=on]:border-amber-400 data-[state=on]:bg-amber-400 aria-pressed:bg-amber-400 data-[state=on]:text-black data-[state=on]:hover:bg-amber-300 data-[state=on]:hover:text-black";

export interface TrackActions {
  onShow: (index: number) => void;
  onMove: (index: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onSettings: (index: number) => void;
  onLyrics: (index: number) => void;
  onAdd: () => void;
}

/** One column of the grid: a bar. */
const BAR_WIDTH = "1.25rem";

/** Width of the controls next to the bar grid. */
const CONTROLS =
  "grid grid-cols-[minmax(7rem,1fr)_2rem_3.5rem_minmax(5rem,1.5fr)_minmax(3.5rem,1fr)_4.5rem] items-center gap-x-2";

function TrackIcon({ track }: { track: TrackSummary }) {
  const Icon =
    track.kind === "drums" ? DrumIcon : track.kind === "stringed" ? GuitarIcon : PianoIcon;
  return <Icon className="size-4 shrink-0" aria-hidden="true" />;
}

function BarGrid({
  color,
  filled,
  current,
  dimmed,
  onSeek,
}: {
  color: string;
  filled: boolean[];
  current: number;
  dimmed: boolean;
  onSeek: (bar: number) => void;
}) {
  return (
    <div
      aria-hidden="true"
      className="grid h-6 shrink-0 gap-px"
      style={{ gridTemplateColumns: `repeat(${filled.length}, ${BAR_WIDTH})` }}
    >
      {filled.map((on, bar) => (
        <button
          key={bar}
          type="button"
          tabIndex={-1}
          onClick={() => onSeek(bar)}
          className={cn(
            "h-full cursor-pointer rounded-[2px] outline-none",
            on ? (dimmed ? "opacity-40" : "opacity-100") : "bg-muted opacity-60",
            bar === current && "ring-2 ring-foreground ring-inset",
          )}
          style={on ? { backgroundColor: color } : undefined}
        />
      ))}
    </div>
  );
}

function TrackRowMenu({
  track,
  count,
  actions,
}: {
  track: TrackSummary;
  count: number;
  actions: TrackActions;
}) {
  const i = track.index;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${track.name}`}
          title="Track actions"
        >
          <MoreVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => actions.onSettings(i)}>
          <Settings2Icon />
          Settings…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onLyrics(i)}>
          <MicVocalIcon />
          Lyrics…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={i === 0} onSelect={() => actions.onMove(i, i - 1)}>
          <ArrowUpIcon />
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={i === count - 1} onSelect={() => actions.onMove(i, i + 1)}>
          <ArrowDownIcon />
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onDuplicate(i)}>
          <CopyIcon />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={count === 1}
          onSelect={() => actions.onRemove(i)}
        >
          <Trash2Icon />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The song's tracks at the bottom of the window: for each one its name (click
 * to show it in the score), visibility, mute, solo, volume, pan, equaliser and
 * automation switches, and a coloured grid with one cell per bar. The Master
 * row sets the overall volume. Replaces the old Mixer and Tracks panels.
 */
export function TrackList({
  score,
  revision,
  tracks,
  shown,
  mix,
  onChange,
  onReset,
  actions,
  bar,
  onSeekBar,
  saved,
  playing,
  onEqualizer,
  onMasterEffects,
}: {
  score: Score;
  /** Changes with every edit (the bars change in place). */
  revision: number;
  tracks: TrackSummary[];
  /** Index of the track shown in the score. */
  shown: number;
  mix: MixerSettings;
  onChange: MixerChange;
  onReset: () => void;
  actions: TrackActions;
  /** The bar being played (0-based). */
  bar: number;
  onSeekBar: (bar: number) => void;
  /** Whether changes are saved for this song (desktop app only). */
  saved: boolean;
  /** Pan is applied at the next pause during playback (see ScorePlayer.setMix). */
  playing: boolean;
  /** Opens the track's effects at its equaliser. */
  onEqualizer?: (track: number) => void;
  /** Opens the master bus's effects. */
  onMasterEffects?: () => void;
}) {
  const barCount = score.masterBars.length;
  const grids = useMemo(() => {
    void revision;
    return score.tracks.map((t) => filledBars(t, barCount));
  }, [score, barCount, revision]);
  const numbers = Array.from({ length: barCount }, (_, i) => i + 1);

  return (
    <section
      aria-label="Tracks and mixer"
      className="flex max-h-[32vh] min-h-0 shrink-0 flex-col overflow-auto border-t bg-card text-sm"
    >
      <div className="flex min-w-max flex-col">
        <div className="sticky top-0 z-10 flex border-b bg-card">
          <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 flex-col gap-0.5 border-r bg-card px-2 py-1">
            <div className={cn(CONTROLS, "text-xs text-muted-foreground")}>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Add track"
                  title="Add track…"
                  onClick={actions.onAdd}
                >
                  <PlusIcon />
                </Button>
                <h2 className="font-semibold text-foreground">Tracks</h2>
              </div>
              <span />
              <span />
              <span>Vol</span>
              <span>Pan</span>
              <span>Eq</span>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="grid items-center gap-px text-center text-[10px] text-muted-foreground tabular-nums"
            style={{ gridTemplateColumns: `repeat(${barCount}, ${BAR_WIDTH})` }}
          >
            {numbers.map((n) => (
              <span key={n}>{n === 1 || n % 4 === 0 ? n : ""}</span>
            ))}
          </div>
        </div>

        <ol className="flex flex-col">
          {tracks.map((track) => {
            const i = track.index;
            const trackMix = mix.tracks[i];
            if (!trackMix) return null;
            const audible = isAudible(mix, i);
            const isShown = i === shown;
            return (
              <li
                key={`${i}-${track.name}`}
                className={cn("flex border-b", isShown && "bg-muted/70")}
                aria-current={isShown ? "true" : undefined}
              >
                <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 items-center border-r [background-color:inherit] bg-inherit px-2 py-1">
                  <div className={cn(CONTROLS, "w-full")}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="h-5 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: trackColor(i) }}
                      />
                      <TrackIcon track={track} />
                      <button
                        type="button"
                        onClick={() => actions.onShow(i)}
                        title={describeInstrument(track)}
                        aria-label={`Show ${track.name}`}
                        className="min-w-0 truncate rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span className="tabular-nums">{i + 1}. </span>
                        {track.name}
                        {isShown && <span className="sr-only"> (shown)</span>}
                      </button>
                    </div>
                    <div className="flex items-center">
                      <Toggle
                        size="sm"
                        pressed={isShown}
                        onPressedChange={() => actions.onShow(i)}
                        aria-label={`Visible: ${track.name}`}
                        title="Show in the score"
                        className="size-7 min-w-7 px-0"
                      >
                        <EyeIcon />
                      </Toggle>
                    </div>
                    <div className="flex gap-0.5">
                      <Toggle
                        size="sm"
                        variant="outline"
                        pressed={trackMix.mute}
                        onPressedChange={(value) => onChange({ type: "mute", track: i, value })}
                        aria-label={`Mute ${track.name}`}
                        title="Mute"
                        className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
                      >
                        M
                      </Toggle>
                      <Toggle
                        size="sm"
                        variant="outline"
                        pressed={trackMix.solo}
                        onPressedChange={(value) => onChange({ type: "solo", track: i, value })}
                        aria-label={`Solo ${track.name}`}
                        title="Solo"
                        className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
                      >
                        S
                      </Toggle>
                    </div>
                    <LabeledSlider
                      label={`Volume, ${track.name}`}
                      valueText={describeVolume(trackMix.volume)}
                      value={trackMix.volume}
                      onValueChange={(value) => onChange({ type: "volume", track: i, value })}
                    />
                    <LabeledSlider
                      label={`Pan, ${track.name}`}
                      valueText={describePan(trackMix.pan)}
                      value={trackMix.pan}
                      min={-1}
                      max={1}
                      step={0.125}
                      onValueChange={(value) =>
                        onChange({ type: "pan", track: i, value }, { commit: false })
                      }
                      onValueCommit={(value) => onChange({ type: "pan", track: i, value })}
                    />
                    <div className="flex items-center justify-end gap-0.5">
                      <Toggle
                        size="sm"
                        disabled
                        aria-label={`Automation for ${track.name} (not available yet)`}
                        title="Automation (not available yet)"
                        className="size-6 min-w-6 px-0 text-xs"
                      >
                        A
                      </Toggle>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={!onEqualizer}
                        onClick={() => onEqualizer?.(i)}
                        aria-label={`Equaliser and effects for ${track.name}`}
                        title="Equaliser and effects"
                      >
                        <SlidersVerticalIcon />
                      </Button>
                      <TrackRowMenu track={track} count={tracks.length} actions={actions} />
                    </div>
                  </div>
                </div>
                <div className="flex items-center px-0">
                  <BarGrid
                    color={trackColor(i)}
                    filled={grids[i] ?? []}
                    current={bar}
                    dimmed={!audible}
                    onSeek={onSeekBar}
                  />
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex">
          <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 items-center gap-2 border-r bg-card px-2 py-1.5">
            <div className={cn(CONTROLS, "w-full")}>
              <span className="pl-2.5 font-semibold">Master</span>
              <span />
              <span />
              <LabeledSlider
                label="Master volume"
                valueText={describeVolume(mix.master)}
                value={mix.master}
                onValueChange={(value) => onChange({ type: "master", value })}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                {describeVolume(mix.master)}
              </span>
              <span className="flex items-center">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!onMasterEffects}
                  onClick={onMasterEffects}
                  aria-label="Master effects"
                  title="Master effects"
                >
                  <SlidersVerticalIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onReset}
                  aria-label="Reset the mix"
                  title="Reset the mix"
                >
                  <RotateCcwIcon />
                </Button>
              </span>
            </div>
          </div>
        </div>
        <p className="sticky left-0 w-[30rem] px-3 pb-1.5 text-xs text-muted-foreground">
          {saved
            ? "Mix changes are saved for this song."
            : "Mix changes last until you close this song."}
          {playing && " Pan changes are applied when you pause."}
        </p>
      </div>
    </section>
  );
}
