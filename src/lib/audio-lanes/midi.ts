/**
 * MIDI clips (ADR 0006): pure helpers for the notes and controller events of a MIDI lane's
 * clips. Event times are ms from the clip start on the audio timeline, like clip positions, so
 * the clip edits in `edits.ts` work for both kinds. Every function returns new objects.
 */
import type {
  AudioClip,
  AudioLane,
  LaneInstrument,
  MidiCc,
  MidiClipData,
  MidiNote,
  MidiTake,
  PadSlot,
} from "@/lib/tauri";

/** The most notes one take of a clip may hold (the Rust side rejects more). */
export const MAX_NOTES_PER_CLIP = 20_000;
/** The most controller events one take may hold. */
export const MAX_CC_PER_CLIP = 50_000;
/** The most notes and controller events of all MIDI lanes of a song. */
export const MAX_MIDI_EVENTS = 200_000;
/** The most pads a pad bank holds. */
export const MAX_PADS = 128;
/** The shortest note an edit leaves, in ms. */
export const MIN_NOTE_MS = 5;
/** The General MIDI drum channel (0-based). */
export const DRUM_CHANNEL = 9;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const clampInt = (value: number, min: number, max: number): number =>
  clamp(Math.round(value), min, max);

export const EMPTY_TAKE: MidiTake = { notes: [], cc: [] };

/** The events a new MIDI clip starts with. */
export interface MidiClipInit {
  notes?: MidiNote[];
  cc?: MidiCc[];
}

/** A MIDI lane holds MIDI clips. */
export const isMidiLane = (lane: Pick<AudioLane, "kind">): boolean => lane.kind === "midi";

/** A clip of a MIDI lane. */
export const isMidiClip = (clip: Pick<AudioClip, "midi">): boolean => clip.midi !== undefined;

/** An audio clip (one that plays a source file). */
export const isAudioClip = (clip: Pick<AudioClip, "midi">): boolean => clip.midi === undefined;

/** The events of the take a MIDI clip plays (an empty take for an audio clip). */
export function activeMidiTake(clip: Pick<AudioClip, "midi" | "take">): MidiTake {
  return clip.midi?.takes[clip.take] ?? clip.midi?.takes[0] ?? EMPTY_TAKE;
}

/** The clip with the events of its played take replaced. */
export function withActiveTake(clip: AudioClip, take: MidiTake): AudioClip {
  if (!clip.midi) return clip;
  const index = Math.min(clip.take, clip.midi.takes.length - 1);
  return {
    ...clip,
    midi: { takes: clip.midi.takes.map((t, i) => (i === index ? take : t)) },
  };
}

/** A note's end, in ms from the clip start. */
export const noteEnd = (note: Pick<MidiNote, "startMs" | "lenMs">): number =>
  note.startMs + note.lenMs;

/** Notes in start order, then pitch. */
export const sortNotes = (notes: readonly MidiNote[]): MidiNote[] =>
  [...notes].sort((a, b) => a.startMs - b.startMs || a.pitch - b.pitch);

/** Controller events in time order. */
export const sortCc = (cc: readonly MidiCc[]): MidiCc[] => [...cc].sort((a, b) => a.atMs - b.atMs);

/** A note with every value in range, inside a clip of `clipMs`. */
export function normalizeNote(note: MidiNote, clipMs: number): MidiNote {
  const { rawStartMs, rawLenMs, muted, ...rest } = note;
  const startMs = clamp(note.startMs, 0, clipMs);
  return {
    ...rest,
    startMs,
    lenMs: clamp(note.lenMs, 0, Math.max(0, clipMs - startMs)),
    pitch: clampInt(note.pitch, 0, 127),
    vel: clampInt(note.vel, 1, 127),
    chan: clampInt(note.chan, 0, 15),
    ...(Number.isFinite(rawStartMs) && { rawStartMs }),
    ...(Number.isFinite(rawLenMs) && { rawLenMs }),
    ...(muted === true && { muted: true }),
  };
}

/** A controller event with every value in range. */
export function normalizeCc(cc: MidiCc, clipMs: number): MidiCc {
  const bend = cc.kind === "bend";
  const { cc: number, ...rest } = cc;
  return {
    ...rest,
    atMs: clamp(cc.atMs, 0, clipMs),
    value: bend ? clampInt(cc.value, -8192, 8191) : clampInt(cc.value, 0, 127),
    chan: clampInt(cc.chan, 0, 15),
    ...(cc.kind === "cc" && { cc: clampInt(number ?? 0, 0, 127) }),
  };
}

/** A take in range: events inside the clip, capped and sorted. */
export function normalizeTake(take: MidiTake, clipMs: number): MidiTake {
  return {
    notes: sortNotes(
      (take.notes ?? [])
        .filter((n) => n.startMs < clipMs)
        .slice(0, MAX_NOTES_PER_CLIP)
        .map((n) => normalizeNote(n, clipMs)),
    ),
    cc: sortCc(
      (take.cc ?? [])
        .filter((c) => c.atMs <= clipMs)
        .slice(0, MAX_CC_PER_CLIP)
        .map((c) => normalizeCc(c, clipMs)),
    ),
  };
}

/** MIDI clip data with one take per clip take, every take in range. */
export function normalizeMidi(midi: MidiClipData, takes: number, clipMs: number): MidiClipData {
  return {
    takes: Array.from({ length: takes }, (_, i) =>
      normalizeTake(midi.takes[i] ?? EMPTY_TAKE, clipMs),
    ),
  };
}

/** Events of a take that start in [fromMs, toMs), moved so `fromMs` becomes 0. */
export function sliceTake(take: MidiTake, fromMs: number, toMs: number): MidiTake {
  return {
    notes: take.notes
      .filter((n) => n.startMs >= fromMs && n.startMs < toMs)
      .map((n) => ({
        ...n,
        startMs: n.startMs - fromMs,
        lenMs: Math.min(n.lenMs, toMs - n.startMs),
        ...(n.rawStartMs !== undefined && { rawStartMs: n.rawStartMs - fromMs }),
      })),
    cc: take.cc
      .filter((c) => c.atMs >= fromMs && c.atMs < toMs)
      .map((c) => ({ ...c, atMs: c.atMs - fromMs })),
  };
}

/** Every event of a take moved by `deltaMs` (notes keep fresh ids when `freshIds`). */
export function shiftTake(take: MidiTake, deltaMs: number, freshId?: () => string): MidiTake {
  return {
    notes: take.notes.map((n) => ({
      ...n,
      ...(freshId && { id: freshId() }),
      startMs: n.startMs + deltaMs,
      ...(n.rawStartMs !== undefined && { rawStartMs: n.rawStartMs + deltaMs }),
    })),
    cc: take.cc.map((c) => ({ ...c, atMs: c.atMs + deltaMs })),
  };
}

/** Two takes as one, `b` placed `offsetMs` after `a`'s start. */
export function mergeTakes(a: MidiTake, b: MidiTake, offsetMs: number): MidiTake {
  const moved = shiftTake(b, offsetMs);
  return { notes: sortNotes([...a.notes, ...moved.notes]), cc: sortCc([...a.cc, ...moved.cc]) };
}

/** Every pitch of a take moved by `semitones`; notes pushed outside 0…127 are dropped. */
export function transposeNotes(
  notes: readonly MidiNote[],
  ids: ReadonlySet<string> | null,
  semitones: number,
): MidiNote[] {
  return notes
    .map((n) => (ids && !ids.has(n.id) ? n : { ...n, pitch: n.pitch + semitones }))
    .filter((n) => n.pitch >= 0 && n.pitch <= 127);
}

/** The pool sources an instrument plays (a pad bank's embedded samples). */
export function instrumentSources(instrument: LaneInstrument | undefined): string[] {
  if (instrument?.type !== "pads") return [];
  return instrument.pads.flatMap((p) => (p.sourceId ? [p.sourceId] : []));
}

/** A pad with default settings. */
export function newPad(key: number, name: string, extra: Partial<PadSlot> = {}): PadSlot {
  return {
    key,
    name,
    playback: "oneShot",
    trimStartMs: 0,
    trimEndMs: 0,
    semitones: 0,
    cents: 0,
    volume: 1,
    pan: 0,
    velDepth: 1,
    choke: 0,
    voices: 4,
    sendA: 0,
    sendB: 0,
    ...extra,
  };
}

/** A pad with every value in range. */
export function normalizePad(pad: PadSlot): PadSlot {
  const { sample, sourceId, drum, ...rest } = pad;
  return {
    ...rest,
    key: clampInt(pad.key, 0, 127),
    name: String(pad.name ?? "").slice(0, 64),
    playback: pad.playback === "gate" || pad.playback === "loop" ? pad.playback : "oneShot",
    trimStartMs: clamp(pad.trimStartMs, 0, 86_400_000),
    trimEndMs: clamp(pad.trimEndMs, 0, 86_400_000),
    semitones: clampInt(pad.semitones, -24, 24),
    cents: clampInt(pad.cents, -100, 100),
    volume: clamp(pad.volume, 0, 1),
    pan: clamp(pad.pan, -1, 1),
    velDepth: clamp(pad.velDepth, 0, 1),
    choke: clampInt(pad.choke, 0, 16),
    voices: clampInt(pad.voices, 1, 32),
    sendA: clamp(pad.sendA, 0, 1),
    sendB: clamp(pad.sendB, 0, 1),
    ...(sample?.folderId && sample.rel && { sample }),
    ...(typeof sourceId === "string" && sourceId && { sourceId }),
    ...(Number.isFinite(drum) && { drum: clampInt(drum!, 0, 127) }),
  };
}

/** An instrument with every value in range; pads whose source is unknown lose it. */
export function normalizeInstrument(
  instrument: LaneInstrument | undefined,
  sources: ReadonlySet<string>,
): LaneInstrument | undefined {
  if (!instrument) return undefined;
  switch (instrument.type) {
    case "soundfont":
      return {
        type: "soundfont",
        program: clampInt(instrument.program, 0, 127),
        bank: clampInt(instrument.bank, 0, 16_383),
      };
    case "pads":
      return {
        type: "pads",
        pads: instrument.pads.slice(0, MAX_PADS).map((p) => {
          const pad = normalizePad(p);
          if (!pad.sourceId || sources.has(pad.sourceId)) return pad;
          const rest = { ...pad };
          delete rest.sourceId;
          return rest;
        }),
      };
    default:
      return instrument;
  }
}

/** The number of MIDI events in a song's lanes. */
export function midiEventCount(lanes: readonly Pick<AudioLane, "clips">[]): number {
  return lanes.reduce(
    (sum, lane) =>
      lane.clips.reduce(
        (s, clip) =>
          s +
          (clip.midi?.takes.reduce((t, take) => t + take.notes.length + take.cc.length, 0) ?? 0),
        sum,
      ),
    0,
  );
}
