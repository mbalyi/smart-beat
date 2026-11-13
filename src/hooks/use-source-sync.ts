import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HostRoom } from "@/lib/practice-together/host-room";
import type { Session } from "@/lib/practice-together/session";
import {
  SourceSync,
  type SourceInbox,
  type SourceIo,
  type SourceSyncState,
} from "@/lib/practice-together/source-transfer";
import {
  audioSourceChunk,
  audioSourceSize,
  audioStageAbort,
  audioStageAppend,
  audioStageBegin,
  audioStageFinish,
} from "@/lib/tauri";

/** The audio files of the shared lanes, as the app sees them (see `source-transfer.ts`). */
export interface SourceSharing {
  state: SourceSyncState;
  /** The shared lanes' files and which of them are loaded here (call when either changes). */
  setNeeded(
    sources: readonly { id: string; name: string; file?: string }[],
    loaded: Iterable<string>,
  ): void;
  /** Every player has every file (a guest: this player has them). True with no session. */
  complete(): boolean;
  /** Who still lacks what (the host only), for the message that holds Play back. */
  lacking(): { peer: string; id: string; name: string }[];
  /** Tries a file that failed again, from any player that has it. */
  retry(id: string): void;
}

const NO_FILES: ReadonlySet<string> = new Set();
export const NO_SOURCE_STATE: SourceSyncState = {
  waiting: NO_FILES,
  failed: [],
  transfers: [],
  complete: true,
};

/** No session: nothing to wait for. */
export const NO_SOURCE_SHARING: SourceSharing = {
  state: NO_SOURCE_STATE,
  setNeeded: () => {},
  complete: () => true,
  lacking: () => [],
  retry: () => {},
};

/** The audio engine of this app, as the transfer uses it. */
export const appSourceIo: SourceIo = {
  size: (id) => audioSourceSize(id).catch(() => null),
  chunk: audioSourceChunk,
  stageBegin: audioStageBegin,
  stageAppend: audioStageAppend,
  // The decoded size (left and right channels as 32-bit floats) is counted against the session.
  stageFinish: async (id, name) => {
    const info = await audioStageFinish(id, name);
    return Math.round((info.durationMs / 1000) * info.sampleRate * 8);
  },
  stageAbort: (id) => audioStageAbort(id).catch(() => {}),
};

interface Options {
  session: Session | HostRoom | null;
  /** This tab holds the live session. */
  owns: boolean;
  phase: string | undefined;
  inbox: SourceInbox;
  /** True while the song plays (the files wait for it to stop). */
  paused: () => boolean;
  io?: SourceIo;
}

/**
 * Runs the audio-file end of a session for this tab: the host's, which hears what every guest has
 * and hands files on, or a guest's, which gets them from the host. Nothing runs without a session.
 */
export function useSourceSync({
  session,
  owns,
  phase,
  inbox,
  paused,
  io = appSourceIo,
}: Options): SourceSharing {
  const [sync, setSync] = useState<SourceSync | null>(null);
  const [state, setState] = useState<SourceSyncState>(NO_SOURCE_STATE);
  const syncRef = useRef<SourceSync | null>(null);
  /** What the lanes last said they need: a session that starts later is told at once. */
  const needed = useRef<{
    sources: { id: string; name: string; file?: string }[];
    loaded: Set<string>;
  }>({
    sources: [],
    loaded: new Set(),
  });
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  });

  const open =
    phase === "waiting" ||
    phase === "approving" ||
    phase === "syncing" ||
    phase === "synchronized" ||
    phase === "reconnecting";
  const role = session?.role;

  useEffect(() => {
    if (!session || !owns || !open) return;
    if (session.role === "host") {
      const room = session as HostRoom;
      const manager = new SourceSync({
        io,
        role: "host",
        link: { send: (seat, msg) => room.sendSource(seat, msg) },
        paused: () => pausedRef.current(),
        changed: () => setState(manager.state()),
      });
      room.setSourceHooks({
        receive: (seat, msg) => manager.receive(seat, msg),
        welcomed: (seat) => manager.peerJoined(seat),
        left: (seat) => manager.peerLeft(seat),
      });
      syncRef.current = manager;
      manager.setNeeded(needed.current.sources, needed.current.loaded);
      for (const { id } of room.sourceSeats()) manager.peerJoined(id);
      // Setting state here is how React is told a new coordinator exists.
      setSync(manager);
      setState(manager.state());
      return () => {
        room.setSourceHooks(null);
        manager.end();
        syncRef.current = null;
        setSync(null);
        setState(NO_SOURCE_STATE);
      };
    }
    const guest = session as Session;
    // A host whose app does not share audio files is not told about any.
    const manager = new SourceSync({
      io,
      role: "guest",
      link: { send: (_peer, msg) => guest.sendSource(msg) },
      paused: () => pausedRef.current(),
      changed: () => setState(manager.state()),
    });
    inbox.listen((msg) => manager.receive("host", msg));
    // The host's welcome says whether its app shares audio lanes: say what this player has then.
    inbox.onWelcome(() => {
      if (guest.peerLanes) manager.peerJoined("host");
    });
    syncRef.current = manager;
    manager.setNeeded(needed.current.sources, needed.current.loaded);
    if (guest.peerLanes) manager.peerJoined("host");
    setSync(manager);
    setState(manager.state());
    return () => {
      inbox.listen(null);
      inbox.onWelcome(null);
      inbox.clear();
      manager.end();
      syncRef.current = null;
      setSync(null);
      setState(NO_SOURCE_STATE);
    };
    // The coordinator belongs to this session: not to the rest of the render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, owns, open, role]);

  const setNeeded = useCallback(
    (sources: readonly { id: string; name: string; file?: string }[], loaded: Iterable<string>) => {
      needed.current = {
        sources: [...sources],
        loaded: new Set([...needed.current.loaded, ...loaded]),
      };
      syncRef.current?.setNeeded(needed.current.sources, needed.current.loaded);
    },
    [],
  );
  const complete = useCallback(() => syncRef.current?.complete ?? true, []);
  const lacking = useCallback(() => syncRef.current?.lacking() ?? [], []);
  const retry = useCallback((id: string) => syncRef.current?.retry(id), []);

  return useMemo(
    () => ({ state: sync ? state : NO_SOURCE_STATE, setNeeded, complete, lacking, retry }),
    [sync, state, setNeeded, complete, lacking, retry],
  );
}
