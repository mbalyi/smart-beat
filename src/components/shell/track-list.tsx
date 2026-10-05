import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  CopyIcon,
  CrosshairIcon,
  DrumIcon,
  EyeIcon,
  FileMusicIcon,
  GuitarIcon,
  MicVocalIcon,
  MoreVerticalIcon,
  PianoIcon,
  PlusIcon,
  RotateCcwIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SlidersVerticalIcon,
  Trash2Icon,
} from "lucide-react";

import { AudioWaveform } from "@/components/audio/audio-track-panel";
import { AutomationLane, LaneKindSelect } from "@/components/audio/automation-lane";
import { EqPopover } from "@/components/audio/eq-popover";
import { LevelMeter } from "@/components/audio/level-meter";
import { LabeledSlider } from "@/components/labeled-slider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { filledBars } from "@/lib/score/bar-grid";
import { barTexts, shortText, tempoMarkers } from "@/lib/score/tempo";
import { describeInstrument } from "@/lib/score/instrument-view";
import {
  describePan,
  describeVolume,
  EMPTY_AUTOMATION,
  isAudible,
  trackAutomation,
  trackEq,
  type MixerChange,
} from "@/lib/score/mixer";
import type { Score } from "@/lib/score/model";
import type { TrackSummary } from "@/lib/score/score";
import { trackColor } from "@/lib/score/track-colors";
import type { AutomationLaneKind, BackingInfo, MixerSettings } from "@/lib/tauri";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { cn } from "@/lib/utils";

export interface TrackActions {
  onShow: (index: number) => void;
  onMove: (index: number, to: number) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onSettings: (index: number) => void;
  onLyrics: (index: number) => void;
  onAdd: () => void;
  /** Opens the track's pedalboard. */
  onEffects?: (index: number) => void;
  /** Opens the drum mixer of a drum track. */
  onDrumMixer?: (index: number) => void;
}

/** One column of the grid: a bar. */
const BAR_WIDTH = "1.25rem";
/** A bar column plus the 1 px gap, in pixels (for drawings that line up with the grid). */
export const BAR_PX = 21;

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
  focused,
  onFocus,
}: {
  track: TrackSummary;
  count: number;
  actions: TrackActions;
  focused: boolean;
  onFocus: (focus: boolean) => void;
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
        {actions.onEffects && (
          <DropdownMenuItem onSelect={() => actions.onEffects?.(i)}>
            <SlidersHorizontalIcon />
            Effects (pedalboard)…
          </DropdownMenuItem>
        )}
        {actions.onDrumMixer && track.kind === "drums" && (
          <DropdownMenuItem onSelect={() => actions.onDrumMixer?.(i)}>
            <DrumIcon />
            Drum mixer…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onFocus(!focused)}>
          <CrosshairIcon />
          {focused ? "Unfocus" : "Focus (turn the others down)"}
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
  onMasterEffects,
  audio,
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
  /** Opens the master bus's effects. */
  onMasterEffects?: () => void;
  /** The audio track row (missing: none and none can be added here). */
  audio?: {
    info: BackingInfo | null;
    /** Song ms at each bar start, plus the end. */
    barTimes: readonly number[];
    onAdd: () => void;
    onEdit: () => void;
  };
}) {
  const [lanes, setLanes] = useState<Record<number, AutomationLaneKind>>({});
  const barCount = score.masterBars.length;
  const grids = useMemo(() => {
    void revision;
    return score.tracks.map((t) => filledBars(t, barCount));
  }, [score, barCount, revision]);
  const numbers = Array.from({ length: barCount }, (_, i) => i + 1);
  const texts = useMemo(() => {
    void revision;
    return barTexts(score);
  }, [score, revision]);
  const tempos = useMemo(() => {
    void revision;
    return new Map(tempoMarkers(score).map((m) => [m.bar, m]));
  }, [score, revision]);

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
                {audio && !mix.audioTrack && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Add audio track"
                    title="Add audio track (mp3, wav…)…"
                    onClick={audio.onAdd}
                  >
                    <FileMusicIcon />
                  </Button>
                )}
                <h2 className="font-semibold text-foreground">Tracks</h2>
              </div>
              <span />
              <span />
              <span>Vol</span>
              <span>Pan</span>
              <span>Eq</span>
            </div>
          </div>
          <div className="flex flex-col justify-center">
            {/* Tempo markers (GP8 shows them above the bar grid); the score shows them too. */}
            <div
              data-testid="tempo-markers"
              className="grid h-3.5 items-center gap-px text-[9px] leading-none whitespace-nowrap text-amber-700 tabular-nums dark:text-amber-400"
              style={{ gridTemplateColumns: `repeat(${barCount}, ${BAR_WIDTH})` }}
            >
              {numbers.map((n) => {
                const marker = tempos.get(n - 1);
                return marker ? (
                  <span
                    key={n}
                    className="overflow-visible"
                    title={`Bar ${n}: ${marker.label ? `${marker.label}, ` : ""}${marker.bpm} BPM`}
                  >
                    ♩{marker.bpm}
                  </span>
                ) : (
                  <span key={n} />
                );
              })}
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
            {texts.size > 0 && (
              // Texts written on the beats of any track, above all the tracks.
              <ul
                aria-label="Texts in the song"
                data-testid="bar-texts"
                className="grid h-4 items-center gap-px text-[10px] leading-none whitespace-nowrap text-foreground"
                style={{ gridTemplateColumns: `repeat(${barCount}, ${BAR_WIDTH})` }}
              >
                {numbers.map((n) => {
                  const list = texts.get(n - 1);
                  if (!list) return <li key={n} aria-hidden="true" />;
                  const full = list.join(", ");
                  return (
                    <li
                      key={n}
                      title={`Bar ${n}: ${full}`}
                      // The current bar's text is on top; the text under the pointer is above that, in full.
                      className={cn("group/text relative hover:z-30", n - 1 === bar && "z-20")}
                    >
                      <span
                        className={cn(
                          "block w-max rounded-sm bg-muted px-1 py-0.5 italic",
                          n - 1 === bar && "ring-1 ring-foreground",
                        )}
                      >
                        <span className="group-hover/text:hidden">{shortText(full)}</span>
                        <span className="hidden group-hover/text:inline">{full}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <ol className="flex flex-col">
          {tracks.map((track) => {
            const i = track.index;
            const trackMix = mix.tracks[i];
            if (!trackMix) return null;
            const audible = isAudible(mix, i);
            const isShown = i === shown;
            const automation = trackAutomation(mix, i);
            const lane = lanes[i] ?? "volume";
            const focused = mix.focus === i;
            // Opaque, so bars scrolled under the sticky name column stay hidden.
            const rowBackground = isShown ? "bg-muted" : "bg-card";
            return (
              <li
                key={`${i}-${track.name}`}
                className={cn("flex flex-col border-b bg-card", isShown && "bg-muted")}
                aria-current={isShown ? "true" : undefined}
              >
                <div className="flex">
                  <div
                    className={cn(
                      "sticky left-0 z-10 flex w-[30rem] shrink-0 items-center border-r px-2 py-1",
                      rowBackground,
                    )}
                  >
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
                          aria-label={`Show ${track.name}${focused ? " (in focus)" : ""}`}
                          className="min-w-0 truncate rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <span className="tabular-nums">{i + 1}. </span>
                          {track.name}
                          {isShown && <span className="sr-only"> (shown)</span>}
                          {focused && <span className="sr-only"> (in focus)</span>}
                        </button>
                        {focused && (
                          <CrosshairIcon
                            className="size-3.5 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        )}
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
                      <div className="flex flex-col gap-0.5">
                        <LabeledSlider
                          label={`Volume, ${track.name}`}
                          valueText={describeVolume(trackMix.volume)}
                          value={trackMix.volume}
                          onValueChange={(value) => onChange({ type: "volume", track: i, value })}
                        />
                        <LevelMeter
                          label={`Level, ${track.name}`}
                          select={(m) => m.tracks[i] ?? 0}
                        />
                      </div>
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
                          pressed={automation.enabled}
                          onPressedChange={(enabled) =>
                            onChange({
                              type: "automation",
                              track: i,
                              automation: { ...automation, enabled },
                            })
                          }
                          aria-label={`Automation for ${track.name}`}
                          title="Automation (volume, pan and mute along the song)"
                          className="size-6 min-w-6 px-0 text-xs"
                        >
                          A
                        </Toggle>
                        <EqPopover
                          name={track.name}
                          eq={trackEq(mix, i)}
                          onChange={(eq) => onChange({ type: "eq", track: i, eq })}
                        />
                        <TrackRowMenu
                          track={track}
                          count={tracks.length}
                          actions={actions}
                          focused={focused}
                          onFocus={(on) => onChange({ type: "focus", track: on ? i : null })}
                        />
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
                </div>
                {automation.enabled && (
                  <div className="flex border-t border-dashed">
                    <div
                      className={cn(
                        "sticky left-0 z-10 flex w-[30rem] shrink-0 items-center justify-end gap-2 border-r px-2 py-1 text-xs",
                        rowBackground,
                      )}
                    >
                      <span>Automation</span>
                      <LaneKindSelect
                        name={track.name}
                        kind={lane}
                        onChange={(kind) => setLanes((l) => ({ ...l, [i]: kind }))}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={automation[lane].length === 0}
                        onClick={() =>
                          onChange({
                            type: "automation",
                            track: i,
                            automation: { ...automation, [lane]: [] },
                          })
                        }
                      >
                        Clear
                      </Button>
                    </div>
                    <AutomationLane
                      name={track.name}
                      kind={lane}
                      automation={automation.enabled ? automation : EMPTY_AUTOMATION}
                      barCount={barCount}
                      barWidth={BAR_PX}
                      onChange={(next) =>
                        onChange({ type: "automation", track: i, automation: next })
                      }
                    />
                  </div>
                )}
              </li>
            );
          })}
          {audio && mix.audioTrack && (
            <li className="flex border-b" data-testid="audio-track-row">
              <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 items-center border-r bg-card px-2 py-1">
                <div className={cn(CONTROLS, "w-full")}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-5 w-1 shrink-0 rounded-full bg-amber-500"
                    />
                    <AudioLinesIcon className="size-4 shrink-0" aria-hidden="true" />
                    <button
                      type="button"
                      onClick={audio.onEdit}
                      title={mix.audioTrack.path ?? mix.audioTrack.name}
                      aria-label={`Edit the audio track ${mix.audioTrack.name}`}
                      className="min-w-0 truncate rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {mix.audioTrack.name}
                    </button>
                  </div>
                  <div className="flex items-center">
                    <Switch
                      checked={mix.audioTrack.enabled}
                      onCheckedChange={(enabled) =>
                        onChange({ type: "audio-track", value: { ...mix.audioTrack!, enabled } })
                      }
                      aria-label="Audio track on"
                    />
                  </div>
                  <div className="flex gap-0.5">
                    <Toggle
                      size="sm"
                      variant="outline"
                      pressed={mix.audioTrack.mute}
                      onPressedChange={(mute) =>
                        onChange({ type: "audio-track", value: { ...mix.audioTrack!, mute } })
                      }
                      aria-label="Mute the audio track"
                      className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
                    >
                      M
                    </Toggle>
                    <Toggle
                      size="sm"
                      variant="outline"
                      pressed={mix.audioTrack.solo}
                      onPressedChange={(solo) =>
                        onChange({ type: "audio-track", value: { ...mix.audioTrack!, solo } })
                      }
                      aria-label="Solo the audio track"
                      className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
                    >
                      S
                    </Toggle>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <LabeledSlider
                      label="Volume, audio track"
                      valueText={describeVolume(mix.audioTrack.volume)}
                      value={mix.audioTrack.volume}
                      onValueChange={(volume) =>
                        onChange({ type: "audio-track", value: { ...mix.audioTrack!, volume } })
                      }
                    />
                    <LevelMeter label="Level, audio track" select={(m) => m.backing ?? 0} />
                  </div>
                  <LabeledSlider
                    label="Pan, audio track"
                    valueText={describePan(mix.audioTrack.pan)}
                    value={mix.audioTrack.pan}
                    min={-1}
                    max={1}
                    step={0.125}
                    onValueChange={(pan) =>
                      onChange({ type: "audio-track", value: { ...mix.audioTrack!, pan } })
                    }
                  />
                  <div className="flex items-center justify-end gap-0.5">
                    <EqPopover
                      name="audio track"
                      eq={mix.audioTrack.eq}
                      onChange={(eq) =>
                        onChange({ type: "audio-track", value: { ...mix.audioTrack!, eq } })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={audio.onEdit}
                      aria-label="Audio track settings and sync points"
                      title="Settings and sync points"
                    >
                      <Settings2Icon />
                    </Button>
                  </div>
                </div>
              </div>
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={audio.onEdit}
                className="flex items-center overflow-hidden"
              >
                {audio.info ? (
                  <AudioWaveform
                    info={audio.info}
                    sync={mix.audioTrack.sync}
                    barTimes={audio.barTimes}
                    barWidth={BAR_PX}
                    className="h-6!"
                  />
                ) : (
                  <span className="px-2 text-xs text-muted-foreground">Recording not loaded</span>
                )}
              </button>
            </li>
          )}
        </ol>

        <div className="flex">
          <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 items-center gap-2 border-r bg-card px-2 py-1.5">
            <div className={cn(CONTROLS, "w-full")}>
              <span className="pl-2.5 font-semibold">Master</span>
              <span />
              <span />
              <div className="flex flex-col gap-0.5">
                <LabeledSlider
                  label="Master volume"
                  valueText={describeVolume(mix.master)}
                  value={mix.master}
                  onValueChange={(value) => onChange({ type: "master", value })}
                />
                <LevelMeter label="Level, master" select={(m) => m.master} />
              </div>
              <LabeledSlider
                label="Master pan"
                valueText={describePan(mix.masterPan ?? 0)}
                value={mix.masterPan ?? 0}
                min={-1}
                max={1}
                step={0.125}
                onValueChange={(value) => onChange({ type: "master-pan", value })}
              />
              <span className="flex items-center justify-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!onMasterEffects}
                  onClick={onMasterEffects}
                  aria-label="Mastering effects"
                  title="Mastering effects (pedalboard)"
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
