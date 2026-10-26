import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  CableIcon,
  CopyIcon,
  CopyPlusIcon,
  ListOrderedIcon,
  CrosshairIcon,
  DrumIcon,
  EyeIcon,
  FileMusicIcon,
  GripVerticalIcon,
  GuitarIcon,
  MicVocalIcon,
  MoreVerticalIcon,
  PaletteIcon,
  PianoIcon,
  PlugIcon,
  PlusIcon,
  RotateCcwIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SlidersVerticalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { AudioWaveform } from "@/components/audio/audio-track-panel";
import { AutomationLane, LaneKindSelect } from "@/components/audio/automation-lane";
import { EqPopover } from "@/components/audio/eq-popover";
import { LevelMeter } from "@/components/audio/level-meter";
import { LabeledSlider } from "@/components/labeled-slider";
import { PanControl } from "@/components/pan-control";
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
import { barSections, barTexts, shortText, tempoMarkers } from "@/lib/score/tempo";
import { lowSoundWarning } from "@/lib/audio/sound-ranges";
import { describeInstrument } from "@/lib/score/instrument-view";
import { lowestPitch, tuningLabel } from "@/lib/score/music";
import type { SoundFontId } from "@/lib/score/soundfonts";
import {
  describeVolume,
  EMPTY_AUTOMATION,
  heardMix,
  isAudible,
  isMonitorAudible,
  trackAutomation,
  trackEq,
  type MixerChange,
} from "@/lib/score/mixer";
import type { Score } from "@/lib/score/model";
import type { TrackSummary } from "@/lib/score/score";
import { TrackColorDialog } from "@/components/shell/track-color-dialog";
import { trackColor } from "@/lib/score/track-colors";
import { describeLatency, MONITOR_NAME } from "@/lib/audio/monitor";
import type {
  AutomationLaneKind,
  BackingInfo,
  MixerSettings,
  MonitorStatus,
  MonitorTrackSettings,
} from "@/lib/tauri";
import { MUTE_PRESSED, SOLO_PRESSED } from "@/components/ui/mixer-toggle-styles";
import { cn } from "@/lib/utils";

export interface TrackActions {
  onShow: (index: number) => void;
  /** Adds the track to the continuous view or takes it out (#157). */
  onToggleVisible?: (index: number) => void;
  /** Moves a stacked track up or down (-1, +1) in the continuous view, apart from the file order. */
  onMoveInView?: (index: number, delta: number) => void;
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
  /** Opens the dialog that copies a (non-drum) track to another instrument. */
  onCopyToInstrument?: (index: number) => void;
  /** Re-maps a drum track's notes onto the standard lanes of the drum tab. */
  onNormalizeDrums?: (index: number) => void;
}

/** One column of the grid: a bar. */
const BAR_WIDTH = "1.25rem";
/** A bar column plus the 1 px gap, in pixels (for drawings that line up with the grid). */
export const BAR_PX = 21;

/** Width of the sticky name and mixer column left of the bar grid (`w-[30rem]`), in rem. */
const NAME_COLUMN_REM = 30;

/** Remembers whether the rows above the bars (sections, tempo markers, texts) are shown. */
export const NOTES_STORAGE_KEY = "smart-beat:track-notes";

/** The rows above the bars are shown unless the user hid them. */
function readNotesShown(): boolean {
  try {
    return localStorage.getItem(NOTES_STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

function storeNotesShown(shown: boolean) {
  try {
    localStorage.setItem(NOTES_STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    // Not remembered: shown next time.
  }
}

/** Width of the controls next to the bar grid. */
const CONTROLS =
  "grid grid-cols-[minmax(7rem,1fr)_var(--eye-col,2rem)_3.5rem_minmax(5rem,1.5fr)_minmax(3.5rem,1fr)_4.5rem] items-center gap-x-2";

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
  onColor,
  place,
}: {
  track: TrackSummary;
  count: number;
  actions: TrackActions;
  /** Position in the continuous view and how many tracks it has (null: not stacked). */
  place: { position: number; of: number } | null;
  focused: boolean;
  onFocus: (focus: boolean) => void;
  /** Opens the colour picker of the track. */
  onColor: () => void;
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
        {actions.onNormalizeDrums && track.kind === "drums" && (
          <DropdownMenuItem onSelect={() => actions.onNormalizeDrums?.(i)}>
            <ListOrderedIcon />
            Normalize drum notation
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => onFocus(!focused)}>
          <CrosshairIcon />
          {focused ? "Unfocus" : "Focus (turn the others down)"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onColor}>
          <PaletteIcon />
          Colour…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {place && place.of > 1 && actions.onMoveInView && (
          <>
            <DropdownMenuItem
              disabled={place.position === 0}
              onSelect={() => actions.onMoveInView?.(i, -1)}
            >
              <ArrowUpIcon />
              Move up in the view
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={place.position === place.of - 1}
              onSelect={() => actions.onMoveInView?.(i, 1)}
            >
              <ArrowDownIcon />
              Move down in the view
            </DropdownMenuItem>
          </>
        )}
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
        {actions.onCopyToInstrument && track.kind !== "drums" && (
          <DropdownMenuItem onSelect={() => actions.onCopyToInstrument?.(i)}>
            <CopyPlusIcon />
            Copy to instrument…
          </DropdownMenuItem>
        )}
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
/** A small warning next to a track whose lowest string is far below what its sound was recorded at. */
function LowSoundMark({ track, soundFont }: { track: TrackSummary; soundFont?: SoundFontId }) {
  if (!soundFont || track.kind !== "stringed") return null;
  const warning = lowSoundWarning(soundFont, track.program, lowestPitch(track.tuning, track.capo));
  if (!warning) return null;
  return (
    <span
      role="img"
      aria-label={`${track.name}: ${warning.message}`}
      title={warning.message}
      data-testid="low-sound-mark"
      className="shrink-0 text-amber-600 dark:text-amber-400"
    >
      <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

/** What the track list needs for the monitor track (missing: none, and none can be added). */
export interface MonitorRowProps {
  /** Its input, as the engine reports it (null: not listening). */
  status: MonitorStatus | null;
  /** The native engine plays it (it is silent with alphaTab's synthesizer). */
  engineOn: boolean;
  /** The input chosen in Settings ("System default"). */
  inputName: string;
  /** The channel chosen in Settings: 0-based, or null for all mixed. */
  channel: number | null;
  onAdd: () => void;
  onRemove: () => void;
  /** Opens its pedalboard. */
  onEffects: () => void;
  /** Opens Settings, where the input is chosen; focus returns to `from`. */
  onInputSettings?: (from: HTMLElement) => void;
}

/** What the monitor track is listening to, or why it is silent. */
function monitorText(
  monitor: MonitorTrackSettings,
  props: MonitorRowProps,
): { text: string; problem: boolean } {
  if (!props.engineOn) {
    return { text: "Plays with effects playback (the native audio engine) on", problem: true };
  }
  if (!monitor.enabled) return { text: `Off · ${props.inputName}`, problem: false };
  const status = props.status;
  if (status?.error) return { text: status.error, problem: true };
  if (!status?.open) return { text: `Opening ${props.inputName}…`, problem: false };
  const channel =
    status.channels < 2
      ? ""
      : props.channel === null
        ? " · all inputs"
        : ` · input ${Math.min(props.channel, status.channels - 1) + 1}`;
  return {
    text: `${status.device}${channel} · about ${describeLatency(status.latencyMs)} delay`,
    problem: false,
  };
}

/**
 * The monitor track: the audio input (Settings › Audio) played live through its own effects,
 * with the same mute, solo, volume, pan and EQ as the other tracks.
 */
function MonitorRow({
  monitor,
  props,
  audible,
  onChange,
}: {
  monitor: MonitorTrackSettings;
  props: MonitorRowProps;
  /** Not muted, and not silenced by another track's solo. */
  audible: boolean;
  onChange: (monitor: MonitorTrackSettings) => void;
}) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const { text, problem } = monitorText(monitor, props);
  return (
    <li className="flex border-b" data-testid="monitor-track-row">
      <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 items-center border-r bg-card px-2 py-1">
        <div className={cn(CONTROLS, "w-full")}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="h-5 w-1 shrink-0 rounded-full bg-emerald-500" />
            <CableIcon className="size-4 shrink-0" aria-hidden="true" />
            <button
              type="button"
              onClick={props.onEffects}
              title={`${props.inputName}: effects (pedalboard)`}
              aria-label={`Effects of the ${MONITOR_NAME.toLowerCase()} track`}
              className="min-w-0 truncate rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {MONITOR_NAME}
            </button>
          </div>
          <div className="flex items-center">
            <Switch
              checked={monitor.enabled}
              onCheckedChange={(enabled) => onChange({ ...monitor, enabled })}
              aria-label="Monitor track on (listen to the input)"
            />
          </div>
          <div className="flex gap-0.5">
            <Toggle
              size="sm"
              variant="outline"
              pressed={monitor.mute}
              onPressedChange={(mute) => onChange({ ...monitor, mute })}
              aria-label="Mute the monitor track"
              title="Mute"
              className={cn("size-6 min-w-6 px-0 text-xs", MUTE_PRESSED)}
            >
              M
            </Toggle>
            <Toggle
              size="sm"
              variant="outline"
              pressed={monitor.solo}
              onPressedChange={(solo) => onChange({ ...monitor, solo })}
              aria-label="Solo the monitor track"
              title="Solo"
              className={cn("size-6 min-w-6 px-0 text-xs", SOLO_PRESSED)}
            >
              S
            </Toggle>
          </div>
          <div className="flex flex-col gap-0.5">
            <LabeledSlider
              label="Volume, monitor track"
              valueText={describeVolume(monitor.volume)}
              value={monitor.volume}
              onValueChange={(volume) => onChange({ ...monitor, volume })}
            />
            <LevelMeter label="Level, monitor track" select={(m) => m.monitor ?? 0} />
          </div>
          <PanControl
            label="Pan, monitor track"
            value={monitor.pan}
            onValueChange={(pan) => onChange({ ...monitor, pan })}
          />
          <div className="flex items-center justify-end gap-0.5">
            <EqPopover
              name="monitor track"
              eq={monitor.eq}
              onChange={(eq) => onChange({ ...monitor, eq })}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={menuButton}
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Actions for the monitor track"
                  title="Track actions"
                >
                  <MoreVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={props.onEffects}>
                  <SlidersHorizontalIcon />
                  Effects (pedalboard)…
                </DropdownMenuItem>
                {props.onInputSettings && (
                  <DropdownMenuItem
                    onSelect={() =>
                      menuButton.current && props.onInputSettings?.(menuButton.current)
                    }
                  >
                    <PlugIcon />
                    Input settings…
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={props.onRemove}>
                  <Trash2Icon />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 px-2 text-xs">
        {monitor.enabled && props.engineOn && (
          <LevelMeter
            label="Input level, monitor track"
            select={(m) => m.monitorInput ?? 0}
            className="w-24"
          />
        )}
        <span
          role="status"
          className={cn(
            "whitespace-nowrap",
            problem ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
            !audible && !problem && "opacity-60",
          )}
        >
          {text}
        </span>
      </div>
    </li>
  );
}

export function TrackList({
  score,
  revision,
  tracks,
  shown,
  stack,
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
  monitor,
  soundFont,
}: {
  score: Score;
  /** The sound set that plays the song (missing: no warning about very low notes). */
  soundFont?: SoundFontId;
  /** Changes with every edit (the bars change in place). */
  revision: number;
  tracks: TrackSummary[];
  /** Index of the track shown in the score. */
  shown: number;
  /**
   * The tracks stacked in the continuous view, in display order, and whether that layout is on
   * (otherwise the eye just shows the track, as before; #157).
   */
  stack?: { indexes: number[]; stacking: boolean };
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
  /** The monitor track row (missing: none and none can be added here). */
  monitor?: MonitorRowProps;
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
  const [colorTrack, setColorTrack] = useState<number | null>(null);
  const [notesShown, setNotesShown] = useState(readNotesShown);
  const dragged = useRef<number | null>(null);
  const scroller = useRef<HTMLElement>(null);
  // The user scrolled the panel by hand: leave it alone until the next play or seek (#178).
  const scrolledByHand = useRef(false);
  const stacking = !!stack?.stacking;
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
  const lastBar = useRef(bar);
  useEffect(() => {
    if (playing) scrolledByHand.current = false;
  }, [playing]);
  useEffect(() => {
    // Playback moves one bar at a time: any other jump is a seek (the toolbar, the score, a
    // loop), which resumes following.
    if (bar !== lastBar.current && bar !== lastBar.current + 1) scrolledByHand.current = false;
    lastBar.current = bar;
  }, [bar]);
  // Keep the playing bar in view in a long song (#178): the grid is wider than the panel.
  useEffect(() => {
    const el = scroller.current;
    if (!playing || !el || scrolledByHand.current) return;
    const label = NAME_COLUMN_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
    const first = bar * BAR_PX;
    const room = el.clientWidth - label;
    if (first >= el.scrollLeft && first + BAR_PX <= el.scrollLeft + room) return;
    el.scrollLeft = Math.max(0, first - room / 2 + BAR_PX / 2);
  }, [bar, playing]);
  // Stopped at the start: show the first bars again (#182).
  useEffect(() => {
    if (!playing && bar === 0 && scroller.current) scroller.current.scrollLeft = 0;
  }, [bar, playing]);
  const seekBar = (index: number) => {
    scrolledByHand.current = false;
    onSeekBar(index);
  };
  const sections = useMemo(() => {
    void revision;
    return barSections(score);
  }, [score, revision]);
  const tempos = useMemo(() => {
    void revision;
    return new Map(tempoMarkers(score).map((m) => [m.bar, m]));
  }, [score, revision]);

  return (
    <section
      aria-label="Tracks and mixer"
      data-tour="tracks"
      ref={scroller}
      onWheel={() => (scrolledByHand.current = true)}
      onTouchMove={() => (scrolledByHand.current = true)}
      onPointerDown={() => (scrolledByHand.current = true)}
      style={{ "--eye-col": stacking ? "3.75rem" : undefined } as CSSProperties}
      className="flex max-h-[32vh] min-h-0 shrink-0 flex-col overflow-auto border-t bg-card text-sm"
    >
      <div className="flex min-w-max flex-col">
        <div className="sticky top-0 z-10 flex border-b bg-card">
          <div className="sticky left-0 z-10 flex w-[30rem] shrink-0 flex-col gap-0.5 border-r bg-card px-2 py-1">
            <Toggle
              size="sm"
              variant="outline"
              pressed={notesShown}
              onPressedChange={(value) => {
                setNotesShown(value);
                storeNotesShown(value);
              }}
              aria-label="Show sections, tempo markers and texts"
              title={
                notesShown
                  ? "Hide sections, tempo markers and texts"
                  : "Show sections, tempo markers and texts"
              }
              data-tour="track-notes"
              className="absolute top-1 right-2 size-6 min-w-6 px-0"
            >
              <EyeIcon className="size-3.5" />
            </Toggle>
            <div className={cn(CONTROLS, "text-xs text-muted-foreground")}>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Add track"
                  title="Add track…"
                  onClick={actions.onAdd}
                  data-tour="add-track"
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
                {monitor && !mix.monitor && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Add monitor track"
                    title="Add monitor track (hear your audio input live, with effects)"
                    onClick={monitor.onAdd}
                  >
                    <CableIcon />
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
            {notesShown && sections.size > 0 && (
              // Section names (Verse, Chorus…) at the bar they start, as in the score (#178).
              <ul
                aria-label="Sections of the song"
                data-testid="bar-sections"
                className="grid h-3.5 items-center gap-px text-[10px] leading-none font-semibold whitespace-nowrap text-foreground"
                style={{ gridTemplateColumns: `repeat(${barCount}, ${BAR_WIDTH})` }}
              >
                {numbers.map((n) => {
                  const name = sections.get(n - 1);
                  return name ? (
                    <li key={n} title={`Bar ${n}: ${name}`} className="overflow-visible">
                      {name}
                    </li>
                  ) : (
                    <li key={n} aria-hidden="true" />
                  );
                })}
              </ul>
            )}
            {/* Tempo markers (GP8 shows them above the bar grid); the score shows them too. */}
            {notesShown && (
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
            )}
            <div
              aria-hidden="true"
              className="grid items-center gap-px text-center text-[10px] text-muted-foreground tabular-nums"
              style={{ gridTemplateColumns: `repeat(${barCount}, ${BAR_WIDTH})` }}
            >
              {numbers.map((n) => (
                <span key={n}>{n === 1 || n % 4 === 0 ? n : ""}</span>
              ))}
            </div>
            {notesShown && texts.size > 0 && (
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
            const audible = isAudible(heardMix(mix), i);
            const isShown = i === shown;
            const position = stack ? stack.indexes.indexOf(i) : -1;
            const stacked = stacking && position >= 0;
            const place =
              stacking && stack && position >= 0 ? { position, of: stack.indexes.length } : null;
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
                <div
                  role="presentation"
                  className="flex"
                  onDragOver={(event) => {
                    if (stacked && dragged.current !== null) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const from = dragged.current;
                    dragged.current = null;
                    if (!stacked || from === null || !stack) return;
                    event.preventDefault();
                    const delta = position - stack.indexes.indexOf(from);
                    if (delta !== 0) actions.onMoveInView?.(from, delta);
                  }}
                >
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
                          style={{ backgroundColor: trackColor(i, mix.trackColors?.[i]) }}
                        />
                        <TrackIcon track={track} />
                        <button
                          type="button"
                          onClick={() => actions.onShow(i)}
                          onKeyDown={(event) => {
                            if (!place || !event.altKey) return;
                            const delta =
                              event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                            if (delta === 0) return;
                            event.preventDefault();
                            actions.onMoveInView?.(i, delta);
                          }}
                          aria-keyshortcuts={
                            place && place.of > 1 ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                          }
                          title={describeInstrument(track)}
                          aria-label={`Show ${track.name}${focused ? " (in focus)" : ""}${
                            place && place.of > 1
                              ? ` (position ${place.position + 1} of ${place.of} in the view)`
                              : ""
                          }`}
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
                        {track.kind === "stringed" && (
                          // The tuning at a glance (#83); the pitches are in the tooltip.
                          <span
                            data-testid="tuning-name"
                            className="shrink-0 rounded-sm border px-1 text-[10px] leading-4 text-foreground"
                          >
                            {tuningLabel(track.tuning)}
                          </span>
                        )}
                        <LowSoundMark track={track} soundFont={soundFont} />
                      </div>
                      <div className="flex items-center">
                        {place && place.of > 1 && (
                          <button
                            type="button"
                            draggable
                            data-testid="view-handle"
                            aria-label={`Reorder ${track.name} in the view`}
                            aria-keyshortcuts="ArrowUp ArrowDown"
                            onDragStart={(event) => {
                              dragged.current = i;
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => (dragged.current = null)}
                            onKeyDown={(event) => {
                              const delta =
                                event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                              if (delta === 0) return;
                              event.preventDefault();
                              actions.onMoveInView?.(i, delta);
                            }}
                            title="Drag to reorder in the view, or use the Up and Down arrows"
                            className="mr-0.5 flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <GripVerticalIcon className="size-3.5" aria-hidden="true" />
                          </button>
                        )}
                        <Toggle
                          size="sm"
                          pressed={stacking ? stacked : isShown}
                          disabled={stacking && isShown}
                          onPressedChange={() =>
                            stacking && actions.onToggleVisible
                              ? actions.onToggleVisible(i)
                              : actions.onShow(i)
                          }
                          aria-label={`Visible: ${track.name}`}
                          title={
                            stacking
                              ? isShown
                                ? "The track you edit is always in the view"
                                : stacked
                                  ? "Take out of the continuous view"
                                  : "Show in the continuous view"
                              : "Show in the score"
                          }
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
                      <PanControl
                        label={`Pan, ${track.name}`}
                        value={trackMix.pan}
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
                        {isShown ? (
                          // The Effects tour points at the EQ of the track shown in the score.
                          <EqPopover
                            data-tour="track-eq"
                            name={track.name}
                            eq={trackEq(mix, i)}
                            onChange={(eq) => onChange({ type: "eq", track: i, eq })}
                          />
                        ) : (
                          <EqPopover
                            name={track.name}
                            eq={trackEq(mix, i)}
                            onChange={(eq) => onChange({ type: "eq", track: i, eq })}
                          />
                        )}
                        <TrackRowMenu
                          track={track}
                          count={tracks.length}
                          actions={actions}
                          focused={focused}
                          onFocus={(on) => onChange({ type: "focus", track: on ? i : null })}
                          onColor={() => setColorTrack(i)}
                          place={place}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center px-0">
                    <BarGrid
                      color={trackColor(i, mix.trackColors?.[i])}
                      filled={grids[i] ?? []}
                      current={bar}
                      dimmed={!audible}
                      onSeek={seekBar}
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
                  <PanControl
                    label="Pan, audio track"
                    value={mix.audioTrack.pan}
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
          {monitor && mix.monitor && (
            <MonitorRow
              monitor={mix.monitor}
              props={monitor}
              audible={isMonitorAudible(mix)}
              onChange={(value) => onChange({ type: "monitor", value })}
            />
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
              <PanControl
                label="Master pan"
                value={mix.masterPan ?? 0}
                onValueChange={(value) => onChange({ type: "master-pan", value })}
              />
              <span className="flex items-center justify-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!onMasterEffects}
                  onClick={onMasterEffects}
                  aria-label="Mastering effects"
                  data-tour="mastering"
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
      {colorTrack !== null && tracks[colorTrack] && (
        <TrackColorDialog
          open
          onOpenChange={(open) => !open && setColorTrack(null)}
          trackName={tracks[colorTrack].name}
          index={colorTrack}
          color={mix.trackColors?.[colorTrack] ?? null}
          anyCustom={!!mix.trackColors?.some(Boolean)}
          onChange={(color) => onChange({ type: "track-color", track: colorTrack, color })}
          onResetAll={() => onChange({ type: "reset-track-colors" })}
        />
      )}
    </section>
  );
}
