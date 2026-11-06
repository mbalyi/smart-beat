/**
 * Practice together: how the shared settings map onto the app's practice state. The host's
 * speed, loop, metronome and count-in travel with every command; a guest takes them over.
 * Track mute and solo never travel: each player hears their own mix.
 */
import type { Command, TransportAction } from "@/lib/practice-together/protocol";
import type { PracticeAction, PracticeState } from "@/lib/score/practice";

/** The settings part of a command, read from the practice state. */
export function settingsOf(
  practice: PracticeState,
): Pick<Command, "speed" | "loop" | "metronome" | "countIn" | "countInBeats"> {
  return {
    speed: practice.speed,
    loop: practice.loop ? { from: practice.range.start, to: practice.range.end } : null,
    metronome: practice.metronome,
    countIn: practice.countIn,
    countInBeats: practice.countInBeats,
  };
}

/** A command for the host to schedule. */
export function commandOf(
  action: TransportAction,
  tick: number,
  practice: PracticeState,
): Omit<Command, "id" | "at"> {
  return { action, tick, ...settingsOf(practice) };
}

/** What a guest's practice state needs so it matches the command (nothing if it already does). */
export function actionsFor(practice: PracticeState, cmd: Command): PracticeAction[] {
  const actions: PracticeAction[] = [];
  const loop = cmd.loop;
  if (loop) {
    const range = { start: loop.from, end: loop.to };
    if (
      !practice.loop ||
      practice.range.start !== range.start ||
      practice.range.end !== range.end
    ) {
      actions.push({ type: "loop", value: true, range });
    }
  } else if (practice.loop) {
    actions.push({ type: "loop", value: false });
  }
  // The speed action ends a running Speed Trainer: the host runs it and sends its speeds.
  if (practice.speed !== cmd.speed || practice.trainer) {
    actions.push({ type: "speed", value: cmd.speed });
  }
  if (practice.metronome !== cmd.metronome) {
    actions.push({ type: "metronome", value: cmd.metronome });
  }
  if (practice.countIn !== cmd.countIn) actions.push({ type: "count-in", value: cmd.countIn });
  if (practice.countInBeats !== cmd.countInBeats) {
    actions.push({ type: "count-in-beats", value: cmd.countInBeats });
  }
  return actions;
}

/** Whether two commands carry the same settings (the host sends a settings command when they differ). */
export function sameSettings(a: PracticeState, b: PracticeState): boolean {
  const x = settingsOf(a);
  const y = settingsOf(b);
  return (
    x.speed === y.speed &&
    x.metronome === y.metronome &&
    x.countIn === y.countIn &&
    x.countInBeats === y.countInBeats &&
    x.loop?.from === y.loop?.from &&
    x.loop?.to === y.loop?.to &&
    (x.loop === null) === (y.loop === null)
  );
}
