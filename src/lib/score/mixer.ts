/**
 * Mixer state: master volume and pan, volume, pan, mute and solo per track,
 * and for the native audio engine the effect chains (several sounds per
 * track), channel EQ, automation, focus, the drum mixer, the audio track and the
 * monitor track.
 */
import { MAX_TRACK_EFFECTS, type EffectSlot } from "@/lib/audio/effects";
import {
  DEFAULT_INTERPRETATION,
  normalizeInterpretation,
  type Interpretation,
} from "@/lib/score/interpretation";
import type { ScoreSummary } from "@/lib/score/score";
import { isTrackColor } from "@/lib/score/track-colors";
import {
  MIXER_SETTINGS_MIN_VERSION,
  MIXER_SETTINGS_VERSION,
  type AudioTrackSettings,
  type AutomationLaneKind,
  type AutomationPoint,
  type DrumMixer,
  type FocusMode,
  type MixerSettings,
  type MonitorTrackSettings,
  type SongPreset,
  type TrackAutomation,
  type TrackEq,
  type TrackMix,
  type TrackSounds,
} from "@/lib/tauri";

/** Pan changes regenerate the MIDI, so they're applied when the user lets go. */
export type MixerChange = (action: MixerAction, options?: { commit: boolean }) => void;

export type MixerAction =
  | { type: "master"; value: number }
  | { type: "master-pan"; value: number }
  | { type: "volume"; track: number; value: number }
  | { type: "pan"; track: number; value: number }
  | { type: "mute"; track: number; value: boolean }
  | { type: "solo"; track: number; value: boolean }
  /** The chain of a track's first sound. */
  | { type: "effects"; track: number; slots: EffectSlot[] }
  /** The chain of one sound of a track. */
  | { type: "sound-effects"; track: number; sound: number; slots: EffectSlot[] }
  /** All sounds of a track and their switches (null: back to one sound). */
  | { type: "sounds"; track: number; sounds: TrackSounds | null }
  | { type: "master-effects"; slots: EffectSlot[] }
  | { type: "interpretation"; track: number; value: Interpretation }
  | { type: "eq"; track: number; eq: TrackEq }
  | { type: "automation"; track: number; automation: TrackAutomation }
  /**
   * Focus one track (null: none, the normal mix). Without a mode the current one stays; it is
   * saved with the song but never changes the faders, mutes and solos below it.
   */
  | { type: "focus"; track: number | null; mode?: FocusMode }
  /** A colour for a track's strip and bars (`#rrggbb`; null: the default one; #83). */
  | { type: "track-color"; track: number; color: string | null }
  /** Every track back to its default colour. */
  | { type: "reset-track-colors" }
  | { type: "drums"; track: number; drums: DrumMixer | null }
  /** Plays a drum track with an imported kit (#40; null: the SoundFont's own). */
  | { type: "drum-kit"; track: number; kit: string | null }
  | { type: "audio-track"; value: AudioTrackSettings | null }
  /** The monitor track (null removes it). */
  | { type: "monitor"; value: MonitorTrackSettings | null }
  | { type: "presets"; presets: SongPreset[] }
  /** Volumes, pans, mute and solo back to the file's; effects and the rest stay. */
  | { type: "reset"; mix: MixerSettings };

export const FLAT_EQ: TrackEq = { lowDb: 0, midDb: 0, midHz: 1000, highDb: 0 };
export const EMPTY_AUTOMATION: TrackAutomation = {
  enabled: false,
  volume: [],
  pan: [],
  mute: [],
};
/** Mirrors `MAX_SOUNDS` in `src-tauri/src/audio/engine.rs`. */
export const MAX_SOUNDS = 8;
/** How the focus switch changes the levels (dB). */
export const FOCUS_BOOST_DB = 3;
export const FOCUS_CUT_DB = -12;

/** The mix saved in the song file. */
export function mixFromScore(summary: ScoreSummary): MixerSettings {
  return {
    version: MIXER_SETTINGS_VERSION,
    master: 1,
    tracks: summary.tracks.map((track) => ({ ...track.mix })),
  };
}

/**
 * The mix to start with: the user's saved mix if it fits this song, otherwise
 * the one from the file. Older settings are upgraded.
 */
export function initialMix(summary: ScoreSummary, saved: MixerSettings | null): MixerSettings {
  const fromFile = mixFromScore(summary);
  if (
    !saved ||
    saved.version < MIXER_SETTINGS_MIN_VERSION ||
    saved.version > MIXER_SETTINGS_VERSION ||
    saved.tracks.length !== fromFile.tracks.length
  ) {
    return fromFile;
  }
  // Drum-tab lines belong to the score: they are put on its notes when it opens (#53).
  const mix: MixerSettings = { ...saved, version: MIXER_SETTINGS_VERSION };
  delete mix.drumLines;
  return mix;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function updateTrack(mix: MixerSettings, index: number, change: Partial<TrackMix>): MixerSettings {
  if (!mix.tracks[index]) return mix;
  return {
    ...mix,
    tracks: mix.tracks.map((track, i) => (i === index ? { ...track, ...change } : track)),
  };
}

/** A per-track list with `value` at `index` (and `fallback(i)` where unset). */
function perTrack<T>(
  mix: MixerSettings,
  list: readonly T[] | undefined,
  index: number,
  value: T,
  fallback: (i: number) => T,
): T[] {
  return mix.tracks.map((_, i) => (i === index ? value : (list?.[i] ?? fallback(i))));
}

/** Everything the mixer knows about one track; it follows the track when tracks move. */
export interface TrackState {
  mix: TrackMix;
  effects: EffectSlot[];
  interpretation: Interpretation;
  /** Null: the track has one sound (its chain is `effects`). */
  sounds: TrackSounds | null;
  eq: TrackEq;
  automation: TrackAutomation;
  drums: DrumMixer | null;
  /** The imported drum kit it plays (#40). */
  kit: string | null;
  /** The colour the user chose, `#rrggbb`. */
  color: string | null;
  focused: boolean;
}

export function trackStates(mix: MixerSettings): TrackState[] {
  return mix.tracks.map((track, i) => ({
    mix: track,
    effects: trackEffects(mix, i),
    interpretation: trackInterpretation(mix, i),
    sounds: trackSoundsOf(mix, i),
    eq: trackEq(mix, i),
    automation: trackAutomation(mix, i),
    drums: mix.drums?.[i] ?? null,
    kit: mix.drumKits?.[i] ?? null,
    color: mix.trackColors?.[i] ?? null,
    focused: mix.focus === i,
  }));
}

/** The mix with these tracks (in this order); master settings stay. */
export function withTrackStates(mix: MixerSettings, states: readonly TrackState[]): MixerSettings {
  const next: MixerSettings = {
    ...mix,
    version: MIXER_SETTINGS_VERSION,
    tracks: states.map((s) => s.mix),
    effects: states.map((s) => s.effects),
    interpretation: states.map((s) => s.interpretation),
  };
  const someSounds = states.some((s) => s.sounds);
  const someEq = states.some((s) => s.eq !== FLAT_EQ && !isFlat(s.eq));
  const someAutomation = states.some(
    (s) => s.automation.enabled || automationPointCount(s.automation) > 0,
  );
  const someDrums = states.some((s) => s.drums);
  next.sounds = someSounds
    ? states.map((s) => s.sounds ?? { sounds: [], switches: [] })
    : undefined;
  next.eq = someEq ? states.map((s) => s.eq) : undefined;
  next.automation = someAutomation ? states.map((s) => s.automation) : undefined;
  next.drums = someDrums ? states.map((s) => s.drums) : undefined;
  next.drumKits = states.some((s) => s.kit) ? states.map((s) => s.kit) : undefined;
  next.trackColors = states.some((s) => s.color) ? states.map((s) => s.color) : undefined;
  const focus = states.findIndex((s) => s.focused);
  next.focus = focus >= 0 ? focus : undefined;
  // No track in focus (it was removed): back to the normal mix.
  if (focus < 0) next.focusMode = undefined;
  return stripUndefined(next);
}

/** The mix without some optional settings. */
function without(mix: MixerSettings, ...keys: (keyof MixerSettings)[]): MixerSettings {
  const out = { ...mix };
  for (const key of keys) delete out[key];
  return out;
}

function stripUndefined(mix: MixerSettings): MixerSettings {
  const out = { ...mix } as Record<string, unknown>;
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out as unknown as MixerSettings;
}

export const isFlat = (eq: TrackEq) =>
  eq.graphic?.length === 10
    ? eq.graphic.every((g) => g === 0)
    : eq.lowDb === 0 && eq.midDb === 0 && eq.highDb === 0;

const automationPointCount = (a: TrackAutomation) => a.volume.length + a.pan.length + a.mute.length;

export function mixerReducer(mix: MixerSettings, action: MixerAction): MixerSettings {
  switch (action.type) {
    case "master":
      return { ...mix, master: clamp(action.value, 0, 1) };
    case "master-pan":
      return { ...mix, masterPan: clamp(action.value, -1, 1) };
    case "volume":
      return updateTrack(mix, action.track, { volume: clamp(action.value, 0, 1) });
    case "pan":
      return updateTrack(mix, action.track, { pan: clamp(action.value, -1, 1) });
    case "mute":
      return updateTrack(mix, action.track, { mute: action.value });
    case "solo":
      return updateTrack(mix, action.track, { solo: action.value });
    case "effects":
      return mixerReducer(mix, {
        type: "sound-effects",
        track: action.track,
        sound: 0,
        slots: action.slots,
      });
    case "sound-effects": {
      if (!mix.tracks[action.track]) return mix;
      const own = trackSoundsOf(mix, action.track);
      if (!own || action.sound === 0) {
        const effects = perTrack(mix, mix.effects, action.track, action.slots, () => []);
        if (!own) return { ...mix, effects };
        const sounds = own.sounds.map((s, i) => (i === 0 ? { ...s, effects: action.slots } : s));
        return withSounds({ ...mix, effects }, action.track, { ...own, sounds });
      }
      if (!own.sounds[action.sound]) return mix;
      const sounds = own.sounds.map((s, i) =>
        i === action.sound ? { ...s, effects: action.slots } : s,
      );
      return withSounds(mix, action.track, { ...own, sounds });
    }
    case "sounds": {
      if (!mix.tracks[action.track]) return mix;
      const value = normalizeSounds(action.sounds);
      const first = value?.sounds[0]?.effects ?? trackEffects(mix, action.track);
      const effects = perTrack(mix, mix.effects, action.track, first, () => []);
      return withSounds({ ...mix, effects }, action.track, value);
    }
    case "master-effects":
      return { ...mix, masterEffects: action.slots };
    case "interpretation": {
      if (!mix.tracks[action.track]) return mix;
      const interpretation = perTrack(
        mix,
        mix.interpretation,
        action.track,
        normalizeInterpretation(action.value),
        (i) => trackInterpretation(mix, i),
      );
      return { ...mix, interpretation };
    }
    case "eq": {
      if (!mix.tracks[action.track]) return mix;
      return {
        ...mix,
        eq: perTrack(mix, mix.eq, action.track, normalizeEq(action.eq), () => FLAT_EQ),
      };
    }
    case "automation": {
      if (!mix.tracks[action.track]) return mix;
      const automation = perTrack(
        mix,
        mix.automation,
        action.track,
        normalizeAutomation(action.automation),
        () => EMPTY_AUTOMATION,
      );
      return { ...mix, automation };
    }
    case "focus": {
      if (action.track === null || !mix.tracks[action.track]) {
        return without(mix, "focus", "focusMode");
      }
      const next = { ...mix, focus: action.track };
      if (action.mode === undefined) return next;
      // "The others are turned down" is the default and isn't written.
      return action.mode === "othersDown"
        ? without(next, "focusMode")
        : { ...next, focusMode: action.mode };
    }
    case "track-color": {
      if (!mix.tracks[action.track]) return mix;
      const color = isTrackColor(action.color) ? action.color.toLowerCase() : null;
      const trackColors = perTrack(mix, mix.trackColors, action.track, color, () => null);
      return trackColors.some(Boolean) ? { ...mix, trackColors } : without(mix, "trackColors");
    }
    case "reset-track-colors":
      return without(mix, "trackColors");
    case "drums": {
      if (!mix.tracks[action.track]) return mix;
      return { ...mix, drums: perTrack(mix, mix.drums, action.track, action.drums, () => null) };
    }
    case "drum-kit": {
      if (!mix.tracks[action.track]) return mix;
      return {
        ...mix,
        drumKits: perTrack(mix, mix.drumKits, action.track, action.kit, () => null),
      };
    }
    case "audio-track": {
      if (!action.value) return without(mix, "audioTrack");
      return { ...mix, audioTrack: normalizeAudioTrack(action.value) };
    }
    case "monitor": {
      if (!action.value) return without(mix, "monitor");
      return { ...mix, monitor: normalizeMonitor(action.value) };
    }
    case "presets":
      return { ...mix, presets: action.presets };
    case "reset":
      return {
        ...without(mix, "focus", "focusMode", "masterPan"),
        master: action.mix.master,
        tracks: action.mix.tracks,
      };
  }
}

function withSounds(mix: MixerSettings, track: number, value: TrackSounds | null): MixerSettings {
  const sounds = perTrack(mix, mix.sounds, track, value ?? { sounds: [], switches: [] }, () => ({
    sounds: [],
    switches: [],
  }));
  if (sounds.every((s) => s.sounds.length === 0)) return without(mix, "sounds");
  return { ...mix, sounds };
}

/** One sound is the same as none: a track with sounds has at least two. */
function normalizeSounds(value: TrackSounds | null): TrackSounds | null {
  if (!value || value.sounds.length < 2) return null;
  const sounds = value.sounds.slice(0, MAX_SOUNDS);
  const switches = value.switches
    .filter((s) => s.sound >= 0 && s.sound < sounds.length && s.bar >= 0)
    .map((s) => ({ bar: Math.round(s.bar), sound: s.sound }))
    .sort((a, b) => a.bar - b.bar)
    // One switch per bar: the last one wins.
    .filter((s, i, all) => all[i + 1]?.bar !== s.bar);
  return { sounds, switches };
}

function normalizeEq(eq: TrackEq): TrackEq {
  const gain = (g: number) => clamp(Number.isFinite(g) ? g : 0, -15, 15);
  const next: TrackEq = {
    lowDb: gain(eq.lowDb),
    midDb: gain(eq.midDb),
    midHz: clamp(Number.isFinite(eq.midHz) ? eq.midHz : 1000, 200, 5000),
    highDb: gain(eq.highDb),
  };
  if (eq.graphic?.length === 10) next.graphic = eq.graphic.map(gain);
  return next;
}

const LANE_RANGE: Record<AutomationLaneKind, [number, number]> = {
  volume: [0, 1],
  pan: [-1, 1],
  mute: [0, 1],
};

function normalizeLane(kind: AutomationLaneKind, points: readonly AutomationPoint[]) {
  const [min, max] = LANE_RANGE[kind];
  return points
    .filter((p) => Number.isFinite(p.bar) && Number.isFinite(p.value))
    .map((p) => ({
      bar: Math.max(0, p.bar),
      value: kind === "mute" ? (p.value >= 0.5 ? 1 : 0) : clamp(p.value, min, max),
    }))
    .sort((a, b) => a.bar - b.bar);
}

function normalizeAutomation(a: TrackAutomation): TrackAutomation {
  return {
    enabled: a.enabled,
    volume: normalizeLane("volume", a.volume),
    pan: normalizeLane("pan", a.pan),
    mute: normalizeLane("mute", a.mute),
  };
}

function normalizeAudioTrack(a: AudioTrackSettings): AudioTrackSettings {
  const sync = a.sync
    .filter((p) => p.bar >= 0 && Number.isFinite(p.ms) && p.ms >= 0)
    .map((p) => ({ bar: Math.round(p.bar), ms: p.ms }))
    .sort((x, y) => x.bar - y.bar)
    .filter((p, i, all) => all[i + 1]?.bar !== p.bar);
  return {
    ...a,
    volume: clamp(a.volume, 0, 1),
    pan: clamp(a.pan, -1, 1),
    semitones: clamp(Math.round(a.semitones), -24, 24),
    cents: clamp(Math.round(a.cents), -100, 100),
    eq: normalizeEq(a.eq),
    sync,
  };
}

function normalizeMonitor(m: MonitorTrackSettings): MonitorTrackSettings {
  return {
    enabled: m.enabled,
    volume: clamp(m.volume, 0, 1),
    pan: clamp(m.pan, -1, 1),
    mute: m.mute,
    solo: m.solo,
    eq: normalizeEq(m.eq),
    effects: m.effects.slice(0, MAX_TRACK_EFFECTS),
  };
}

/** How a track is played back (the defaults if nothing was set). */
export const trackInterpretation = (mix: MixerSettings, track: number): Interpretation =>
  mix.interpretation?.[track] ?? DEFAULT_INTERPRETATION;

/** A track's effect chain (its first sound; empty if it has none). */
export const trackEffects = (mix: MixerSettings, track: number): EffectSlot[] =>
  mix.effects?.[track] ?? [];

/** The sounds of a track, or null when it has just one. */
export function trackSoundsOf(mix: MixerSettings, track: number): TrackSounds | null {
  const own = mix.sounds?.[track];
  return own && own.sounds.length > 1 ? own : null;
}

/** Every sound's chain of a track (one or more). */
export function soundChains(mix: MixerSettings, track: number): EffectSlot[][] {
  const own = trackSoundsOf(mix, track);
  return own ? own.sounds.map((s) => s.effects) : [trackEffects(mix, track)];
}

/** The names of a track's sounds ("Sound 1" when it has one). */
export function soundNames(mix: MixerSettings, track: number): string[] {
  return trackSoundsOf(mix, track)?.sounds.map((s) => s.name) ?? ["Sound 1"];
}

/** The chain of one sound of a track. */
export const soundEffects = (mix: MixerSettings, track: number, sound: number): EffectSlot[] =>
  soundChains(mix, track)[sound] ?? [];

/** The chain of every track, one per track (sound 1 of each). */
export const allTrackEffects = (mix: MixerSettings): EffectSlot[][] =>
  mix.tracks.map((_, i) => trackEffects(mix, i));

export const trackEq = (mix: MixerSettings, track: number): TrackEq => mix.eq?.[track] ?? FLAT_EQ;

export const trackAutomation = (mix: MixerSettings, track: number): TrackAutomation =>
  mix.automation?.[track] ?? EMPTY_AUTOMATION;

/**
 * Extra gain of each track from the focus (dB): the others turned down by `cutDb`. Only in the
 * "others down" mode; the other modes mute instead (see `heardMix`).
 */
export function focusTrims(mix: MixerSettings, cutDb = FOCUS_CUT_DB): number[] {
  const on = mix.focus !== undefined && (mix.focusMode ?? "othersDown") === "othersDown";
  return mix.tracks.map((_, i) => (!on ? 0 : i === mix.focus ? FOCUS_BOOST_DB : cutDb));
}

/** The practice mode in force: "normal" without a focused track. */
export function practiceMode(mix: MixerSettings): FocusMode | "normal" {
  return mix.focus === undefined ? "normal" : (mix.focusMode ?? "othersDown");
}

/**
 * The mix as it is played (#83): the saved one with the practice mode applied on top. "Hear
 * only me" plays the focused track alone (whatever is muted or soloed), "backing" mutes it and
 * plays the rest. The saved mix is never changed, so the normal mix comes back as it was.
 */
export function heardMix(mix: MixerSettings): MixerSettings {
  const mode = practiceMode(mix);
  if (mode === "normal" || mode === "othersDown") return mix;
  const focus = mix.focus!;
  const tracks = mix.tracks.map((t, i) =>
    mode === "onlyMe"
      ? { ...t, mute: i !== focus, solo: false }
      : i === focus
        ? { ...t, mute: true, solo: false }
        : t,
  );
  const audio = mix.audioTrack;
  return {
    ...mix,
    tracks,
    // The recording is a backing too: silent while practising alone.
    ...(audio && mode === "onlyMe" && { audioTrack: { ...audio, mute: true, solo: false } }),
  };
}

/** How far the focus turns the other tracks down: presets, and the range of the slider (dB). */
export const FOCUS_CUT_PRESETS = [
  { name: "Subtle", db: -6 },
  { name: "Medium", db: -12 },
  { name: "Strong", db: -24 },
] as const;
export const FOCUS_CUT_MIN_DB = -24;
export const FOCUS_CUT_STORAGE_KEY = "smart-beat:focus-cut";

export function readFocusCutDb(): number {
  try {
    const value = Number(localStorage.getItem(FOCUS_CUT_STORAGE_KEY));
    const stored = localStorage.getItem(FOCUS_CUT_STORAGE_KEY);
    if (stored === null || !Number.isFinite(value)) return FOCUS_CUT_DB;
    return clamp(Math.round(value), FOCUS_CUT_MIN_DB, 0);
  } catch {
    return FOCUS_CUT_DB;
  }
}

export function storeFocusCutDb(db: number) {
  try {
    localStorage.setItem(FOCUS_CUT_STORAGE_KEY, String(clamp(Math.round(db), FOCUS_CUT_MIN_DB, 0)));
  } catch {
    // Not remembered: the default next time.
  }
}

/** Adds a sound (a copy of `from`'s chain) and returns the new list. */
export function addSound(mix: MixerSettings, track: number, from = 0): TrackSounds {
  const own = trackSoundsOf(mix, track) ?? {
    sounds: [{ name: "Sound 1", effects: trackEffects(mix, track) }],
    switches: [],
  };
  if (own.sounds.length >= MAX_SOUNDS) return own;
  const name = `Sound ${own.sounds.length + 1}`;
  const effects = structuredClone(own.sounds[from]?.effects ?? []);
  return { ...own, sounds: [...own.sounds, { name, effects }] };
}

/** Removes a sound; switches to it go, later ones move down. */
export function removeSound(mix: MixerSettings, track: number, sound: number): TrackSounds | null {
  const own = trackSoundsOf(mix, track);
  if (!own || !own.sounds[sound]) return own;
  return {
    sounds: own.sounds.filter((_, i) => i !== sound),
    switches: own.switches
      .filter((s) => s.sound !== sound)
      .map((s) => ({ ...s, sound: s.sound > sound ? s.sound - 1 : s.sound })),
  };
}

/**
 * Whether a track is heard: not muted, and soloed if any track (or the audio track, or the
 * monitor track) is.
 */
export function isAudible(mix: MixerSettings, index: number): boolean {
  const track = mix.tracks[index];
  if (!track || track.mute) return false;
  const audioSolo = !!mix.audioTrack?.enabled && !!mix.audioTrack.solo;
  const monitorSolo = !!mix.monitor?.enabled && !!mix.monitor.solo;
  return track.solo || (!mix.tracks.some((t) => t.solo) && !audioSolo && !monitorSolo);
}

/** Whether the monitor track is heard: on, not muted, and soloed if anything else is. */
export function isMonitorAudible(mix: MixerSettings): boolean {
  const monitor = mix.monitor;
  if (!monitor?.enabled || monitor.mute) return false;
  const audioSolo = !!mix.audioTrack?.enabled && !!mix.audioTrack.solo;
  return monitor.solo || (!mix.tracks.some((t) => t.solo) && !audioSolo);
}

/** Spoken pan value for screen readers, e.g. "Centre", "Left 80%". */
export function describePan(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  if (percent === 0) return "Centre";
  return `${pan < 0 ? "Left" : "Right"} ${percent}%`;
}

/** Visible pan badge, e.g. "L 80%", "C", "R 70%". */
export function panLabel(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  if (percent === 0) return "C";
  return `${pan < 0 ? "L" : "R"} ${percent}%`;
}

/** A pan this close to the middle snaps onto it (5%). */
export const PAN_SNAP = 0.05;

/** Pan with the centre snap applied, so the middle is easy to hit again. */
export function snapPan(pan: number): number {
  return Math.abs(pan) < PAN_SNAP ? 0 : pan;
}

export const describeVolume = (volume: number) => `${Math.round(volume * 100)}%`;

/** A gain (0…1) in decibels, "-∞ dB" for silence. */
export function describeDb(volume: number): string {
  if (volume <= 0) return "-∞ dB";
  const db = 20 * Math.log10(volume);
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}
