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

import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
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
  /** This player follows the host: the transport buttons are the host's. */
  locked: boolean;
  setName(name: string): void;
  setQuality(choice: QualityChoice): void;
  host(kind: ConnectionKind): Promise<void>;
  join(kind: ConnectionKind, code: string): Promise<void>;
  leave(): void;
  /** Routes a transport request through the session. True when it was handled. */
  intercept(request: TogetherRequest): boolean;
}

interface Options {
  playerRef: RefObject<TogetherPlayer | null>;
  practice: PracticeState;
  dispatchPractice: (action: PracticeAction) => void;
  score: Score;
  /** Changes with every edit of the score. */
  revision: number;
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
const TOAST_KINDS = new Set(["late", "poor", "dropped", "woke", "score", "peer-left"]);

export function usePracticeTogether({
  playerRef,
  practice,
  dispatchPractice,
  score,
  revision,
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

  /** Builds the session around a transport. `link`: the state the transport is already in. */
  const open = useCallback(
    async (role: "host" | "guest", transport: PeerTransport, link: "connecting" | "open") => {
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
        score: await scoreFingerprint(scoreRef.current),
        quality: qualityRef.current,
        hooks: {
          ...shared.hooks,
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
      shared.bind(session);
      sessionRef.current = session;
      sharedRef.current = shared;
      session.subscribe(setState);
      setState(session.snapshot);
      session.start(link);
    },
    [playerRef, practiceRef, dispatchRef, scoreRef, qualityRef, nameRef],
  );

  const host = useCallback(
    async (kind: ConnectionKind) => {
      end();
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") {
          const { transport, info } = await hostOnLan();
          setHostCode({ kind, code: info.code, address: info.address });
          await open("host", transport, "connecting");
        } else {
          const { transport, code } = await hostOverInternet();
          setHostCode({ kind, code });
          await open("host", transport, "connecting");
        }
      } catch (e) {
        end();
        setError(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [end, open],
  );

  const join = useCallback(
    async (kind: ConnectionKind, code: string) => {
      end();
      setError(null);
      setStarting(true);
      try {
        if (kind === "lan") await open("guest", await joinOnLan(code), "open");
        else await open("guest", await joinOverInternet(code), "connecting");
      } catch (e) {
        end();
        setError(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [end, open],
  );

  // A different score, or an edit: the other app checks it against its own.
  const connected = state !== null;
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || !connected) return;
    let current = true;
    void scoreFingerprint(score).then((fingerprint) => current && session.setScore(fingerprint));
    return () => {
      current = false;
    };
  }, [score, revision, connected]);

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
      if (session.role === "guest") {
        toast.info("The host controls playback in a Practice together session.");
        return true;
      }
      // A host that is still waiting for the clocks plays on its own.
      if (current !== "synchronized") return false;
      const player = playerRef.current;
      if (!player) return false;
      const settings = practiceRef.current;
      const send = (action: Parameters<typeof commandOf>[0], tick: number) =>
        void session.command(commandOf(action, tick, settings));
      switch (request.kind) {
        case "playPause":
          send(player.isPlaying() ? "pause" : "play", player.getTick());
          return true;
        case "stop":
          send("stop", 0);
          return true;
        case "seekBar":
          send("seek", player.barStartTick(request.bar));
          return true;
        case "playFromBar":
          send("play", player.barStartTick(request.bar));
          return true;
      }
    },
    [playerRef, practiceRef],
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
      locked:
        state?.role === "guest" && (state.phase === "syncing" || state.phase === "synchronized"),
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
