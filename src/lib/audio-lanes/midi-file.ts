/**
 * MIDI files and MIDI lanes (ADR 0006): a file's parts become a MIDI clip on a lane (in the file's
 * own timing), and a lane's clips become a standard MIDI file whose bars and tempo follow the
 * song, so the file lines up with the song's bars in any other program.
 */
import { activeMidiTake, sortNotes } from "@/lib/audio-lanes/midi";
import { newId } from "@/lib/audio-lanes/model";
import { barAtTimelineMs, type SongGrid } from "@/lib/audio-lanes/sync";
import type { Parsed } from "@/lib/import/midi";
import type { AudioClip, AudioLanesSettings, MidiNote } from "@/lib/tauri";

/** Ticks per quarter note in files we write. */
export const FILE_DIVISION = 960;

/** Milliseconds at each tick of a parsed file, through its tempo changes. */
export function tickToMs(parsed: Pick<Parsed, "division" | "tempos">): (tick: number) => number {
  const tempos = [...parsed.tempos].sort((a, b) => a.tick - b.tick);
  if (tempos.length === 0 || tempos[0]!.tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  const starts: number[] = [];
  let ms = 0;
  tempos.forEach((t, i) => {
    if (i > 0) {
      const prev = tempos[i - 1]!;
      ms += ((t.tick - prev.tick) / parsed.division) * (60_000 / prev.bpm);
    }
    starts.push(ms);
  });
  return (tick) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i]!.tick > tick) i--;
    const t = tempos[i]!;
    return starts[i]! + ((tick - t.tick) / parsed.division) * (60_000 / t.bpm);
  };
}

/** Every note of a file's parts, in ms from its start, each on its part's channel. */
export function fileNotes(parsed: Parsed): { notes: MidiNote[]; lengthMs: number } {
  const at = tickToMs(parsed);
  const notes = sortNotes(
    parsed.parts.flatMap((part) =>
      part.notes.map((n) => ({
        id: newId(),
        startMs: at(n.start),
        lenMs: Math.max(1, at(n.end) - at(n.start)),
        pitch: Math.min(127, Math.max(0, n.pitch)),
        vel: Math.min(127, Math.max(1, n.velocity)),
        chan: Math.min(15, Math.max(0, part.channel)),
      })),
    ),
  );
  const lengthMs = Math.max(at(parsed.endTick), ...notes.map((n) => n.startMs + n.lenMs), 10);
  return { notes, lengthMs };
}

// --- Writing ----------------------------------------------------------------------------

const vlq = (value: number): number[] => {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
};
const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const text = (s: string) => [...new TextEncoder().encode(s)];

/** Song bar positions as ticks: where each bar starts, and its length in beats. */
function barTicks(song: SongGrid, bars: number): number[] {
  const out = [0];
  for (let b = 0; b < bars; b++) {
    const beats = song.beats[b] ?? song.beats[song.beats.length - 1] ?? 4;
    out.push(out[b]! + beats * FILE_DIVISION);
  }
  return out;
}

/**
 * A MIDI lane's clips as a standard MIDI file (type 1, one track): positions in bars and beats of
 * the song, a tempo per bar that keeps the song's timing, and every note and controller event.
 */
export function laneToMidiFile(
  audio: AudioLanesSettings,
  song: SongGrid,
  clips: readonly AudioClip[],
  name: string,
): Uint8Array {
  const midiClips = clips.filter((c) => c.midi && !c.mute);
  const endMs = Math.max(0, ...midiClips.map((c) => c.startMs + c.lengthMs));
  const lastBar = Math.ceil(barAtTimelineMs(audio, song, endMs)) + 1;
  const starts = barTicks(song, lastBar + 1);
  const tickAt = (ms: number) => {
    const at = Math.max(0, barAtTimelineMs(audio, song, ms));
    const bar = Math.floor(at);
    const next = starts[bar + 1] ?? starts[bar]! + 4 * FILE_DIVISION;
    return Math.round(starts[bar]! + (at - bar) * (next - starts[bar]!));
  };
  const events: { tick: number; order: number; bytes: number[] }[] = [];
  const nameBytes = text(name.slice(0, 120));
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes] });
  // A tempo per bar, from the bar's length on the timeline.
  for (let b = 0; b < lastBar; b++) {
    const length = (song.barTimes[b + 1] ?? NaN) - (song.barTimes[b] ?? NaN);
    const beats = song.beats[b] ?? 4;
    if (!(length > 0)) continue;
    const usPerQuarter = Math.round((length * 1000) / beats);
    events.push({
      tick: starts[b]!,
      order: 0,
      bytes: [
        0xff,
        0x51,
        0x03,
        (usPerQuarter >> 16) & 0xff,
        (usPerQuarter >> 8) & 0xff,
        usPerQuarter & 0xff,
      ],
    });
  }
  for (const clip of midiClips) {
    const take = activeMidiTake(clip);
    const end = clip.startMs + clip.lengthMs;
    for (const n of take.notes) {
      if (n.muted) continue;
      const on = clip.startMs + n.startMs;
      if (on >= end) continue;
      const off = Math.min(on + n.lenMs, end);
      const pitch = Math.min(127, Math.max(0, n.pitch + clip.semitones));
      events.push({ tick: tickAt(on), order: 2, bytes: [0x90 | n.chan, pitch, n.vel] });
      events.push({ tick: tickAt(off), order: 0, bytes: [0x80 | n.chan, pitch, 0] });
    }
    for (const c of take.cc) {
      const at = clip.startMs + c.atMs;
      if (at >= end) continue;
      const bytes =
        c.kind === "cc"
          ? [0xb0 | c.chan, c.cc ?? 0, c.value]
          : c.kind === "program"
            ? [0xc0 | c.chan, c.value]
            : c.kind === "pressure"
              ? [0xd0 | c.chan, c.value]
              : [0xe0 | c.chan, (c.value + 8192) & 0x7f, ((c.value + 8192) >> 7) & 0x7f];
      events.push({ tick: tickAt(at), order: 1, bytes });
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [
    ...text("MThd"),
    ...u32(6),
    0,
    1,
    0,
    1,
    (FILE_DIVISION >> 8) & 0xff,
    FILE_DIVISION & 0xff,
  ];
  return new Uint8Array([...header, ...text("MTrk"), ...u32(track.length), ...track]);
}
