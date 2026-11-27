/**
 * MIDI recording (ADR 0006), the pure part: what the player played (messages stamped with the
 * timeline ms they heard) becomes notes, one pass per loop round, and goes onto a MIDI lane in
 * the chosen record mode: a new take, overdub, replace, touch-replace or latch-replace.
 */
import { addClip, addMidiTake, findClip, setMidiTake } from "@/lib/audio-lanes/edits";
import { activeMidiTake, mergeTakes, noteEnd, sortCc, sortNotes } from "@/lib/audio-lanes/midi";
import { newId, newMidiClip } from "@/lib/audio-lanes/model";
import type { AudioClip, AudioLanesSettings, MidiCc, MidiNote, MidiTake } from "@/lib/tauri";

/** A message as the recorder hands it over (`midi_record_stop`). */
export interface RecordedEvent {
  ms: number;
  status: number;
  d1: number;
  d2: number;
}

/** How a recording goes onto the lane. */
export type MidiRecordMode = "take" | "overdub" | "replace" | "touch" | "latch";

export const RECORD_MODES: readonly { value: MidiRecordMode; label: string; hint: string }[] = [
  { value: "take", label: "New take", hint: "Keeps what was there; each pass is a take" },
  { value: "overdub", label: "Overdub", hint: "Adds to what is there (one drum at a time)" },
  { value: "replace", label: "Replace", hint: "Clears the recorded span first" },
  { value: "touch", label: "Touch replace", hint: "Replaces only the notes you play over" },
  { value: "latch", label: "Latch replace", hint: "Replaces from your first note to the stop" },
];

/** One pass of a recording: notes and controllers in timeline ms. */
export interface Pass {
  notes: MidiNote[];
  cc: MidiCc[];
  startMs: number;
  endMs: number;
}

/** A jump back of the timeline larger than this (ms) starts a new loop pass. */
const WRAP_MS = 250;
/** The shortest note a release can make. */
const MIN_NOTE_MS = 10;

/**
 * The recorded messages as passes of notes. A note still held when a pass ends (the loop
 * wrapped, or Stop) ends there; `stopMs` is where the last pass ends.
 */
export function eventsToPasses(events: readonly RecordedEvent[], stopMs?: number): Pass[] {
  const passes: Pass[] = [];
  let pass: Pass | null = null;
  let open = new Map<string, MidiNote>();
  let last = -Infinity;
  const close = (p: Pass, at: number) => {
    for (const note of open.values())
      p.notes.push({ ...note, lenMs: Math.max(MIN_NOTE_MS, at - note.startMs) });
    open = new Map();
  };
  for (const e of events) {
    if (!pass || e.ms < last - WRAP_MS) {
      if (pass) {
        close(pass, last);
        pass.endMs = Math.max(pass.endMs, last);
      }
      pass = { notes: [], cc: [], startMs: e.ms, endMs: e.ms };
      passes.push(pass);
    }
    last = e.ms;
    pass.endMs = Math.max(pass.endMs, e.ms);
    const command = e.status & 0xf0;
    const chan = e.status & 0x0f;
    const key = `${chan}:${e.d1}`;
    if (command === 0x90 && e.d2 > 0) {
      const held = open.get(key);
      if (held) pass.notes.push({ ...held, lenMs: Math.max(MIN_NOTE_MS, e.ms - held.startMs) });
      open.set(key, { id: newId(), startMs: e.ms, lenMs: 0, pitch: e.d1, vel: e.d2, chan });
    } else if (command === 0x80 || command === 0x90) {
      const held = open.get(key);
      if (held) {
        pass.notes.push({ ...held, lenMs: Math.max(MIN_NOTE_MS, e.ms - held.startMs) });
        open.delete(key);
      }
    } else if (command === 0xb0) {
      pass.cc.push({ atMs: e.ms, kind: "cc", cc: e.d1, value: e.d2, chan });
    } else if (command === 0xe0) {
      pass.cc.push({ atMs: e.ms, kind: "bend", value: ((e.d2 << 7) | e.d1) - 8192, chan });
    } else if (command === 0xd0) {
      pass.cc.push({ atMs: e.ms, kind: "pressure", value: e.d1, chan });
    } else if (command === 0xc0) {
      pass.cc.push({ atMs: e.ms, kind: "program", value: e.d1, chan });
    }
  }
  if (pass) {
    const end = Math.max(stopMs ?? last, last);
    close(pass, end);
    pass.endMs = end;
  }
  return passes
    .map((p) => ({ ...p, notes: sortNotes(p.notes), cc: sortCc(p.cc) }))
    .filter((p) => p.notes.length > 0 || p.cc.length > 0);
}

/** A pass cut to a time span (a punch or a loop): notes starting inside it. */
export function punch(pass: Pass, span: { startMs: number; endMs: number }): Pass {
  return {
    notes: pass.notes
      .filter((n) => n.startMs >= span.startMs && n.startMs < span.endMs)
      .map((n) => ({ ...n, lenMs: Math.min(n.lenMs, span.endMs - n.startMs) })),
    cc: pass.cc.filter((c) => c.atMs >= span.startMs && c.atMs < span.endMs),
    startMs: span.startMs,
    endMs: span.endMs,
  };
}

/** Notes and controllers moved from timeline ms to ms from a clip start. */
function toClip(pass: Pass, clipStartMs: number): MidiTake {
  return {
    notes: pass.notes.map((n) => ({ ...n, startMs: n.startMs - clipStartMs })),
    cc: pass.cc.map((c) => ({ ...c, atMs: c.atMs - clipStartMs })),
  };
}

/** The clip of a lane under a span (the first that overlaps it). */
function clipUnder(audio: AudioLanesSettings, laneId: string, startMs: number, endMs: number) {
  const lane = audio.lanes.find((l) => l.id === laneId);
  return lane?.clips.find((c) => c.midi && c.startMs < endMs && c.startMs + c.lengthMs > startMs);
}

/** Grows a clip to cover a span (its events keep their timeline places). */
function cover(clip: AudioClip, startMs: number, endMs: number): AudioClip {
  const start = Math.min(clip.startMs, startMs);
  const end = Math.max(clip.startMs + clip.lengthMs, endMs);
  const shift = clip.startMs - start;
  return {
    ...clip,
    startMs: start,
    lengthMs: end - start,
    midi: clip.midi && {
      takes: clip.midi.takes.map((t) => ({
        notes: t.notes.map((n) => ({ ...n, startMs: n.startMs + shift })),
        cc: t.cc.map((c) => ({ ...c, atMs: c.atMs + shift })),
      })),
    },
  };
}

/** Removes notes of a take that start inside a span (clip-relative ms). */
function clearSpan(take: MidiTake, fromMs: number, toMs: number): MidiTake {
  return {
    notes: take.notes.filter((n) => n.startMs < fromMs || n.startMs >= toMs),
    cc: take.cc.filter((c) => c.atMs < fromMs || c.atMs >= toMs),
  };
}

/** Removes notes the new notes play over (same channel, overlapping in time). */
function clearTouched(take: MidiTake, played: readonly MidiNote[]): MidiTake {
  return {
    ...take,
    notes: take.notes.filter(
      (n) =>
        !played.some((p) => p.chan === n.chan && p.startMs < noteEnd(n) && noteEnd(p) > n.startMs),
    ),
  };
}

/**
 * Puts a recording on a MIDI lane in one go (the caller makes it one Undo step). `span` is the
 * recorded span on the timeline (the punch or loop range, or from the first to the last note).
 * Returns the new state and the clip the recording went to.
 */
export function applyRecording(
  audio: AudioLanesSettings,
  laneId: string,
  passes: readonly Pass[],
  mode: MidiRecordMode,
  name = "Recording",
): { audio: AudioLanesSettings; clipId: string | null } {
  const used = passes.filter((p) => p.notes.length > 0 || p.cc.length > 0);
  if (used.length === 0) return { audio, clipId: null };
  const startMs = Math.min(...used.map((p) => p.startMs));
  const endMs = Math.max(...used.map((p) => Math.max(p.endMs, ...p.notes.map(noteEnd))));
  const existing = clipUnder(audio, laneId, startMs, endMs);

  if (mode === "take") {
    if (!existing || used.length > 1 || existing.startMs > startMs) {
      // A new clip; loop passes become its takes (the last one heard).
      const clipId = newId();
      const first = used[0]!;
      let next = addClip(
        audio,
        laneId,
        newMidiClip(`${name} 1`, startMs, endMs - startMs, toClip(first, startMs), clipId),
      );
      used.slice(1).forEach((p, i) => {
        next = addMidiTake(next, clipId, `${name} ${i + 2}`, toClip(p, startMs));
      });
      return { audio: next, clipId };
    }
    const grown = cover(existing, startMs, endMs);
    let next = updateWhole(audio, grown);
    next = addMidiTake(
      next,
      grown.id,
      `${name} ${grown.takes.length + 1}`,
      toClip(used[0]!, grown.startMs),
    );
    return { audio: next, clipId: grown.id };
  }

  // Overdub and the replace modes edit the heard take of the clip under the recording.
  const base = existing
    ? cover(existing, startMs, endMs)
    : newMidiClip(name, startMs, endMs - startMs, {}, newId());
  let take = activeMidiTake(base);
  for (const pass of used) {
    const played = toClip(pass, base.startMs);
    if (mode === "replace")
      take = clearSpan(take, pass.startMs - base.startMs, pass.endMs - base.startMs);
    if (mode === "touch") take = clearTouched(take, played.notes);
    if (mode === "latch" && played.notes.length > 0) {
      const first = Math.min(...played.notes.map((n) => n.startMs));
      take = clearSpan(take, first, pass.endMs - base.startMs);
    }
    take = mergeTakes(take, played, 0);
  }
  const next = existing ? updateWhole(audio, base) : addClip(audio, laneId, base);
  return { audio: setMidiTake(next, base.id, take), clipId: base.id };
}

/** Replaces a clip as a whole (position, length and events). */
function updateWhole(audio: AudioLanesSettings, clip: AudioClip): AudioLanesSettings {
  if (!findClip(audio, clip.id)) return audio;
  return {
    ...audio,
    lanes: audio.lanes.map((l) => ({
      ...l,
      clips: l.clips.map((c) => (c.id === clip.id ? clip : c)),
    })),
  };
}
