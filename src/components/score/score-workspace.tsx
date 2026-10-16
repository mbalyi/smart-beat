import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { isEnabled } from "@/lib/features";
import { soundFontCounterId, track as trackUsage } from "@/lib/telemetry";

import { AudioTrackPanel } from "@/components/audio/audio-track-panel";
import { DrumMixerDialog } from "@/components/audio/drum-mixer-dialog";
import {
  PedalboardDialog,
  type PedalboardSounds,
  type PedalboardTarget,
} from "@/components/audio/pedalboard-dialog";
import { SoundLibraryDialog } from "@/components/audio/sound-library-dialog";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { BarDialog } from "@/components/score/bar-dialog";
import { BarProblems } from "@/components/score/bar-problems";
import { BendDialog, type CurveKind } from "@/components/score/bend-dialog";
import { ChordDialog } from "@/components/score/chord-dialog";
import { EditToolbar, type EditActions } from "@/components/score/edit-toolbar";
import {
  EffectsToolbar,
  type EffectActions,
  type PaletteState,
} from "@/components/score/effects-toolbar";
import { ExportDialog } from "@/components/score/export-dialog";
import { InstrumentPanel } from "@/components/score/instrument-panel";
import { LyricsDialog } from "@/components/score/lyrics-dialog";
import { LyricsStrip } from "@/components/score/lyrics-strip";
import { PracticeMix } from "@/components/score/practice-mix";
import { ScoreContextMenu, type ScoreMenuActions } from "@/components/score/score-context-menu";
import { exportGroups } from "@/lib/export/choices";
import { baseName } from "@/lib/score/format";
import { useTheme } from "@/hooks/use-theme";
import { TunerDialog } from "@/components/score/tuner-dialog";
import { RecordBar } from "@/components/score/record-bar";
import { RecordDialog, type DroppedTake } from "@/components/score/record-dialog";
import { onTourPanels as subscribeTourPanels, type TourBusMessage } from "@/lib/tour/tour-bus";
import { useTour } from "@/hooks/use-tour";
import { PracticeControls, SpeedTrainerDialog } from "@/components/score/practice-controls";
import { FileMenu, ToolsMenu } from "@/components/score/song-menu";
import { TransposeDialog, type TransposePreview } from "@/components/score/transpose-dialog";
import { ScoreView, type EditOverlay } from "@/components/score/score-view";
import { PrintDialog } from "@/components/score/print-dialog";
import { TempoDialog, type TempoInitial } from "@/components/score/tempo-dialog";
import { TextDialog } from "@/components/score/text-dialog";
import { CopyInstrumentDialog } from "@/components/score/copy-instrument-dialog";
import { TrackDialog, type TrackSettings } from "@/components/score/track-dialog";
import { Inspector } from "@/components/shell/inspector";
import { NotePalette } from "@/components/shell/note-palette";
import { TrackList, type TrackActions } from "@/components/shell/track-list";
import { WorkspaceToolbar } from "@/components/shell/workspace-toolbar";
import { useEditorKeys } from "@/hooks/use-editor-keys";
import { useFileActions } from "@/hooks/use-file-actions";
import { useM4aSupport, usePdfSupport } from "@/hooks/use-m4a-support";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { NO_NOTE_EFFECTS, useMenuState } from "@/hooks/use-menu-state";
import type { SavedAs, ScoreDocument } from "@/hooks/use-score-document";
import { useScoreEditor } from "@/hooks/use-score-editor";
import { useSoundLibrary } from "@/hooks/use-sound-library";
import { usePianoModel } from "@/hooks/use-piano-model";
import { recordTargets, useRecordToTab } from "@/hooks/use-record-to-tab";
import { useSpaceToPlay } from "@/hooks/use-space-to-play";
import {
  MAX_MASTER_EFFECTS,
  MAX_TRACK_EFFECTS,
  withFocusBlock,
  type EffectSlot,
  type EffectType,
} from "@/lib/audio/effects";
import {
  barOccurrences,
  barTimeline,
  syncPointsFromTempo,
  type BarOccurrence,
} from "@/lib/audio/engine-config";
import { useAudioInput, useAudioInputChannel } from "@/lib/audio/input";
import { meters } from "@/lib/audio/meter-store";
import { MONITOR_NAME, newMonitorTrack, rememberMonitorTrack } from "@/lib/audio/monitor";
import type { EffectProblems } from "@/lib/audio/native-engine";
import {
  nativeEngineAvailable,
  readAudioEnginePreference,
  storeAudioEnginePreference,
} from "@/lib/audio/engine-preference";
import {
  chainOf,
  drumsOf,
  presetTargetOf,
  type Preset,
  type PresetTarget,
} from "@/lib/audio/presets";
import { PresetBrowserDialog } from "@/components/audio/preset-browser-dialog";
import { DrumKitDialog } from "@/components/audio/drum-kit-dialog";
import { SoundFontsDialog } from "@/components/audio/soundfonts-dialog";
import { useDrumKits } from "@/hooks/use-drum-kits";
import { useSoundFonts } from "@/hooks/use-soundfonts";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { diagramFromNotes, recognizeChord } from "@/lib/score/chords";
import {
  barProblems,
  fixBarDurations,
  fixTargets,
  type BarProblem,
} from "@/lib/score/bar-duration";
import { selectionRange, type EffectsInfo } from "@/lib/score/editor";
import type { EncodingChoice } from "@/lib/score/encoding";
import {
  drumKitOf,
  instrumentViewName,
  kitEntries,
  notesOf,
  ownDrumKit,
} from "@/lib/score/instrument-view";
import { keyTonic, prefersFlats } from "@/lib/score/keys";
import { hasLyrics, lyricsOf, setLyrics, syllablesAround } from "@/lib/score/lyrics";
import {
  pdfPage,
  printScore,
  readPrintSettings,
  storePrintSettings,
  whenDrawn,
  type PrintSettings,
  type PrintTracks,
} from "@/lib/print";
import { applyTempo, tempoScope, type TempoRequest } from "@/lib/score/tempo";
import { readSyncOffset, storeSyncOffset } from "@/lib/score/sync";
import { DEFAULT_INTERPRETATION } from "@/lib/score/interpretation";
import {
  addSound,
  EMPTY_AUTOMATION,
  FLAT_EQ,
  mixerReducer,
  readFocusCutDb,
  removeSound,
  soundEffects,
  storeFocusCutDb,
  soundNames,
  trackEffects,
  trackInterpretation,
  trackSoundsOf,
  trackStates,
  withTrackStates,
  type MixerChange,
  type TrackState,
  type MixerAction,
} from "@/lib/score/mixer";
import {
  CLASSIC_LAYOUT,
  readLayoutPrefs,
  storeLayoutPrefs,
  type LayoutPrefs,
} from "@/lib/score/layout";
import { trackContent, type Beat, type Score, type Track } from "@/lib/score/model";
import type { InstrumentPreset } from "@/lib/score/music";
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
  type PracticeAction,
  normalizeRange,
  type PracticeState,
} from "@/lib/score/practice";
import type { Scale } from "@/lib/score/scales";
import { summarizeScore, trackMix, type TrackView } from "@/lib/score/score";
import {
  applyBarSettings,
  barSettingsOf,
  barSettingsRange,
  changedParts,
  sectionsOf,
  structureWarnings,
  tempoAt,
  toggleRepeatEnd,
  toggleRepeatStart,
  type BarSettings,
} from "@/lib/score/structure";
import {
  DEFAULT_SOUNDFONT,
  FALLBACK_SOUNDFONT,
  getSoundFont,
  isStoredSoundFontId,
  readSoundFontPreference,
  soundFontUrl,
  storedSoundFontId,
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
  convertTrackToInstrument,
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
  type ConversionResult,
} from "@/lib/score/tracks";
import { canNormalizeDrums, normalizeDrumNotation } from "@/lib/score/drum-normalize";
import {
  AUDIO_EXTENSIONS,
  isCommandError,
  isTauri,
  MIXER_SETTINGS_VERSION,
  pickAudioFile,
  pickSavePath,
  readDroppedAudio,
  saveMixerSettings,
  writePdfFile,
  type AudioTrackSettings,
  type BackingInfo,
  type BackingSource,
  type FocusMode,
  type MenuAction,
  type MixerSettings,
  type MonitorStatus,
  type NoteEffectFlags,
} from "@/lib/tauri";

/** Mixer changes are saved this long after the last one. */
export const SAVE_DELAY_MS = 500;

/** Counts the mixer changes that are tracked (docs/analytics.md); parameters are not counted. */
function trackMixChange(action: MixerAction) {
  switch (action.type) {
    case "mute":
      if (action.value) trackUsage("mute_track");
      break;
    case "solo":
      if (action.value) trackUsage("solo_track");
      break;
    case "sounds":
    case "drum-kit":
      trackUsage("sound_change");
      break;
    case "focus":
      if (action.track !== null) trackUsage("practice_mix");
      break;
    default:
      break;
  }
}

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

/** How long a note entered while editing sounds (ms). */
const EDIT_NOTE_MS = 700;

export const AUDITION_STORAGE_KEY = "smart-beat:audition-notes";

/** "Play notes while editing" is on unless the user turned it off. */
function readAuditionNotes(): boolean {
  try {
    return localStorage.getItem(AUDITION_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeAuditionNotes(on: boolean) {
  try {
    localStorage.setItem(AUDITION_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not remembered: on next time.
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
  active = true,
  tabs,
  headerSlot,
  onOpen,
  onImportAudio,
  onOpenScore,
  onEditedChange,
  onSaved,
  onReopenWithEncoding,
  startEditing = false,
  droppedAudio = null,
  onOpenSettings,
}: {
  song: ScoreDocument;
  /** The song's tab is shown. Other songs stay loaded (edits, undo, playback position) but hidden. */
  active?: boolean;
  /** The document tabs, shown under the toolbar. */
  tabs?: ReactNode;
  /** The app header's centre, where the main controls are shown. */
  headerSlot?: HTMLElement | null;
  onOpen: () => void;
  /** Import from Audio; left out while the `audio-2-tab` feature is off. */
  onImportAudio?: () => void;
  /** Free-mode Record to Tab: opens the take as a new song that exists only in memory. */
  onOpenScore?: (score: Score, name: string) => void;
  /** Called after the song was saved (Save or Save As): its new name, path and content key. */
  onSaved?: (saved: SavedAs) => void;
  /** Guitar Pro 3–5 songs: read the file again with another text encoding (#53). */
  onReopenWithEncoding?: (choice: EncodingChoice) => void;
  /** Called when the song gets (or loses, by undoing everything) unsaved changes. */
  onEditedChange?: (edited: boolean) => void;
  /** Open in edit mode (new songs). */
  startEditing?: boolean;
  /** An audio file dropped on the window while this song is shown (`nonce` changes per drop). */
  droppedAudio?: { path: string; nonce: number } | null;
  /** Opens the app's Settings (the tuner's audio input); focus comes back to `from`. */
  onOpenSettings?: (from: HTMLElement) => void;
}) {
  const score = song.score;
  const editor = useScoreEditor(score, song.unsaved);
  const summary = summarizeScore(score);
  const statusId = useId();

  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ScorePlayer | null>(null);
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
  // The song's named parts, to practise them by name (#83).
  const sections = useMemo(() => {
    void revision;
    return sectionsOf(score);
  }, [score, revision]);
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
  const [auditionNotes, setAuditionNotes] = useState(readAuditionNotes);

  // The mix follows the tracks (not their positions) through reordering and undo.
  const [mix, setMix] = useState(song.mix);
  const mixRef = useRef(song.mix);
  // Everything the mixer knows about a track (effects, sounds, EQ, automation,
  // drum mixer, focus) follows it too.
  const stateByTrack = useRef(
    new Map<Track, TrackState>(trackStates(song.mix).map((s, i) => [score.tracks[i]!, s])),
  );
  const [soundFont, setSoundFont] = useState<SoundFontId>(readSoundFontPreference);
  const [audioEngine, setAudioEngine] = useState(readAudioEnginePreference);
  // The input the monitor track plays (Settings › Audio, for the whole app).
  const audioInput = useAudioInput();
  const inputChannel = useAudioInputChannel();
  const monitorDevice = audioInput?.label ?? null;
  const monitorInputNow = useEffectEvent(() => ({ device: monitorDevice, channel: inputChannel }));
  /** The monitor track's input as the engine last reported it (null: no monitor, or closed). */
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [effectProblems, setEffectProblems] = useState<EffectProblems>({
    tracks: [],
    master: [],
  });
  const [pedalboard, setPedalboard] = useState<{
    open: boolean;
    /** A track, the monitor track, or null for the master. */
    track: number | "monitor" | null;
    /**
     * The track it was opened for (none: the master). The dialog's Track / Mastering switch
     * goes back to it, whatever track is highlighted in the mixer by then.
     */
    opened: number | "monitor" | null;
    focus?: EffectType;
    /** The sound of the track being edited. */
    sound: number;
    /** Changes with every opening, so the dialog starts fresh. */
    session: number;
  }>({ open: false, track: null, opened: null, sound: 0, session: 0 });
  const [drumMixer, setDrumMixer] = useState<{ open: boolean; track: number }>({
    open: false,
    track: 0,
  });
  /** The loaded recording of the audio track (waveform), or null. */
  const [backingInfo, setBackingInfo] = useState<BackingInfo | null>(null);
  const [audioEditorOpen, setAudioEditorOpen] = useState(false);
  const [audioZoom, setAudioZoom] = useState(40);
  // Bars in playback order (repeats included), as the engine plays them.
  const [playedBars, setPlayedBars] = useState<BarOccurrence[] | null>(null);
  /** Which recording is loaded in the engine ("" for none). */
  const loadedAudio = useRef("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const library = useSoundLibrary();
  const drumKits = useDrumKits();
  const [kitsOpen, setKitsOpen] = useState(false);
  const soundFonts = useSoundFonts();
  const [soundFontsOpen, setSoundFontsOpen] = useState(false);
  // The panels the user left open (a new install starts without them, #83).
  const [mixerOpen, setMixerOpen] = useState(() => (readLayoutPrefs() ?? CLASSIC_LAYOUT).mixer);
  // Side panels cover the score in narrow windows: start without the inspector there.
  const [inspectorOpen, setInspectorOpen] = useState(
    () =>
      (readLayoutPrefs() ?? CLASSIC_LAYOUT).inspector &&
      !window.matchMedia?.("(max-width: 1023px)").matches,
  );
  /**
   * Practice View (#83): only the score and the playback and practice controls, the practised
   * track in focus. Holds what to put back when it ends (null: off). The panels' own state is
   * untouched, so they come back as they were.
   */
  const [practiceView, setPracticeView] = useState<{
    editing: boolean;
    focus?: number;
    focusMode?: FocusMode;
  } | null>(null);
  const [focusCutDb, setFocusCutDb] = useState(readFocusCutDb);
  const [inspectorTab, setInspectorTab] = useState<"song" | "track">("track");
  // Narrowing the window below 1024 px closes the inspector: it would cover the score.
  useEffect(() => {
    const narrow = window.matchMedia?.("(max-width: 1023px)");
    if (!narrow) return;
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setInspectorOpen(false);
    };
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  }, []);
  const [zoom, setZoom] = useState(100);
  const [syncOffset, setSyncOffset] = useState(readSyncOffset);
  const [trackDialog, setTrackDialog] = useState<TrackDialogState | null>(null);
  /** The track being copied to another instrument (its object, so it survives reordering). */
  const [copyTrack, setCopyTrack] = useState<Track | null>(null);
  const [trainerOpen, setTrainerOpen] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  /** The bars the Speed Trainer was opened for from the score's context menu (#83). */
  const [trainerRange, setTrainerRange] = useState<LoopRange | null>(null);
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
  /** The preset browser (#42): what it was opened for. */
  const [presetBrowser, setPresetBrowser] = useState<{
    open: boolean;
    target: PresetTarget;
    track: number | "monitor" | null;
    sound: number;
    targets?: PresetTarget[];
  }>({ open: false, target: "guitar", track: null, sound: 0 });
  const [lyricsDialog, setLyricsDialog] = useState<{ open: boolean; track: Track | null }>({
    open: false,
    track: null,
  });
  const [transposeOpen, setTransposeOpen] = useState(false);
  const [tempoOpen, setTempoOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [printSettings, setPrintSettings] = useState(readPrintSettings);
  /** Runs once the score has been drawn again (printing needs the page layout). */
  const afterRender = useRef<(() => void) | null>(null);
  /** Where bars with the wrong length are drawn (shown track). */
  const [problemRects, setProblemRects] = useState<Rect[]>([]);
  const [scale, setScale] = useState<Scale | null>(null);
  const scalePickerRef = useRef<HTMLButtonElement>(null);
  const [practice, dispatchPracticeAction] = useReducer(practiceReducer, undefined, () =>
    initialPractice(readPracticePrefs()),
  );
  /** Every practice change goes through here so switching a tool on is counted once. */
  const dispatchPractice = useCallback((action: PracticeAction) => {
    if (action.type === "loop" && action.value) trackUsage("loop_on");
    else if (action.type === "metronome" && action.value) trackUsage("metronome_on");
    else if (action.type === "count-in" && action.value) trackUsage("count_in_on");
    else if (action.type === "start-trainer") trackUsage("speed_trainer_start");
    else if (action.type === "stop-trainer") trackUsage("speed_trainer_stop");
    else if (action.type === "hold-trainer" && action.value) trackUsage("speed_trainer_hold");
    else if (action.type === "speed") trackUsage("practice_speed");
    else if (action.type === "range") trackUsage("practice_range");
    else if (action.type === "restart-on-stop")
      trackUsage(action.value ? "restart_on_stop_on" : "restart_on_stop_off");
    dispatchPracticeAction(action);
  }, []);
  /** Bars last dragged across in the score (what Loop starts with). */
  const [pickedRange, setPickedRange] = useState<LoopRange | null>(null);

  const sameTracks =
    score.tracks.length === originalTracks.length &&
    score.tracks.every((t, i) => t === originalTracks[i]);
  // Only the desktop app can store settings, and only for the file's own tracks.
  const saved = isTauri() && song.fileKey !== null && sameTracks;
  useSavedMix(song, mix, saved);

  const m4aSupported = useM4aSupport();
  const pdfSupported = usePdfSupport();
  const fileActions = useFileActions({
    song,
    editor,
    getMix: () => mixRef.current,
    renderAudio: (onProgress) => {
      const player = playerRef.current;
      if (!player) return Promise.reject(new Error("The score is not ready yet."));
      return player.renderAudio(onProgress);
    },
    onSaved: (saved) => onSaved?.(saved),
    onEditedChange,
  });

  const changeSoundFont = (id: SoundFontId) => {
    trackUsage("sound_change");
    trackUsage("soundfont_select", soundFontCounterId(getSoundFont(id, soundFonts.fonts)));
    previousSoundFont.current = soundFont;
    setSoundFont(id);
    storeSoundFontPreference(id);
    void playerRef.current?.setSoundFont(soundFontUrl(id));
  };

  /** The sound set that was in use before the last switch, i.e. what is kept if the switch fails. */
  const previousSoundFont = useRef<SoundFontId | null>(null);

  const onSoundFontError = useEffectEvent(
    (error: Error, { previousKept }: { previousKept: boolean }) => {
      if (soundFont === FALLBACK_SOUNDFONT) {
        toast.error("Instrument sounds could not be loaded", { description: errorText(error) });
        return;
      }
      const added = isStoredSoundFontId(soundFont);
      const name = soundFonts.fonts.find((font) => font.id === soundFont)?.label ?? "The SoundFont";
      toast.error(
        added
          ? `${name} could not be loaded`
          : `${getSoundFont(soundFont).label} sounds are not available`,
        { description: "Using the standard sounds instead." },
      );
      setSoundFont(FALLBACK_SOUNDFONT);
      storeSoundFontPreference(FALLBACK_SOUNDFONT);
      // The standard sounds may still be loaded (the ones playing before the switch): then don't
      // interrupt playback. If the kept sounds are another bank's, load the standard ones so the
      // picker and the sound agree.
      if (!previousKept || previousSoundFont.current !== FALLBACK_SOUNDFONT) {
        void playerRef.current?.setSoundFont(soundFontUrl(FALLBACK_SOUNDFONT));
      }
    },
  );

  /** Where the edit cursor, its note and the selection are drawn now. */
  const updateOverlay = useEffectEvent(() => {
    const player = playerRef.current;
    if (!player) return;
    // Outside edit mode only a range selected with Shift is drawn (#92).
    const beat = editing ? editor.cursorBeat() : null;
    const note = editing ? editor.cursorNote() : null;
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
      // Outside edit mode too, so a selection made there is kept for edit mode (#53).
      if (beat.voice.bar.staff.track !== trackObject) return;
      if (extend) trackUsage("shift_select");
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
  // The score follows the app's light or dark mode; printing stays light (#83).
  const { resolvedTheme } = useTheme();
  const initial = useRef({ trackIndex, view, layout, soundFont, theme: resolvedTheme });
  // Kept current, for a player created again (the audio engine changed).
  useEffect(() => {
    initial.current = { trackIndex, view, layout, soundFont, theme: resolvedTheme };
  });

  /** A new player for the same song (other audio engine) gets the current settings. */
  const restorePlayerSettings = useEffectEvent((player: ScorePlayer) => {
    player.setZoom(zoom / 100);
    player.setEditing(editing);
    player.setLoop(practice.loop ? practice.range : null);
    player.setSpeed(practice.speed);
    player.setMetronome(practice.metronome);
    player.setCountIn(practice.countIn);
    player.setRestartOnStop(practice.restartOnStop);
    player.setLoopCountIn(!!practice.trainer?.countInBetween && audioEngine === "native");
    player.setFocusCut(focusCutDb);
  });
  const playerCreated = useRef(false);

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
        soundFontUrl: soundFontUrl(start.soundFont),
        reducedMotion: prefersReducedMotion(),
        audioEngine,
        theme: start.theme,
        monitorInput: monitorInputNow(),
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
          const next = afterRender.current;
          afterRender.current = null;
          next?.();
        },
        onRangeSelect: (picked) => {
          setPickedRange(picked);
          if (picked) dispatchPractice({ type: "range", range: picked });
        },
        onLoopRestart: () => dispatchPractice({ type: "loop-completed" }),
        onEffectProblems: setEffectProblems,
        onEngineFault: () =>
          toast.error("A sound stopped working", {
            description:
              "Smart Beat switched all effects off so the song can go on. Remove the amp or cabinet you added last, or reopen the song.",
          }),
        onMeters: (m) => meters.set(m),
        onOccurrences: setPlayedBars,
        onMonitorStatus: setMonitorStatus,
      },
    );
    playerRef.current = player;
    if (playerCreated.current) restorePlayerSettings(player);
    playerCreated.current = true;
    return () => {
      player.destroy();
      playerRef.current = null;
      // The next player (engine switched) has no recording loaded yet.
      loadedAudio.current = "";
      setBackingInfo(null);
      setPlayedBars(null);
      setMonitorStatus(null);
    };
  }, [song.score, audioEngine, dispatchPractice]);

  // A song in a hidden tab does not keep playing.
  useEffect(() => {
    if (!active) playerRef.current?.pause();
  }, [active]);

  // Practice settings go to the player whenever they change.
  const { loop, range, speed, metronome, countIn, restartOnStop } = practice;
  useEffect(() => {
    playerRef.current?.setLoop(loop ? range : null);
  }, [loop, range]);
  useEffect(() => playerRef.current?.setSpeed(speed), [speed]);
  useEffect(() => {
    playerRef.current?.setMetronome(metronome);
    playerRef.current?.setCountIn(countIn);
    playerRef.current?.setRestartOnStop(restartOnStop);
    storePracticePrefs({ metronome, countIn, restartOnStop });
  }, [metronome, countIn, restartOnStop]);
  useEffect(() => playerRef.current?.setEditing(editing), [editing]);
  useEffect(() => playerRef.current?.setFocusCut(focusCutDb), [focusCutDb]);
  useEffect(() => playerRef.current?.setTheme(resolvedTheme), [resolvedTheme]);
  // A count-in before every loop, while the Speed Trainer asks for one (native engine; #83).
  const loopCountIn = !!practice.trainer?.countInBetween && audioEngine === "native";
  useEffect(() => playerRef.current?.setLoopCountIn(loopCountIn), [loopCountIn]);

  /** After every change to the music: new mix order, re-render, new MIDI. */
  const onModelChange = useEffectEvent(() => {
    const states = score.tracks.map((t) => {
      const known = stateByTrack.current.get(t);
      if (known) return known;
      const fresh: TrackState = {
        mix: { ...trackMix(t) },
        effects: [],
        interpretation: DEFAULT_INTERPRETATION,
        sounds: null,
        eq: FLAT_EQ,
        automation: EMPTY_AUTOMATION,
        drums: null,
        kit: null,
        color: null,
        focused: false,
      };
      stateByTrack.current.set(t, fresh);
      return fresh;
    });
    const before = trackStates(mixRef.current);
    const next = withTrackStates(mixRef.current, states);
    const changedOrder =
      states.length !== before.length ||
      states.some((s, i) => {
        const b = before[i]!;
        return (
          s.mix !== b.mix ||
          s.effects !== trackEffects(mixRef.current, i) ||
          s.interpretation !== trackInterpretation(mixRef.current, i) ||
          s.sounds !== b.sounds ||
          s.eq !== b.eq ||
          s.automation !== b.automation ||
          s.drums !== b.drums ||
          s.kit !== b.kit ||
          s.focused !== b.focused
        );
      });
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

  // Hear each note as it is entered: a short preview, never the song (#90).
  const auditionNote = useEffectEvent((pitch: number) => {
    if (!auditionNotes || !editing) return;
    playerRef.current?.previewNote(pitch, track.program, EDIT_NOTE_MS);
  });
  useEffect(() => {
    editor.onNoteEntered(auditionNote);
    return () => {
      editor.onNoteEntered(null);
    };
  }, [editor]);

  useEffect(
    () =>
      editor.subscribe((change) => {
        if (change === "model") onModelChange();
        else onCursorChange();
      }),
    [editor],
  );
  // A song that exists only in memory (an audio transcription) is unsaved from the start.
  const reportUnsaved = useEffectEvent(() => {
    if (editor.edited) onEditedChange?.(true);
  });
  useEffect(() => reportUnsaved(), []);

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
    onFermata: () => editor.toggleFermata(),
    onRepeat: (side) => editor.toggleRepeat(side),
    onText: () => setTextDialogOpen(true),
    onChord: () => setChordDialogOpen(true),
    onLyrics: () => openLyrics(trackObject),
    onDone: () => focusScore(),
  };
  const paletteState: PaletteState = {
    effect: (scope, id, value) => editor.effectState(scope, id, value),
    fermata: editor.fermataState,
    repeatStart: editor.repeatState("start"),
    repeatEnd: editor.repeatState("end"),
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

  // Outside edit mode Escape clears a range dragged in the score (#53).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (editing || !viewport) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      playerRef.current?.clearSelection();
      editor.clearSelection();
    };
    // alphaTab keeps the mouse down from focusing the score: focus it for Escape.
    const onPointer = () => viewport.focus({ preventScroll: true });
    viewport.addEventListener("keydown", onKey);
    viewport.addEventListener("pointerdown", onPointer);
    return () => {
      viewport.removeEventListener("keydown", onKey);
      viewport.removeEventListener("pointerdown", onPointer);
    };
  }, [editing, editor]);

  function focusScore() {
    viewportRef.current?.focus({ preventScroll: true });
  }

  /** After a dialog opened from the menu or panel: continue in the score. */
  const returnFocusToScore = (event: Event) => {
    if (!viewportRef.current) return;
    event.preventDefault();
    focusScore();
  };

  /** Switches to edit mode (leaving Practice View) from any entry point. */
  const toggleEditingOn = () => {
    if (practiceView) leavePracticeView();
    setEditing(true);
  };

  const toggleEditing = () => {
    // Editing ends Practice View.
    if (practiceView) {
      leavePracticeView();
      setEditing(true);
      return;
    }
    setEditing((on) => !on);
  };

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
    if (next.notation !== view.notation) trackUsage("notation_mode_switch");
    setViews((current) => new Map(current).set(trackObject, next));
    playerRef.current?.setView(next);
  };

  const changeZoom = (percent: number) => {
    setZoom(percent);
    playerRef.current?.setZoom(percent / 100);
  };

  const changeLayout = (next: Layout) => {
    setLayout(next);
    playerRef.current?.setLayout(next);
  };

  const changeMix: MixerChange = (action, { commit } = { commit: true }) => {
    if (commit) trackMixChange(action);
    const next = mixerReducer(mixRef.current, action);
    mixRef.current = next;
    trackStates(next).forEach((state, i) => {
      const t = score.tracks[i];
      if (t) stateByTrack.current.set(t, state);
    });
    setMix(next);
    if (commit) playerRef.current?.setMix(next);
    if (
      action.type === "monitor" &&
      action.value?.enabled &&
      !mix.monitor?.enabled &&
      !engineOn &&
      nativeEngineAvailable()
    )
      changeAudioEngine("native");
  };

  // --- Panels and Practice View (#83) ------------------------------------------------------

  const showMixer = mixerOpen && !practiceView;
  const showInspector = inspectorOpen && !practiceView;
  const showInstrumentView = instrumentView && !practiceView;
  const rememberPanels = (change: Partial<LayoutPrefs>) =>
    storeLayoutPrefs({ ...(readLayoutPrefs() ?? CLASSIC_LAYOUT), ...change });
  const enterPracticeView = () => {
    trackUsage("practice_view");
    setPracticeView({ editing, focus: mix.focus, focusMode: mix.focusMode });
    setEditing(false);
    if (mix.focus === undefined) changeMix({ type: "focus", track: trackIndex });
  };
  /** Ends Practice View: the panels, edit mode and the mix's focus come back as they were. */
  const leavePracticeView = () => {
    if (!practiceView) return;
    setPracticeView(null);
    setEditing(practiceView.editing);
    changeMix({
      type: "focus",
      track: practiceView.focus ?? null,
      mode: practiceView.focusMode ?? "othersDown",
    });
  };
  const togglePracticeView = () => (practiceView ? leavePracticeView() : enterPracticeView());
  /** A panel switch in Practice View ends it and shows the panel. */
  const toggleMixer = () => {
    const next = practiceView ? true : !mixerOpen;
    leavePracticeView();
    if (next) trackUsage("mixer_open");
    setMixerOpen(next);
    rememberPanels({ mixer: next });
  };
  const toggleInspector = () => {
    const next = practiceView ? true : !inspectorOpen;
    leavePracticeView();
    setInspectorOpen(next);
    rememberPanels({ inspector: next });
  };
  // --- Guided tours (#84) -----------------------------------------------------------------
  // A tour asks for a panel, a dialog, Edit mode, other practice settings or playback; what it
  // changed is put back when the tour ends.
  const tourSnapshot = useRef<{
    mixer: boolean;
    inspector: boolean;
    inspectorTab: "song" | "track";
    instrumentView: boolean;
    editing: boolean;
    track: number;
    practice: PracticeState;
  } | null>(null);
  const onTourPanels = useEffectEvent((message: TourBusMessage) => {
    // The song a tour started on restores itself, even if another tab is shown by then.
    const owner = tourSnapshot.current !== null;
    if (!active && !(message === "restore" && owner)) return;
    const closeDialogs = () => {
      setTrainerOpen(false);
      setPedalboard((p) => ({ ...p, open: false }));
      setDrumMixer((d) => ({ ...d, open: false }));
      recording.close();
    };
    const restorePractice = (saved: PracticeState) => {
      dispatchPracticeAction({ type: "stop-trainer" });
      dispatchPracticeAction({ type: "speed", value: saved.speed });
      dispatchPracticeAction({ type: "loop", value: saved.loop, range: saved.range });
      dispatchPracticeAction({ type: "metronome", value: saved.metronome });
      dispatchPracticeAction({ type: "count-in", value: saved.countIn });
    };
    if (message === "restore") {
      const saved = tourSnapshot.current;
      tourSnapshot.current = null;
      closeDialogs();
      if (playing) playerRef.current?.playPause();
      if (!saved) return;
      setMixerOpen(saved.mixer);
      setInspectorOpen(saved.inspector);
      setInspectorTab(saved.inspectorTab);
      setInstrumentView(saved.instrumentView);
      setEditing(saved.editing);
      restorePractice(saved.practice);
      changeTrack(saved.track);
      return;
    }
    tourSnapshot.current ??= {
      mixer: mixerOpen,
      inspector: inspectorOpen,
      inspectorTab,
      instrumentView,
      editing,
      track: trackIndex,
      practice,
    };
    leavePracticeView();
    if (message.mixer !== undefined) setMixerOpen(message.mixer);
    if (message.inspector !== undefined) setInspectorOpen(message.inspector);
    if (message.inspectorTab !== undefined) setInspectorTab(message.inspectorTab);
    if (message.instrumentView !== undefined) setInstrumentView(message.instrumentView);
    if (message.editing !== undefined) setEditing(message.editing);
    let shownTrack = trackIndex;
    if (message.track !== undefined) {
      const wanted =
        typeof message.track === "number"
          ? message.track
          : summary.tracks.findIndex((t) =>
              message.track === "drums" ? t.kind === "drums" : t.kind !== "drums",
            );
      if (wanted >= 0) {
        changeTrack(wanted);
        shownTrack = wanted;
      }
    }
    const settings = message.practice && {
      ...message.practice,
      // A loop must lie inside this song, which may be shorter than the tour assumes.
      loop:
        message.practice.loop === undefined || message.practice.loop === false
          ? message.practice.loop
          : normalizeRange(message.practice.loop, score.masterBars.length),
    };
    if (settings) {
      if (settings.trainer === "stop") dispatchPracticeAction({ type: "stop-trainer" });
      if (settings.speed !== undefined)
        dispatchPracticeAction({ type: "speed", value: settings.speed });
      if (settings.loop !== undefined) {
        dispatchPracticeAction(
          settings.loop
            ? { type: "loop", value: true, range: settings.loop }
            : { type: "loop", value: false, range: practice.range },
        );
      }
      if (settings.metronome !== undefined)
        dispatchPracticeAction({ type: "metronome", value: settings.metronome });
      if (settings.countIn !== undefined)
        dispatchPracticeAction({ type: "count-in", value: settings.countIn });
      if (settings.trainer && settings.trainer !== "stop") {
        dispatchPracticeAction({
          type: "start-trainer",
          trainer: settings.trainer,
          range: settings.loop || practice.range,
        });
      }
    }
    // One dialog at a time: asking for another closes the one that is open.
    if (message.dialog !== undefined) closeDialogs();
    if (message.dialog === "speed-trainer") setTrainerOpen(true);
    else if (message.dialog === "pedalboard") openPedalboard(shownTrack);
    else if (message.dialog === "master-pedalboard") openPedalboard(null);
    else if (message.dialog === "drum-mixer") {
      const drums = summary.tracks.findIndex((t) => t.kind === "drums");
      if (drums >= 0) setDrumMixer({ open: true, track: drums });
    } else if (message.dialog === "record") recording.open();
    if (message.play !== undefined && message.play !== playing) playerRef.current?.playPause();
  });
  useEffect(() => subscribeTourPanels((message) => onTourPanels(message)), []);

  const changeFocusCut = (db: number) => {
    setFocusCutDb(db);
    storeFocusCutDb(db);
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

  // --- Record to Tab (#108) ------------------------------------------------------------------

  const recordEnabled = isEnabled("record-2-tab");
  const recording = useRecordToTab({
    score,
    editor,
    player: () => playerRef.current,
    ready,
    practice: () => ({
      metronome: practice.metronome,
      countIn: practice.countIn,
      loop: practice.loop ? practice.range : null,
      speed: practice.speed,
    }),
    mix: () => mixRef.current,
    // Like a mixer change, but it is not a use of the mixer, and the mix is put back afterwards.
    setTrackStates: (states) => {
      let next = mixRef.current;
      for (const { track: index, mute, solo } of states) {
        next = mixerReducer(next, { type: "mute", track: index, value: mute });
        next = mixerReducer(next, { type: "solo", track: index, value: solo });
      }
      mixRef.current = next;
      trackStates(next).forEach((state, i) => {
        const t = score.tracks[i];
        if (t) stateByTrack.current.set(t, state);
      });
      setMix(next);
      playerRef.current?.setMix(next);
    },
    onOpenScore: (opened, name) => onOpenScore?.(opened, name),
  });
  const pianoModel = usePianoModel(recordEnabled && recording.dialogOpen);
  const recordBusy = recording.phase.kind !== "idle";

  // One-time tips the first time an advanced area is opened (#84).
  const tour = useTour();
  const showTip = useEffectEvent(tour.hint);
  useEffect(() => {
    if (!active) return;
    if (editing && !practiceView)
      showTip("editing", "editing", "New to editing? A short tour shows the tools.");
    if (trainerOpen)
      showTip(
        "speed-trainer",
        "speed-trainer",
        "First time with the Speed Trainer? A short tour explains it.",
      );
    if (pedalboard.open)
      showTip("effects", "effects", "First time with effects? A short tour shows where they live.");
    if (recording.dialogOpen)
      showTip(
        "record-to-tab",
        "record-to-tab",
        "First time recording to tab? A short tour explains it.",
      );
  }, [active, editing, practiceView, trainerOpen, pedalboard.open, recording.dialogOpen]);
  const [recordDrop, setRecordDrop] = useState<DroppedTake | null>(null);

  const playPause = () => {
    trackUsage(playing ? "pause" : "play");
    // Which sounds people actually listen with, not only which they picked.
    if (!playing) {
      trackUsage("play_soundfont", soundFontCounterId(getSoundFont(soundFont, soundFonts.fonts)));
    }
    playerRef.current?.playPause();
  };
  useSpaceToPlay(playPause, ready && active && !recordBusy);

  // --- Effects and the native audio engine -------------------------------------

  const changeAudioEngine = (kind: typeof audioEngine) => {
    storeAudioEnginePreference(kind);
    setEffectProblems({ tracks: [], master: [] });
    setAudioEngine(kind);
  };
  const openPedalboard = (track: number | "monitor" | null, focus?: EffectType) => {
    if (focus && typeof track === "number") {
      // The EQ button: the track gets an EQ if it has none (and there is room).
      const current = trackEffects(mixRef.current, track);
      const { chain, index } = withFocusBlock(current, focus, MAX_TRACK_EFFECTS);
      if (index >= 0 && chain.length !== current.length) {
        trackUsage("pedal_add", focus === "ampSim" ? "amp_sim" : focus);
        changeMix({ type: "effects", track, slots: chain });
      }
    }
    setPedalboard((p) => ({
      open: true,
      track,
      opened: track,
      focus,
      sound: 0,
      session: p.session + 1,
    }));
  };
  /** The track the pedalboard edits, or would edit when switched back from the master. */
  const pedalboardTrack = pedalboard.track ?? pedalboard.opened ?? trackIndex;
  const pedalboardTarget: PedalboardTarget =
    pedalboard.track === null
      ? { track: null, name: "Master", presetTarget: "master" }
      : pedalboard.track === "monitor"
        ? { track: "monitor", name: MONITOR_NAME, presetTarget: "guitar" }
        : {
            track: pedalboard.track,
            name: summary.tracks[pedalboard.track]?.name ?? "Track",
            presetTarget: presetTargetOf(summary.tracks[pedalboard.track] ?? track),
          };
  const drumKitEntries = useMemo(
    () => kitEntries(track.kind === "drums" ? ownDrumKit(trackObject) : []),
    // The kit changes with the track (and its articulations with edits).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackObject, track.kind, revision],
  );
  /** Applies a preset from the browser to what it was opened for (#42). */
  const applyPreset = (preset: Preset) => {
    trackUsage("sound_change");
    trackUsage("effect_pedal");
    const { track, sound } = presetBrowser;
    if (preset.kind === "drumMix") {
      if (typeof track !== "number") return;
      changeMix({ type: "drums", track, drums: drumsOf(preset) });
      changeMix({ type: "sound-effects", track, sound: 0, slots: chainOf(preset) });
    } else if (preset.target === "master" || track === null) {
      changeMix({ type: "master-effects", slots: chainOf(preset).slice(0, MAX_MASTER_EFFECTS) });
    } else if (track === "monitor") {
      changeMonitorEffects(chainOf(preset).slice(0, MAX_TRACK_EFFECTS));
    } else {
      changeMix({
        type: "sound-effects",
        track,
        sound,
        slots: chainOf(preset).slice(0, MAX_TRACK_EFFECTS),
      });
    }
    toast(`“${preset.name}” applied`);
  };

  /** A new effect chain for the monitor track. */
  const changeMonitorEffects = (effects: EffectSlot[]) => {
    const monitor = mixRef.current.monitor;
    if (monitor) changeMix({ type: "monitor", value: { ...monitor, effects } });
  };
  const pedalboardChain =
    pedalboard.track === null
      ? (mix.masterEffects ?? [])
      : pedalboard.track === "monitor"
        ? (mix.monitor?.effects ?? [])
        : soundEffects(mix, pedalboard.track, pedalboard.sound);
  const changePedalboardChain = (slots: EffectSlot[]) => {
    if (pedalboard.track === "monitor") {
      changeMonitorEffects(slots);
      return;
    }
    changeMix(
      pedalboard.track === null
        ? { type: "master-effects", slots }
        : { type: "sound-effects", track: pedalboard.track, sound: pedalboard.sound, slots },
    );
  };
  const pedalboardSounds: PedalboardSounds | undefined = (() => {
    const t = pedalboard.track;
    // The monitor track has one sound: it plays live, not along the song's bars.
    if (t === null || t === "monitor") return undefined;
    const own = trackSoundsOf(mix, t);
    const select = (sound: number) => setPedalboard((p) => ({ ...p, sound }));
    return {
      names: soundNames(mix, t),
      current: Math.min(pedalboard.sound, soundNames(mix, t).length - 1),
      switches: own?.switches ?? [],
      barCount: score.masterBars.length,
      onSelect: select,
      onAdd: () => {
        const sounds = addSound(mixRef.current, t, pedalboard.sound);
        changeMix({ type: "sounds", track: t, sounds });
        select(sounds.sounds.length - 1);
      },
      onRename: (sound, name) => {
        const current = trackSoundsOf(mixRef.current, t);
        if (!current) {
          // A single sound gets its name once there are two: keep it for then.
          const sounds = addSound(mixRef.current, t, 0);
          sounds.sounds[0] = { ...sounds.sounds[0]!, name };
          changeMix({
            type: "sounds",
            track: t,
            sounds: { ...sounds, sounds: [sounds.sounds[0]!] },
          });
          return;
        }
        changeMix({
          type: "sounds",
          track: t,
          sounds: {
            ...current,
            sounds: current.sounds.map((s, i) => (i === sound ? { ...s, name } : s)),
          },
        });
      },
      onRemove: (sound) => {
        changeMix({ type: "sounds", track: t, sounds: removeSound(mixRef.current, t, sound) });
        select(0);
      },
      onSwitchesChange: (switches) => {
        const current = trackSoundsOf(mixRef.current, t);
        if (current) changeMix({ type: "sounds", track: t, sounds: { ...current, switches } });
      },
    };
  })();

  // --- Audio track ---------------------------------------------------------------

  const occurrences = useMemo(() => {
    void revision;
    return playedBars ?? barOccurrences(score, null);
  }, [score, revision, playedBars]);
  const barTimes = useMemo(() => barTimeline(score, occurrences), [score, occurrences]);
  const audio = mix.audioTrack;
  const engineOn = audioEngine === "native";
  const audioKey = audio ? `${audio.name}\n${audio.path ?? ""}` : "";

  const newAudioTrack = (name: string, path: string): AudioTrackSettings => ({
    name,
    path,
    embedded: false,
    enabled: true,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    eq: { ...FLAT_EQ },
    semitones: 0,
    cents: 0,
    filter: "off",
    sync: [],
  });

  /** Loads the recording into the engine: from its file, or from the song file. */
  const loadRecording = async (settings: AudioTrackSettings) => {
    const player = playerRef.current;
    if (!player?.usesNativeEngine) return;
    const sources: BackingSource[] = [];
    if (settings.path) sources.push({ type: "file", path: settings.path });
    if (settings.embedded && song.path?.toLowerCase().endsWith(".gp")) {
      sources.push({ type: "embedded", scorePath: song.path, name: settings.name });
    }
    let lastError: unknown = new Error(`“${settings.name}” has no file to load.`);
    for (const source of sources) {
      try {
        const info = await player.loadBacking(source);
        loadedAudio.current = `${settings.name}\n${settings.path ?? ""}`;
        setBackingInfo(info);
        return;
      } catch (error) {
        lastError = error;
        if (!isCommandError(error) || error.kind !== "not-found") break;
      }
    }
    setBackingInfo(null);
    toast.error(`Couldn't open the recording “${settings.name}”`, {
      description: errorText(lastError),
    });
  };

  // Loads the recording when the song opens, the engine starts or the file changes.
  useEffect(() => {
    if (!audio || !engineOn || !ready) return;
    if (loadedAudio.current === audioKey) return;
    void loadRecording(audio);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioKey, engineOn, ready]);

  /** Opens a recording as the audio track (replacing the current one). */
  const addAudioTrack = async (path?: string) => {
    let file = path ?? null;
    if (!file) {
      try {
        file = await pickAudioFile();
      } catch (error) {
        toast.error("Couldn't show the Open dialog", { description: errorText(error) });
        return;
      }
    }
    if (!file) return;
    const name = file.split(/[\\/]/).pop() ?? file;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
      toast.error(`“${name}” is not an audio file Smart Beat opens`, {
        description: "Use an mp3, wav, flac, ogg or aiff file.",
      });
      return;
    }
    const settings = newAudioTrack(name, file);
    changeMix({ type: "audio-track", value: settings });
    setAudioEditorOpen(true);
    if (!engineOn) {
      toast.info("The audio track plays with the native audio engine", {
        action: nativeEngineAvailable()
          ? { label: "Enable effects playback", onClick: () => changeAudioEngine("native") }
          : undefined,
      });
      return;
    }
    await loadRecording(settings);
  };
  const removeAudioTrack = () => {
    changeMix({ type: "audio-track", value: null });
    loadedAudio.current = "";
    setBackingInfo(null);
    setAudioEditorOpen(false);
    void playerRef.current?.clearBacking();
  };
  const locateRecording = async () => {
    if (!audio) return;
    let file: string | null;
    try {
      file = await pickAudioFile();
    } catch (error) {
      toast.error("Couldn't show the Open dialog", { description: errorText(error) });
      return;
    }
    if (!file) return;
    const name = file.split(/[\\/]/).pop() ?? file;
    const next = { ...audio, name, path: file };
    changeMix({ type: "audio-track", value: next });
    await loadRecording(next);
  };
  /**
   * A file dropped on the window: a capture is always for the sound library; a
   * WAV is a cabinet while the library is open, and the song's audio track
   * otherwise.
   */
  const routeDroppedFile = (path: string) => {
    if (recordEnabled && recording.dialogOpen) {
      // Record to Tab is open: the file is the recording to turn into tab.
      void readDroppedAudio(path)
        .then((bytes) => {
          const file = new File([bytes], baseName(path));
          setRecordDrop((d) => ({ file, nonce: (d?.nonce ?? 0) + 1 }));
        })
        .catch((error: unknown) =>
          toast.error("Couldn't read the recording", { description: errorText(error) }),
        );
      return;
    }
    if (/\.nam$/i.test(path)) void library.importPath(path, "amp");
    else if (libraryOpen && /\.wav$/i.test(path)) void library.importPath(path, "cab");
    else void addAudioTrack(path);
  };
  const lastDrop = useRef<number | null>(null);
  useEffect(() => {
    if (!droppedAudio || droppedAudio.nonce === lastDrop.current) return;
    lastDrop.current = droppedAudio.nonce;
    routeDroppedFile(droppedAudio.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedAudio]);

  // --- Monitor track ---------------------------------------------------------------

  useEffect(() => {
    playerRef.current?.setMonitorInput({ device: monitorDevice, channel: inputChannel });
  }, [monitorDevice, inputChannel]);
  // The next song's new monitor track starts from this one (level, EQ and effects).
  useEffect(() => {
    if (mix.monitor) rememberMonitorTrack(mix.monitor);
  }, [mix.monitor]);

  /** Adds the monitor track: the audio input, played live. */
  const addMonitorTrack = () => {
    changeMix({ type: "monitor", value: newMonitorTrack() });
    toast.info("The monitor track plays your audio input live", {
      description:
        "Use headphones if the input is a microphone, or the speakers can feed back into it. Choose the input in Settings.",
    });
  };
  const removeMonitorTrack = () => {
    changeMix({ type: "monitor", value: null });
    setPedalboard((p) => (p.track === "monitor" ? { ...p, open: false } : p));
  };

  const toggleInstrumentView = () => {
    // In Practice View the switch ends it and shows the view.
    if (practiceView) {
      leavePracticeView();
      if (instrumentView) return;
    }
    if (!instrumentView) trackUsage(track.kind === "stringed" ? "fretboard_view" : "piano_view");
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
    if (selection) {
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
    onDuplicate: (index) => {
      trackUsage("track_duplicate");
      changeTracks("Duplicate track", () => duplicateTrack(score, index));
    },
    onRemove: (index) => {
      const name = summary.tracks[index]?.name ?? "the track";
      changeTracks("Remove track", () => removeTrack(score, index));
      trackUsage("track_delete");
      toast(`Removed “${name}”`, { action: { label: "Undo", onClick: () => editor.undo() } });
    },
    onSettings: (index) => {
      setTrackDialog({ mode: "edit", track: score.tracks[index]! });
    },
    onLyrics: (index) => {
      openLyrics(score.tracks[index]);
    },
    onAdd: () => {
      setTrackDialog({ mode: "add" });
    },
    onEffects: (index) => openPedalboard(index),
    onDrumMixer: (index) => setDrumMixer({ open: true, track: index }),
    onCopyToInstrument: (index) => setCopyTrack(score.tracks[index] ?? null),
    onNormalizeDrums: (index) => normalizeDrums(index),
  };

  /** Re-maps a drum track onto the standard lanes: one undo step, then edit mode (nothing is saved). */
  function normalizeDrums(index: number) {
    const target = score.tracks[index];
    if (!target || !canNormalizeDrums(target)) return;
    trackUsage("drum_normalize");
    editor.run(
      "Normalize drum notation",
      () => [...trackContent(target)],
      () => {
        normalizeDrumNotation(target);
      },
    );
    toggleEditingOn();
    toast("Drum notation normalized", {
      action: { label: "Undo", onClick: () => editor.undo() },
    });
  }

  function copyToInstrument(preset: InstrumentPreset) {
    const source = copyTrack;
    if (!source) return;
    let result: ConversionResult | null = null;
    changeTracks(
      "Copy track to instrument",
      () => {
        result = convertTrackToInstrument(score, score.tracks.indexOf(source), preset);
        if (!result) throw new Error("Drum tracks cannot be copied to another instrument.");
        editor.placeCursorOnTrack(score.tracks.indexOf(result.track));
      },
      false,
    );
    const done = result as ConversionResult | null;
    if (done) trackUsage("copy_to_instrument", preset.id);
    if (done && (done.shifted > 0 || done.dropped > 0)) {
      toast(
        `${done.shifted} ${done.shifted === 1 ? "note was" : "notes were"} moved an octave to fit ${preset.name}` +
          (done.dropped > 0 ? `; ${done.dropped} could not be placed` : ""),
      );
    }
  }

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
    trackUsage("track_add");
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

  // --- Print ----------------------------------------------------------------

  /** Prints the score: in the page layout, which is switched to for the time it takes. */
  /**
   * Prints the chosen tracks, or with `pdfPath` saves them as a PDF there without the print
   * dialog (macOS app; #83). Either way the score is laid out for paper first and put back after.
   */
  const submitPrint = (settings: PrintSettings, tracks: PrintTracks, pdfPath?: string) => {
    setPrintSettings(settings);
    storePrintSettings(settings);
    const player = playerRef.current;
    if (!player) return;
    // The chosen tracks, in page layout at the print size; back to the screen view afterwards.
    const restore = player.showForPrint(tracks, settings.scale);
    let restored = false;
    const back = () => {
      if (restored) return;
      restored = true;
      restore();
    };
    if (!pdfPath) window.addEventListener("afterprint", back, { once: true });
    const what = pdfPath ? "Couldn't export the PDF" : "Couldn't print";
    const toastId = pdfPath ? toast.loading("Exporting the PDF…") : undefined;
    afterRender.current = async () => {
      const surface = surfaceRef.current;
      let cleanup: (() => void) | null = null;
      const failed = (error: unknown) => {
        toast.error(what, {
          id: toastId,
          description:
            pdfPath || !pdfSupported
              ? errorText(error)
              : `${errorText(error)} Try Export as PDF in the print settings instead.`,
        });
        back();
      };
      const exportFile = () =>
        writePdfFile(pdfPath!, pdfPage(settings)).then(() => {
          cleanup?.();
          back();
          toast.success(`Exported “${baseName(pdfPath!)}”`, {
            id: toastId,
            description: pdfPath,
          });
        });
      try {
        // The parts of the score arrive a moment after the render.
        cleanup =
          surface && (await whenDrawn(surface))
            ? printScore(surface, settings, pdfPath ? exportFile : undefined, failed)
            : null;
        if (!cleanup) {
          toast.error("There is nothing to print yet", { id: toastId });
          back();
        }
      } catch (error) {
        failed(error);
      }
    };
  };

  /** Asks where to save the PDF, then exports it (#83). */
  const exportPdf = async (settings: PrintSettings, tracks: PrintTracks) => {
    try {
      const dir = song.path?.match(/^(.*[\\/])/)?.[1] ?? "";
      const stem = song.name.replace(/\.[^.]+$/, "");
      let path = await pickSavePath(
        `${dir}${stem}.pdf`,
        [{ name: "PDF", extensions: ["pdf"] }],
        "Export as PDF",
      );
      if (!path) return;
      if (!path.toLowerCase().endsWith(".pdf")) path = `${path}.pdf`;
      submitPrint(settings, tracks, path);
    } catch (error) {
      toast.error("Couldn't export the PDF", { description: errorText(error) });
    }
  };

  // Ctrl/⌘+P prints the shown song.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPrintOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // --- Tempo ------------------------------------------------------------------

  const tempoInitial = (): TempoInitial => {
    const [start, end] = editor.selection
      ? selectionRange(editor.selection)
      : [{ bar: cursorBar }, { bar: cursorBar }];
    return {
      bpm: tempoAt(score, start.bar),
      barCount: score.masterBars.length,
      bar: start.bar + 1,
      endBar: end.bar + 1,
      beats: score.masterBars[cursorBar]?.timeSignatureNumerator ?? 4,
      speed: practice.speed,
    };
  };

  const submitTempo = (request: TempoRequest) => {
    trackUsage("tempo_change");
    const range = tempoScope(score, request);
    const what =
      request.scope === "song"
        ? "Change the song tempo"
        : request.scope === "from"
          ? "Change the tempo"
          : "Change the tempo of some bars";
    editor.editBars(
      what,
      range,
      () => applyTempo(score, request),
      `Tempo ${request.bpm} BPM ${
        request.scope === "song"
          ? "for the song"
          : request.scope === "from"
            ? `from bar ${request.bar + 1}`
            : `for bars ${request.from + 1} to ${request.to + 1}`
      }`,
    );
  };

  const goToBar = (bar: number) => {
    editor.setCursorTo({ bar, beat: 0, voice: 0 });
    playerRef.current?.seekToBar(bar);
    focusScore();
  };

  /** The bars the Shift-selected range covers, or null. */
  const selectedBars = (): LoopRange | null => {
    const selection = editor.selection;
    if (!selection) return null;
    const [start, end] = selectionRange(selection);
    return { start: start.bar, end: end.bar };
  };

  /** The score's right-click menu (#83). */
  const loopBars = (start: number, end: number) =>
    dispatchPractice({ type: "loop", value: true, range: { start, end } });
  const scoreMenuActions: ScoreMenuActions = {
    onPlayFrom: (at) => {
      editor.setCursorTo({ bar: at, beat: 0, voice: 0 });
      playerRef.current?.seekToBar(at);
      if (!playing && ready) playPause();
    },
    onLoopBar: (at) => loopBars(at, at),
    onLoopStart: (at) =>
      practice.loop ? loopBars(at, Math.max(at, practice.range.end)) : loopBars(at, at),
    onLoopEnd: (at) =>
      practice.loop ? loopBars(Math.min(practice.range.start, at), at) : loopBars(at, at),
    onPracticeSection: (section) => loopBars(section.start, section.end),
    onTrainer: (range) => {
      setTrainerRange(range);
      setTrainerOpen(true);
    },
    onCopy: () => editor.copy(),
    onCut: () => editor.cut(),
    onDelete: () => {
      trackUsage("delete_selection");
      editor.deleteAtCursor();
    },
    onLoopSelection: () => {
      const range = selectedBars();
      if (!range) return;
      trackUsage("loop_selection");
      loopBars(range.start, range.end);
    },
    onPracticeSelection: () => {
      const range = selectedBars();
      if (!range) return;
      trackUsage("practise_selection");
      setTrainerRange(range);
      setTrainerOpen(true);
    },
    onPlaySelection: () => {
      const range = selectedBars();
      if (!range) return;
      trackUsage("play_selection");
      playerRef.current?.seekToBar(range.start);
      if (!playing && ready) playPause();
    },
  };

  // --- Menu -------------------------------------------------------------------

  useMenuActions((action) => {
    if (!active) return; // the shown song's workspace handles the menu
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
      case "toggle-mixer":
        toggleMixer();
        break;
      case "toggle-inspector":
        toggleInspector();
        break;
      case "toggle-practice-view":
        togglePracticeView();
        break;
      case "add-track":
        setTrackDialog({ mode: "add" });
        break;
      case "add-audio-track":
        void addAudioTrack();
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
      case "export-all":
        setExportOpen(true);
        break;
      case "export-gp":
        void fileActions.exportAs("gp");
        break;
      case "export-gp5":
        void fileActions.exportAs("gp5");
        break;
      case "export-gp4":
        void fileActions.exportAs("gp4");
        break;
      case "export-gp3":
        void fileActions.exportAs("gp3");
        break;
      case "export-musicxml":
        void fileActions.exportAs("musicxml");
        break;
      case "export-midi":
        void fileActions.exportAs("midi");
        break;
      case "export-alphatex":
        void fileActions.exportAs("atex");
        break;
      case "export-ascii-tab":
        void fileActions.exportAs("ascii-tab");
        break;
      case "export-audio":
        void fileActions.exportAudio();
        break;
      case "export-audio-m4a":
        void fileActions.exportAudio("m4a");
        break;
      case "export-pdf":
        void exportPdf(printSettings, [trackIndex]);
        break;
      case "print":
        setPrintOpen(true);
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

  useMenuState(
    {
      songOpen: true,
      undo: editor.undoLabel,
      redo: editor.redoLabel,
      canRemoveTrack: score.tracks.length > 1,
      editMode: editing,
      fretboard: showInstrumentView,
      mixer: showMixer,
      inspector: showInspector,
      practiceView: !!practiceView,
      loop: practice.loop,
      metronome: practice.metronome,
      countIn: practice.countIn,
      repeatStart: score.masterBars[cursorBar]?.isRepeatStart ?? false,
      repeatEnd: (score.masterBars[cursorBar]?.repeatCount ?? 0) > 0,
      hasNote: effects.note !== null,
      noteEffects: noteEffectFlags(effects),
    },
    active,
  );

  const editActions: EditActions = {
    onDuration: (d) => editor.setDuration(d),
    onDots: (dots) => editor.toggleDots(dots),
    onTuplet: (t) => editor.setTuplet(t),
    onRest: () => editor.clearNotes(),
    onFillRests: () => editor.fillWithRests(),
    onTie: () => editor.toggleTie(),
    onInsertBeat: () => editor.insertBeat(),
    onDeleteBeat: () => editor.deleteBeats(),
    onVoice: (v) => editor.switchVoice(v),
    onBar: openBarDialog,
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

  const problemBars = new Set(problems.map((p) => p.bar)).size;
  // The red Record to Tab button sits after the undo and redo buttons, next to the transport.
  const recordButton =
    recordEnabled && !recordBusy ? (
      <Tip label="Record to Tab…">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Record to Tab"
          data-record-button=""
          data-tour="record"
          onClick={() => recording.open()}
        >
          <CircleIcon className="fill-red-500 text-red-500" aria-hidden="true" />
        </Button>
      </Tip>
    ) : null;
  const fileActionsMenu = (
    <>
      <FileMenu
        onImportAudio={onImportAudio}
        onRecordToTab={recordEnabled && !recordBusy ? () => recording.open() : undefined}
        onSave={() => void fileActions.save()}
        onSaveAs={() => void fileActions.saveAs()}
        onExport={(format) => void fileActions.exportAs(format)}
        onExportAudio={() => void fileActions.exportAudio()}
        onExportM4a={m4aSupported ? () => void fileActions.exportAudio("m4a") : undefined}
        onExportAll={() => setExportOpen(true)}
        onPrint={() => setPrintOpen(true)}
        encoding={
          song.encoding && onReopenWithEncoding
            ? {
                current: song.encoding,
                choice: song.encodingChoice ?? "auto",
                edited: editor.edited,
                onChange: onReopenWithEncoding,
              }
            : undefined
        }
      />
      <ToolsMenu
        onTranspose={() => setTransposeOpen(true)}
        onFixBars={() => fixBars()}
        onTempo={() => setTempoOpen(true)}
      />
    </>
  );

  return (
    <div
      role="group"
      aria-label={summary.title || song.name}
      inert={!active}
      aria-hidden={active ? undefined : true}
      // Hidden songs keep their size (alphaTab measures its container), just not their looks.
      className={cn(
        "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto bg-background",
        !active && "pointer-events-none invisible",
      )}
    >
      <WorkspaceToolbar
        title={summary.title || song.name}
        summary={summary}
        trackIndex={trackIndex}
        onTrackChange={changeTrack}
        view={view}
        onViewChange={changeView}
        layout={layout}
        onLayoutChange={changeLayout}
        zoom={zoom}
        onZoomChange={changeZoom}
        onOpen={onOpen}
        actions={fileActionsMenu}
        record={recordButton}
        editing={editing}
        onToggleEditing={toggleEditing}
        edited={editor.edited}
        undoLabel={editor.undoLabel}
        redoLabel={editor.redoLabel}
        onUndo={() => {
          editor.undo();
          if (editing) focusScore();
        }}
        onRedo={() => {
          editor.redo();
          if (editing) focusScore();
        }}
        ready={ready}
        playing={playing}
        position={position}
        bar={bar}
        barCount={score.masterBars.length}
        onPlayPause={playPause}
        onStop={() => {
          trackUsage("stop");
          if (playerRef.current?.stop()) trackUsage("restart_on_stop_used");
        }}
        onTempo={() => setTempoOpen(true)}
        tempo={{ songBpm: tempoAt(score, bar), speed: practice.speed }}
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
            onRestartOnStopChange={(value) => dispatchPractice({ type: "restart-on-stop", value })}
            onOpenTrainer={() => setTrainerOpen(true)}
            onStopTrainer={() => dispatchPractice({ type: "stop-trainer" })}
            onHoldTrainer={(value) => dispatchPractice({ type: "hold-trainer", value })}
            sections={sections}
          />
        }
        instrumentView={showInstrumentView}
        instrumentLabel={instrumentViewName(track.kind)}
        onToggleInstrumentView={toggleInstrumentView}
        inspectorOpen={showInspector}
        onToggleInspector={toggleInspector}
        mixerOpen={showMixer}
        headerSlot={headerSlot}
        active={active}
        onToggleMixer={toggleMixer}
        practiceView={!!practiceView}
        onTogglePracticeView={togglePracticeView}
        practiceMix={
          <PracticeMix
            tracks={summary.tracks}
            shown={trackIndex}
            mix={mix}
            onChange={changeMix}
            cutDb={focusCutDb}
            onCutChange={changeFocusCut}
            monitor={
              isTauri()
                ? {
                    inputName: audioInput?.label ?? "System default",
                    channel: inputChannel,
                    message: mix.monitor?.enabled
                      ? !engineOn
                        ? "Enable Native engine with effects to hear your input."
                        : (monitorStatus?.error ?? undefined)
                      : undefined,
                    onToggle: (enabled) => {
                      changeMix({
                        type: "monitor",
                        value: { ...(mixRef.current.monitor ?? newMonitorTrack()), enabled },
                      });
                    },
                    onEffects: () => openPedalboard("monitor"),
                    onInputSettings: onOpenSettings,
                  }
                : undefined
            }
          />
        }
      />
      {tabs}
      <BarProblems problems={problems} onFix={() => fixBars()} onGoTo={goToBar} />
      {/* Palette | score | inspector; below 1024 px the palette stacks above the score. */}
      <div className="relative flex min-h-72 flex-1 max-lg:flex-col">
        <NotePalette editing={editing}>
          <EditToolbar
            beat={editor.beatInfo}
            voice={editor.cursor.voice}
            dots={(count) => editor.beatsState((b) => b.dots === count)}
            tie={editor.beatsState((b) => b.notes.some((n) => n.isTieDestination))}
            status={editor.describeCursor()}
            message={editor.message}
            actions={editActions}
            statusId={statusId}
            auditionNotes={auditionNotes}
            onAuditionNotesChange={(on) => {
              setAuditionNotes(on);
              storeAuditionNotes(on);
            }}
          />
          <EffectsToolbar
            effects={effects}
            state={paletteState}
            kind={track.kind}
            actions={effectActions}
          />
        </NotePalette>
        {/* Scrolls as a whole when the window is too short for all of it. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <ScoreContextMenu
            barAt={(x, y) => {
              const rect = surfaceRef.current?.getBoundingClientRect();
              return rect ? (playerRef.current?.barAt(x - rect.left, y - rect.top) ?? null) : null;
            }}
            sections={sections}
            actions={scoreMenuActions}
            selection={selectedBars()}
            editing={editing}
          >
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
          </ScoreContextMenu>
          {showInstrumentView && (
            <InstrumentPanel
              kind={track.kind}
              tuning={track.tuning}
              capo={track.capo}
              active={shownNotes}
              editing={editing}
              cursorString={track.kind === "stringed" ? editor.cursor.string : null}
              drumSounds={shownNotes.map((n) => n.pitch)}
              onPlayString={(pitch) => playerRef.current?.previewNote(pitch, track.program)}
              onOpenTuner={() => {
                trackUsage("tuner");
                setTunerOpen(true);
              }}
              onOpenRecord={
                recordEnabled && !recordBusy ? () => recording.open(trackIndex) : undefined
              }
              onFret={(string, fret) => {
                editor.setString(string);
                editor.setFret(fret - track.capo);
                if (editing) focusScore();
              }}
              onFretDelete={(string) => {
                editor.setString(string);
                editor.removeCursorNote();
                if (editing) focusScore();
              }}
              onPitch={(pitch) => {
                editor.enterPitch(pitch);
                if (editing) focusScore();
              }}
              onDrum={(sound) => {
                editor.enterDrum(sound);
                if (editing) focusScore();
              }}
              drumKit={drumKitEntries}
              cursorDrum={editing ? editor.cursor.pitch : null}
              onReplaceDrum={(sound) => {
                editor.replaceDrum(sound);
                focusScore();
              }}
              onPreviewDrum={(sound) => playerRef.current?.previewDrum(sound)}
              scale={scale}
              defaultScaleRoot={keyTonic(keyBar?.keySignature ?? 0, keyBar?.keySignatureType ?? 0)}
              scalePickerRef={scalePickerRef}
              onScaleChange={setScale}
            />
          )}
          {showLyrics && <LyricsStrip lines={lyricLines} current={lyricBeat} />}
        </div>
        {showInspector && (
          <aside
            aria-label="Inspector"
            className="flex min-h-0 w-72 shrink-0 flex-col border-l bg-sidebar text-sidebar-foreground max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:shadow-xl"
          >
            <h2 className="sr-only">Inspector</h2>
            {/* In narrow windows the inspector covers the score: it can be closed from here too. */}
            <Button
              variant="ghost"
              size="xs"
              className="self-end lg:hidden"
              onClick={toggleInspector}
            >
              <XIcon data-icon="inline-start" />
              Close inspector
            </Button>
            <Inspector
              tab={inspectorTab}
              onTabChange={setInspectorTab}
              song={{
                title: summary.title,
                artist: summary.artist,
                file: song.name,
                bars: score.masterBars.length,
                tempo: tempoAt(score, bar),
                problems: problemBars,
              }}
              track={track}
              view={view}
              onViewChange={changeView}
              mix={mix.tracks[trackIndex]}
              color={mix.trackColors?.[trackIndex]}
              soundFont={soundFont}
              onSoundFontChange={changeSoundFont}
              soundFonts={soundFonts.fonts}
              onManageSoundFonts={() => {
                setSoundFontsOpen(true);
                void soundFonts.refresh(); // another song may have added or removed one
              }}
              soundsReady={ready}
              syncOffset={syncOffset}
              onSyncOffsetChange={(ms) => {
                storeSyncOffset(ms);
                setSyncOffset(readSyncOffset());
              }}
              actions={{
                onTrackSettings: () => setTrackDialog({ mode: "edit", track: trackObject }),
                onLyrics: () => openLyrics(trackObject),
                onTranspose: () => setTransposeOpen(true),
                onFixBars: () => fixBars(),
                onTempo: () => setTempoOpen(true),
                onEditEffects: () => openPedalboard(trackIndex),
                onDrumMixer: () => setDrumMixer({ open: true, track: trackIndex }),
                onNormalizeDrums: () => normalizeDrums(trackIndex),
                onCopyToInstrument: () => setCopyTrack(trackObject),
              }}
              audioEngine={audioEngine}
              onAudioEngineChange={nativeEngineAvailable() ? changeAudioEngine : undefined}
              effects={trackEffects(mix, trackIndex)}
              effectProblems={effectProblems.tracks[trackIndex]?.flat().length ?? 0}
              onEffectsChange={(slots) => changeMix({ type: "effects", track: trackIndex, slots })}
              interpretation={trackInterpretation(mix, trackIndex)}
              onInterpretationChange={(value) =>
                changeMix({ type: "interpretation", track: trackIndex, value })
              }
              drumKit={{
                kits: drumKits.kits,
                current: mix.drumKits?.[trackIndex] ?? null,
                available: drumKits.available,
                onManage: () => setKitsOpen(true),
                onChange: (kit) => {
                  changeMix({ type: "drum-kit", track: trackIndex, kit });
                  if (kit && audioEngine !== "native" && nativeEngineAvailable()) {
                    toast("Imported kits play with the native engine", {
                      action: {
                        label: "Enable effects playback",
                        onClick: () => changeAudioEngine("native"),
                      },
                    });
                  }
                },
              }}
            />
          </aside>
        )}
      </div>
      {showMixer && (
        <TrackList
          score={score}
          soundFont={soundFont}
          revision={revision}
          tracks={summary.tracks}
          shown={trackIndex}
          mix={mix}
          onChange={changeMix}
          onReset={resetMix}
          actions={trackActions}
          bar={bar}
          onSeekBar={(index) => playerRef.current?.seekToBar(index)}
          saved={saved}
          playing={playing}
          onMasterEffects={() => openPedalboard(null)}
          audio={
            isTauri()
              ? {
                  info: backingInfo,
                  barTimes,
                  onAdd: () => void addAudioTrack(),
                  onEdit: () => setAudioEditorOpen((open) => !open),
                }
              : undefined
          }
          monitor={
            isTauri()
              ? {
                  status: monitorStatus,
                  engineOn,
                  inputName: audioInput?.label ?? "System default",
                  channel: inputChannel,
                  onAdd: addMonitorTrack,
                  onRemove: removeMonitorTrack,
                  onEffects: () => openPedalboard("monitor"),
                  onInputSettings: onOpenSettings,
                }
              : undefined
          }
        />
      )}
      {showMixer && audio && audioEditorOpen && (
        <AudioTrackPanel
          audio={audio}
          info={backingInfo}
          barTimes={barTimes}
          barWidth={audioZoom}
          onBarWidthChange={setAudioZoom}
          onChange={(value) => changeMix({ type: "audio-track", value })}
          onRemove={removeAudioTrack}
          onLocate={() => void locateRecording()}
          onImportTempo={() =>
            changeMix({
              type: "audio-track",
              value: { ...audio, sync: syncPointsFromTempo(score, audio.sync, barTimes) },
            })
          }
          onClose={() => setAudioEditorOpen(false)}
          canEmbed={isTauri()}
        />
      )}
      {recordEnabled && (
        <>
          <RecordDialog
            open={recording.dialogOpen}
            onOpenChange={(open) => (open ? recording.open() : recording.close())}
            targets={recordTargets(summary.tracks)}
            defaultTrack={recording.dialogTrack ?? trackIndex}
            defaultBar={editor.cursor.bar}
            barCount={score.masterBars.length}
            supported={isTauri()}
            onRecord={recording.start}
            onRecordFile={recording.fromFile}
            droppedFile={recordDrop}
            pianoModel={pianoModel}
          />
          <RecordBar
            phase={recording.phase}
            level={recording.level}
            onStop={recording.stop}
            onCancel={recording.cancel}
          />
        </>
      )}
      {track.kind === "stringed" && (
        <TunerDialog
          open={tunerOpen}
          onOpenChange={setTunerOpen}
          trackName={track.name}
          tuning={track.tuning}
          onPlay={(pitch) => playerRef.current?.previewNote(pitch, track.program)}
          onOpenSettings={onOpenSettings}
        />
      )}
      <PedalboardDialog
        key={pedalboard.session}
        open={pedalboard.open}
        onOpenChange={(open) => setPedalboard((p) => ({ ...p, open }))}
        target={pedalboardTarget}
        chain={pedalboardChain}
        onChange={changePedalboardChain}
        onBrowsePresets={() =>
          setPresetBrowser({
            open: true,
            target: pedalboardTarget.presetTarget,
            track: pedalboard.track,
            sound: pedalboard.sound,
            targets:
              pedalboard.track === null
                ? ["master"]
                : ([pedalboardTarget.presetTarget, "master"].filter(
                    (t, i, all) => all.indexOf(t) === i,
                  ) as PresetTarget[]),
          })
        }
        problems={
          audioEngine !== "native"
            ? []
            : pedalboard.track === null
              ? effectProblems.master
              : pedalboard.track === "monitor"
                ? (effectProblems.monitor ?? [])
                : (effectProblems.tracks[pedalboard.track]?.[pedalboard.sound] ?? [])
        }
        trackName={
          pedalboardTrack === "monitor"
            ? MONITOR_NAME
            : (summary.tracks[pedalboardTrack]?.name ?? track.name)
        }
        onTargetChange={(mastering) =>
          setPedalboard((p) => ({
            ...p,
            track: mastering ? null : (p.opened ?? trackIndex),
            sound: 0,
          }))
        }
        sounds={pedalboardSounds}
        songPresets={mix.presets}
        onSongPresetsChange={(presets) => changeMix({ type: "presets", presets })}
        library={library.items}
        onImport={(kind) => void library.importFile(kind)}
        onManageLibrary={() => setLibraryOpen(true)}
        engineOn={audioEngine === "native"}
        onEnableEngine={nativeEngineAvailable() ? () => changeAudioEngine("native") : undefined}
        focusType={pedalboard.focus}
      />
      <DrumMixerDialog
        open={drumMixer.open}
        onOpenChange={(open) => setDrumMixer((d) => ({ ...d, open }))}
        trackIndex={drumMixer.track}
        trackName={summary.tracks[drumMixer.track]?.name ?? "Drums"}
        mixer={mix.drums?.[drumMixer.track] ?? null}
        onChange={(drums) => changeMix({ type: "drums", track: drumMixer.track, drums })}
        engineOn={engineOn}
        onEnableEngine={nativeEngineAvailable() ? () => changeAudioEngine("native") : undefined}
        busChain={soundEffects(mix, drumMixer.track, 0)}
        onBrowsePresets={() =>
          setPresetBrowser({
            open: true,
            target: "drums",
            track: drumMixer.track,
            sound: 0,
            targets: ["drums"],
          })
        }
        onBusChainChange={(slots) =>
          changeMix({ type: "sound-effects", track: drumMixer.track, sound: 0, slots })
        }
      />
      <DrumKitDialog
        open={kitsOpen}
        onOpenChange={setKitsOpen}
        kits={drumKits.kits}
        available={drumKits.available}
        onPick={drumKits.pick}
        onImport={drumKits.importFrom}
        onRemove={(id) => {
          // Tracks playing the kit go back to the built-in sounds.
          for (const [i, kit] of (mix.drumKits ?? []).entries()) {
            if (kit === id) changeMix({ type: "drum-kit", track: i, kit: null });
          }
          void drumKits.remove(id);
        }}
      />
      <SoundFontsDialog
        open={soundFontsOpen}
        onOpenChange={setSoundFontsOpen}
        fonts={soundFonts.fonts}
        stored={soundFonts.stored}
        catalogue={soundFonts.catalogue}
        available={soundFonts.available}
        activeId={soundFont}
        onPick={soundFonts.pick}
        onImport={soundFonts.importFrom}
        onDownload={soundFonts.download}
        onCancelDownload={soundFonts.cancelDownload}
        onRemove={async (id) => {
          // Playing with it: go back to the standard sounds before the file is deleted.
          if (soundFont === storedSoundFontId(id)) changeSoundFont(DEFAULT_SOUNDFONT);
          return soundFonts.remove(id);
        }}
      />
      <PresetBrowserDialog
        open={presetBrowser.open}
        onOpenChange={(open) => setPresetBrowser((b) => ({ ...b, open }))}
        target={presetBrowser.target}
        targets={presetBrowser.targets}
        onApply={applyPreset}
      />
      <SoundLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        items={library.items}
        onImport={(kind) => void library.importFile(kind)}
        onRename={(id, name, tags) => void library.rename(id, name, tags)}
        onRemove={(id) => void library.remove(id)}
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
        soundFont={soundFont}
        onSubmit={submitTrack}
        onCloseAutoFocus={returnFocusToScore}
      />
      <CopyInstrumentDialog
        open={copyTrack !== null}
        onOpenChange={(open) => !open && setCopyTrack(null)}
        trackName={copyTrack?.name ?? ""}
        onSubmit={copyToInstrument}
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
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        groups={exportGroups({ m4a: m4aSupported, pdf: true })}
        onChoose={({ target }) => {
          if (target.kind === "format") void fileActions.exportAs(target.format);
          else if (target.kind === "audio") void fileActions.exportAudio(target.audio);
          else setPrintOpen(true);
        }}
        onCloseAutoFocus={returnFocusToScore}
      />
      <PrintDialog
        open={printOpen}
        onOpenChange={setPrintOpen}
        initial={printSettings}
        trackNames={summary.tracks.map((t) => t.name)}
        shownTrack={trackIndex}
        onSubmit={(settings, tracks) => submitPrint(settings, tracks)}
        onExportPdf={
          pdfSupported ? (settings, tracks) => void exportPdf(settings, tracks) : undefined
        }
        onCloseAutoFocus={returnFocusToScore}
      />
      <TempoDialog
        open={tempoOpen}
        onOpenChange={setTempoOpen}
        initial={tempoInitial()}
        onSubmit={submitTempo}
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
        onOpenChange={(open) => {
          setTrainerOpen(open);
          if (!open) setTrainerRange(null);
        }}
        barCount={score.masterBars.length}
        initialRange={trainerRange ?? suggestedRange()}
        sections={sections}
        countInBetweenAvailable={audioEngine === "native"}
        onCloseAutoFocus={returnFocusToScore}
        onStart={(trainer, trainerRange) => {
          dispatchPractice({ type: "start-trainer", trainer, range: trainerRange });
          if (!playing && ready) playPause();
        }}
      />
    </div>
  );
}
