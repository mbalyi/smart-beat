import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";

import { useTabSharing, type ReceivedScore } from "@/hooks/use-tab-sharing";
import { putHandoff, takeHandoff } from "@/lib/practice-together/handoff";
import {
  hosted,
  joined,
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
import { actionsFor, commandOf, sameSettings } from "@/lib/practice-together/practice-sync";
import {
  readQualityChoice,
  storeQualityChoice,
  type QualityChoice,
} from "@/lib/practice-together/quality-presets";
import { hostOverInternet, joinOverInternet, rtcSupported } from "@/lib/practice-together/rtc";
import { Session, type SessionState } from "@/lib/practice-together/session";
import { SharedTransport, type TransportPlayer } from "@/lib/practice-together/shared-transport";
import type { RequestAction, ScoreFingerprint } from "@/lib/practice-together/protocol";
import type { TabProgress } from "@/lib/practice-together/tab-transfer";
import type { GuestAcceptor, PeerTransport } from "@/lib/practice-together/transport";
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
  hostCode: { kind: ConnectionKind; code: string; address?: string } | null;
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
  /** A guest follows the host's tab: it is not edited here until the session ends. */
  readOnly?: boolean;
  setName(name: string): void;
  setQuality(choice: QualityChoice): void;
  host(kind: ConnectionKind): Promise<void>;
  join(kind: ConnectionKind, code: string): Promise<void>;
  /** Joins the session this app was last in again (after a drop, or when its battery ran out). */
  rejoin(): Promise<void>;
  leave(): void;
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
  /** This song is the host's tab, received in a session: its fingerprint and who sent it. */
  received?: { key: string; from: string };
  /** A guest got the host's tab: open it as a tab of its own (the session moves along). */
  onReceiveTab?: (tab: ReceivedScore) => void;
}

const NAME_KEY = "smart-beat:practice-together:name";

/** Ends after which the session is not offered again: it is over, or this guest is not welcome. */
const FORGET_KINDS = new Set(["peer-left", "banned", "declined", "version"]);

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || "Player";
  } catch {
    return "Player";
  }
}

/** A guest waiting for the host's yes. */
interface ApprovalEntry {
  name: string;
  resolve: (ok: boolean) => void;
}

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
const TOAST_KINDS = new Set(["late", "poor", "dropped", "woke", "tab", "peer-left"]);

/** A burst of edits is fingerprinted once, this long after the last one. */
const FINGERPRINT_DEBOUNCE_MS = 200;

export function usePracticeTogether({
  playerRef,
  practice,
  dispatchPractice,
  score,
  revision,
  title = "Song",
  received,
  onReceiveTab,
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
  const tabs = useTabSharing({ scoreRef, titleRef, revisionRef, detachRef, receiveRef });

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

  const end = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    sharedRef.current?.release();
    sharedRef.current = null;
    setState(null);
    setHostCode(null);
    clearApprovals();
  }, [clearApprovals]);

  // A session ends with its song.
  useEffect(() => end, [end]);

  /** A guest got the host's tab: the connection moves to the workspace that opens it. */
  const detach = useCallback(
    (key: string) => {
      const session = sessionRef.current;
      // Only a guest moves along with the tab it received.
      if (!(session instanceof Session)) return;
      const { transport, session: id, peerName } = session.release();
      sessionRef.current = null;
      sharedRef.current?.release();
      sharedRef.current = null;
      putHandoff({ transport, session: id, peerName, key, quality: qualityRef.current });
      setState(null);
      setHostCode(null);
      clearApprovals();
    },
    [qualityRef, clearApprovals],
  );
  useEffect(() => {
    detachRef.current = detach;
  }, [detach]);

  /** The host: starts `action` on both computers at the same moment. */
  const startFor = useCallback(
    (action: RequestAction, tick: number) => {
      const session = sessionRef.current;
      if (session?.role !== "host") return;
      void session.command(commandOf(action, tick, practiceRef.current)).then((result) => {
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
      const shared = new SharedTransport({
        player: () => playerRef.current,
        applySettings: (cmd) => {
          for (const action of actionsFor(practiceRef.current, cmd)) dispatchRef.current(action);
        },
      });
      const takeOver = target.role === "guest" ? target.takeOver : undefined;
      const hooks = {
        ...shared.hooks,
        schedule: (cmd: Parameters<typeof shared.hooks.schedule>[0], localAt: number) => {
          if (cmd.action === "play") sharedStart();
          return shared.hooks.schedule(cmd, localAt);
        },
        tab: tabs.hooks,
        request: answer,
        approve: (guest: string, signal?: AbortSignal) =>
          new Promise<boolean>((resolve) => {
            const entry = { name: guest, resolve };
            enqueue(entry);
            // The guest went away before the host answered: take the question back.
            signal?.addEventListener("abort", () => settle(entry, false), { once: true });
          }),
      };
      const score =
        takeOver?.fingerprint ?? (await tabs.fingerprint(scoreRef.current, revisionRef.current));
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
      sessionRef.current = session;
      sharedRef.current = shared;
      session.subscribe(setState);
      if (target.role === "guest") session.subscribe(keepLast);
      const stats = sessionAnalytics(Boolean(takeOver));
      session.subscribe((next) => stats.observe(next));
      setState(session.snapshot);
      if (target.role === "guest") (session as Session).start(target.link);
    },
    [
      playerRef,
      practiceRef,
      dispatchRef,
      scoreRef,
      qualityRef,
      nameRef,
      answer,
      tabs,
      revisionRef,
      enqueue,
      settle,
      keepLast,
    ],
  );

  const host = useCallback(
    async (kind: ConnectionKind) => {
      end();
      // This click is what lets the page start sound later, when the other computer says Play.
      void playerRef.current?.warmUpAudio().catch(() => {});
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") {
          const { acceptor, info } = await hostOnLan();
          setHostCode({ kind, code: info.code, address: info.address });
          await open({ role: "host", acceptor });
          hosted(kind);
        } else {
          const { acceptor, code } = await hostOverInternet();
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
      // This click is what lets the page start sound later, when the other computer says Play.
      void playerRef.current?.warmUpAudio().catch(() => {});
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") {
          await open({ role: "guest", transport: await joinOnLan(code), link: "open" });
        } else {
          const transport = await joinOverInternet(code, undefined, guestId());
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
      const fingerprint = { key: receivedKey, bars: scoreRef.current.masterBars.length };
      void open({
        role: "guest",
        transport: handoff.transport,
        link: "open",
        takeOver: { resume: handoff.session ?? undefined, fingerprint },
      }).catch(() => handoff.transport.close());
    }, 0);
    return () => clearTimeout(timer);
  }, [receivedKey, open, tabs, revisionRef, scoreRef]);

  // A different score, or an edit: the other app checks it against its own.
  const connected = state !== null;
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !connected) return;
    let current = true;
    const timer = setTimeout(
      () =>
        void tabs
          .fingerprint(score, revision)
          .then((fingerprint) => current && session.setScore(fingerprint)),
      FINGERPRINT_DEBOUNCE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [score, revision, connected, tabs]);

  // The host's speed, loop, metronome and count-in follow to the guest.
  const lastShared = useRef<PracticeState | null>(null);
  const phase = state?.phase;
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
      if (isHost) startFor(action, tick ?? player.getTick());
      else if (!session.request(action, tick)) {
        // The clocks are being synced again: the host would not act on it.
        toast.info("Wait a moment: the two computers are still syncing their clocks.", {
          id: "together-start",
        });
      }
      return true;
    },
    [playerRef, startFor],
  );

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
      readOnly: state?.role === "guest" && state.phase !== "closed" && state.phase !== "failed",
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
      kick,
      ban,
      intercept,
    ],
  );
}
