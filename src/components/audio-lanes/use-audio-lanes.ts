import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  freshGroups,
  groupClips,
  groupLeaders,
  moveClipGroup,
  pruneGroups,
  regroupCopies,
  ungroupClips,
  withGroup,
} from "@/lib/audio-lanes/clip-groups";
import {
  addClip,
  addLane,
  addSource,
  duplicateClips,
  findClip,
  glueClips,
  pasteClips,
  removeClips,
  splitClip,
} from "@/lib/audio-lanes/edits";
import {
  MAX_LANES,
  activeTake,
  lanesOf,
  clipEndMs,
  newClip,
  newLane,
} from "@/lib/audio-lanes/model";
import {
  clipLaneIds,
  insertSpaceAtRange,
  normalizeRange,
  removeRangeClosingGap,
  splitAtRangeEdges,
  trimToRange,
  type TimeRange,
} from "@/lib/audio-lanes/range-edits";
import { snapMs, type SongGrid } from "@/lib/audio-lanes/sync";
import { trimToLine } from "@/lib/audio-lanes/trim-line";
import { errorText } from "@/lib/errors";
import type { MixerAction } from "@/lib/score/mixer";
import {
  AUDIO_EXTENSIONS,
  audioZeroCrossing,
  isCommandError,
  loadAudioSource,
  pickAudioFile,
  type AudioClip,
  type AudioLanesSettings,
  type AudioSource,
  type MixerSettings,
  type SourceInfo,
  type SourceLocation,
} from "@/lib/tauri";

/** How many lane edits undo remembers. */
const HISTORY = 100;

/** Snap for moving and trimming clips. */
export type SnapMode = "bar" | "beat" | "off";

/** Opens an audio file: decodes it and returns its description (waveform peaks included). */
export type SourceLoader = (location: SourceLocation) => Promise<SourceInfo>;

/**
 * Whether the lanes can be heard. Lanes are decoded and edited with any engine, but only the
 * native audio engine plays them; with the SoundFonts the lanes are silent.
 */
export interface LanePlayback {
  /** The native audio engine makes the sound. */
  engineOn: boolean;
  /** Switches to the native audio engine (undefined: it cannot be used here). */
  enable?: () => void;
}

export interface AudioLanesOptions {
  mix: MixerSettings;
  changeMix: (action: MixerAction) => void;
  /**
   * Opens a file (default: the file-level command, which needs no audio engine). The workspace
   * passes the native engine's loader while it runs, so the engine also learns where the file
   * came from.
   */
  loadSource?: SourceLoader;
  /**
   * Bumped when a new native engine is made, so files load again into it (null: no native
   * engine, files are loaded once).
   */
  epoch?: number | null;
  /** The song file, for files embedded in it (`.gp` only). */
  songPath: string | null;
  grid: SongGrid;
  /** Whether the lanes are heard (see {@link LanePlayback}); shown next to the lanes. */
  playback?: LanePlayback;
  /** The user moved the edit cursor (a click in a lane): the score can follow it there. */
  onCursorMove?: (ms: number) => void;
  /**
   * Where the position line is now, on the audio timeline (the playhead while playing): Split and
   * Paste act there. Without it they act at the edit cursor.
   */
  positionMs?: () => number | null;
  /** The time selection changed (null: cleared): the score loops the bars it covers. */
  onTimeRangeChange?: (range: TimeRange | null) => void;
}

/** What {@link useAudioLanes} assumes when the host says nothing: no notice is shown. */
const NO_NOTICE: LanePlayback = { engineOn: true };

/** The fraction of the file name after the last dot, lower case. */
const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Where a source's bytes can be read from, in order of preference. An embedded file that is not
 * in the song file yet (a recorded take, a stem put on a lane: nothing is saved until the song
 * is) is last asked of the loaded copy, so its waveform shows right away.
 */
export function sourceLocations(source: AudioSource, songPath: string | null): SourceLocation[] {
  const locations: SourceLocation[] = [];
  if (source.path) locations.push({ type: "file", path: source.path });
  if (source.embedded && songPath?.toLowerCase().endsWith(".gp")) {
    locations.push({ type: "embedded", scorePath: songPath, entry: `${source.id}.${source.ext}` });
    if (source.legacyEntry)
      locations.push({ type: "embedded", scorePath: songPath, entry: source.legacyEntry });
  }
  if (source.embedded) locations.push({ type: "pool", id: source.id, name: source.name });
  return locations;
}

/** Every reference to source `from` (the source and the takes that play it) pointed at `to`. */
export function renameSource(
  audio: AudioLanesSettings,
  from: string,
  to: SourceInfo,
): AudioLanesSettings {
  const exists = audio.sources.some((s) => s.id === to.id);
  return {
    ...audio,
    sources: exists
      ? audio.sources.filter((s) => s.id !== from)
      : audio.sources.map((s) =>
          s.id === from ? { ...s, id: to.id, ext: to.ext, legacyEntry: undefined } : s,
        ),
    lanes: audio.lanes.map((l) => ({
      ...l,
      clips: l.clips.map((c) => ({
        ...c,
        takes: c.takes.map((t) => (t.sourceId === from ? { ...t, sourceId: to.id } : t)),
        // An old track's clip was as long as any file could be: now its real length is known.
        lengthMs:
          c.takes[c.take]?.sourceId === from
            ? Math.min(c.lengthMs, to.durationMs - activeTake(c).offsetMs)
            : c.lengthMs,
      })),
    })),
  };
}

/**
 * The song's audio lanes as the UI works on them: the settings in the mix, the files loaded into
 * the engine (with their waveform peaks), undo history, the selection, the edit cursor and the
 * clip commands.
 */
export function useAudioLanes(options: AudioLanesOptions) {
  const {
    mix,
    changeMix,
    loadSource = loadAudioSource,
    epoch = null,
    songPath,
    grid,
    playback = NO_NOTICE,
    onCursorMove,
    positionMs,
    onTimeRangeChange,
  } = options;
  const audio = useMemo(() => lanesOf(mix), [mix.audio, mix.audioTrack]); // eslint-disable-line react-hooks/exhaustive-deps
  const audioRef = useRef(audio);
  useEffect(() => {
    audioRef.current = audio;
  }, [audio]);

  const [infos, setInfos] = useState<ReadonlyMap<string, SourceInfo>>(new Map());
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [editCursorMs, followPosition] = useState(0);
  const cursorMoved = useRef(onCursorMove);
  useEffect(() => {
    cursorMoved.current = onCursorMove;
  }, [onCursorMove]);
  /** Puts the edit cursor (the position line) at a point the user chose. */
  const setEditCursorMs = useCallback((ms: number) => {
    followPosition(ms);
    cursorMoved.current?.(ms);
  }, []);
  const [snap, setSnap] = useState<SnapMode>("beat");
  const [timeRange, keepTimeRange] = useState<TimeRange | null>(null);
  /** The lanes time-selection edits act on (null or empty: every lane). */
  const [rangeLanes, setRangeLanes] = useState<readonly string[] | null>(null);
  const rangeChanged = useRef(onTimeRangeChange);
  useEffect(() => {
    rangeChanged.current = onTimeRangeChange;
  }, [onTimeRangeChange]);
  const timeRangeNow = useRef<TimeRange | null>(null);
  /** Sets the time selection (null clears it); a click-short range clears it too. */
  const setTimeRange = useCallback((range: TimeRange | null) => {
    const next = normalizeRange(range);
    // Clearing nothing is not a change: the score keeps a loop it set itself.
    if (!next && !timeRangeNow.current) return;
    timeRangeNow.current = next;
    keepTimeRange(next);
    rangeChanged.current?.(next);
  }, []);
  const history = useRef<{ past: AudioLanesSettings[]; future: AudioLanesSettings[] }>({
    past: [],
    future: [],
  });
  /** How many undo and redo steps there are (state, so the buttons follow). */
  const [steps, setSteps] = useState({ undo: 0, redo: 0 });
  const remember = (next: { past: AudioLanesSettings[]; future: AudioLanesSettings[] }) => {
    history.current = next;
    setSteps({ undo: next.past.length, redo: next.future.length });
  };
  const [lastEditAt, setLastEditAt] = useState(0);
  const clipboard = useRef<AudioClip[]>([]);
  /** How many clips are on the clipboard (state, so Paste can tell whether it has anything). */
  const [clipboardSize, setClipboardSize] = useState(0);
  const position = useRef(positionMs);
  useEffect(() => {
    position.current = positionMs;
  }, [positionMs]);
  /** The epoch each source was loaded in (or is being loaded in), by source id. */
  const loadedIn = useRef(new Map<string, number | null>());

  const commit = useCallback(
    (next: AudioLanesSettings) =>
      changeMix({ type: "audio", value: next.lanes.length ? next : null }),
    [changeMix],
  );

  /** Applies an edit and remembers the state before it for undo. */
  const apply = useCallback(
    (edit: (audio: AudioLanesSettings) => AudioLanesSettings) => {
      const before = audioRef.current;
      const edited = edit(before);
      if (edited === before) return;
      // A clip group left with one clip (after a delete, glue or lane removal) goes.
      const next = pruneGroups(edited);
      remember({ past: [...history.current.past, before].slice(-HISTORY), future: [] });
      setLastEditAt(Date.now());
      audioRef.current = next;
      commit(next);
    },
    [commit],
  );

  /** Starts a drag that changes the lanes many times: undo takes it back in one step. */
  const beginGesture = useCallback(() => {
    remember({
      past: [...history.current.past, audioRef.current].slice(-HISTORY),
      future: [],
    });
    setLastEditAt(Date.now());
  }, []);

  /** An edit inside a gesture (no undo step of its own). */
  const applyQuiet = useCallback(
    (edit: (audio: AudioLanesSettings) => AudioLanesSettings) => {
      const next = edit(audioRef.current);
      if (next === audioRef.current) return;
      audioRef.current = next;
      commit(next);
    },
    [commit],
  );

  const undo = useCallback(() => {
    const { past, future } = history.current;
    const previous = past[past.length - 1];
    if (!previous) return false;
    remember({ past: past.slice(0, -1), future: [audioRef.current, ...future] });
    audioRef.current = previous;
    commit(previous);
    setLastEditAt(Date.now());
    return true;
  }, [commit]);

  const redo = useCallback(() => {
    const { past, future } = history.current;
    const next = future[0];
    if (!next) return false;
    remember({ past: [...past, audioRef.current], future: future.slice(1) });
    audioRef.current = next;
    commit(next);
    setLastEditAt(Date.now());
    return true;
  }, [commit]);

  // Loads every file the lanes play when the song opens or a file is added. Decoding needs no
  // audio engine; a new native engine gets the files again (it must know where they came from).
  useEffect(() => {
    for (const source of audio.sources) {
      const loaded = loadedIn.current;
      if (loaded.has(source.id) && (epoch === null || loaded.get(source.id) === epoch)) continue;
      loaded.set(source.id, epoch);
      void (async () => {
        let lastError: unknown = new Error(`“${source.name}” has no file to load.`);
        for (const location of sourceLocations(source, songPath)) {
          try {
            const info = await loadSource(location);
            loaded.set(info.id, epoch);
            setInfos((m) => new Map(m).set(info.id, info).set(source.id, info));
            setMissing((m) => {
              const next = new Set(m);
              next.delete(source.id);
              return next;
            });
            // An old audio track's file gets its content id once it is read.
            if (info.id !== source.id) commit(renameSource(audioRef.current, source.id, info));
            return;
          } catch (error) {
            // The loaded copy is the last resort: its "not loaded" is not what the user needs to read.
            if (location.type !== "pool") lastError = error;
            if (!isCommandError(error) || error.kind !== "not-found") break;
          }
        }
        setMissing((m) => new Set(m).add(source.id));
        toast.error(`Couldn't open the audio file “${source.name}”`, {
          description: errorText(lastError),
        });
      })();
    }
  }, [audio.sources, epoch, loadSource, songPath, commit]);

  const snapTo = useCallback(
    (ms: number) =>
      snap === "off" ? Math.max(0, ms) : Math.max(0, snapMs(audioRef.current, grid, ms, snap)),
    [grid, snap],
  );

  /**
   * Opens audio files as clips: on `laneId` from `atMs` (one after another), or each on a new lane
   * when no lane is given. Files are embedded in the song by default.
   */
  const importFiles = useCallback(
    async (paths: readonly string[], laneId?: string, atMs?: number) => {
      let at = snapTo(atMs ?? editCursorMs);
      for (const path of paths) {
        const name = baseName(path);
        if (!(AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name))) {
          toast.error(`“${name}” is not an audio file Smart Beat opens`, {
            description: "Use an mp3, m4a, wav, flac, ogg or aiff file.",
          });
          continue;
        }
        let info: SourceInfo;
        try {
          info = await loadSource({ type: "file", path });
        } catch (error) {
          toast.error(`Couldn't open “${name}”`, { description: errorText(error) });
          continue;
        }
        loadedIn.current.set(info.id, epoch);
        setInfos((m) => new Map(m).set(info.id, info));
        const source: AudioSource = { id: info.id, name, ext: info.ext, path, embedded: true };
        const clip = newClip(info.id, name, at, info.durationMs);
        const startAt = at;
        apply((a) => {
          if (!laneId && a.lanes.length >= MAX_LANES) {
            toast.error(`A song can have ${MAX_LANES} audio lanes`);
            return a;
          }
          const withSource = addSource(a, source);
          if (laneId) return addClip(withSource, laneId, { ...clip, startMs: startAt });
          const lane = newLane(name.replace(/\.[^.]+$/, ""));
          return addClip(addLane(withSource, lane), lane.id, clip);
        });
        if (laneId) at = startAt + info.durationMs;
      }
    },
    [apply, editCursorMs, epoch, loadSource, snapTo],
  );
  /** Shows the file chooser and opens the chosen file (on `laneId` at `atMs`, else a new lane). */
  const chooseFile = useCallback(
    async (laneId?: string, atMs?: number) => {
      let file: string | null;
      try {
        file = await pickAudioFile();
      } catch (error) {
        toast.error("Couldn't show the Open dialog", { description: errorText(error) });
        return;
      }
      if (file) await importFiles([file], laneId, atMs);
    },
    [importFiles],
  );
  /** Where Split and Paste act: the position line (the playhead while playing). */
  const lineMs = useCallback(() => position.current?.() ?? editCursorMs, [editCursorMs]);

  /**
   * Splits clips at a point (default: the position line), on a zero crossing: `ids`, else the
   * selected clips, else every clip under the line.
   */
  const splitAt = useCallback(
    async (ids: readonly string[], at: number) => {
      const a = audioRef.current;
      const targets = a.lanes
        .flatMap((l) => l.clips)
        .filter(
          (c) => (ids.length === 0 || ids.includes(c.id)) && c.startMs < at && clipEndMs(c) > at,
        );
      const cuts = await Promise.all(
        targets.map(async (c) => {
          const take = activeTake(c);
          // The file position under the cursor is simple to map back only for a plain clip; a
          // reversed or stretched one is cut where the cursor is (its cut still gets a fade).
          if (c.reversed || c.stretch.length) return { id: c.id, at };
          const sourceMs = take.offsetMs + (at - c.startMs) * c.playrate;
          const crossing = await audioZeroCrossing(take.sourceId, sourceMs).catch(() => sourceMs);
          return { id: c.id, at: c.startMs + (crossing - take.offsetMs) / c.playrate };
        }),
      );
      apply((current) => cuts.reduce((next, cut) => splitClip(next, cut.id, cut.at), current));
    },
    [apply],
  );

  const commands = useMemo(() => {
    // Each command acts on the clips given, else on the selection; grouped clips with their group.
    const copy = (ids: readonly string[] = selection) => {
      const all = withGroup(audioRef.current, ids);
      clipboard.current = audioRef.current.lanes.flatMap((l) =>
        l.clips.filter((c) => all.includes(c.id)),
      );
      setClipboardSize(clipboard.current.length);
    };
    const remove = (ids: readonly string[] = selection) => {
      const all = withGroup(audioRef.current, ids);
      apply((a) => removeClips(a, all));
      setSelection((s) => s.filter((id) => !all.includes(id)));
    };
    /** The lanes a time-selection edit acts on: the chosen ones, else every lane. */
    const rangeTargets = () => (rangeLanes?.length ? rangeLanes : clipLaneIds(audioRef.current));
    const onRange = (edit: (a: AudioLanesSettings, range: TimeRange) => AudioLanesSettings) => {
      if (timeRange) apply((a) => edit(a, timeRange));
    };
    return {
      addLane: () => apply((a) => addLane(a)),
      /** Splits the clips crossing either edge of the time selection. */
      splitTimeRange: () => onRange((a, r) => splitAtRangeEdges(a, rangeTargets(), r)),
      /** Keeps only the parts of the clips inside the time selection. */
      trimToTimeRange: () => onRange((a, r) => trimToRange(a, rangeTargets(), r)),
      /** Removes the time selection on every lane and closes the gap. */
      removeTimeRange: () => {
        if (!timeRange) return;
        onRange(removeRangeClosingGap);
        setTimeRange(null);
      },
      /** Inserts empty space as long as the time selection at its start, on every lane. */
      insertSpace: () => onRange(insertSpaceAtRange),
      /** Splits at `atMs` (default: the position line). */
      split: (ids: readonly string[] = selection, atMs?: number) =>
        void splitAt(ids, atMs ?? lineMs()),
      /** Trims the start of the clips under `atMs` (default: the position line) to it. */
      trimStartToLine: (ids: readonly string[] = selection, atMs?: number) =>
        apply((a) => trimToLine(a, ids, "start", atMs ?? lineMs())),
      /** Trims the end of the clips under `atMs` (default: the position line) to it. */
      trimEndToLine: (ids: readonly string[] = selection, atMs?: number) =>
        apply((a) => trimToLine(a, ids, "end", atMs ?? lineMs())),
      glue: (ids: readonly string[] = selection) => apply((a) => glueClips(a, ids)),
      duplicate: (ids: readonly string[] = selection) =>
        apply((a) => regroupCopies(a, duplicateClips(a, withGroup(a, ids)))),
      /** Groups the clips (two or more), so they move, delete and select together. */
      group: (ids: readonly string[] = selection) => apply((a) => groupClips(a, ids)),
      ungroup: (ids: readonly string[] = selection) => apply((a) => ungroupClips(a, ids)),
      remove,
      copy,
      cut: (ids: readonly string[] = selection) => {
        copy(ids);
        remove(ids);
      },
      /** Pastes on a lane at `atMs` (default: the position line). */
      paste: (laneId: string, atMs?: number) =>
        apply((a) => pasteClips(a, laneId, freshGroups(clipboard.current), atMs ?? lineMs())),
      /** Moves the selected clips by one beat (a bar with `big`; 10 ms with snap off). */
      nudge: (direction: -1 | 1, big: boolean) =>
        apply((a) =>
          groupLeaders(a, withGroup(a, selection)).reduce((next, id) => {
            const found = findClip(next, id);
            if (!found) return next;
            const step =
              snap === "off" && !big
                ? 10
                : gridStepMs(grid, found.clip.startMs, big || snap === "bar");
            return moveClipGroup(next, id, found.clip.startMs + direction * step);
          }, a),
        ),
    };
  }, [apply, grid, lineMs, rangeLanes, selection, setTimeRange, snap, splitAt, timeRange]);

  /** Selects clips, each with its whole group (`alone`: just these clips). */
  const select = useCallback(
    (ids: readonly string[], alone = false) =>
      setSelection(alone ? ids : withGroup(audioRef.current, ids)),
    [],
  );

  return {
    audio,
    infos,
    missing,
    selection,
    select,
    editCursorMs,
    setEditCursorMs,
    /** Moves the edit cursor along with playback (without moving playback again). */
    followPosition,
    snap,
    setSnap,
    snapTo,
    /** The song's bars and beats on the audio timeline. */
    grid,
    /** The time selection on the audio timeline (null: none). */
    timeRange,
    setTimeRange,
    rangeLanes,
    setRangeLanes,
    apply,
    applyQuiet,
    beginGesture,
    undo,
    redo,
    canUndo: steps.undo > 0,
    canRedo: steps.redo > 0,
    lastEditAt,
    canPaste: clipboardSize > 0,
    /** Where the position line is now (the playhead while playing). */
    lineMs,
    importFiles,
    chooseFile,
    commands,
    /** Whether the lanes are heard with the engine in use. */
    playback,
  };
}

/** A beat (or a bar) in ms at a point of the song, for nudging clips. */
export function gridStepMs(grid: SongGrid, ms: number, bar: boolean): number {
  const times = grid.barTimes;
  let i = 0;
  while (i + 2 < times.length && times[i + 1]! <= ms) i++;
  const length = (times[i + 1] ?? times[i]! + 2000) - times[i]!;
  return bar ? length : length / (grid.beats[i] ?? 4);
}

export type AudioLanesController = ReturnType<typeof useAudioLanes>;
