import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AudioOp, LaneBridge } from "@/lib/audio-lanes/collab";
import type { HostRoom } from "@/lib/practice-together/host-room";
import type { Session } from "@/lib/practice-together/session";
import {
  GuestEditing,
  HostEditing,
  type EditInbox,
  type HostLink,
  type RemotePlayer,
} from "@/lib/practice-together/shared-editing";
import type { ScoreEditor } from "@/lib/score/editor";
import type { EditSync } from "@/lib/score/ops/collab";

/** Editing the tab together in a Practice together session (#216), as the workspace sees it. */
export interface SharedEditing {
  /** The host's switch: whether guests may edit (always true for a guest, who does not decide). */
  guestsCanEdit: boolean;
  setGuestsCanEdit(on: boolean): void;
  /** A guest that has the host's tab up to date and may edit it. */
  editable: boolean;
  /** Both sides run shared editing for this tab (the host's app is new enough). */
  live: boolean;
  /** The other players' cursors. */
  players: readonly RemotePlayer[];
  /** The ids of this tab's parts (to find where a cursor is). Null without shared editing. */
  sync: EditSync | null;
  /** The host: each guest, whether it is up to date and whether it may edit. */
  guests: { id: string; name: string; live: boolean; canEdit: boolean }[];
  /** Changes whenever the players or rights changed (to redraw cursors). */
  version: number;
  /** The audio lanes, shared along with the tab (see `LaneSharing`). */
  lanes: {
    /** This player's lane edits are sent now. */
    active: boolean;
    send(ops: AudioOp[]): boolean;
    /** The lanes controller hands over its end of the session (null: gone). */
    attach(bridge: LaneBridge | null): void;
  };
}

const NO_LANES: SharedEditing["lanes"] = { active: false, send: () => false, attach: () => {} };

export const NO_SHARED_EDITING: SharedEditing = {
  guestsCanEdit: true,
  setGuestsCanEdit: () => {},
  editable: false,
  live: false,
  players: [],
  sync: null,
  guests: [],
  version: 0,
  lanes: NO_LANES,
};

interface Options {
  editor: ScoreEditor | null | undefined;
  session: Session | HostRoom | null;
  /** This tab holds the live session (a session in another tab edits that tab's score). */
  owns: boolean;
  /** The session's phase. */
  phase: string | undefined;
  /** For a guest: the tab came from the host as the file written at this edit number. */
  receivedSeq: number | undefined;
  /** For a guest: the fingerprint key of the tab (the host's, as it was sent). */
  receivedKey: string | undefined;
  /** The fingerprint key of this tab as it is now. */
  currentKey(): Promise<string>;
  /** The guest's own id (the one the host knows it by). */
  guestId: string;
  hostName: string;
  inbox: EditInbox;
  /** Set to write the host's tab: returns the edit number the file is from. */
  snapshotRef: { current: (() => { seq: number } | null) | undefined };
}

/**
 * Runs the editing end of a session for this tab: the host's, which numbers and hands out
 * everybody's edits, or a guest's, which sends its own and applies the host's. Nothing runs
 * unless this tab holds a live session.
 */
export function useSharedEditing({
  editor,
  session,
  owns,
  phase,
  receivedSeq,
  receivedKey,
  currentKey,
  guestId,
  hostName,
  inbox,
  snapshotRef,
}: Options): SharedEditing {
  const [version, setVersion] = useState(0);
  const [host, setHost] = useState<HostEditing | null>(null);
  const [guest, setGuest] = useState<GuestEditing | null>(null);
  const keyRef = useRef(currentKey);
  useEffect(() => {
    keyRef.current = currentKey;
  });
  // The audio lanes of this tab take part in the session through their bridge: they hand it over
  // when they are ready, and the session starts and ends it.
  const bridgeRef = useRef<LaneBridge | null>(null);
  const roleOfLanes = useRef<"host" | "guest" | null>(null);
  const attach = useCallback((bridge: LaneBridge | null) => {
    bridgeRef.current = bridge;
    if (bridge && roleOfLanes.current) bridge.begin(roleOfLanes.current === "host");
  }, []);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const open =
    phase === "waiting" ||
    phase === "approving" ||
    phase === "syncing" ||
    phase === "synchronized" ||
    phase === "reconnecting";
  const role = session?.role;

  useEffect(() => {
    if (!editor || !session || !owns || !open) return;
    if (session.role === "host") {
      const room = session as HostRoom;
      const link: HostLink = {
        seats: () => room.editSeats(),
        send: (seat, body) => room.sendEdit(seat, body),
        setLive: (seat, on) => room.setEditLive(seat, on),
        shareTab: (seat) => void room.shareTabTo(seat),
      };
      const editing = new HostEditing(editor, link, {
        name: hostName,
        currentKey: () => keyRef.current(),
        changed: bump,
        lanes: () => bridgeRef.current,
      });
      roleOfLanes.current = "host";
      bridgeRef.current?.begin(true);
      room.setEditHooks(editing);
      snapshotRef.current = () => editing.snapshot();
      const stopPresence = editor.subscribe(() => editing.setPresence());
      const stopPlayers = editing.subscribe(bump);
      // Setting state here is how React is told a new coordinator exists.
      setHost(editing);
      return () => {
        stopPresence();
        stopPlayers();
        room.setEditHooks(null);
        snapshotRef.current = undefined;
        bridgeRef.current?.end();
        roleOfLanes.current = null;
        editing.end();
        setHost(null);
      };
    }

    const guestSession = session as Session;
    let cancelled = false;
    let editing: GuestEditing | null = null;
    let stopPresence = () => {};
    const begin = (key: string) => {
      if (cancelled) return;
      editing = new GuestEditing(
        editor,
        { send: (body) => guestSession.sendEdit(body) },
        {
          guest: guestId,
          seq: receivedSeq ?? -1,
          key,
          changed: bump,
          lanes: () => bridgeRef.current,
          hostLanes: () => guestSession.peerLanes,
        },
      );
      roleOfLanes.current = "guest";
      bridgeRef.current?.begin(false);
      editing.start();
      const current = editing;
      inbox.listen((body) => current.receive(body));
      stopPresence = editor.subscribe(() => current.setPresence());
      setGuest(editing);
    };
    // A guest that got the tab as a file knows its fingerprint; one that had it works it out.
    if (receivedKey !== undefined) begin(receivedKey);
    else void keyRef.current().then(begin);
    return () => {
      cancelled = true;
      stopPresence();
      inbox.listen(null);
      // What this session said is of no use to the next one.
      inbox.clear();
      bridgeRef.current?.end();
      roleOfLanes.current = null;
      editing?.end();
      setGuest(null);
    };
    // The coordinator belongs to this editor and this session: not to the rest of the render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, session, owns, open, role]);

  return useMemo(() => {
    if (host) {
      return {
        guestsCanEdit: host.guestsCanEdit,
        setGuestsCanEdit: (on: boolean) => host.setGuestsCanEdit(on),
        editable: false,
        live: true,
        players: host.players,
        sync: host.sync,
        guests: host.editors(),
        version,
        lanes: { active: true, send: (ops: AudioOp[]) => host.sendLanes(ops), attach },
      };
    }
    if (guest) {
      return {
        ...NO_SHARED_EDITING,
        editable: guest.editable,
        live: guest.live,
        players: guest.players,
        sync: guest.sync,
        version,
        lanes: { active: guest.editable, send: (ops: AudioOp[]) => guest.sendLanes(ops), attach },
      };
    }
    return { ...NO_SHARED_EDITING, lanes: { ...NO_LANES, attach } };
    // `version` stands for what changed inside the coordinators.
  }, [host, guest, version, attach]);
}
