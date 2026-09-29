import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { MixerPanel, type MixerChange } from "@/components/score/mixer-panel";
import { ScoreToolbar } from "@/components/score/score-toolbar";
import { ScoreView } from "@/components/score/score-view";
import { TransportBar } from "@/components/score/transport-bar";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { useSpaceToPlay } from "@/hooks/use-space-to-play";
import { errorText } from "@/lib/errors";
import { mixerReducer, mixFromScore } from "@/lib/score/mixer";
import { ScorePlayer, type Layout, type PlaybackPosition } from "@/lib/score/player";
import type { TrackView } from "@/lib/score/score";
import {
  DEFAULT_SOUNDFONT,
  getSoundFont,
  readSoundFontPreference,
  storeSoundFontPreference,
  type SoundFontId,
} from "@/lib/score/soundfonts";
import { isTauri, saveMixerSettings, type MixerSettings } from "@/lib/tauri";

/** Mixer changes are saved this long after the last one. */
export const SAVE_DELAY_MS = 500;

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Saves the mix shortly after it changes, and right away when the song closes. */
function useSavedMix(song: ScoreDocument, mix: MixerSettings) {
  const pending = useRef<MixerSettings | null>(null);
  const enabled = isTauri(); // only the desktop app can store settings

  const flush = useEffectEvent(() => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    saveMixerSettings(song.fileKey, next).catch((error: unknown) => {
      toast.error("Couldn't save the mix", { description: errorText(error) });
    });
  });

  useEffect(() => {
    if (!enabled || mix === song.mix) return;
    pending.current = mix;
    const timer = setTimeout(flush, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, mix, song.mix]);

  useEffect(() => () => flush(), []);

  return enabled;
}

/** An open song: toolbar, notation, transport and mixer. */
export function ScoreWorkspace({ song, onOpen }: { song: ScoreDocument; onOpen: () => void }) {
  const { summary } = song;
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ScorePlayer | null>(null);
  const mixerButtonRef = useRef<HTMLButtonElement>(null);

  const [trackIndex, setTrackIndex] = useState(0);
  const [views, setViews] = useState<TrackView[]>(() => summary.tracks.map((t) => t.defaultView));
  const [layout, setLayout] = useState<Layout>("page");
  const [rendering, setRendering] = useState(true);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<PlaybackPosition>({ currentMs: 0, endMs: 0, bpm: 0 });
  const [bar, setBar] = useState(0);
  const [mix, setMix] = useState(song.mix);
  const mixRef = useRef(song.mix);
  const [soundFont, setSoundFont] = useState<SoundFontId>(readSoundFontPreference);
  const [mixerOpen, setMixerOpen] = useState(false);
  const saved = useSavedMix(song, mix);

  const track = summary.tracks[trackIndex] ?? summary.tracks[0]!;
  const view = views[trackIndex] ?? track.defaultView;

  const changeSoundFont = (id: SoundFontId) => {
    setSoundFont(id);
    storeSoundFontPreference(id);
    void playerRef.current?.setSoundFont(getSoundFont(id).url);
  };

  const onSoundFontError = useEffectEvent(
    (error: Error, { previousKept }: { previousKept: boolean }) => {
      if (soundFont === DEFAULT_SOUNDFONT) {
        toast.error("Instrument sounds could not be loaded", { description: errorText(error) });
        return;
      }
      toast.error(`${getSoundFont(soundFont).label} sounds are not available`, {
        description: "Using the standard sounds instead.",
      });
      setSoundFont(DEFAULT_SOUNDFONT);
      storeSoundFontPreference(DEFAULT_SOUNDFONT);
      // The standard sounds may still be loaded: then don't interrupt playback.
      if (!previousKept) void playerRef.current?.setSoundFont(getSoundFont(DEFAULT_SOUNDFONT).url);
    },
  );

  // The initial state, read once when the player is created. Later changes go
  // straight to the player from the handlers below.
  const initial = useRef({ trackIndex, view, layout, soundFont });

  useEffect(() => {
    const viewport = viewportRef.current;
    const surface = surfaceRef.current;
    if (!viewport || !surface) return;
    const start = initial.current;
    const player = new ScorePlayer(
      {
        element: surface,
        scrollElement: viewport,
        score: song.score,
        trackIndex: start.trackIndex,
        view: start.view,
        layout: start.layout,
        mix: mixRef.current,
        soundFontUrl: getSoundFont(start.soundFont).url,
        reducedMotion: prefersReducedMotion(),
      },
      {
        onRenderingChange: setRendering,
        onReadyChange: setReady,
        onPlayingChange: setPlaying,
        onPositionChange: setPosition,
        onBarChange: setBar,
        onSoundFontError,
        onError: (error) =>
          toast.error("Something went wrong with the score", { description: errorText(error) }),
      },
    );
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [song.score]);

  const changeTrack = (index: number) => {
    const next = summary.tracks[index];
    if (!next) return;
    setTrackIndex(index);
    playerRef.current?.showTrack(index, views[index] ?? next.defaultView);
  };

  const changeView = (next: TrackView) => {
    setViews((current) => current.map((v, i) => (i === trackIndex ? next : v)));
    playerRef.current?.setView(next);
  };

  const changeLayout = (next: Layout) => {
    setLayout(next);
    playerRef.current?.setLayout(next);
  };

  const changeMix: MixerChange = (action, { commit } = { commit: true }) => {
    const next = mixerReducer(mixRef.current, action);
    mixRef.current = next;
    setMix(next);
    if (commit) playerRef.current?.setMix(next);
  };

  const playPause = () => playerRef.current?.playPause();
  useSpaceToPlay(playPause, ready);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScoreToolbar
        name={song.name}
        summary={summary}
        trackIndex={trackIndex}
        view={view}
        layout={layout}
        onOpen={onOpen}
        onTrackChange={changeTrack}
        onViewChange={changeView}
        onLayoutChange={changeLayout}
        onToggleMixer={() => setMixerOpen((open) => !open)}
        mixerOpen={mixerOpen}
        mixerButtonRef={mixerButtonRef}
      />
      <ScoreView
        viewportRef={viewportRef}
        surfaceRef={surfaceRef}
        label={`Score: ${track.name}`}
        layout={layout}
        rendering={rendering}
      />
      <TransportBar
        ready={ready}
        playing={playing}
        position={position}
        bar={bar}
        barCount={song.score.masterBars.length}
        onPlayPause={playPause}
        onStop={() => playerRef.current?.stop()}
        onSeekBar={(index) => playerRef.current?.seekToBar(index)}
      />
      <MixerPanel
        open={mixerOpen}
        onOpenChange={setMixerOpen}
        tracks={summary.tracks}
        mix={mix}
        onChange={changeMix}
        onReset={() => changeMix({ type: "reset", mix: mixFromScore(summary) })}
        soundFont={soundFont}
        onSoundFontChange={changeSoundFont}
        saved={saved}
        returnFocusTo={mixerButtonRef}
        soundsReady={ready}
        playing={playing}
      />
    </div>
  );
}
