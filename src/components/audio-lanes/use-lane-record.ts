import { useEffect, useMemo, useRef, useState } from "react";

import type { LaneRecordControls } from "@/components/audio-lanes/lane-record-context";
import type { RecordAudioSetup } from "@/components/audio-lanes/use-record-audio";
import type { LiveInput } from "@/lib/audio/lane-monitor";
import { readAudioRecordPrefs, readHearMyself, storeHearMyself } from "@/lib/audio/record-prefs";
import { looksBuiltIn } from "@/lib/audio/input";
import type { AudioLane } from "@/lib/tauri";

/** What arming a lane needs of the rest of the app. */
export interface LaneRecordEnv {
  /** The song's audio lanes (a lane that is gone, a folder or a switched-off lane cannot be armed). */
  lanes: readonly Pick<AudioLane, "id" | "folder" | "enabled">[];
  /** A take is being recorded. */
  recording: boolean;
  /** The lane that take goes on, armed or not (Record audio can pick any lane; null: a new lane). */
  recordingLaneId: string | null;
  /** Starts a take, or stops (keep) or throws away the one in progress. */
  start: (setup: RecordAudioSetup) => void;
  stop: () => void;
  discard: () => void;
  /** Lends the live input to the player (null: the song's own monitor track again). */
  setLiveInput: (live: LiveInput | null) => void;
  /** Whether the native engine runs (the input is only heard through it). */
  engineOn: boolean;
  /** Switches to the native engine when hearing the input needs it (true: it runs). */
  ensureEngine: () => boolean;
  /** The audio input's name (Settings › Audio), for the built-in microphone default. */
  inputName: string | null;
}

/** Arming and recording on an audio lane (#249): one armed lane, the live input and the keys. */
export function useLaneRecord(env: LaneRecordEnv) {
  const { lanes, recording, start, stop, discard, setLiveInput, engineOn, ensureEngine } = env;
  const [armed, setArmed] = useState<string | null>(null);
  const [hear, setHearState] = useState<boolean | null>(null);
  // The lane stays armed only while it can record: not deleted, not a folder, not switched off.
  const armedId = lanes.some((l) => l.id === armed && !l.folder && l.enabled) ? armed : null;
  const hearing = hear ?? readHearMyself(looksBuiltIn(env.inputName));

  const setHear = (value: boolean) => {
    storeHearMyself(value);
    setHearState(value);
    // Hearing the input needs the native engine; the app switches to it for the take.
    if (value && armedId && !engineOn) ensureEngine();
  };

  // The engine plays what the armed lane, or the lane being recorded, asks for; letting go gives
  // the song's monitor track back. Nothing is sent while no lane was ever armed or recorded.
  const lent = useRef(false);
  /** What the engine is asked for a lane: the input heard (armed lane only), its clips quiet. */
  const liveFor = (laneId: string | null, silence: boolean): LiveInput | null =>
    laneId ? { laneId, hear: laneId === armedId && hearing && engineOn, silence } : null;
  const target = recording && env.recordingLaneId ? env.recordingLaneId : armedId;
  useEffect(() => {
    if (!target && !lent.current) return;
    lent.current = target !== null;
    setLiveInput(liveFor(target, recording));
    // `liveFor` is rebuilt from the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, armedId, hearing, recording, engineOn, setLiveInput]);
  useEffect(
    () => () => {
      if (lent.current) setLiveInput(null);
    },
    [setLiveInput],
  );

  const toggle = (laneId: string) => {
    if (recording) {
      if (laneId === armedId) stop();
      return;
    }
    if (laneId !== armedId) {
      setArmed(laneId);
      if (hearing && !engineOn) ensureEngine();
      return;
    }
    start({ laneId, ...readAudioRecordPrefs() });
  };

  // Space keeps the take, Escape throws it away: before the player's own Space handling.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== " " && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "Escape") discard();
      else stop();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording, stop, discard]);

  const controls = useMemo<LaneRecordControls>(
    () => ({ armedId, recording, toggle }),
    // `toggle` closes over the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [armedId, recording, hearing, engineOn, start, stop],
  );
  return {
    controls,
    armedId,
    hear: hearing,
    setHear,
    disarm: () => setArmed(null),
    /** Quiets the lane's clips before the song starts for a take (the effect follows a render later). */
    beforeTake: (laneId: string | null) => {
      if (!laneId) return;
      lent.current = true;
      setLiveInput(liveFor(laneId, true));
    },
    /** Starts the take on the armed lane (the armed bar's button). */
    record: () => {
      if (armedId && !recording) start({ laneId: armedId, ...readAudioRecordPrefs() });
    },
  };
}
