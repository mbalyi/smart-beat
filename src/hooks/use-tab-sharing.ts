import { useCallback, useMemo, useRef, type RefObject } from "react";

import { scoreFingerprint } from "@/lib/practice-together/fingerprint";
import type { ScoreFingerprint } from "@/lib/practice-together/protocol";
import type { TabHooks } from "@/lib/practice-together/session";
import type { Score } from "@/lib/score/model";

/** The host's tab, read and ready to be opened as a tab of its own. */
export interface ReceivedScore {
  score: Score;
  /** The song's name on the host's computer. */
  name: string;
  /** The score fingerprint of this version: the host's, whatever this app would compute. */
  key: string;
  /** Which of the host's tabs it is (see `ScoreFingerprint.origin`). */
  origin?: number;
  /** The host's name. */
  from: string;
}

interface Options {
  scoreRef: RefObject<Score>;
  /** This tab's id: what the host's offer says which of its tabs it is. */
  idRef?: RefObject<number>;
  /** The open song's name, shown to the guest. */
  titleRef: RefObject<string>;
  /** Changes with every edit of the score. */
  revisionRef: RefObject<number>;
  /** Moves the live connection out of this workspace for the tab with this key. */
  detachRef: RefObject<(key: string) => void>;
  /** Opens a received tab. Without it, a tab is not accepted. */
  receiveRef: RefObject<((tab: ReceivedScore) => void) | undefined>;
  /** Whether another open tab of this app has the song with this fingerprint key. */
  haveRef?: RefObject<((key: string, origin?: number) => boolean) | undefined>;
  /** Shows the open tab with this key and moves the session to it. */
  showRef?: RefObject<((key: string, origin?: number) => void) | undefined>;
}

/**
 * Practice together: sharing the tab (#158). The host offers its score as a Guitar Pro file; the
 * guest reads it and hands it to the app, which opens it as a tab and moves the session there.
 * A tab read from the host keeps the host's fingerprint until it is edited, so the two apps
 * agree even when saving and reading changed how the score is written out.
 */
export function useTabSharing({
  idRef,
  scoreRef,
  titleRef,
  revisionRef,
  detachRef,
  receiveRef,
  haveRef,
  showRef,
}: Options) {
  const pending = useRef<ReceivedScore | null>(null);
  const trusted = useRef<{ key: string; revision: number } | null>(null);

  /** The fingerprint of the score as it is now (`revision`: which edit it is). */
  const fingerprint = useCallback(
    async (score: Score, revision: number, origin?: number): Promise<ScoreFingerprint> => {
      const known = trusted.current;
      const base =
        known && known.revision === revision
          ? { key: known.key, bars: score.masterBars.length }
          : await scoreFingerprint(score);
      return origin === undefined ? base : { ...base, origin };
    },
    [],
  );

  /** This score is the host's version `key`, as it is at `revision`. */
  const trust = useCallback((key: string, revision: number) => {
    trusted.current = { key, revision };
  }, []);

  const hooks = useMemo<TabHooks>(
    () => ({
      offer: async () => {
        // alphaTab's writer is big: it loads when a tab is first shared.
        const { writeGp7 } = await import("@/lib/export/gp7");
        const score = scoreRef.current;
        // The file and the fingerprint must describe the same edit: read both in this step.
        const bytes = writeGp7(score);
        const origin = idRef?.current;
        const { key, bars } = await fingerprint(score, revisionRef.current, origin);
        return { name: titleRef.current, bytes, key, bars, origin };
      },
      receive: async (tab) => {
        if (!receiveRef.current) return "unsupported";
        try {
          const { loadSong } = await import("@/lib/import");
          const { score } = await loadSong(tab.bytes, "shared.gp");
          pending.current = {
            score,
            name: tab.name,
            key: tab.key,
            origin: tab.origin,
            from: tab.from,
          };
          return null;
        } catch {
          return "unreadable";
        }
      },
      opened: () => {
        const tab = pending.current;
        pending.current = null;
        const receive = receiveRef.current;
        if (!tab || !receive) return;
        detachRef.current(tab.key);
        receive(tab);
      },
      have: (key, origin) => haveRef?.current?.(key, origin) ?? false,
      show: (key, origin) => showRef?.current?.(key, origin),
    }),
    [idRef, scoreRef, titleRef, revisionRef, detachRef, receiveRef, haveRef, showRef, fingerprint],
  );

  // One object for as long as its parts stand: the effects that list it do not run on every render.
  return useMemo(() => ({ hooks, fingerprint, trust }), [hooks, fingerprint, trust]);
}
