import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  addClip,
  addLane,
  addSource,
  duplicateClips,
  findClip,
  glueClips,
  moveClip,
  pasteClips,
  removeClips,
  splitClip,
} from "@/lib/audio-lanes/edits";
import {
  EMPTY_AUDIO,
  MAX_LANES,
  activeTake,
  clipEndMs,
  newClip,
  newLane,
} from "@/lib/audio-lanes/model";
import { snapMs, type SongGrid } from "@/lib/audio-lanes/sync";
import { errorText } from "@/lib/errors";
import type { MixerAction } from "@/lib/score/mixer";
import {
  AUDIO_EXTENSIONS,
  audioZeroCrossing,
  isCommandError,
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

/** Loads audio files into the engine (the score player, native engine only). */
export interface SourceLoader {
  loadSource(location: SourceLocation): Promise<SourceInfo>;
}

export interface AudioLanesOptions {
  mix: MixerSettings;
  changeMix: (action: MixerAction) => void;
  /** The engine to load files into (null: none yet). */
  loader: () => SourceLoader | null;
  /** The native engine is on and the player is ready (files load then). */
  canLoad: boolean;
  /** Bumped when a new player is made, so files load again into it. */
  epoch: number;
  /** The song file, for files embedded in it (`.gp` only). */
  songPath: string | null;
  grid: SongGrid;
  /** Asks for the native engine; false when it cannot be used here. */
  ensureEngine: () => boolean;
}

/** The fraction of the file name after the last dot, lower case. */
const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Where a source's bytes can be read from, in order of preference. */
export function sourceLocations(source: AudioSource, songPath: string | null): SourceLocation[] {
  const locations: SourceLocation[] = [];
  if (source.path) locations.push({ type: "file", path: source.path });
  if (source.embedded && songPath?.toLowerCase().endsWith(".gp")) {
    locations.push({ type: "embedded", scorePath: songPath, entry: `${source.id}.${source.ext}` });
    if (source.legacyEntry)
      locations.push({ type: "embedded", scorePath: songPath, entry: source.legacyEntry });
  }
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
  const { mix, changeMix, loader, canLoad, epoch, songPath, grid, ensureEngine } = options;
  const audio = mix.audio ?? EMPTY_AUDIO;
  const audioRef = useRef(audio);
  audioRef.current = audio;

  const [infos, setInfos] = useState<ReadonlyMap<string, SourceInfo>>(new Map());
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [editCursorMs, setEditCursorMs] = useState(0);
  const [snap, setSnap] = useState<SnapMode>("beat");
  const history = useRef<{ past: AudioLanesSettings[]; future: AudioLanesSettings[] }>({
    past: [],
    future: [],
  });
  const [lastEditAt, setLastEditAt] = useState(0);
  const clipboard = useRef<AudioClip[]>([]);
  const loading = useRef(new Set<string>());

  const commit = useCallback(
    (next: AudioLanesSettings) =>
      changeMix({ type: "audio", value: next.lanes.length ? next : null }),
    [changeMix],
  );

  /** Applies an edit and remembers the state before it for undo. */
  const apply = useCallback(
    (edit: (audio: AudioLanesSettings) => AudioLanesSettings) => {
      const before = audioRef.current;
      const next = edit(before);
      if (next === before) return;
      history.current = { past: [...history.current.past, before].slice(-HISTORY), future: [] };
      setLastEditAt(Date.now());
      audioRef.current = next;
      commit(next);
    },
    [commit],
  );

  /** Starts a drag that changes the lanes many times: undo takes it back in one step. */
  const beginGesture = useCallback(() => {
    history.current = {
      past: [...history.current.past, audioRef.current].slice(-HISTORY),
      future: [],
    };
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
    history.current = { past: past.slice(0, -1), future: [audioRef.current, ...future] };
    audioRef.current = previous;
    commit(previous);
    setLastEditAt(Date.now());
    return true;
  }, [commit]);

  const redo = useCallback(() => {
    const { past, future } = history.current;
    const next = future[0];
    if (!next) return false;
    history.current = { past: [...past, audioRef.current], future: future.slice(1) };
    audioRef.current = next;
    commit(next);
    setLastEditAt(Date.now());
    return true;
  }, [commit]);

  // Loads every file the lanes play when the song opens, the engine starts or a file is added.
  useEffect(() => {
    if (!canLoad) return;
    const engine = loader();
    if (!engine) return;
    for (const source of audio.sources) {
      if (infos.has(source.id) || loading.current.has(`${epoch}:${source.id}`)) continue;
      loading.current.add(`${epoch}:${source.id}`);
      void (async () => {
        let lastError: unknown = new Error(`“${source.name}” has no file to load.`);
        for (const location of sourceLocations(source, songPath)) {
          try {
            const info = await engine.loadSource(location);
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
            lastError = error;
            if (!isCommandError(error) || error.kind !== "not-found") break;
          }
        }
        setMissing((m) => new Set(m).add(source.id));
        toast.error(`Couldn't open the audio file “${source.name}”`, {
          description: errorText(lastError),
        });
      })();
    }
  }, [audio.sources, canLoad, epoch, infos, loader, songPath, commit]);

  // A new player starts with no files: load them all again.
  useEffect(() => {
    setInfos(new Map());
  }, [epoch]);

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
      if (!ensureEngine()) return;
      const engine = loader();
      if (!engine) {
        toast.info("The audio lanes load once the effects engine is ready. Try again in a moment.");
        return;
      }
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
          info = await engine.loadSource({ type: "file", path });
        } catch (error) {
          toast.error(`Couldn't open “${name}”`, { description: errorText(error) });
          continue;
        }
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
    [apply, editCursorMs, ensureEngine, loader, snapTo],
  );

  /** Splits the selected clips (or every clip under the cursor) at the edit cursor, on a zero crossing. */
  const splitAtCursor = useCallback(async () => {
    const a = audioRef.current;
    const at = editCursorMs;
    const targets = a.lanes
      .flatMap((l) => l.clips)
      .filter(
        (c) =>
          (selection.length === 0 || selection.includes(c.id)) &&
          c.startMs < at &&
          clipEndMs(c) > at,
      );
    const cuts = await Promise.all(
      targets.map(async (c) => {
        const take = activeTake(c);
        const sourceMs = take.offsetMs + (at - c.startMs) * c.playrate;
        const crossing = await audioZeroCrossing(take.sourceId, sourceMs).catch(() => sourceMs);
        return { id: c.id, at: c.startMs + (crossing - take.offsetMs) / c.playrate };
      }),
    );
    apply((current) => cuts.reduce((next, cut) => splitClip(next, cut.id, cut.at), current));
  }, [apply, editCursorMs, selection]);

  const commands = useMemo(
    () => ({
      addLane: () => apply((a) => addLane(a)),
      split: () => void splitAtCursor(),
      glue: () => apply((a) => glueClips(a, selection)),
      duplicate: () => apply((a) => duplicateClips(a, selection)),
      remove: () => {
        apply((a) => removeClips(a, selection));
        setSelection([]);
      },
      copy: () => {
        clipboard.current = audioRef.current.lanes.flatMap((l) =>
          l.clips.filter((c) => selection.includes(c.id)),
        );
      },
      paste: (laneId: string) =>
        apply((a) => pasteClips(a, laneId, clipboard.current, editCursorMs)),
      /** Moves the selected clips by one beat (a bar with `big`; 10 ms with snap off). */
      nudge: (direction: -1 | 1, big: boolean) =>
        apply((a) =>
          selection.reduce((next, id) => {
            const found = findClip(next, id);
            if (!found) return next;
            const step =
              snap === "off" && !big
                ? 10
                : gridStepMs(grid, found.clip.startMs, big || snap === "bar");
            return moveClip(next, id, found.clip.startMs + direction * step);
          }, a),
        ),
    }),
    [apply, editCursorMs, grid, selection, snap, splitAtCursor],
  );

  return {
    audio,
    infos,
    missing,
    selection,
    select: setSelection,
    editCursorMs,
    setEditCursorMs,
    snap,
    setSnap,
    snapTo,
    apply,
    applyQuiet,
    beginGesture,
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    lastEditAt,
    importFiles,
    commands,
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
