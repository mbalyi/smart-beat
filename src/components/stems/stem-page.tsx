import {
  ArrowLeftIcon,
  InfoIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useReducer, useState } from "react";

import { ExternalLink } from "@/components/external-link";
import { LabeledSlider } from "@/components/labeled-slider";
import { SectionKicker } from "@/components/section-kicker";
import { StemRow } from "@/components/stems/stem-row";
import { formatTime, joinNames, stemName, STEM_LABELS } from "@/components/stems/stem-labels";
import { usePosition, useStemState } from "@/components/stems/use-stem-player";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { STEM_LIMITS_URL } from "@/lib/project-info";
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

/** The page of a separated song: a row per stem, one transport, a loop and a speed. */
export function StemPage({
  song,
  onBack,
  createPlayer = createSongPlayer,
}: {
  song: StemSong;
  onBack: () => void;
  /** Where the sound comes from; tests give a fake. */
  createPlayer?: (song: StemSong) => StemPlayer | null;
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

  const kinds = useMemo(() => songKinds(song), [song]);
  const skipped = song.skipped.map((kind) => STEM_LABELS[kind].toLowerCase());

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 pt-4 pb-10 sm:px-6 sm:pt-6 sm:pb-14 lg:px-8">
      <header className="flex flex-col gap-3">
        <div>
          <Button variant="outline" size="lg" className="bg-card" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
            Back to start
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <SectionKicker>Stem separation</SectionKicker>
          <h1 className="font-heading text-[clamp(30px,5vw,52px)] leading-[1.05] font-bold tracking-[-0.04em] break-words">
            {song.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatTime(song.durationSeconds)} · {song.engine === "neural" ? "Neural" : "Fast"}{" "}
            engine · {song.stems.length} parts. Everything ran on this computer.
          </p>
        </div>
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
      </header>

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
      {player && <Stems key={song.id} song={song} kinds={kinds} player={player} />}

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
  );
}

/** The transport and the rows, once the player exists. */
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
      <Transport player={player} />
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

/** Play, position, loop, speed and count-in. */
function Transport({ player }: { player: StemPlayer }) {
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
    ? `Looping ${formatTime(state.loop.start)} to ${formatTime(state.loop.end)}`
    : pendingStart !== null
      ? `Loop starts at ${formatTime(pendingStart)}. Set its end.`
      : "No loop. Drag on a waveform, or set the start and end at the playhead.";

  return (
    <section
      aria-label="Transport"
      className="flex flex-col gap-4 rounded-2xl border border-foreground/10 bg-card p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={!ready}
          className="min-w-28 max-sm:h-11"
          onClick={() => (busy ? player.pause() : void player.play())}
        >
          {busy ? (
            <PauseIcon aria-hidden="true" data-icon="inline-start" />
          ) : (
            <PlayIcon aria-hidden="true" data-icon="inline-start" />
          )}
          {busy ? "Pause" : "Play"}
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={!ready}
          className="bg-card max-sm:h-11"
          onClick={() => player.stop()}
        >
          <SquareIcon aria-hidden="true" data-icon="inline-start" className="fill-current" />
          Stop
        </Button>
        <span role="timer" aria-label="Position" className="text-lg font-semibold tabular-nums">
          {formatTime(draft ?? position)} / {formatTime(state.duration)}
        </span>
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {state.countdown !== null && (
            <span className="font-semibold text-foreground">Starting in {state.countdown}…</span>
          )}
          {state.rendering && (
            <>
              <Loader2Icon
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Rendering…
            </>
          )}
        </p>
      </div>

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
        className="max-sm:h-11"
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="group" aria-label="Loop" className="flex flex-wrap items-center gap-2">
          <RepeatIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          <Button
            variant="outline"
            size="lg"
            disabled={!ready}
            className="bg-card max-sm:h-11"
            onClick={setStart}
          >
            Set loop start
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={!ready}
            className="bg-card max-sm:h-11"
            onClick={setEnd}
          >
            Set loop end
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={!state.loop && pendingStart === null}
            className="bg-card max-sm:h-11"
            onClick={clearLoop}
          >
            Clear loop
          </Button>
        </div>
        <div className="flex items-center gap-2 max-sm:w-full">
          <span id="stem-speed-label" className="text-sm font-medium">
            Speed
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            aria-labelledby="stem-speed-label"
            className="max-sm:min-w-0 max-sm:flex-1"
            value={String(state.speed)}
            onValueChange={(value) => value && player.setSpeed(Number(value))}
          >
            {STEM_SPEEDS.map((speed) => (
              <ToggleGroupItem
                key={speed}
                value={String(speed)}
                aria-label={`Speed ${speed}%`}
                size="lg"
                className="px-3 max-sm:h-11 max-sm:min-w-0 max-sm:flex-1 max-sm:px-0"
              >
                {speed}%
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium max-sm:min-h-11">
          <Switch checked={state.countIn} onCheckedChange={(on) => player.setCountIn(on)} />
          Count-in ({COUNT_IN_SECONDS} s)
        </label>
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {loopNote || loopText} A slower speed keeps the pitch; a change to a stem takes a moment to
        render there.
      </p>
    </section>
  );
}
