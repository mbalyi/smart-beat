/**
 * Recording onto an audio lane (#249): the live input is heard through that lane's effects, and
 * the lane's own clips stay quiet under the take.
 *
 * Nothing here is saved with the song. The native engine plays the live input on its monitor
 * track, so an armed lane lends it the lane's effect chain, level and pan while it is armed
 * ({@link withLiveInput}); when the lane is let go the song's own monitor track is back. The take
 * itself is always recorded dry: the effects only change what the player hears.
 */
import { anyLaneSolo } from "@/lib/score/mixer";
import { lanesOf } from "@/lib/audio-lanes/model";
import { looksBuiltIn } from "@/lib/audio/input";
import { DEFAULT_MONITOR, describeLatency } from "@/lib/audio/monitor";
import type { MixerSettings, MonitorStatus, MonitorTrackSettings } from "@/lib/tauri";

/**
 * What an armed or recording lane asks of the engine. Hearing the input and keeping clips quiet
 * are separate: the armed lane lends its effects, while the lane a take goes on (armed or not)
 * is the one that goes quiet.
 */
export interface LiveInput {
  /** The lane whose effects the live input is heard through (null: the song's own monitor). */
  hearLane: string | null;
  /** The lane whose own clips are silent, a take being recorded onto it (null: none). */
  silentLane: string | null;
}

/** The input on the monitor track the way the armed lane would sound: its effects, level and pan. */
function laneMonitorTrack(mix: MixerSettings, laneId: string): MonitorTrackSettings | null {
  const lane = lanesOf(mix).lanes.find((l) => l.id === laneId && !l.folder);
  if (!lane) return null;
  // Heard alongside whatever is soloed, never muting (or being muted by) the rest of the mix.
  const soloed = anyLaneSolo(mix) || mix.tracks.some((t) => t.solo);
  return {
    ...DEFAULT_MONITOR,
    enabled: true,
    volume: lane.volume,
    pan: lane.pan,
    mute: false,
    solo: soloed,
    effects: lane.effects,
  };
}

/**
 * The mix the engine is given while a lane records: the lane's effects on the monitor track when
 * the player wants to hear themselves, and the lane's clips taken out while the take runs.
 * Without a live input (or for a lane that is gone) the mix is returned as it is.
 */
export function withLiveInput(mix: MixerSettings, live: LiveInput | null): MixerSettings {
  if (!live) return mix;
  const monitor = live.hearLane ? laneMonitorTrack(mix, live.hearLane) : null;
  const audio = lanesOf(mix);
  const silent =
    live.silentLane !== null &&
    audio.lanes.some((l) => l.id === live.silentLane && l.clips.length > 0);
  if (!monitor && !silent) return mix;
  return {
    ...mix,
    ...(monitor ? { monitor } : {}),
    ...(silent
      ? {
          audio: {
            ...audio,
            lanes: audio.lanes.map((l) => (l.id === live.silentLane ? { ...l, clips: [] } : l)),
          },
        }
      : {}),
  };
}

/**
 * Whether the audio input may be the computer's own microphone: it is named so, or it is the
 * system default, which cannot be told from here (a laptop's default is its built-in microphone).
 * Hearing it through speakers would feed back, so it is not heard until the player says so.
 */
export function maybeBuiltInInput(label: string | null | undefined): boolean {
  return !label?.trim() || looksBuiltIn(label);
}

/** What the armed lane's input says about itself: where it listens and how late it is heard. */
export function describeLiveInput(input: {
  hear: boolean;
  engineOn: boolean;
  inputName: string;
  /** The input's channel (null: all of them mixed). */
  channel: number | null;
  status: MonitorStatus | null;
}): { text: string; problem: boolean } {
  const { hear, engineOn, inputName, channel, status } = input;
  const where =
    channel === null ? `${inputName}, all inputs` : `${inputName}, input ${channel + 1}`;
  if (!hear) return { text: `${where} · not heard`, problem: false };
  if (!engineOn) {
    return {
      text: "Hearing yourself needs effects playback (the native audio engine)",
      problem: true,
    };
  }
  if (status?.error) return { text: status.error, problem: true };
  if (!status?.open) return { text: `Opening ${inputName}…`, problem: false };
  return { text: `${where} · about ${describeLatency(status.latencyMs)} delay`, problem: false };
}
