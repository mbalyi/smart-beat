import { useEffect, useEffectEvent, useId, useMemo, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

import { BarDialog } from "@/components/score/bar-dialog";
import { BarProblems } from "@/components/score/bar-problems";
import { BendDialog, type CurveKind } from "@/components/score/bend-dialog";
import { ChordDialog } from "@/components/score/chord-dialog";
import { EditToolbar, type EditActions } from "@/components/score/edit-toolbar";
import { EffectsToolbar, type EffectActions } from "@/components/score/effects-toolbar";
import { InstrumentPanel } from "@/components/score/instrument-panel";
import { LyricsDialog } from "@/components/score/lyrics-dialog";
import { LyricsStrip } from "@/components/score/lyrics-strip";
import { MixerPanel, type MixerChange } from "@/components/score/mixer-panel";
import { PracticeControls, SpeedTrainerDialog } from "@/components/score/practice-controls";
import { ScoreToolbar } from "@/components/score/score-toolbar";
import { FileMenu, ToolsMenu } from "@/components/score/song-menu";
import { TransposeDialog, type TransposePreview } from "@/components/score/transpose-dialog";
import { ScoreView, type EditOverlay } from "@/components/score/score-view";
import { TextDialog } from "@/components/score/text-dialog";
import { TrackDialog, type TrackSettings } from "@/components/score/track-dialog";
import { TracksPanel, type TrackActions } from "@/components/score/tracks-panel";
import { TransportBar } from "@/components/score/transport-bar";
import { useEditorKeys } from "@/hooks/use-editor-keys";
import { useFileActions } from "@/hooks/use-file-actions";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { NO_NOTE_EFFECTS, useMenuState } from "@/hooks/use-menu-state";
import type { SavedAs, ScoreDocument } from "@/hooks/use-score-document";
import { useScoreEditor } from "@/hooks/use-score-editor";
import { useSpaceToPlay } from "@/hooks/use-space-to-play";
import { errorText } from "@/lib/errors";
import { diagramFromNotes, recognizeChord } from "@/lib/score/chords";
import {
  barProblems,
  fixBarDurations,
  fixTargets,
  type BarProblem,
} from "@/lib/score/bar-duration";
import { selectionRange, type EffectsInfo } from "@/lib/score/editor";
import { drumKitOf, instrumentViewName, notesOf } from "@/lib/score/instrument-view";
import { keyTonic, prefersFlats } from "@/lib/score/keys";
import { hasLyrics, lyricsOf, setLyrics, syllablesAround } from "@/lib/score/lyrics";
import { mixerReducer } from "@/lib/score/mixer";
import { trackContent, type Beat, type Track } from "@/lib/score/model";
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
import type { Scale } from "@/lib/score/scales";
import { summarizeScore, trackMix, type TrackView } from "@/lib/score/score";
import {
  applyBarSettings,
  barSettingsOf,
  barSettingsRange,
  changedParts,
  structureWarnings,
  tempoAt,
  toggleRepeatEnd,
  toggleRepeatStart,
  type BarSettings,
} from "@/lib/score/structure";
import {
  DEFAULT_SOUNDFONT,
  getSoundFont,
  readSoundFontPreference,
  storeSoundFontPreference,
  type SoundFontId,
} from "@/lib/score/soundfonts";
import {
  beatsFor,
  planTranspose,
  transposeMusic,
  type TransposeRequest,
} from "@/lib/score/transpose";
import {
  createTrack,
  duplicateTrack,
  insertTrack,
  moveTrack,
  removeTrack,
  renameTrack,
  retuneKeepingPitches,
  setCapo,
  setInstrument,
  setTuning,
  uniqueTrackName,
} from "@/lib/score/tracks";
import {
  isTauri,
  MIXER_SETTINGS_VERSION,
  saveMixerSettings,
  type MenuAction,
  type MixerSettings,
  type NoteEffectFlags,
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

/** The Note menu's check marks for the effects at the cursor. */
function noteEffectFlags(effects: EffectsInfo): NoteEffectFlags {
  const note = effects.note;
  if (!note) return NO_NOTE_EFFECTS;
  return {
    hammerPull: note.hammerPull !== 0,
    slide: note.slideOut !== 0,
    vibrato: note.vibrato !== 0,
    palmMute: note.palmMute !== 0,
    letRing: note.letRing !== 0,
    deadNote: note.dead !== 0,
    ghostNote: note.ghost !== 0,
    harmonic: note.harmonic !== 0,
    accent: note.accent !== 0,
    staccato: note.staccato !== 0,
  };
}

/** Note menu toggles and the effect each switches. */
const NOTE_MENU_EFFECTS = {
  "toggle-hammer-pull": "hammerPull",
  "toggle-slide": "slideOut",
  "toggle-vibrato": "vibrato",
  "toggle-palm-mute": "palmMute",
  "toggle-let-ring": "letRing",
  "toggle-dead-note": "dead",
  "toggle-ghost-note": "ghost",
  "toggle-harmonic": "harmonic",
  "toggle-accent": "accent",
  "toggle-staccato": "staccato",
} as const satisfies Partial<Record<MenuAction, string>>;

const isNoteMenuEffect = (action: MenuAction): action is keyof typeof NOTE_MENU_EFFECTS =>
  action in NOTE_MENU_EFFECTS;

/**
 * An open song: toolbar, notation (with the editor), instrument view,
 * transport with practice tools, mixer and tracks.
 */
export function ScoreWorkspace({
  song,
  onOpen,
  onEditedChange,
  onSaved,
  startEditing = false,
}: {
  song: ScoreDocument;
  onOpen: () => void;
  /** Called after the song was saved (Save or Save As): its new name, path and content key. */
  onSaved?: (saved: SavedAs) => void;
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
  /**
   * The view chosen for a track, or the one saved with it. Read from the
   * score itself: during an edit the render's summary may lack new tracks.
   */
  const viewOf = (t: Track, index: number): TrackView =>
    views.get(t) ??
    summarizeScore(score).tracks[index]?.defaultView ?? { notation: "score", rhythm: false };
  const view = viewOf(trackObject, trackIndex);
  // Bars of the shown track that do not add up to their time signature.
  const revision = editor.revision; // changes with every edit, which changes the bars in place
  const problems = useMemo(() => {
    void revision;
    return barProblems(score, trackIndex);
  }, [score, trackIndex, revision]);

  const [layout, setLayout] = useState<Layout>("page");
  const [rendering, setRendering] = useState(true);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState<PlaybackPosition>({ currentMs: 0, endMs: 0, bpm: 0 });
  const [bar, setBar] = useState(0);
  const [editing, setEditing] = useState(startEditing);
  const [overlay, setOverlay] = useState<EditOverlay | null>(null);
  /** Beats of the shown track being played (or clicked while paused). */
  const [activeBeats, setActiveBeats] = useState<Beat[]>([]);
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
  /** The bar dialog's bar and its settings when it opened (kept while it closes). */
  const [barDialog, setBarDialog] = useState<{
    open: boolean;
    index: number;
    initial: BarSettings | null;
  }>({ open: false, index: 0, initial: null });
  const [curveDialog, setCurveDialog] = useState<{ open: boolean; kind: CurveKind }>({
    open: false,
    kind: "bend",
  });
  const [textDialogOpen, setTextDialogOpen] = useState(false);
  const [chordDialogOpen, setChordDialogOpen] = useState(false);
  const [lyricsDialog, setLyricsDialog] = useState<{ open: boolean; track: Track | null }>({
    open: false,
    track: null,
  });
  const [transposeOpen, setTransposeOpen] = useState(false);
  /** Where bars with the wrong length are drawn (shown track). */
  const [problemRects, setProblemRects] = useState<Rect[]>([]);
  const [scale, setScale] = useState<Scale | null>(null);
  const scalePickerRef = useRef<HTMLButtonElement>(null);
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

  const fileActions = useFileActions({
    song,
    editor,
    getMix: () => mixRef.current,
    onSaved: (saved) => onSaved?.(saved),
    onEditedChange,
  });

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

  /** Draws a frame around every bar of the shown track with the wrong length. */
  const refreshProblemRects = useEffectEvent(() => {
    const player = playerRef.current;
    if (!player) return;
    const bars = trackObject.staves[0]?.bars ?? [];
    const rects = [...new Set(problems.map((p) => p.bar))].flatMap((index) => {
      const beats = bars[index]?.voices.flatMap((voice) => voice.beats) ?? [];
      const rect = union(beats.flatMap((beat) => player.beatRects(beat)));
      return rect ? [rect] : [];
    });
    setProblemRects(rects);
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
        onActiveBeatsChange: setActiveBeats,
        onBeatClick: (target) => onBeatClick(target),
        onBeatDrag: (beat) => onBeatDrag(beat),
        onRendered: () => {
          updateOverlay();
          refreshProblemRects();
        },
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
    // Right away (not in an effect): a New or Open right after an edit must ask first.
    onEditedChange?.(editor.edited);
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

  // --- Structure, effects, lyrics and chords ----------------------------------

  const effects = editor.effects;
  const cursorBar = editor.cursor.bar;
  const keyBar = trackObject.staves[0]?.bars[cursorBar];

  /** Opens the bend (or whammy bar) editor, or says why it can't be used here. */
  const openCurve = (kind: CurveKind) => {
    if (track.kind !== "stringed") {
      editor.announce(
        kind === "bend"
          ? "Bends are only available on tab tracks"
          : "The whammy bar is only available on tab tracks",
      );
    } else if (kind === "bend" && !effects.note) {
      editor.announce("No note at the cursor");
    } else if (kind === "whammy" && !effects.beat) {
      editor.announce("No notes on this beat");
    } else {
      setCurveDialog({ open: true, kind });
    }
  };

  const openBarDialog = () =>
    setBarDialog({ open: true, index: cursorBar, initial: barSettingsOf(score, cursorBar) });

  const openLyrics = (target: Track | undefined) => {
    if (target) setLyricsDialog({ open: true, track: target });
  };

  const submitBar = (index: number, next: BarSettings) => {
    const parts = changedParts(barSettingsOf(score, index), next);
    if (parts.length === 0) return;
    editor.editBars(
      parts.length === 1 ? `Change ${parts[0]}` : "Change bar settings",
      barSettingsRange(score, index, next),
      () => applyBarSettings(score, index, next),
      `Bar ${index + 1}: ${parts.join(", ")} changed`,
    );
  };

  const toggleRepeat = (end: boolean) => {
    const masterBar = score.masterBars[cursorBar]!;
    const on = end ? masterBar.repeatCount > 0 : masterBar.isRepeatStart;
    const what = end ? "repeat end" : "repeat start";
    editor.editBars(
      `${on ? "Remove" : "Add"} ${what}`,
      { from: cursorBar, to: cursorBar },
      () => (end ? toggleRepeatEnd(score, cursorBar) : toggleRepeatStart(score, cursorBar)),
      `Bar ${cursorBar + 1}: ${what} ${on ? "removed" : "added"}`,
    );
  };

  const submitLyrics = (target: Track, lines: Parameters<typeof setLyrics>[1]) =>
    editor.run(
      "Change lyrics",
      () => [target],
      () => setLyrics(target, lines),
      `Lyrics of ${target.name.trim() || "the track"} changed`,
    );

  /** Set by View › Scale Tool: the scale picker takes focus once it is shown. */
  const [focusScalePicker, setFocusScalePicker] = useState(false);
  useEffect(() => {
    if (!focusScalePicker || !scalePickerRef.current) return;
    scalePickerRef.current.focus();
    setFocusScalePicker(false);
  }, [focusScalePicker, instrumentView]);

  const openScaleTool = () => {
    if (track.kind === "drums") {
      toast("The scale tool works on stringed and keyboard tracks");
      return;
    }
    if (!instrumentView) toggleInstrumentView();
    setFocusScalePicker(true);
  };

  const effectActions: EffectActions = {
    onToggleNote: (id) => editor.toggleNoteEffect(id),
    onNoteEffect: (id, value) => editor.setNoteEffect(id, value),
    onToggleBeat: (id) => editor.toggleBeatEffect(id),
    onBeatEffect: (id, value) => editor.setBeatEffect(id, value),
    onGrace: (type) => editor.setGrace(type),
    onBend: () => openCurve("bend"),
    onWhammy: () => openCurve("whammy"),
    onText: () => setTextDialogOpen(true),
    onChord: () => setChordDialogOpen(true),
    onDone: () => focusScore(),
  };

  /** Chord names for the selected notes (or the cursor's), in the key's spelling. */
  const flatKey = prefersFlats(keyBar?.keySignature ?? 0);
  const chordSuggestions = chordDialogOpen
    ? recognizeChord(editor.selectedPitches(), { preferFlats: flatKey })
    : [];
  const cursorNotes = editor.beatInfo.notes.filter((n) => n.string !== null && n.fret !== null);
  const notesDiagram =
    track.kind === "stringed" && cursorNotes.length > 0
      ? diagramFromNotes(
          cursorNotes.map((n) => ({ string: n.string!, fret: n.fret! })),
          track.tuning.length,
        )
      : null;

  useEditorKeys(viewportRef, editor, {
    enabled: editing,
    menuHandlesUndo: isTauri(),
    onBend: () => openCurve("bend"),
  });

  function focusScore() {
    viewportRef.current?.focus({ preventScroll: true });
  }

  /** After a dialog opened from the menu or panel: continue in the score. */
  const returnFocusToScore = (event: Event) => {
    if (!viewportRef.current) return;
    event.preventDefault();
    focusScore();
  };

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
    onLyrics: (index) => {
      setTracksOpen(false);
      openLyrics(score.tracks[index]);
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
            if (settings.keepPitches ?? true) {
              removed = retuneKeepingPitches(staff, settings.tuning, settings.capo);
            } else {
              removed = setTuning(staff, settings.tuning);
              setCapo(staff, settings.capo);
            }
          }
        },
      );
      if (removed > 0) {
        const plural = removed === 1;
        const keep = settings.keepPitches ?? true;
        toast(
          keep
            ? `${removed} ${plural ? "note" : "notes"} could not be played in the new tuning and ${plural ? "was" : "were"} deleted`
            : `${removed} ${plural ? "note was" : "notes were"} on removed strings and deleted`,
          { action: { label: "Undo", onClick: () => editor.undo() } },
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

  // --- Transpose and bar lengths ----------------------------------------------

  /** What a transposition would do, without changing anything (for the dialog). */
  const previewTranspose = (request: TransposeRequest): TransposePreview => {
    const cursorBeat = editor.cursorBeat();
    const selected = editor.selection ? editor.selectedBeatList() : cursorBeat ? [cursorBeat] : [];
    const beats = beatsFor(score, request.scope, trackIndex, selected);
    const plan = planTranspose(beats, request.semitones);
    return { moved: plan.placements.length + plan.pitched.length, unplayable: plan.unplayable };
  };

  const submitTranspose = (request: TransposeRequest) => {
    const result = transposeMusic(editor, request);
    if (result.ok)
      toast(result.message, { action: { label: "Undo", onClick: () => editor.undo() } });
    else toast.error("Couldn't transpose", { description: result.message });
  };

  /** Fills short bars of the shown track with rests and trims long ones. */
  const fixBars = (list: readonly BarProblem[] = problems) => {
    if (list.length === 0) {
      toast("All bars of this track have the right length");
      return;
    }
    const bars = new Set(list.map((p) => p.bar)).size;
    editor.run(
      "Fix bar durations",
      () => fixTargets(score, list),
      () => fixBarDurations(score, list),
      `Fixed ${bars} ${bars === 1 ? "bar" : "bars"}`,
    );
    toast(`Fixed ${bars} ${bars === 1 ? "bar" : "bars"}`, {
      action: { label: "Undo", onClick: () => editor.undo() },
    });
  };

  const goToBar = (bar: number) => {
    editor.setCursorTo({ bar, beat: 0, voice: 0 });
    playerRef.current?.seekToBar(bar);
    focusScore();
  };

  // --- Menu -------------------------------------------------------------------

  useMenuActions((action) => {
    if (isNoteMenuEffect(action)) {
      if (editing) editor.toggleNoteEffect(NOTE_MENU_EFFECTS[action]);
      return;
    }
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
      case "lyrics":
        openLyrics(trackObject);
        break;
      case "save":
        void fileActions.save();
        break;
      case "save-as":
        void fileActions.saveAs();
        break;
      case "export-musicxml":
        void fileActions.exportAs("musicxml");
        break;
      case "export-midi":
        void fileActions.exportAs("midi");
        break;
      case "export-ascii-tab":
        void fileActions.exportAs("ascii-tab");
        break;
      case "transpose":
        setTransposeOpen(true);
        break;
      case "fix-bar-durations":
        if (editing) fixBars();
        break;
      case "scale-tool":
        openScaleTool();
        break;
      // The Bar and Note menus work on the edit cursor (they are disabled outside edit mode).
      case "bar-settings":
        if (editing) openBarDialog();
        break;
      case "toggle-repeat-start":
      case "toggle-repeat-end":
        if (editing) toggleRepeat(action === "toggle-repeat-end");
        break;
      case "bend":
        if (editing) openCurve("bend");
        break;
      case "text":
        if (editing) setTextDialogOpen(true);
        break;
      case "chord":
        if (editing) setChordDialogOpen(true);
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
    repeatStart: score.masterBars[cursorBar]?.isRepeatStart ?? false,
    repeatEnd: (score.masterBars[cursorBar]?.repeatCount ?? 0) > 0,
    hasNote: effects.note !== null,
    noteEffects: noteEffectFlags(effects),
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
    onBar: openBarDialog,
    onUndo: () => editor.undo(),
    onRedo: () => editor.redo(),
    onDone: focusScore,
  };

  const shownNotes = !playing && editing ? editor.beatInfo.notes : notesOf(activeBeats);

  // The lyrics strip follows playback, the edit cursor, or the bar last played.
  const showLyrics = hasLyrics(trackObject);
  const lyricBeat: Beat | null =
    playing || !editing
      ? (activeBeats.find((b) => b.voice.index === 0) ??
        trackObject.staves[0]?.bars[bar]?.voices[0]?.beats[0] ??
        null)
      : editor.cursorBeat();
  const lyricLines = showLyrics && lyricBeat ? syllablesAround(trackObject, lyricBeat) : [];
  const barDialogIndex = barDialog.index;
  const lyricsTrack = lyricsDialog.track;

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
        actions={
          <>
            <FileMenu
              onSave={() => void fileActions.save()}
              onSaveAs={() => void fileActions.saveAs()}
              onExport={(format) => void fileActions.exportAs(format)}
            />
            <ToolsMenu onTranspose={() => setTransposeOpen(true)} onFixBars={() => fixBars()} />
          </>
        }
      />
      <BarProblems problems={problems} onFix={() => fixBars()} onGoTo={goToBar} />
      {/* Scrolls as a whole when the window is too short for all of it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
        {editing && <EffectsToolbar effects={effects} kind={track.kind} actions={effectActions} />}
        <ScoreView
          viewportRef={viewportRef}
          surfaceRef={surfaceRef}
          label={`Score: ${track.name}`}
          layout={layout}
          rendering={rendering}
          editing={editing}
          overlay={overlay}
          problemRects={problemRects}
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
            scale={scale}
            defaultScaleRoot={keyTonic(keyBar?.keySignature ?? 0, keyBar?.keySignatureType ?? 0)}
            scalePickerRef={scalePickerRef}
            onScaleChange={setScale}
          />
        )}
      </div>
      {showLyrics && <LyricsStrip lines={lyricLines} current={lyricBeat} />}
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
        onCloseAutoFocus={returnFocusToScore}
      />
      <BarDialog
        open={barDialog.open}
        onOpenChange={(open) => setBarDialog((d) => ({ ...d, open }))}
        barNumber={barDialogIndex + 1}
        initial={barDialog.initial}
        currentTempo={tempoAt(score, barDialogIndex)}
        warningsFor={(draft) =>
          structureWarnings(score, { index: barDialogIndex, settings: draft })
        }
        onSubmit={(next) => submitBar(barDialogIndex, next)}
        onCloseAutoFocus={returnFocusToScore}
      />
      <BendDialog
        open={curveDialog.open}
        onOpenChange={(open) => setCurveDialog((d) => ({ ...d, open }))}
        kind={curveDialog.kind}
        initial={curveDialog.kind === "whammy" ? effects.whammy : effects.bend}
        onSubmit={(points) =>
          curveDialog.kind === "whammy" ? editor.setWhammy(points) : editor.setBend(points)
        }
        onCloseAutoFocus={returnFocusToScore}
      />
      <TextDialog
        open={textDialogOpen}
        onOpenChange={setTextDialogOpen}
        initial={effects.text}
        onSubmit={(text) => editor.setText(text)}
        onCloseAutoFocus={returnFocusToScore}
      />
      <ChordDialog
        open={chordDialogOpen}
        onOpenChange={setChordDialogOpen}
        initial={effects.chord}
        strings={track.kind === "stringed" ? { tuning: track.tuning, capo: track.capo } : null}
        suggestions={chordSuggestions}
        notesDiagram={notesDiagram}
        preferFlats={flatKey}
        onSubmit={(spec) => editor.setChord(spec)}
        onCloseAutoFocus={returnFocusToScore}
      />
      <LyricsDialog
        open={lyricsDialog.open}
        onOpenChange={(open) => setLyricsDialog((d) => ({ ...d, open }))}
        trackName={lyricsTrack?.name.trim() || "Track"}
        initial={lyricsTrack ? lyricsOf(lyricsTrack) : []}
        barCount={score.masterBars.length}
        onSubmit={(lines) => lyricsTrack && submitLyrics(lyricsTrack, lines)}
        onCloseAutoFocus={returnFocusToScore}
      />
      <TransposeDialog
        open={transposeOpen}
        onOpenChange={setTransposeOpen}
        hasSelection={editor.selection !== null}
        preview={previewTranspose}
        onSubmit={submitTranspose}
        onCloseAutoFocus={returnFocusToScore}
      />
      <SpeedTrainerDialog
        open={trainerOpen}
        onOpenChange={setTrainerOpen}
        barCount={score.masterBars.length}
        initialRange={suggestedRange()}
        onCloseAutoFocus={returnFocusToScore}
        onStart={(trainer, trainerRange) => {
          dispatchPractice({ type: "start-trainer", trainer, range: trainerRange });
          if (!playing && ready) playPause();
        }}
      />
    </div>
  );
}
