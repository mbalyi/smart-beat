import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { useSharedEditing, type SharedEditing } from "@/hooks/use-shared-editing";
import { useTabSharing, type ReceivedScore } from "@/hooks/use-tab-sharing";
import { putHandoff, takeHandoff } from "@/lib/practice-together/handoff";
import {
  hosted,
  joined,
  handOverSessionAnalytics,
  playerRemoved,
  presetChosen,
  rejoined,
  sessionAnalytics,
  setupFailed,
  sharedStart,
} from "@/lib/practice-together/analytics";
import { HostRoom } from "@/lib/practice-together/host-room";
import {
  forgetSession,
  guestId,
  readLastSession,
  rememberSession,
  type LastSession,
} from "@/lib/practice-together/identity";
import { hostOnLan, joinOnLan } from "@/lib/practice-together/lan";
import {
  liveAbortClaim,
  liveBeginClaim,
  liveCarry,
  liveDisown,
  liveEnd,
  liveOwner,
  liveResume,
  liveSession,
  liveSetKey,
  liveSetOwner,
  liveSnapshot,
  liveStart,
  liveSuspend,
  liveTabClosed,
  liveDrop,
  liveTabWithKey,
  liveWant,
  liveClearWanted,
  subscribeLive,
  type HostCodeInfo,
  type LiveCarry,
  type LiveOwner,
  type WaitingGuest,
} from "@/lib/practice-together/live";
import { actionsFor, commandOf, sameSettings } from "@/lib/practice-together/practice-sync";
import {
  readQualityChoice,
  storeQualityChoice,
  type QualityChoice,
} from "@/lib/practice-together/quality-presets";
import { hostOverInternet, joinOverInternet, rtcSupported } from "@/lib/practice-together/rtc";
import { Session, type SessionState } from "@/lib/practice-together/session";
import { EditInbox } from "@/lib/practice-together/shared-editing";
import { SourceInbox, sourceReasonText } from "@/lib/practice-together/source-transfer";
import { useSourceSync, type SourceSharing } from "@/hooks/use-source-sync";
import { SharedTransport, type TransportPlayer } from "@/lib/practice-together/shared-transport";
import {
  clampLoop,
  type RequestAction,
  type ScoreFingerprint,
} from "@/lib/practice-together/protocol";
import type { TabProgress } from "@/lib/practice-together/tab-transfer";
import type { GuestAcceptor, PeerTransport } from "@/lib/practice-together/transport";
import type { ScoreEditor } from "@/lib/score/editor";
import type { Score } from "@/lib/score/model";
import type { PracticeAction, PracticeState } from "@/lib/score/practice";
import { isTauri, practiceSignalAvailable } from "@/lib/tauri";

/** Where two players meet: on the same network, or over the internet. */
export type ConnectionKind = "lan" | "internet";

/** The transport buttons and keys, as the workspace sees them. */
export type TogetherRequest =
  | { kind: "playPause" }
  | { kind: "stop" }
  | { kind: "seekBar"; bar: number }
  | { kind: "playFromBar"; bar: number };

/** The player as this hook needs it (a `ScorePlayer`). */
export interface TogetherPlayer extends TransportPlayer {
  getTick(): number;
  barStartTick(index: number): number;
  /** Opens the sound output; called from the click that starts a session. */
  warmUpAudio(): Promise<void>;
}

export interface PracticeTogether {
  /** The session, once hosting or joining has started. */
  state: SessionState | null;
  /** The code the host gives the guest. */
  hostCode: HostCodeInfo | null;
  /** A guest waiting for the host's yes (the first of those waiting). */
  approval: { name: string; answer: (ok: boolean) => void } | null;
  /** More guests waiting for the host's yes behind `approval`. */
  approvalsWaiting: number;
  /** The session this app was last in as a guest, when it can be tried again (null: none). */
  lastSession: LastSession | null;
  quality: QualityChoice;
  name: string;
  /** Hosting or joining is being set up. */
  starting: boolean;
  error: string | null;
  /** Whether this build and webview can offer "over the internet". */
  internetAvailable: boolean;
  /** The host's tab on its way to the guest (or a new version of it), for the dialog. */
  transfer?: TabProgress | null;
  /**
   * A guest follows the host's tab and may not edit it: the host turned editing off, the host's
   * app is older, or the tab is not up to date yet (#216). Otherwise a guest edits along.
   */
  readOnly?: boolean;
  /** This app is a guest in a session: the host sets the speed, loop, metronome and count-in. */
  isGuest?: boolean;
  /** Editing the tab together (#216): the host's switch, the other players' cursors. */
  edit: SharedEditing;
  /** The audio files of the shared lanes: what is on its way, and the setting of what is needed. */
  sources: SourceSharing;
  /**
   * A session is live in another tab of this app and this tab is not showing it (null: none, or
   * it is here). `tabs` counts the tabs in it, `here` says whether this tab is one of them.
   */
  elsewhere?: { role: "host" | "guest"; tabs: number; here: boolean } | null;
  /** How many tabs are in the live session (0 when there is none). */
  tabsInSession?: number;
  /** The host brings this tab into the live session from another tab (it plays from here). */
  addToSession?(): Promise<void>;
  setName(name: string): void;
  setQuality(choice: QualityChoice): void;
  host(kind: ConnectionKind): Promise<void>;
  join(kind: ConnectionKind, code: string): Promise<void>;
  /** Joins the session this app was last in again (after a drop, or when its battery ran out). */
  rejoin(): Promise<void>;
  leave(): void;
  /** The host sends its tab to every guest again (Sync tab). */
  syncTab(): void;
  /** The host removes a guest; it can join again with the code. */
  kick(id: string): void;
  /** The host removes a guest for good: it cannot join this session again. */
  ban(id: string): void;
  /**
   * Routes a transport request through the session. True when it was handled: the host starts it
   * for both, a guest asks the host, and a move of the position while the song plays is refused.
   */
  intercept(request: TogetherRequest): boolean;
}

interface Options {
  playerRef: RefObject<TogetherPlayer | null>;
  practice: PracticeState;
  dispatchPractice: (action: PracticeAction) => void;
  score: Score;
  /** Changes with every edit of the score. */
  revision: number;
  /** The open song's name, shown to a guest that gets the tab from this host. */
  title?: string;
  /** This tab's id (the song's), to tell the tabs of one session apart. */
  id?: number;
  /** This tab is the one shown. */
  active?: boolean;
  /** This song is the host's tab, received in a session: its fingerprint and who sent it. */
  received?: { key: string; from: string; origin?: number; seq?: number };
  /** A guest got the host's tab: open it as a tab of its own (the session moves along). */
  onReceiveTab?: (tab: ReceivedScore) => void;
  /** The editor of this tab: with it, the players of a session edit the tab together (#216). */
  editor?: ScoreEditor | null;
}

const NAME_KEY = "smart-beat:practice-together:name";

/** Play is held back: some audio file of the lanes is not at every player yet. */
function toastFilesMissing(sources: SourceSharing | null) {
  const failed = sources?.state.failed[0];
  if (failed) {
    toast.error("An audio file could not be shared, so nobody can start", {
      description: `“${failed.name}”: ${sourceReasonText(failed.reason)}. Take its lane out of the tab, or add the file again.`,
      id: "together-files",
    });
    return;
  }
  const names = [...new Set((sources?.lacking() ?? []).map((l) => l.name))];
  toast.info("Waiting for the audio files", {
    description: names.length
      ? `Nobody starts until everyone has every file: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} still on the way.`
      : "Nobody starts until everyone has every file.",
    id: "together-files",
  });
}

/** Ends after which the session is not offered again: it is over, or this guest is not welcome. */
const FORGET_KINDS = new Set(["peer-left", "banned", "declined", "version"]);

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || "Player";
  } catch {
    return "Player";
  }
}

type ApprovalEntry = WaitingGuest;

/** A ref that always holds the latest value, for callbacks that outlive a render. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : ((e as { message?: string } | null)?.message ?? String(e));

/** Problems worth a toast when they appear (the rest are shown in the dialog and the chip). */
const TOAST_KINDS = new Set([
  "late",
  "poor",
  "dropped",
  "woke",
  "tab",
  "peer-left",
  "kicked",
  "banned",
]);

/** A Play that went out counts as about to play for this long (the start is a moment ahead). */
const PLAY_PENDING_MS = 4000;

/** A burst of edits is fingerprinted once, this long after the last one. */
const FINGERPRINT_DEBOUNCE_MS = 200;

export function usePracticeTogether({
  playerRef,
  practice,
  dispatchPractice,
  score,
  revision,
  title = "Song",
  id = 0,
  active = true,
  received,
  onReceiveTab,
  editor,
}: Options): PracticeTogether {
  const [state, setState] = useState<SessionState | null>(null);
  const [hostCode, setHostCode] = useState<PracticeTogether["hostCode"]>(null);
  /** The guests waiting for the host's yes, oldest first (what the screen shows). */
  const [waiting, setWaiting] = useState<ApprovalEntry[]>([]);
  const [lastSession, setLastSession] = useState<LastSession | null>(readLastSession);
  const [quality, setQualityState] = useState<QualityChoice>(readQualityChoice);
  const [name, setNameState] = useState(readName);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internetAvailable, setInternetAvailable] = useState(false);

  const idRef = useLatest(id);
  const receivedOriginRef = useLatest(received?.origin);
  /** Which of the host's tabs this tab is: the host's own tab id, or the one a received tab came from. */
  const originFor = useCallback(
    (role: "host" | "guest") => (role === "host" ? idRef.current : receivedOriginRef.current),
    [idRef, receivedOriginRef],
  );
  const sessionRef = useRef<Session | HostRoom | null>(null);
  /** Guests waiting for the host's yes, oldest first. */
  const approvals = useRef<ApprovalEntry[]>([]);
  const sharedRef = useRef<SharedTransport | null>(null);
  const practiceRef = useLatest(practice);
  const dispatchRef = useLatest(dispatchPractice);
  const scoreRef = useLatest(score);
  const qualityRef = useLatest(quality);
  const nameRef = useLatest(name);
  const titleRef = useLatest(title);
  const revisionRef = useLatest(revision);
  const receiveRef = useLatest(onReceiveTab);
  const detachRef = useRef<(key: string) => void>(() => {});
  // The host offered a tab this app has open in another tab: show that one (the session moves).
  const haveRef = useRef<(key: string, origin?: number) => boolean>((key, origin) => {
    const found = liveTabWithKey(key, origin);
    return found !== null && found !== idRef.current;
  });
  const showRef = useRef<(key: string, origin?: number) => void>((key, origin) => {
    const found = liveTabWithKey(key, origin);
    if (found !== null) liveWant(found);
  });
  // Editing together (#216): what the other end says about it waits here until the editing that
  // listens exists; the host's tab is numbered as it is written to a file.
  const [inbox] = useState(() => new EditInbox());
  const [sourceInbox] = useState(() => new SourceInbox());
  /** The audio file sharing of this tab's session (for the gate in `makeHooks`). */
  const sourcesRef = useRef<SourceSharing | null>(null);
  const [snapshotRef] = useState<{ current: (() => { seq: number } | null) | undefined }>(() => ({
    current: undefined,
  }));
  const tabs = useTabSharing({
    idRef,
    scoreRef,
    titleRef,
    revisionRef,
    detachRef,
    receiveRef,
    haveRef,
    showRef,
    snapshotRef,
  });
  const live = useSyncExternalStore(subscribeLive, liveSnapshot);

  useEffect(() => {
    if (!isTauri() || !rtcSupported()) return;
    let current = true;
    practiceSignalAvailable()
      .then((available) => current && setInternetAvailable(available))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  /** The host answers a guest, or the guest goes away: it leaves the queue. */
  const settle = useCallback((entry: ApprovalEntry, ok: boolean) => {
    const at = approvals.current.indexOf(entry);
    if (at < 0) return;
    approvals.current.splice(at, 1);
    setWaiting([...approvals.current]);
    entry.resolve(ok);
  }, []);

  /** A guest asks to join: it waits behind the ones before it. */
  const enqueue = useCallback((entry: ApprovalEntry) => {
    approvals.current.push(entry);
    setWaiting([...approvals.current]);
  }, []);

  /** Withdraws every question to the host (the session is over). */
  const clearApprovals = useCallback(() => {
    for (const entry of approvals.current.splice(0)) entry.resolve(false);
    setWaiting([]);
  }, []);

  const head = waiting[0];
  const approval = useMemo<PracticeTogether["approval"]>(
    () => (head ? { name: head.name, answer: (ok: boolean) => settle(head, ok) } : null),
    [head, settle],
  );
  const approvalsWaiting = Math.max(0, waiting.length - 1);
  // A host with the dialog closed is told someone is waiting (a toast is read out, too).
  const waitingName = head?.name;
  useEffect(() => {
    if (waitingName) {
      toast.info(`${waitingName} wants to join`, {
        description: "Open Practice together to let them in.",
        id: "together-waiting",
      });
    }
  }, [waitingName]);

  /** Counts the sessions started and ended: a host or join still connecting when it changes is stale. */
  const attemptRef = useRef(0);

  /** The host's last command to the guests, while it is still going out. */
  const inFlight = useRef<Promise<unknown> | null>(null);
  /** The host's last command and when it went out (a Play is "about to play" for a moment). */
  const lastCommand = useRef<{ action: RequestAction; at: number } | null>(null);

  /** What this tab shows and keeps of the session: its subscriptions, the transport, the state. */
  const detachSubs = useRef<(() => void) | null>(null);
  const hostCodeRef = useLatest(hostCode);

  /** Stops showing the session in this tab (without leaving it). */
  const clearLocal = useCallback(() => {
    detachSubs.current?.();
    detachSubs.current = null;
    sessionRef.current = null;
    sharedRef.current?.release();
    sharedRef.current = null;
    setState(null);
    setHostCode(null);
    clearApprovals();
  }, [clearApprovals]);

  const end = useCallback(() => {
    attemptRef.current += 1;
    // The live session (it may be shown in another tab) leaves, and its tab is told.
    if (liveSession() !== null || liveOwner() !== null) liveEnd();
    else sessionRef.current?.leave();
    clearLocal();
  }, [clearLocal]);

  /** This tab as the session's owner: what the registry can ask of it. */
  const owner = useMemo<LiveOwner>(
    () => ({
      id,
      pause: async () => {
        const session = sessionRef.current;
        const player = playerRef.current;
        // The host's tab stops everybody before the session moves away from it. A pause that was
        // already sent (the tab was hidden first) must reach the guests before the session moves:
        // moving it would call that command off.
        if (inFlight.current) await inFlight.current.catch(() => {});
        if (!player) return;
        // Playing, or a Play just sent that starts in a moment (the guests were told already).
        const last = lastCommand.current;
        const startingSoon = last?.action === "play" && Date.now() - last.at < PLAY_PENDING_MS;
        if (!player.isPlaying() && !startingSoon) return;
        if (session?.role === "host" && session.snapshot.phase === "synchronized") {
          lastCommand.current = { action: "pause", at: Date.now() };
          await session
            .command(commandOf("pause", player.getTick(), practiceRef.current))
            .catch(() => {});
        }
        if (player.isPlaying()) player.pause();
      },
      release: (): LiveCarry => {
        // A host that lets go while its song plays (its tab closed, so it could not pause the
        // guests first) leaves it to the next tab to stop them.
        const last = lastCommand.current;
        const playing = playerRef.current?.isPlaying() === true || last?.action === "play";
        const carry: LiveCarry = {
          hostCode: hostCodeRef.current,
          approvals: approvals.current.splice(0),
          stopGuests: sessionRef.current?.role === "host" && playing,
        };
        detachSubs.current?.();
        detachSubs.current = null;
        sessionRef.current = null;
        sharedRef.current?.release();
        sharedRef.current = null;
        setWaiting([]);
        setState(null);
        setHostCode(null);
        return carry;
      },
      ended: clearLocal,
    }),
    [id, clearLocal, playerRef, practiceRef, hostCodeRef],
  );
  const ownerRef = useLatest(owner);

  // A tab that closes: the session moves to another tab of it, or ends with the last one.
  useEffect(
    () => () => {
      attemptRef.current += 1;
      const owned = liveOwner()?.id === id;
      // The tab the session was about to move to closed first: the session has no owner meanwhile.
      const orphaned = !liveOwner() && liveSession() !== null && liveSnapshot().wanted === id;
      if (owned || orphaned) {
        const next = liveTabClosed(id);
        if (next !== null && liveSession()) {
          if (owned) liveDisown(ownerRef.current.release());
          liveWant(next);
          return;
        }
        end();
      } else {
        liveTabClosed(id);
      }
    },
    [end, id, ownerRef],
  );

  /** A guest got the host's tab: the connection moves to the workspace that opens it. */
  const detach = useCallback(
    (key: string) => {
      const session = sessionRef.current;
      // Only a guest moves along with the tab it received.
      if (!(session instanceof Session)) return;
      handOverSessionAnalytics();
      // Letting go of the connection is not the session ending: do not tell the registry.
      detachSubs.current?.();
      detachSubs.current = null;
      const { transport, session: sessionId, peerName } = session.release();
      liveSuspend({ hostCode: null, approvals: [] });
      putHandoff({ transport, session: sessionId, peerName, key, quality: qualityRef.current });
      clearLocal();
    },
    [qualityRef, clearLocal],
  );
  useEffect(() => {
    detachRef.current = detach;
  }, [detach]);

  /** The host: starts `action` on both computers at the same moment. */
  const startFor = useCallback(
    (action: RequestAction, tick: number) => {
      const session = sessionRef.current;
      if (session?.role !== "host") return;
      // Nobody starts until everyone has every audio file of the lanes.
      if (action === "play" && !sourcesRef.current?.complete()) {
        toastFilesMissing(sourcesRef.current);
        return;
      }
      lastCommand.current = { action, at: Date.now() };
      const sent = session.command(commandOf(action, tick, practiceRef.current));
      // A session that moves to another tab waits for this to go out first (see `owner.pause`).
      inFlight.current = sent;
      void sent.finally(() => {
        if (inFlight.current === sent) inFlight.current = null;
      });
      void sent.then((result) => {
        // A start that did not happen must say so: "late" and the clocks are told by the session's
        // own problem, a different tab version is not (the button would just do nothing).
        if (result === "score" || result === "not-synchronized") {
          toast.info(
            result === "score"
              ? "The other computer has a different version of this tab yet. Wait for the tab to arrive."
              : "Wait a moment: the two computers are still syncing their clocks.",
            { id: "together-start" },
          );
        }
      });
    },
    [practiceRef],
  );

  /** The guest asked for Play, Pause, Stop or a new position: done when it makes sense now. */
  const answer = useCallback(
    (action: RequestAction, tick: number | undefined) => {
      const player = playerRef.current;
      if (!player) return;
      const playing = player.isPlaying();
      switch (action) {
        case "play":
          if (!playing) startFor("play", tick ?? player.getTick());
          return;
        case "pause":
          if (playing) startFor("pause", player.getTick());
          return;
        case "stop":
          startFor("stop", 0);
          return;
        case "seek":
          // The position is only moved while nothing plays.
          if (!playing) startFor("seek", tick ?? player.getTick());
          return;
      }
    },
    [playerRef, startFor],
  );

  /**
   * The session a guest was in is remembered while it can be tried again, and forgotten when the
   * host ended it or turned the guest away (a drop, or being kicked, can be answered by rejoining).
   */
  const keepLast = useCallback((next: SessionState) => {
    const kind = next.problem?.kind;
    if ((next.phase === "closed" || next.phase === "failed") && kind && FORGET_KINDS.has(kind)) {
      forgetSession();
      setLastSession(null);
      return;
    }
    const host = next.phase === "synchronized" ? next.peerName : null;
    const last = readLastSession();
    if (host && last && last.host !== host) {
      const updated = { ...last, host };
      rememberSession(updated);
      setLastSession(updated);
    }
  }, []);

  /** This tab shows `session` from now on: its state, and (for a guest) the session to rejoin. */
  const attach = useCallback(
    (session: Session | HostRoom, shared: SharedTransport) => {
      detachSubs.current?.();
      sessionRef.current = session;
      sharedRef.current = shared;
      const stops = [session.subscribe(setState)];
      if (session.role === "guest") stops.push(session.subscribe(keepLast));
      // The session finished on its own (the host ended it, a kick, a ban): the tabs of it are
      // ordinary tabs again, whichever of them shows it.
      stops.push(
        session.subscribe((next) => {
          if (next.phase === "closed" || next.phase === "failed") liveDrop(session);
        }),
      );
      detachSubs.current = () => {
        for (const stop of stops) stop();
      };
    },
    [keepLast],
  );

  /** What the session does in this tab: its player, its practice settings, its tab and its guests. */
  const makeHooks = useCallback(() => {
    const shared = new SharedTransport({
      player: () => playerRef.current,
      // Nobody starts until everyone has every audio file of the lanes.
      filesReady: () => sourcesRef.current?.complete() ?? true,
      applySettings: (cmd) => {
        // The host's loop is kept inside this score's bars.
        const loop = clampLoop(cmd.loop, scoreRef.current.masterBars.length);
        for (const action of actionsFor(practiceRef.current, { ...cmd, loop })) {
          dispatchRef.current(action);
        }
      },
    });
    const hooks = {
      ...shared.hooks,
      schedule: (cmd: Parameters<typeof shared.hooks.schedule>[0], localAt: number) => {
        if (cmd.action === "play") sharedStart();
        return shared.hooks.schedule(cmd, localAt);
      },
      tab: tabs.hooks,
      edit: { receive: (body: Parameters<typeof inbox.push>[0]) => inbox.push(body) },
      source: {
        receive: (msg: Parameters<typeof sourceInbox.push>[0]) => sourceInbox.push(msg),
        welcomed: () => sourceInbox.welcomed(),
      },
      request: answer,
      approve: (guest: string, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          const entry = { name: guest, resolve };
          enqueue(entry);
          // The guest went away before the host answered: take the question back.
          signal?.addEventListener("abort", () => settle(entry, false), { once: true });
        }),
    };
    return { shared, hooks };
  }, [
    playerRef,
    scoreRef,
    practiceRef,
    dispatchRef,
    tabs,
    answer,
    enqueue,
    settle,
    inbox,
    sourceInbox,
  ]);

  /**
   * Builds the session. A host listens for guests (`acceptor`) and keeps a room; a guest talks
   * over `transport` (`link`: the state it is already in).
   */
  const open = useCallback(
    async (
      target:
        | { role: "host"; acceptor: GuestAcceptor }
        | {
            role: "guest";
            transport: PeerTransport;
            link: "connecting" | "open";
            /** A guest taking over a live connection: the session it was welcomed to, and its tab. */
            takeOver?: { resume?: string; fingerprint: ScoreFingerprint };
          },
    ) => {
      const takeOver = target.role === "guest" ? target.takeOver : undefined;
      // A new session starts: nothing said in an earlier one is kept.
      inbox.clear();
      sourceInbox.clear();
      const { shared, hooks } = makeHooks();
      const score =
        takeOver?.fingerprint ??
        (await tabs.fingerprint(scoreRef.current, revisionRef.current, originFor(target.role)));
      const session =
        target.role === "host"
          ? new HostRoom({
              acceptor: target.acceptor,
              name: nameRef.current,
              score,
              quality: qualityRef.current,
              hooks,
            })
          : new Session({
              role: "guest",
              transport: target.transport,
              name: nameRef.current,
              score,
              resume: takeOver?.resume,
              guest: guestId(),
              quality: qualityRef.current,
              hooks,
            });
      attach(session, shared);
      if (takeOver) liveResume(session, ownerRef.current, score.key, score.origin);
      else liveStart(session, ownerRef.current, score.key, score.origin);
      // The count of the session is kept as long as the session lives, in whichever tab.
      const stats = sessionAnalytics(Boolean(takeOver));
      session.subscribe((next) => stats.observe(next));
      setState(session.snapshot);
      if (target.role === "guest") (session as Session).start(target.link);
    },
    [
      makeHooks,
      attach,
      scoreRef,
      revisionRef,
      nameRef,
      qualityRef,
      tabs,
      ownerRef,
      originFor,
      inbox,
      sourceInbox,
    ],
  );

  /** Claims the live session for this tab (the session moves here, nothing is left or asked again). */
  const claiming = useRef(false);
  /** A claim that failed: not tried again until this tab is shown again. */
  const claimFailed = useRef(false);
  /** Moves the session here; true when it is here now, false when it was not moved. */
  const claim = useCallback(async (): Promise<boolean> => {
    const session = liveSession();
    const current = liveOwner();
    if (current?.id === id) return true;
    // One move at a time in the whole app: a second tab waits for this one to finish.
    if (!session || claiming.current || liveSnapshot().claiming) return false;
    claiming.current = true;
    liveBeginClaim();
    const attempt = attemptRef.current;
    // The tab closed or the session was left while this waited: nothing is moved.
    const stale = () => attemptRef.current !== attempt || liveSession() !== session;
    const abandon = () => {
      liveAbortClaim();
      return false;
    };
    try {
      // The new tab's fingerprint is read first, so the session is without an owner only briefly.
      const fingerprint = await tabs.fingerprint(
        scoreRef.current,
        revisionRef.current,
        originFor(session.role),
      );
      if (stale()) return abandon();
      // The host's tab pauses everybody before the session leaves it.
      await current?.pause();
      if (stale()) return abandon();
      const carry = current
        ? current.release()
        : (liveCarry() ?? { hostCode: null, approvals: [] });
      const { shared, hooks } = makeHooks();
      session.rebind(hooks);
      attach(session, shared);
      liveSetOwner(ownerRef.current, fingerprint.key, session, fingerprint.origin);
      setHostCode(carry.hostCode);
      for (const entry of carry.approvals) enqueue(entry);
      setState(session.snapshot);
      // A guest that does not have this tab is sent it; one that does, shows it.
      session.setScore(fingerprint);
      // The tab that played was closed and could not stop the guests: they stop now.
      if (carry.stopGuests && session instanceof HostRoom) {
        session.stopAll(commandOf("pause", playerRef.current?.getTick() ?? 0, practiceRef.current));
      }
      claimFailed.current = false;
      void playerRef.current?.warmUpAudio().catch(() => {});
      return true;
    } catch {
      claimFailed.current = true;
      return abandon();
    } finally {
      claiming.current = false;
    }
  }, [
    id,
    tabs,
    scoreRef,
    revisionRef,
    makeHooks,
    attach,
    ownerRef,
    enqueue,
    playerRef,
    practiceRef,
    originFor,
  ]);

  // The session was asked to move here (the host showed a tab this app has, or the owner closed).
  // While another tab is moving it, this waits and goes next, so the last request is the one kept.
  useEffect(() => {
    if (live.wanted !== id || live.ownerId === id || live.claiming) return;
    // Not in the effect itself: the move sets state in this tab and in the one it leaves.
    const timer = setTimeout(() => {
      liveClearWanted(id);
      void claim();
    }, 0);
    return () => clearTimeout(timer);
  }, [live.wanted, live.ownerId, live.claiming, id, claim]);

  // A host that shows a tab that is in the session takes the session along: while this tab is
  // shown, is in the session and does not hold it, it claims it (once the move in progress, if
  // any, is done). A failed move is not tried again until the tab is shown again.
  const includedHere = live.ids.includes(id);
  const owns = live.ownerId === id;
  const isHost = live.role === "host";
  useEffect(() => {
    if (!active) claimFailed.current = false;
    if (!active || !isHost || !includedHere || owns || live.claiming || claimFailed.current) return;
    const timer = setTimeout(() => void claim(), 0);
    return () => clearTimeout(timer);
  }, [active, isHost, includedHere, owns, live.claiming, claim]);

  // While a session is live, each tab's fingerprint is known, so the other app's offer can be
  // answered ("I have that tab") and the tab found.
  const liveOn = live.live;
  const liveRole = live.role;
  useEffect(() => {
    if (!liveOn || !liveRole) return;
    let current = true;
    const timer = setTimeout(
      () =>
        void tabs
          .fingerprint(score, revision, originFor(liveRole))
          .then((fingerprint) => current && liveSetKey(id, fingerprint.key, fingerprint.origin)),
      FINGERPRINT_DEBOUNCE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [liveOn, liveRole, score, revision, tabs, id, originFor]);

  const host = useCallback(
    async (kind: ConnectionKind) => {
      end();
      const attempt = attemptRef.current;
      // This click is what lets the page start sound later, when the other computer says Play.
      void playerRef.current?.warmUpAudio().catch(() => {});
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") {
          const { acceptor, info } = await hostOnLan();
          // The song was closed (or another session started) while connecting: let go of it.
          if (attemptRef.current !== attempt) return void acceptor.close();
          setHostCode({ kind, code: info.code, address: info.address });
          await open({ role: "host", acceptor });
          hosted(kind);
        } else {
          const { acceptor, code } = await hostOverInternet();
          if (attemptRef.current !== attempt) return void acceptor.close();
          setHostCode({ kind, code });
          await open({ role: "host", acceptor });
          hosted(kind);
        }
      } catch (e) {
        end();
        setupFailed(kind);
        setError(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [end, open, playerRef],
  );

  const join = useCallback(
    async (kind: ConnectionKind, code: string, again = false) => {
      end();
      const attempt = attemptRef.current;
      // This click is what lets the page start sound later, when the other computer says Play.
      void playerRef.current?.warmUpAudio().catch(() => {});
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") {
          const transport = await joinOnLan(code);
          if (attemptRef.current !== attempt) return void transport.close();
          await open({ role: "guest", transport, link: "open" });
        } else {
          const transport = await joinOverInternet(code, undefined, guestId());
          if (attemptRef.current !== attempt) return void transport.close();
          await open({ role: "guest", transport, link: "connecting" });
        }
        // Remembered so that a drop (or a dead battery) can be answered with one click.
        const last: LastSession = { kind, code, at: Date.now() };
        rememberSession(last);
        setLastSession(last);
        if (again) rejoined(kind);
        else joined(kind);
      } catch (e) {
        end();
        setupFailed(kind);
        setError(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [end, open, playerRef],
  );

  /** Joins the session this app was last in again. */
  const rejoin = useCallback(async () => {
    const last = readLastSession();
    if (!last) {
      setLastSession(null);
      return;
    }
    await join(last.kind, last.code, true);
  }, [join]);

  /** Leaves on purpose: there is nothing to come back to. */
  const leave = useCallback(() => {
    forgetSession();
    setLastSession(null);
    end();
  }, [end]);

  const syncTab = useCallback(() => {
    const session = sessionRef.current;
    if (session instanceof HostRoom) session.shareTabAgain();
  }, []);

  const kick = useCallback((id: string) => {
    const session = sessionRef.current;
    if (session instanceof HostRoom) {
      session.kick(id);
      playerRemoved("kick");
    }
  }, []);

  const ban = useCallback((id: string) => {
    const session = sessionRef.current;
    if (session instanceof HostRoom) {
      session.ban(id);
      playerRemoved("ban");
    }
  }, []);

  // This tab is the host's, just received: the connection that brought it moves here.
  const receivedKey = received?.key;
  useEffect(() => {
    if (!receivedKey) return;
    // Not at once: React may run an effect, undo it and run it again while a tab mounts.
    const timer = setTimeout(() => {
      const handoff = takeHandoff(receivedKey);
      if (!handoff) return;
      tabs.trust(receivedKey, revisionRef.current);
      const fingerprint = {
        key: receivedKey,
        bars: scoreRef.current.masterBars.length,
        origin: receivedOriginRef.current,
      };
      void open({
        role: "guest",
        transport: handoff.transport,
        link: "open",
        takeOver: { resume: handoff.session ?? undefined, fingerprint },
      }).catch(() => handoff.transport.close());
    }, 0);
    return () => clearTimeout(timer);
  }, [receivedKey, open, tabs, revisionRef, scoreRef, receivedOriginRef]);

  // A different score, or an edit: the other app checks it against its own.
  const connected = state !== null;
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !connected) return;
    let current = true;
    const timer = setTimeout(
      () =>
        void tabs
          .fingerprint(score, revision, originFor(session.role))
          .then((fingerprint) => current && session.setScore(fingerprint)),
      FINGERPRINT_DEBOUNCE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [score, revision, connected, tabs, originFor]);

  // The host's speed, loop, metronome and count-in follow to the guest.
  const lastShared = useRef<PracticeState | null>(null);
  const phase = state?.phase;
  const edit = useSharedEditing({
    editor,
    session: liveSession(),
    owns,
    phase,
    receivedSeq: received?.seq,
    receivedKey: received?.key,
    currentKey: async () =>
      (await tabs.fingerprint(scoreRef.current, revisionRef.current, undefined)).key,
    guestId: guestId(),
    hostName: name,
    inbox,
    snapshotRef,
  });
  const sources = useSourceSync({
    session: liveSession(),
    owns,
    phase,
    inbox: sourceInbox,
    // The audio files wait while the song plays: its timing comes first.
    paused: () => playerRef.current?.isPlaying() ?? false,
  });
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || session.role !== "host" || phase !== "synchronized") {
      lastShared.current = null;
      return;
    }
    if (lastShared.current === null) {
      lastShared.current = practice;
      return;
    }
    if (sameSettings(lastShared.current, practice)) return;
    const timer = setTimeout(() => {
      lastShared.current = practice;
      const tick = playerRef.current?.getTick() ?? 0;
      void session.command(commandOf("settings", tick, practice));
    }, 150);
    return () => clearTimeout(timer);
  }, [practice, phase, playerRef]);

  // Problems that need telling right when they happen.
  const lastProblem = useRef<string | null>(null);
  const problem = state?.problem ?? null;
  useEffect(() => {
    const key = problem ? `${problem.kind}:${problem.message}` : null;
    if (key === lastProblem.current) return;
    lastProblem.current = key;
    if (problem && TOAST_KINDS.has(problem.kind)) toast.warning(problem.message);
  }, [problem]);

  const intercept = useCallback(
    (request: TogetherRequest): boolean => {
      // The session is on its way to this tab: nothing plays on its own meanwhile.
      // (The tab that holds the session still acts: the host's pause as its tab goes to the back
      // is what stops the guests before the session moves.)
      const moving = liveSnapshot();
      if (moving.claiming && moving.ownerId !== id && moving.ids.includes(id)) return true;
      // A tab of the session that is not the one in play does not play on its own: the one that
      // plays is the host's tab, and a guest's other tabs stay quiet until the host moves to them.
      if (moving.live && moving.ownerId !== id && moving.ids.includes(id) && !sessionRef.current) {
        toast.info(
          moving.role === "guest"
            ? "This tab is not the one in play."
            : "This tab is not the one in play yet.",
          {
            description:
              moving.role === "guest"
                ? "The host chooses which tab plays: it moves here when the host shows this tab."
                : "Show this tab to play it in the session, or use Add this tab to the session.",
            id: "together-not-in-play",
          },
        );
        return true;
      }
      const session = sessionRef.current;
      const current = session?.snapshot.phase;
      if (!session || (current !== "syncing" && current !== "synchronized")) return false;
      const player = playerRef.current;
      if (!player) return false;
      const isHost = session.role === "host";
      // A host that is still waiting for the clocks plays on its own.
      if (isHost && current !== "synchronized") return false;
      if (current !== "synchronized") {
        toast.info("Wait a moment: the two computers are still syncing their clocks.");
        return true;
      }
      const moves = request.kind === "seekBar" || request.kind === "playFromBar";
      if (moves && player.isPlaying()) {
        // A different place would put the two computers out of step: only while stopped.
        toast.info("Pause or stop first to move to another bar in a Practice together session.", {
          id: "together-seek",
        });
        return true;
      }
      let action: RequestAction;
      let tick: number | undefined;
      switch (request.kind) {
        case "playPause":
          action = player.isPlaying() ? "pause" : "play";
          break;
        case "stop":
          action = "stop";
          tick = 0;
          break;
        case "seekBar":
          action = "seek";
          tick = player.barStartTick(request.bar);
          break;
        case "playFromBar":
          action = "play";
          tick = player.barStartTick(request.bar);
          break;
      }
      // Guests check their own files too: the host would hold the start back anyway.
      if (action === "play" && !isHost && !sourcesRef.current?.complete()) {
        toastFilesMissing(sourcesRef.current);
        return true;
      }
      if (isHost) startFor(action, tick ?? player.getTick());
      else if (!session.request(action, tick)) {
        // The clocks are being synced again: the host would not act on it.
        toast.info("Wait a moment: the two computers are still syncing their clocks.", {
          id: "together-start",
        });
      }
      return true;
    },
    [playerRef, startFor, id],
  );

  const elsewhere = useMemo(
    () =>
      live.live && !owns && live.role
        ? { role: live.role, tabs: live.ids.length, here: includedHere }
        : null,
    [live.live, live.role, live.ids.length, owns, includedHere],
  );
  const addToSession = useCallback(async () => {
    if (liveSnapshot().role !== "host") return;
    if (!(await claim())) {
      throw new Error("This tab could not be added to the session. Try again in a moment.");
    }
  }, [claim]);

  const isGuestHere =
    (state?.role === "guest" && state.phase !== "closed" && state.phase !== "failed") ||
    (live.live && live.role === "guest" && includedHere);

  return useMemo(
    () => ({
      state,
      hostCode,
      approval,
      approvalsWaiting,
      lastSession,
      quality,
      name,
      starting,
      error,
      internetAvailable,
      transfer: state?.transfer ?? null,
      // A guest's tabs of the session follow the host's. A guest edits the one it shares with the
      // host (the session's tab) along with the host, when the host allows it.
      readOnly: isGuestHere && !edit.editable,
      isGuest: isGuestHere,
      edit,
      sources,
      elsewhere,
      tabsInSession: live.live ? live.ids.length : 0,
      addToSession,
      setName: (next: string) => {
        setNameState(next);
        try {
          localStorage.setItem(NAME_KEY, next);
        } catch {
          // Not remembered.
        }
      },
      setQuality: (choice: QualityChoice) => {
        setQualityState(choice);
        storeQualityChoice(choice);
        presetChosen(choice);
        sessionRef.current?.setQuality(choice);
      },
      host,
      join: (kind: ConnectionKind, code: string) => join(kind, code),
      rejoin,
      leave,
      syncTab,
      kick,
      ban,
      intercept,
    }),
    [
      state,
      hostCode,
      approval,
      approvalsWaiting,
      lastSession,
      quality,
      name,
      starting,
      error,
      internetAvailable,
      host,
      join,
      rejoin,
      leave,
      syncTab,
      kick,
      ban,
      intercept,
      live.live,
      live.ids.length,
      elsewhere,
      addToSession,
      isGuestHere,
      edit,
      sources,
    ],
  );
}
