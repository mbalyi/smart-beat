/**
 * Tempo changes: the song's tempo, a change at a bar and beat (it applies
 * until the next change), and a tempo for a range of bars only (the tempo
 * before it returns afterwards). alphaTab keeps tempo changes as automations
 * on the master bars, positioned by the fraction of the bar (0 = its start).
 *
 * These functions only change the model; the workspace runs them through
 * `ScoreEditor.editBars` so they can be undone.
 */
import { model } from "@coderline/alphatab";

import type { MasterBar, Score } from "@/lib/score/model";
import { DEFAULT_TEMPO, MAX_TEMPO, MIN_TEMPO, tempoAt } from "@/lib/score/structure";

const { Automation, AutomationType } = model;

const EPSILON = 1e-6;

/** What the tempo dialog asks for. Bars and beats are 0-based. */
export type TempoRequest =
  /** The song's tempo (bar 1). */
  | { scope: "song"; bpm: number }
  /** A change at a bar and beat, in effect until the next change. */
  | { scope: "from"; bar: number; beat: number; bpm: number }
  /** A tempo for bars `from` to `to` only. */
  | { scope: "range"; from: number; to: number; bpm: number };

/** Keeps a tempo between 10 and 400 BPM (decimals are kept, to a hundredth). */
export function clampTempo(bpm: number): number {
  if (!Number.isFinite(bpm)) return DEFAULT_TEMPO;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(bpm * 100) / 100));
}

const isTempo = (automation: model.Automation) => automation.type === AutomationType.Tempo;

/** Where in the bar (0…1) a beat starts. */
export const beatRatio = (masterBar: MasterBar, beat: number): number =>
  Math.min(Math.max(beat, 0), masterBar.timeSignatureNumerator - 1) /
  masterBar.timeSignatureNumerator;

/**
 * Sets the tempo at `ratio` of a bar, replacing a change already there (keeping
 * its label). Always a new automation in a new array: undo restores the old
 * array, it does not see values changed in place.
 */
function setTempoIn(masterBar: MasterBar, ratio: number, bpm: number, label?: string) {
  const existing = masterBar.tempoAutomations.find(
    (a) => isTempo(a) && Math.abs(a.ratioPosition - ratio) < EPSILON,
  );
  const automation = Automation.buildTempoAutomation(false, ratio, bpm, 2);
  automation.text = label ?? existing?.text ?? "";
  masterBar.tempoAutomations = [
    ...masterBar.tempoAutomations.filter((a) => a !== existing),
    automation,
  ].sort((a, b) => a.ratioPosition - b.ratioPosition);
}

/** Removes every tempo change of a bar. */
function clearTempoIn(masterBar: MasterBar) {
  masterBar.tempoAutomations = masterBar.tempoAutomations.filter((a) => !isTempo(a));
}

/** Whether a bar starts with a tempo change of its own. */
const startsWithTempo = (masterBar: MasterBar) =>
  masterBar.tempoAutomations.some((a) => isTempo(a) && a.ratioPosition < EPSILON);

/** The bars a request changes (for undo), without changing anything. */
export function tempoScope(score: Score, request: TempoRequest): { from: number; to: number } {
  const last = score.masterBars.length - 1;
  const clampBar = (bar: number) => Math.min(Math.max(bar, 0), last);
  if (request.scope === "song") return { from: 0, to: 0 };
  if (request.scope === "from") {
    const bar = clampBar(request.bar);
    return { from: bar, to: bar };
  }
  const from = clampBar(request.from);
  const to = Math.max(clampBar(request.to), from);
  return { from, to: Math.min(last, to + 1) };
}

/**
 * Applies a tempo request. Returns the bars it touched (for undo).
 *
 * A range keeps the tempo that was in effect after it: bars inside the range
 * lose their own tempo changes, and the bar after it gets a change back to
 * what it would have played (unless it has a change of its own).
 */
export function applyTempo(score: Score, request: TempoRequest): { from: number; to: number } {
  const bars = score.masterBars;
  const bpm = clampTempo(request.bpm);

  if (request.scope === "song") {
    setTempoIn(bars[0]!, 0, bpm);
    return { from: 0, to: 0 };
  }

  if (request.scope === "from") {
    const bar = Math.min(Math.max(request.bar, 0), bars.length - 1);
    setTempoIn(bars[bar]!, beatRatio(bars[bar]!, request.beat), bpm);
    return { from: bar, to: bar };
  }

  const from = Math.min(Math.max(request.from, 0), bars.length - 1);
  const to = Math.min(Math.max(request.to, from), bars.length - 1);
  const after = to + 1 < bars.length ? tempoAt(score, to + 1) : null;
  for (let i = from; i <= to; i++) {
    // The song's own tempo label (bar 1) stays with the start of the range.
    const label = i === from ? bars[i]!.tempoAutomations.find(isTempo)?.text : undefined;
    clearTempoIn(bars[i]!);
    if (i === from) setTempoIn(bars[i]!, 0, bpm, label);
  }
  if (after !== null && !startsWithTempo(bars[to + 1]!) && Math.abs(after - bpm) > EPSILON) {
    setTempoIn(bars[to + 1]!, 0, after);
  }
  return { from, to: after === null ? to : to + 1 };
}

/** The tempo changes of a bar, in order (for listing them). */
export function tempoChangesOf(
  masterBar: MasterBar,
): { ratio: number; bpm: number; label: string }[] {
  return masterBar.tempoAutomations
    .filter(isTempo)
    .map((a) => ({ ratio: a.ratioPosition, bpm: a.value, label: a.text }))
    .sort((a, b) => a.ratio - b.ratio);
}

/** Every bar where the tempo is set (the start included), with the first tempo set there. */
export function tempoMarkers(score: Score): { bar: number; bpm: number; label: string }[] {
  return score.masterBars.flatMap((masterBar, bar) => {
    const first = tempoChangesOf(masterBar)[0];
    return first ? [{ bar, bpm: Math.round(first.bpm), label: first.label }] : [];
  });
}
