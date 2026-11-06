import type { StemKindId } from "@/lib/tauri";

/** One stem's strip on the page: how loud it is and whether it is muted or soloed. */
export interface StemChannel {
  kind: StemKindId;
  /** 0 (silent) to 1 (full). */
  volume: number;
  muted: boolean;
  soloed: boolean;
}

export type StemMixer = readonly StemChannel[];

export type MixerAction =
  | { type: "toggle-mute"; kind: StemKindId }
  | { type: "toggle-solo"; kind: StemKindId }
  | { type: "set-volume"; kind: StemKindId; volume: number }
  | { type: "reset" };

/** Every stem at full volume, none muted or soloed, in the order given. */
export const initMixer = (kinds: readonly StemKindId[]): StemMixer =>
  kinds.map((kind) => ({ kind, volume: 1, muted: false, soloed: false }));

const clamp = (volume: number) => Math.min(1, Math.max(0, volume));

const change = (
  mixer: StemMixer,
  kind: StemKindId,
  patch: (channel: StemChannel) => Partial<StemChannel>,
): StemMixer =>
  mixer.map((channel) => (channel.kind === kind ? { ...channel, ...patch(channel) } : channel));

/** The mixer's state machine. Pure, so the page and the tests share it. */
export function mixerReducer(mixer: StemMixer, action: MixerAction): StemMixer {
  switch (action.type) {
    case "toggle-mute":
      return change(mixer, action.kind, (channel) => ({ muted: !channel.muted }));
    case "toggle-solo":
      return change(mixer, action.kind, (channel) => ({ soloed: !channel.soloed }));
    case "set-volume":
      // A value that is not a number leaves the volume alone.
      return Number.isFinite(action.volume)
        ? change(mixer, action.kind, () => ({ volume: clamp(action.volume) }))
        : mixer;
    case "reset":
      return initMixer(mixer.map((channel) => channel.kind));
  }
}

/** Whether any stem is soloed: the others are then silent, muted or not. */
export const anySoloed = (mixer: StemMixer): boolean => mixer.some((channel) => channel.soloed);

/**
 * What a stem is heard at: its volume. With a solo on, only the soloed stems are heard, even a
 * muted one (solo overrides mute); without one, a muted stem is silent.
 */
export function gainOf(mixer: StemMixer, channel: StemChannel): number {
  const solo = anySoloed(mixer);
  const heard = solo ? channel.soloed : !channel.muted;
  return heard ? channel.volume : 0;
}

/** The gain of every stem (what the player and `stems_render_mix` take). */
export function gainsOf(mixer: StemMixer): Partial<Record<StemKindId, number>> {
  return Object.fromEntries(mixer.map((channel) => [channel.kind, gainOf(mixer, channel)]));
}

/** True when a stem is silent only because another one is soloed (shown dimmed, not "muted"). */
export const isSoloedOut = (mixer: StemMixer, channel: StemChannel): boolean =>
  anySoloed(mixer) && !channel.soloed;
