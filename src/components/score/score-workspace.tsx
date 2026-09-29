import { useEffect, useEffectEvent, useId, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

import { EditToolbar, type EditActions } from "@/components/score/edit-toolbar";
import { InstrumentPanel } from "@/components/score/instrument-panel";
import { MixerPanel, type MixerChange } from "@/components/score/mixer-panel";
import { PracticeControls, SpeedTrainerDialog } from "@/components/score/practice-controls";
import { ScoreToolbar } from "@/components/score/score-toolbar";
import { ScoreView, type EditOverlay } from "@/components/score/score-view";
import { TrackDialog, type TrackSettings } from "@/components/score/track-dialog";
import { TracksPanel, type TrackActions } from "@/components/score/tracks-panel";
import { TransportBar } from "@/components/score/transport-bar";
import { useEditorKeys } from "@/hooks/use-editor-keys";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { useMenuState } from "@/hooks/use-menu-state";
import type { ScoreDocument } from "@/hooks/use-score-document";
import { useScoreEditor } from "@/hooks/use-score-editor";
import { useSpaceToPlay } from "@/hooks/use-space-to-play";
import { errorText } from "@/lib/errors";
import { selectionRange } from "@/lib/score/editor";
import { drumKitOf, instrumentViewName, notesOf } from "@/lib/score/instrument-view";
import { mixerReducer } from "@/lib/score/mixer";
import { trackContent, type Track } from "@/lib/score/model";
import {
  ScorePlayer,
  type Layout,
  type PlaybackPosition,
  type Rect,
  type ScorePlayerCallbacks,
} from "@/lib/score/player";
import {
  initialPractice,
  practiceReducer,
  readPracticePrefs,
  storePracticePrefs,
  type LoopRange,
} from "@/lib/score/practice";
import { summarizeScore, trackMix, type TrackView } from "@/lib/score/score";
import {
  DEFAULT_SOUNDFONT,
  getSoundFont,
  readSoundFontPreference,
  storeSoundFontPreference,
  type SoundFontId,
} from "@/lib/score/soundfonts";
import {
  createTrack,
  duplicateTrack,
  insertTrack,
  moveTrack,
  removeTrack,
  renameTrack,
  setCapo,
  setInstrument,
  setTuning,
  uniqueTrackName,
} from "@/lib/score/tracks";
import {
  isTauri,
  MIXER_SETTINGS_VERSION,
  saveMixerSettings,
  type MixerSettings,
  type TrackMix,
} from "@/lib/tauri";

/** Mixer changes are saved this long after the last one. */
export const SAVE_DELAY_MS = 500;

/** Remembers whether the fretboard (keyboard, drum pads) is shown. */
export const INSTRUMENT_VIEW_STORAGE_KEY = "smart-beat:instrument-view";

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function readInstrumentView(): boolean {
  try {
    return localStorage.getItem(INSTRUMENT_VIEW_STORAGE_KEY) === "shown";
  } catch {
    return false;
  }
}

function storeInstrumentView(shown: boolean) {
  try {
    localStorage.setItem(INSTRUMENT_VIEW_STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    // Not remembered: hidden next time.
  }
}

/** Saves the mix shortly after it changes, and right away when the song closes. */
function useSavedMix(song: ScoreDocument, mix: MixerSettings, enabled: boolean) {
  const pending = useRef<MixerSettings | null>(null);

  const flush = useEffectEvent(() => {
    const next = pending.current;
    if (!next || !song.fileKey) return;
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
}

/** The smallest rectangle around all of `rects`. */
function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

const isTextField = (element: Element | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

type TrackDialogState = { mode: "add" } | { mode: "edit"; track: Track };

/**
 * An open song: toolbar, notation (with the editor), instrument view,
 * transport with practice tools, mixer and tracks.
 */
export function ScoreWorkspace({
  song,
  onOpen,
  onEditedChange,
  startEditing = false,
}: {
  song: ScoreDocument;
  onOpen: () => void;
  /** Called when the song gets (or loses, by undoing everything) unsaved changes. */
  onEditedChange?: (edited: boolean) => void;
  /** Open in edit mode (new songs). */
  startEditing?: boolean;
}) {
  const score = song.score;
  const editor = useScoreEditor(score);
  const summary = summarizeScore(score);
  const statusId = useId();

  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ScorePlayer | null>(null);
  const mixerButtonRef = useRef<HTMLButtonElement>(null);
  const tracksButtonRef = useRef<HTMLButtonElement>(null);
  const [originalTracks] = useState(() => score.tracks.slice());

  const trackIndex = editor.cursor.track;
  const trackObject = score.tracks[trackIndex]!;
  const track = summary.tracks[trackIndex]!;
  const [views, setViews] = useState<ReadonlyMap<Track, TrackView>>(() => new Map());
  const viewOf = (t: Track, index: number) =>
    views.get(t) ?? summary.tracks[index]?.defaultView ?? { notation: "score", rhythm: false };
  const view = viewOf(trackObject, trackIndex);

  const [layout, setLayout] = useState<Layout>("page");
  const [rendering, setRendering] = useState(true);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<PlaybackPosition>({ currentMs: 0, endMs: 0, bpm: 0 });
  const [bar, setBar] = useState(0);
  const [editing, setEditing] = useState(startEditing);
  const [overlay, setOverlay] = useState<EditOverlay | null>(null);
  const [activeNotes, setActiveNotes] = useState(() => notesOf([]));
  const [instrumentView, setInstrumentView] = useState(readInstrumentView);

  // The mix follows the tracks (not their positions) through reordering and undo.
  const [mix, setMix] = useState(song.mix);
  const mixRef = useRef(song.mix);
  const mixByTrack = useRef(
    new Map<Track, TrackMix>(score.tracks.map((t, i) => [t, song.mix.tracks[i]!])),
  );
  const [soundFont, setSoundFont] = useState<SoundFontId>(readSoundFontPreference);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [tracksOpen, setTracksOpen] = useState(false);
  const [trackDialog, setTrackDialog] = useState<TrackDialogState | null>(null);
  const [trainerOpen, setTrainerOpen] = useState(false);
  const [practice, dispatchPractice] = useReducer(practiceReducer, undefined, () =>
    initialPractice(readPracticePrefs()),
  );
  /** Bars last dragged across in the score (what Loop starts with). */
  const [pickedRange, setPickedRange] = useState<LoopRange | null>(null);

  const sameTracks =
    score.tracks.length === originalTracks.length &&
    score.tracks.every((t, i) => t === originalTracks[i]);
  // Only the desktop app can store settings, and only for the file's own tracks.
  const saved = isTauri() && song.fileKey !== null && sameTracks;
  useSavedMix(song, mix, saved);

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

  /** Where the edit cursor, its note and the selection are drawn now. */
  const updateOverlay = useEffectEvent(() => {
    const player = playerRef.current;
    if (!player || !editing) return;
    const beat = editor.cursorBeat();
    const note = editor.cursorNote();
    setOverlay({
      cursor: beat ? union(player.beatRects(beat)) : null,
      notes: note ? player.noteRects(note) : [],
      selection: editor
        .selectedBeatList()
        .map((b) => union(player.beatRects(b)))
        .filter((r): r is Rect => r !== null),
    });
  });

  const onBeatClick = useEffectEvent(
    ({ beat, note, extend }: Parameters<NonNullable<ScorePlayerCallbacks["onBeatClick"]>>[0]) => {
      if (!editing || beat.voice.bar.staff.track !== trackObject) return;
      editor.setCursorTo(
        { bar: beat.voice.bar.index, beat: beat.index, voice: beat.voice.index, note },
        extend,
      );
    },
  );

  const onBeatDrag = useEffectEvent(
    (beat: Parameters<NonNullable<ScorePlayerCallbacks["onBeatDrag"]>>[0]) => {
      if (beat.voice.bar.staff.track !== trackObject) return;
      editor.setCursorTo(
        { bar: beat.voice.bar.index, beat: beat.index, voice: beat.voice.index },
        true,
      );
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
        onActiveBeatsChange: (beats) => setActiveNotes(notesOf(beats)),
        onBeatClick: (target) => onBeatClick(target),
        onBeatDrag: (beat) => onBeatDrag(beat),
        onRendered: () => updateOverlay(),
        onRangeSelect: (picked) => {
          setPickedRange(picked);
          if (picked) dispatchPractice({ type: "range", range: picked });
        },
        onLoopRestart: () => dispatchPractice({ type: "loop-completed" }),
      },
    );
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [song.score]);

  // Practice settings go to the player whenever they change.
  const { loop, range, speed, metronome, countIn } = practice;
  useEffect(() => {
    playerRef.current?.setLoop(loop ? range : null);
  }, [loop, range]);
  useEffect(() => playerRef.current?.setSpeed(speed), [speed]);
  useEffect(() => {
    playerRef.current?.setMetronome(metronome);
    playerRef.current?.setCountIn(countIn);
    storePracticePrefs({ metronome, countIn });
  }, [metronome, countIn]);
  useEffect(() => playerRef.current?.setEditing(editing), [editing]);

  /** After every change to the music: new mix order, re-render, new MIDI. */
  const onModelChange = useEffectEvent(() => {
    const tracks = score.tracks.map((t) => {
      const known = mixByTrack.current.get(t);
      if (known) return known;
      const fresh = { ...trackMix(t) };
      mixByTrack.current.set(t, fresh);
      return fresh;
    });
    const next: MixerSettings = { ...mixRef.current, version: MIXER_SETTINGS_VERSION, tracks };
    const changedOrder =
      tracks.length !== mixRef.current.tracks.length ||
      tracks.some((t, i) => t !== mixRef.current.tracks[i]);
    if (changedOrder) {
      mixRef.current = next;
      setMix(next);
    }
    const index = editor.cursor.track;
    const shown = score.tracks[index]!;
    playerRef.current?.refresh({
      trackIndex: index,
      view: viewOf(shown, index),
      mix: mixRef.current,
    });
    dispatchPractice({ type: "bar-count", count: score.masterBars.length });
  });

  const onCursorChange = useEffectEvent(() => updateOverlay());

  useEffect(
    () =>
      editor.subscribe((change) => {
        if (change === "model") onModelChange();
        else onCursorChange();
      }),
    [editor],
  );

  useEffect(() => onEditedChange?.(editor.edited), [editor.edited, onEditedChange]);

  useEditorKeys(viewportRef, editor, { enabled: editing, menuHandlesUndo: isTauri() });

  const focusScore = () => viewportRef.current?.focus({ preventScroll: true });

  const toggleEditing = () => setEditing((on) => !on);

  // Entering edit mode puts the keyboard in the score and shows the cursor.
  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      viewportRef.current?.focus({ preventScroll: true });
      updateOverlay();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const changeTrack = (index: number) => {
    const next = score.tracks[index];
    if (!next) return;
    editor.setTrack(index);
    playerRef.current?.showTrack(index, viewOf(next, index));
  };

  const changeView = (next: TrackView) => {
    setViews((current) => new Map(current).set(trackObject, next));
    playerRef.current?.setView(next);
  };

  const changeLayout = (next: Layout) => {
    setLayout(next);
    playerRef.current?.setLayout(next);
  };

  const changeMix: MixerChange = (action, { commit } = { commit: true }) => {
    const next = mixerReducer(mixRef.current, action);
    mixRef.current = next;
    score.tracks.forEach((t, i) => mixByTrack.current.set(t, next.tracks[i]!));
    setMix(next);
    if (commit) playerRef.current?.setMix(next);
  };

  const resetMix = () =>
    changeMix({
      type: "reset",
      mix: {
        version: MIXER_SETTINGS_VERSION,
        master: 1,
        tracks: summary.tracks.map((t) => ({ ...t.mix })),
      },
    });

  const playPause = () => playerRef.current?.playPause();
  useSpaceToPlay(playPause, ready);

  const toggleInstrumentView = () => {
    setInstrumentView((shown) => {
      storeInstrumentView(!shown);
      return !shown;
    });
  };

  // --- Practice -------------------------------------------------------------

  /** The bars to start looping: the ones dragged across, the selection, or the current bar. */
  const suggestedRange = (): LoopRange => {
    if (practice.loop) return practice.range;
    const selection = editor.selection;
    if (editing && selection) {
      const [start, end] = selectionRange(selection);
      return { start: start.bar, end: end.bar };
    }
    return pickedRange ?? { start: bar, end: bar };
  };

  const setLoop = (on: boolean) =>
    dispatchPractice({ type: "loop", value: on, range: on ? suggestedRange() : undefined });

  // --- Tracks -----------------------------------------------------------------

  /** Runs a track change as one undo step, keeping the shown track in view. */
  const changeTracks = (label: string, apply: () => void, keepShown = true) => {
    const shown = score.tracks[editor.cursor.track];
    try {
      editor.run(
        label,
        () => editor.structureTargets(),
        () => {
          apply();
          const index = shown ? score.tracks.indexOf(shown) : -1;
          if (keepShown && index >= 0) editor.placeCursorOnTrack(index);
        },
      );
    } catch (error) {
      toast.error(`Couldn't ${label.toLowerCase()}`, { description: errorText(error) });
    }
  };

  const trackActions: TrackActions = {
    onShow: changeTrack,
    onMove: (index, to) => changeTracks("Move track", () => moveTrack(score, index, to)),
    onDuplicate: (index) => changeTracks("Duplicate track", () => duplicateTrack(score, index)),
    onRemove: (index) => {
      const name = summary.tracks[index]?.name ?? "the track";
      changeTracks("Remove track", () => removeTrack(score, index));
      toast(`Removed “${name}”`, { action: { label: "Undo", onClick: () => editor.undo() } });
    },
    onSettings: (index) => {
      setTracksOpen(false);
      setTrackDialog({ mode: "edit", track: score.tracks[index]! });
    },
    onAdd: () => {
      setTracksOpen(false);
      setTrackDialog({ mode: "add" });
    },
  };

  const submitTrack = (settings: TrackSettings) => {
    if (trackDialog?.mode === "edit") {
      const target = trackDialog.track;
      let removed = 0;
      editor.run(
        "Change track settings",
        () => [...trackContent(target)],
        () => {
          const staff = target.staves[0]!;
          renameTrack(target, settings.name);
          if (settings.kind !== "drums") setInstrument(target, settings.program);
          if (settings.kind === "stringed") {
            removed = setTuning(staff, settings.tuning);
            setCapo(staff, settings.capo);
          }
        },
      );
      if (removed > 0) {
        toast(
          `${removed} ${removed === 1 ? "note was" : "notes were"} on removed strings and deleted`,
          {
            action: { label: "Undo", onClick: () => editor.undo() },
          },
        );
      }
      return;
    }
    changeTracks(
      "Add track",
      () => {
        const added = createTrack(score, {
          ...settings,
          name: uniqueTrackName(score, settings.name),
        });
        setCapo(added.staves[0]!, settings.capo);
        insertTrack(score, added);
        editor.placeCursorOnTrack(score.tracks.length - 1);
      },
      false,
    );
  };

  const editedTrack = trackDialog?.mode === "edit" ? trackDialog.track : null;
  const editedSummary = editedTrack ? summary.tracks[score.tracks.indexOf(editedTrack)] : null;

  // --- Menu -------------------------------------------------------------------

  useMenuActions((action) => {
    switch (action) {
      case "undo":
      case "redo":
        // A focused text field gets its own undo, as with the standard menu item.
        if (isTextField(document.activeElement)) document.execCommand(action);
        else if (action === "undo") editor.undo();
        else editor.redo();
        break;
      case "toggle-edit-mode":
        toggleEditing();
        break;
      case "toggle-fretboard":
        toggleInstrumentView();
        break;
      case "add-track":
        setTrackDialog({ mode: "add" });
        break;
      case "duplicate-track":
        trackActions.onDuplicate(trackIndex);
        break;
      case "remove-track":
        if (score.tracks.length > 1) trackActions.onRemove(trackIndex);
        break;
      case "track-settings":
        setTrackDialog({ mode: "edit", track: trackObject });
        break;
      case "toggle-loop":
        setLoop(!practice.loop);
        break;
      case "speed-trainer":
        setTrainerOpen(true);
        break;
      case "toggle-metronome":
        dispatchPractice({ type: "metronome", value: !practice.metronome });
        break;
      case "toggle-count-in":
        dispatchPractice({ type: "count-in", value: !practice.countIn });
        break;
      default:
        break;
    }
  });

  useMenuState({
    songOpen: true,
    undo: editor.undoLabel,
    redo: editor.redoLabel,
    canRemoveTrack: score.tracks.length > 1,
    editMode: editing,
    fretboard: instrumentView,
    loop: practice.loop,
    metronome: practice.metronome,
    countIn: practice.countIn,
  });

  const editActions: EditActions = {
    onDuration: (d) => editor.setDuration(d),
    onDots: (dots) => editor.toggleDots(dots),
    onTuplet: (t) => editor.setTuplet(t),
    onRest: () => editor.clearNotes(),
    onTie: () => editor.toggleTie(),
    onInsertBeat: () => editor.insertBeat(),
    onDeleteBeat: () => editor.deleteBeats(),
    onVoice: (v) => editor.switchVoice(v),
    onUndo: () => editor.undo(),
    onRedo: () => editor.redo(),
    onDone: focusScore,
  };

  const shownNotes = !playing && editing ? editor.beatInfo.notes : activeNotes;

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
        editing={editing}
        onToggleEditing={toggleEditing}
        edited={editor.edited}
        onOpenTracks={() => setTracksOpen(true)}
        tracksButtonRef={tracksButtonRef}
        instrumentView={instrumentView}
        instrumentLabel={instrumentViewName(track.kind)}
        onToggleInstrumentView={toggleInstrumentView}
      />
      {editing && (
        <EditToolbar
          beat={editor.beatInfo}
          voice={editor.cursor.voice}
          stringed={track.kind === "stringed"}
          status={editor.describeCursor()}
          message={editor.message}
          undoLabel={editor.undoLabel}
          redoLabel={editor.redoLabel}
          actions={editActions}
          statusId={statusId}
        />
      )}
      <ScoreView
        viewportRef={viewportRef}
        surfaceRef={surfaceRef}
        label={`Score: ${track.name}`}
        layout={layout}
        rendering={rendering}
        editing={editing}
        overlay={overlay}
        describedBy={editing ? statusId : undefined}
      />
      {instrumentView && (
        <InstrumentPanel
          kind={track.kind}
          tuning={track.tuning}
          capo={track.capo}
          active={shownNotes}
          editing={editing}
          cursorString={track.kind === "stringed" ? editor.cursor.string : null}
          drumSounds={shownNotes.map((n) => n.pitch)}
          onFret={(string, fret) => {
            editor.setString(string);
            editor.setFret(fret - track.capo);
          }}
          onPitch={(pitch) => editor.enterPitch(pitch)}
          onDrum={(sound) => editor.enterDrum(sound)}
        />
      )}
      <TransportBar
        ready={ready}
        playing={playing}
        position={position}
        bar={bar}
        barCount={score.masterBars.length}
        onPlayPause={playPause}
        onStop={() => playerRef.current?.stop()}
        onSeekBar={(index) => playerRef.current?.seekToBar(index)}
        practice={
          <PracticeControls
            practice={practice}
            barCount={score.masterBars.length}
            onLoopChange={setLoop}
            onRangeChange={(next) => dispatchPractice({ type: "range", range: next })}
            onSpeedChange={(value) => dispatchPractice({ type: "speed", value })}
            onMetronomeChange={(value) => dispatchPractice({ type: "metronome", value })}
            onCountInChange={(value) => dispatchPractice({ type: "count-in", value })}
            onOpenTrainer={() => setTrainerOpen(true)}
            onStopTrainer={() => dispatchPractice({ type: "stop-trainer" })}
          />
        }
      />
      <MixerPanel
        open={mixerOpen}
        onOpenChange={setMixerOpen}
        tracks={summary.tracks}
        mix={mix}
        onChange={changeMix}
        onReset={resetMix}
        soundFont={soundFont}
        onSoundFontChange={changeSoundFont}
        saved={saved}
        returnFocusTo={mixerButtonRef}
        soundsReady={ready}
        playing={playing}
      />
      <TracksPanel
        open={tracksOpen}
        onOpenChange={setTracksOpen}
        tracks={summary.tracks}
        shown={trackIndex}
        actions={trackActions}
        returnFocusTo={tracksButtonRef}
      />
      <TrackDialog
        open={trackDialog !== null}
        onOpenChange={(open) => !open && setTrackDialog(null)}
        initial={
          editedSummary
            ? {
                kind: editedSummary.kind,
                name: editedSummary.name,
                program: editedSummary.program,
                tuning: editedSummary.tuning,
                capo: editedSummary.capo,
              }
            : null
        }
        drumKit={drumKitOf(editedTrack)}
        onSubmit={submitTrack}
      />
      <SpeedTrainerDialog
        open={trainerOpen}
        onOpenChange={setTrainerOpen}
        barCount={score.masterBars.length}
        initialRange={suggestedRange()}
        onStart={(trainer, trainerRange) => {
          dispatchPractice({ type: "start-trainer", trainer, range: trainerRange });
          if (!playing && ready) playPause();
        }}
      />
    </div>
  );
}
