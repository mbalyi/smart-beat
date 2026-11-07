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
  presetChosen,
  sessionAnalytics,
  setupFailed,
  sharedStart,
} from "@/lib/practice-together/analytics";
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
import type { PeerTransport } from "@/lib/practice-together/transport";
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
  /** A guest waiting for the host's yes. */
  approval: { name: string; answer: (ok: boolean) => void } | null;
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
  leave(): void;
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

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || "Player";
  } catch {
    return "Player";
  }
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
  const [approval, setApproval] = useState<PracticeTogether["approval"]>(null);
  const [quality, setQualityState] = useState<QualityChoice>(readQualityChoice);
  const [name, setNameState] = useState(readName);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internetAvailable, setInternetAvailable] = useState(false);

  const sessionRef = useRef<Session | null>(null);
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

  const end = useCallback(() => {
    sessionRef.current?.leave();
    sessionRef.current = null;
    sharedRef.current?.release();
    sharedRef.current = null;
    setState(null);
    setHostCode(null);
    setApproval(null);
  }, []);

  // A session ends with its song.
  useEffect(() => end, [end]);

  /** A guest got the host's tab: the connection moves to the workspace that opens it. */
  const detach = useCallback(
    (key: string) => {
      const session = sessionRef.current;
      if (!session) return;
      const { transport, session: id, peerName } = session.release();
      sessionRef.current = null;
      sharedRef.current?.release();
      sharedRef.current = null;
      putHandoff({ transport, session: id, peerName, key, quality: qualityRef.current });
      setState(null);
      setHostCode(null);
      setApproval(null);
    },
    [qualityRef],
  );
  useEffect(() => {
    detachRef.current = detach;
  }, [detach]);

  /** The host: starts `action` on both computers at the same moment. */
  const startFor = useCallback(
    (action: RequestAction, tick: number) => {
      const session = sessionRef.current;
      if (session?.role === "host")
        void session.command(commandOf(action, tick, practiceRef.current));
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

  /** Builds the session around a transport. `link`: the state the transport is already in. */
  const open = useCallback(
    async (
      role: "host" | "guest",
      transport: PeerTransport,
      link: "connecting" | "open",
      /** A guest taking over a live connection: the session it was welcomed to, and its tab. */
      takeOver?: { resume?: string; fingerprint: ScoreFingerprint },
    ) => {
      const shared = new SharedTransport({
        player: () => playerRef.current,
        applySettings: (cmd) => {
          for (const action of actionsFor(practiceRef.current, cmd)) dispatchRef.current(action);
        },
      });
      const session = new Session({
        role,
        transport,
        name: nameRef.current,
        score:
          takeOver?.fingerprint ?? (await tabs.fingerprint(scoreRef.current, revisionRef.current)),
        resume: takeOver?.resume,
        quality: qualityRef.current,
        hooks: {
          ...shared.hooks,
          schedule: (cmd, localAt) => {
            if (cmd.action === "play") sharedStart();
            return shared.hooks.schedule(cmd, localAt);
          },
          tab: tabs.hooks,
          request: answer,
          approve: (guest) =>
            new Promise<boolean>((resolve) =>
              setApproval({
                name: guest,
                answer: (ok) => {
                  setApproval(null);
                  resolve(ok);
                },
              }),
            ),
        },
      });
      sessionRef.current = session;
      sharedRef.current = shared;
      session.subscribe(setState);
      const stats = sessionAnalytics(Boolean(takeOver));
      session.subscribe((next) => stats.observe(next));
      setState(session.snapshot);
      session.start(link);
    },
    [playerRef, practiceRef, dispatchRef, scoreRef, qualityRef, nameRef, answer, tabs, revisionRef],
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
          const { transport, info } = await hostOnLan();
          setHostCode({ kind, code: info.code, address: info.address });
          await open("host", transport, "connecting");
          hosted(kind);
        } else {
          const { transport, code } = await hostOverInternet();
          setHostCode({ kind, code });
          await open("host", transport, "connecting");
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
    async (kind: ConnectionKind, code: string) => {
      end();
      // This click is what lets the page start sound later, when the other computer says Play.
      void playerRef.current?.warmUpAudio().catch(() => {});
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") await open("guest", await joinOnLan(code), "open");
        else await open("guest", await joinOverInternet(code), "connecting");
        joined(kind);
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
      void open("guest", handoff.transport, "open", {
        resume: handoff.session ?? undefined,
        fingerprint,
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
      else session.request(action, tick);
      return true;
    },
    [playerRef, startFor],
  );

  return useMemo(
    () => ({
      state,
      hostCode,
      approval,
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
      join,
      leave: end,
      intercept,
    }),
    [
      state,
      hostCode,
      approval,
      quality,
      name,
      starting,
      error,
      internetAvailable,
      host,
      join,
      end,
      intercept,
    ],
  );
}
