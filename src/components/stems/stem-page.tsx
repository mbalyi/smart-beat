import {
  CheckIcon,
  FolderOpenIcon,
  InfoIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Repeat2Icon,
  SaveIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import logo from "@/assets/stem-separation/logo.webp";
import { ExternalLink } from "@/components/external-link";
import { LabeledSlider } from "@/components/labeled-slider";
import { MetronomeControl } from "@/components/shell/metronome-control";
import { SpeedSelect } from "@/components/shell/speed-select";
import { SaveStemsDialog } from "@/components/stems/save-stems-dialog";
import { StemRow } from "@/components/stems/stem-row";
import { engineLabel } from "@/components/stems/stem-engines";
import { formatTime, joinNames, stemName, STEM_LABELS } from "@/components/stems/stem-labels";
import { TempoInfo } from "@/components/stems/tempo-info";
import { usePosition, useStemState } from "@/components/stems/use-stem-player";
import { useStemTempo, type DetectTempo } from "@/components/stems/use-stem-tempo";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { STEM_LIMITS_URL } from "@/lib/project-info";
import {
  readPracticePrefs,
  storePracticePrefs,
  type ClickSoundId,
  type PracticePrefs,
} from "@/lib/score/practice";
import { sectionGrid, steadyGrid, type BeatGrid } from "@/lib/stems/beat-grid";
import { formatBpm } from "@/lib/stems/tempo";
import { createSongPlayer, songKinds } from "@/lib/stems/song-player";
import { gainsOf, initMixer, mixerReducer } from "@/lib/stems/mixer";
import {
  COUNT_IN_SECONDS,
  MIN_LOOP_SECONDS,
  STEM_SPEEDS,
  type StemLoop,
  type StemPlayer,
} from "@/lib/stems/player";
import type { StemKindId, StemSong } from "@/lib/tauri";

/** The metronome's settings, remembered with the song page's (the same click and volume). */
function useMetronomeSettings() {
  const [settings, setSettings] = useState(() => {
    const { metronome, metronomeSound, metronomeVolume } = readPracticePrefs();
    return { on: metronome, sound: metronomeSound, volume: metronomeVolume };
  });
  const change = (patch: Partial<{ on: boolean; sound: ClickSoundId; volume: number }>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    const prefs: Partial<PracticePrefs> = {
      metronome: next.on,
      metronomeSound: next.sound,
      metronomeVolume: next.volume,
    };
    storePracticePrefs({ ...readPracticePrefs(), ...prefs });
  };
  return [settings, change] as const;
}

/**
 * The page of a separated song, laid out like an open song: the logo, the song's details
 * (with the tempo) and the Open and Save buttons in the app header's centre, a sticky strip
 * with the transport (play, position, loop, speed, metronome, count-in), the tab bar, then a
 * row per stem.
 */
export function StemPage({
  song,
  tabs,
  headerSlot,
  onOpenStems,
  onSaved,
  savedPath: knownPath,
  onOpenCloudSettings,
  createPlayer = createSongPlayer,
  detectTempo,
}: {
  song: StemSong;
  /** The tab bar, shown right below the app header (the same one the open songs use). */
  tabs?: ReactNode;
  /** Where the page's main controls go: the app header's centre. Without it they sit on top of the page. */
  headerSlot?: HTMLElement | null;
  /** Open stems: choose a saved set of stems to open. */
  onOpenStems?: () => void;
  /** The stems were saved to this file. */
  onSaved?: (path: string) => void;
  /** Where the stems were saved before, when the page was closed and opened again. */
  savedPath?: string;
  /** Opens Settings on the cloud folder section (from the Save dialog's hint). */
  onOpenCloudSettings?: () => void;
  /** Where the sound comes from; tests give a fake. */
  createPlayer?: (song: StemSong) => StemPlayer | null;
  /** Finds the tempo; tests give a fake. */
  detectTempo?: DetectTempo;
}) {
  const [player, setPlayer] = useState<StemPlayer | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    const made = createPlayer(song);
    // The player is an audio resource made for this song, not a copy of React state.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!made) {
      setUnsupported(true);
      return;
    }
    setUnsupported(false);
    setPlayer(made);
    void made.load();
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      made.dispose();
      setPlayer(null);
    };
  }, [song, createPlayer]);

  // Where the song was saved from this page; a song opened from a file already knows its path.
  const [saved, setSaved] = useState<{ id: string; path: string } | null>(null);
  const savedPath = saved?.id === song.id ? saved.path : (knownPath ?? song.savedPath);
  const [saving, setSaving] = useState(false);
  const goingToSettings = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);

  const tempo = useStemTempo(song.id, detectTempo);
  const [metronome, changeMetronome] = useMetronomeSettings();
  const { bpm, firstBeatSec, sections, followSections } = tempo.tempo;
  const grid = useMemo<BeatGrid | null>(() => {
    if (bpm === null) return null;
    if (followSections) {
      return sectionGrid(sections, firstBeatSec) ?? steadyGrid(bpm, firstBeatSec);
    }
    return steadyGrid(bpm, firstBeatSec);
  }, [bpm, firstBeatSec, sections, followSections]);
  useEffect(() => {
    player?.setMetronome({
      on: metronome.on && grid !== null,
      sound: metronome.sound,
      volume: metronome.volume,
      grid,
    });
  }, [player, grid, metronome]);

  const kinds = useMemo(() => songKinds(song), [song]);
  const skipped = song.skipped.map((kind) => STEM_LABELS[kind].toLowerCase());

  const inHeader = headerSlot !== null && headerSlot !== undefined;
  const mainControls = (
    <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-4 gap-y-1">
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={logo}
          alt="Stem separation"
          draggable={false}
          className="h-9 w-auto shrink-0 object-contain"
        />
        <div className="flex min-w-0 flex-col text-left">
          <span className="truncate text-sm font-semibold" title={song.name}>
            {song.name}
          </span>
          <span data-testid="stems-info" className="text-xs text-muted-foreground">
            {formatTime(song.durationSeconds)} · {engineLabel(song.engine)} engine ·{" "}
            {song.stems.length} parts · <TempoInfo model={tempo} player={player} /> · Everything ran
            on this computer.
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {onOpenStems && (
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onOpenStems}
            aria-label="Open stems"
            title="Open stems"
          >
            <FolderOpenIcon />
          </Button>
        )}
        <Button
          ref={saveButton}
          variant="outline"
          size="icon-sm"
          onClick={() => setSaving(true)}
          aria-label="Save stems"
          title="Save stems"
        >
          <SaveIcon />
        </Button>
        {savedPath && (
          <span
            data-testid="stems-saved"
            title={savedPath}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground"
          >
            <CheckIcon aria-hidden="true" className="size-4 text-primary" />
            Saved
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {inHeader && createPortal(mainControls, headerSlot)}
      <h1 className="sr-only">{song.name}</h1>
      {!inHeader && <div className="border-b bg-card px-3 py-2">{mainControls}</div>}
      {player ? (
        <Transport
          player={player}
          metronome={
            <MetronomeControl
              on={metronome.on && grid !== null}
              onChange={(on) => changeMetronome({ on })}
              sound={metronome.sound}
              onSoundChange={(sound) => changeMetronome({ sound })}
              volume={metronome.volume}
              onVolumeChange={(volume) => changeMetronome({ volume })}
              disabled={grid === null}
              title={
                bpm === null
                  ? tempo.finding
                    ? "Finding the tempo"
                    : "Set a tempo first: tap it in the tempo menu"
                  : `Click along at ${formatBpm(bpm)} beats a minute`
              }
            />
          }
        />
      ) : null}
      {tabs}

      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 pt-4 pb-10 sm:px-6 sm:pb-14 lg:px-8">
        {skipped.length > 0 && (
          <p
            data-testid="stems-skipped"
            className="flex gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm"
          >
            <InfoIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <span>
              {song.mono
                ? `This file is mono, so ${joinNames(skipped)} cannot be separated. They stay in “${stemName("other", song.engine)}”.`
                : `${joinNames(skipped)} could not be separated from this song. They stay in “${stemName("other", song.engine)}”.`}
            </span>
          </p>
        )}

        {unsupported && (
          <p role="alert" className="text-sm text-destructive">
            This window cannot play audio, so the stems cannot be played here.
          </p>
        )}
        {!player && !unsupported && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the stems…
          </p>
        )}
        {player && <Stems song={song} kinds={kinds} player={player} />}

        <SaveStemsDialog
          song={song}
          open={saving}
          onOpenChange={setSaving}
          onSaved={(path) => {
            setSaved({ id: song.id, path });
            onSaved?.(path);
          }}
          onOpenCloudSettings={
            onOpenCloudSettings &&
            (() => {
              goingToSettings.current = true;
              onOpenCloudSettings();
            })
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Settings takes the focus when the dialog closes to open it.
            if (!goingToSettings.current) saveButton.current?.focus();
            goingToSettings.current = false;
          }}
        />

        <p className="text-sm text-muted-foreground">
          Separating music by signal processing is not perfect.{" "}
          <ExternalLink
            href={STEM_LIMITS_URL}
            className="font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            What it can and cannot do
          </ExternalLink>
        </p>
      </div>
    </div>
  );
}

/** The rows, once the player exists. */
function Stems({
  song,
  kinds,
  player,
}: {
  song: StemSong;
  kinds: StemKindId[];
  player: StemPlayer;
}) {
  const state = useStemState(player);
  const [mixer, dispatch] = useReducer(mixerReducer, kinds, initMixer);
  useEffect(() => player.setGains(gainsOf(mixer)), [player, mixer]);

  const duration = state.duration || song.durationSeconds;
  const seek = (seconds: number) => player.seek(seconds);
  const loopFromDrag = (loop: StemLoop) => player.setLoop(loop);

  return (
    <>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {!state.loaded && !state.error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the stems…
        </p>
      )}
      <ul aria-label="Stems" className="flex flex-col gap-3">
        {mixer.map((channel) => (
          <StemRow
            key={channel.kind}
            player={player}
            engine={song.engine}
            duration={duration}
            channel={channel}
            mixer={mixer}
            dispatch={dispatch}
            loop={state.loop}
            onSeek={seek}
            onLoop={loopFromDrag}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * The strip above the tab bar, as on an open song: play and stop, the position, the loop, the
 * speed, the metronome and the count-in. It stays at the top while the rows scroll.
 */
function Transport({ player, metronome }: { player: StemPlayer; metronome: ReactNode }) {
  const state = useStemState(player);
  const position = usePosition(player);
  const [draft, setDraft] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // The start of a loop whose end is not set yet.
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [loopNote, setLoopNote] = useState("");
  const busy = state.playing || state.countdown !== null;
  const ready = state.loaded;

  const setStart = () => {
    const at = player.position();
    setLoopNote("");
    if (state.loop && at < state.loop.end - MIN_LOOP_SECONDS) {
      player.setLoop({ start: at, end: state.loop.end });
    } else {
      player.setLoop(null);
      setPendingStart(at);
    }
  };
  const setEnd = () => {
    const at = player.position();
    const start = state.loop?.start ?? pendingStart;
    if (start === null || at < start + MIN_LOOP_SECONDS) {
      setLoopNote("Put the end after the start, then set it again.");
      return;
    }
    setLoopNote("");
    player.setLoop({ start, end: at });
    setPendingStart(null);
  };
  const clearLoop = () => {
    player.setLoop(null);
    setPendingStart(null);
    setLoopNote("");
  };
  const loopText = state.loop
    ? `Looping ${formatTime(state.loop.start)} to ${formatTime(state.loop.end)}.`
    : pendingStart !== null
      ? `Loop starts at ${formatTime(pendingStart)}. Set its end.`
      : "No loop. Drag on a waveform, or set the start and end at the playhead.";

  return (
    <section
      aria-label="Transport"
      className="sticky top-0 z-30 flex shrink-0 flex-col gap-1.5 border-b bg-card px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            onClick={() => (busy ? player.pause() : void player.play())}
            disabled={!ready}
            aria-label={busy ? "Pause" : "Play"}
            title={busy ? "Pause" : "Play"}
            className="rounded-full"
          >
            {busy ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => player.stop()}
            disabled={!ready}
            aria-label="Stop"
            title="Stop"
          >
            <SquareIcon />
          </Button>
        </div>
        <span role="timer" aria-label="Position" className="text-sm font-semibold tabular-nums">
          {formatTime(draft ?? position)} / {formatTime(state.duration)}
        </span>
        <LabeledSlider
          label="Position"
          valueText={`${formatTime(draft ?? position)} of ${formatTime(state.duration)}`}
          value={Math.min(draft ?? position, state.duration)}
          min={0}
          max={Math.max(state.duration, 1)}
          step={1}
          disabled={!ready}
          // Dragging shows where it would land and seeks on release; a key seeks at once.
          onValueChange={(value) => (dragging ? setDraft(value) : player.seek(value))}
          onDraggingChange={setDragging}
          onValueCommit={(value) => {
            if (draft === null) return;
            setDraft(null);
            player.seek(value);
          }}
          className="min-w-40 flex-1"
        />
        <div role="group" aria-label="Loop" className="flex flex-wrap items-center gap-1.5">
          <Repeat2Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          <Button variant="outline" size="sm" disabled={!ready} onClick={setStart}>
            Set loop start
          </Button>
          <Button variant="outline" size="sm" disabled={!ready} onClick={setEnd}>
            Set loop end
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!state.loop && pendingStart === null}
            onClick={clearLoop}
          >
            Clear loop
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <SpeedSelect
            value={state.speed}
            speeds={STEM_SPEEDS}
            onChange={(percent) => player.setSpeed(percent)}
          />
        </div>
        {metronome}
        <Toggle
          variant="outline"
          size="sm"
          pressed={state.countIn}
          onPressedChange={(on) => player.setCountIn(on)}
          title={`Count in ${COUNT_IN_SECONDS} seconds before playing`}
        >
          Count-in
        </Toggle>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {state.countdown !== null && (
          <span className="mr-2 font-semibold text-foreground">Starting in {state.countdown}…</span>
        )}
        {state.rendering && (
          <span className="mr-2 inline-flex items-center gap-1 font-semibold text-foreground">
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none"
            />
            Rendering…
          </span>
        )}
        {loopNote || loopText} A change to a stem takes a moment to render.
      </p>
    </section>
  );
}
