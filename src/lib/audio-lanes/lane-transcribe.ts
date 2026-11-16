/**
 * "Sheet from an audio lane" (#235): the pure rules behind the dialog. What a request covers,
 * what is wrong with it, the defaults (instrument, track, start bar) and how the notes the
 * transcriber found on the audio timeline become a take that starts at a bar of the song.
 */
import { barAtTimelineMs, songMsAt, syncPairs, type SongGrid } from "@/lib/audio-lanes/sync";
import type { LaneRange, ResolvedSource } from "@/lib/audio-lanes/lane-transcribe-request";
import { activeTake, clipEndMs, laneEndMs } from "@/lib/audio-lanes/model";
import { audioMsAt } from "@/lib/audio/engine-config";
import type { RecordInstrument } from "@/lib/audio/record-prefs";
import type { RecordedNote } from "@/lib/import/recording";
import { isPlaceholderVoice, type Score } from "@/lib/score/model";
import type { AudioClip, AudioLane, AudioLanesSettings } from "@/lib/tauri";

/** The most audio one conversion takes (the Rust side checks the same). */
export const MAX_SPAN_MS = 600_000;
/** A span shorter than this is unlikely to hold a note worth writing. */
export const SHORT_SPAN_MS = 500;

export type SourceProblemKind =
  "no-lane" | "folder" | "empty" | "muted" | "clip-muted" | "missing-file" | "outside" | "too-long";

/** Why a source cannot be converted, in words for the player, and what could fix it. */
export interface SourceProblem {
  kind: SourceProblemKind;
  message: string;
  fix: "unmute-clip" | "first-10-minutes" | null;
}

/** What a source holds, once checked. */
export interface SourceReport {
  lane: AudioLane | null;
  /** The clips that will be heard (muted ones left out). */
  clips: AudioClip[];
  /** The span on the audio timeline that will be converted (null when there is nothing). */
  span: LaneRange | null;
  problem: SourceProblem | null;
  /** Things worth knowing that do not stop the conversion. */
  advisories: string[];
}

const problem = (
  kind: SourceProblemKind,
  message: string,
  fix: SourceProblem["fix"] = null,
): SourceProblem => ({ kind, message, fix });

/** A lane that probably holds a whole song rather than one instrument. */
export function looksLikeFullMix(lane: Pick<AudioLane, "name">): boolean {
  const name = lane.name.toLowerCase();
  if (/\b(vocals?|drums?|bass|guitars?|piano|keys|other|lead|rhythm)\b/.test(name)) return false;
  return /\b(full|mix|master|song|original|track|backing|stereo)\b/.test(name) || name === "";
}

/** The instrument a lane is named after (a stem or a recording), or null when the name says nothing. */
export function instrumentFromName(name: string): RecordInstrument | null {
  const text = name.toLowerCase();
  if (/\b(drums?|kit|percussion|perc)\b/.test(text)) return "drums";
  if (/\b(bass|bassline)\b/.test(text)) return "bass";
  if (/\b(piano|keys|keyboard|organ|synth|rhodes)\b/.test(text)) return "piano";
  if (/\b(guitars?|gtr|lead|rhythm|riff|solo)\b/.test(text)) return "guitar";
  return null;
}

/**
 * What a source covers and what is wrong with it. `missing` holds the ids of the audio files
 * that cannot be found.
 */
export function analyseSource(
  audio: AudioLanesSettings,
  source: Pick<ResolvedSource, "laneId" | "clipIds" | "range">,
  missing: ReadonlySet<string> = new Set(),
): SourceReport {
  const lane = audio.lanes.find((l) => l.id === source.laneId) ?? null;
  const none = (p: SourceProblem): SourceReport => ({
    lane,
    clips: [],
    span: null,
    problem: p,
    advisories: [],
  });
  if (!lane) return none(problem("no-lane", "This audio track is not in the tab any more."));
  if (lane.folder) {
    return none(problem("folder", "A folder holds no audio of its own. Choose a track in it."));
  }
  if (lane.clips.length === 0) {
    return none(problem("empty", "This audio track has no audio yet. Add a clip to it first."));
  }
  const chosen =
    source.clipIds.length > 0
      ? lane.clips.filter((c) => source.clipIds.includes(c.id))
      : lane.clips;
  if (chosen.length === 0) {
    return none(problem("outside", "The clip is not on this audio track any more."));
  }
  if (chosen.length === 1 && source.clipIds.length === 1 && chosen[0]!.mute) {
    return none(
      problem("clip-muted", "This clip is muted, so it would be skipped.", "unmute-clip"),
    );
  }
  const heard = chosen.filter((c) => !c.mute);
  if (heard.length === 0) {
    return none(
      problem("muted", "Every clip of this audio track is muted. Unmute one to convert it."),
    );
  }
  const extent: LaneRange = {
    startMs: Math.min(...heard.map((c) => c.startMs)),
    endMs: Math.max(...heard.map(clipEndMs)),
  };
  const wanted = source.range
    ? {
        startMs: Math.max(source.range.startMs, 0),
        endMs: Math.max(source.range.startMs, source.range.endMs),
      }
    : extent;
  const inside = heard.filter((c) => clipEndMs(c) > wanted.startMs && c.startMs < wanted.endMs);
  if (inside.length === 0) {
    return none(problem("outside", "There is no audio in this time span."));
  }
  // Only what the clips actually play counts.
  const span: LaneRange = {
    startMs: Math.max(wanted.startMs, Math.min(...inside.map((c) => c.startMs))),
    endMs: Math.min(wanted.endMs, Math.max(...inside.map(clipEndMs))),
  };
  const files = inside.some((c) => missing.has(activeTake(c).sourceId));
  if (files) {
    return {
      lane,
      clips: inside,
      span,
      problem: problem(
        "missing-file",
        "The audio file of this track can't be found, so it can't be converted. Find it again from the audio track's menu, then try again.",
      ),
      advisories: [],
    };
  }
  const advisories: string[] = [];
  if (span.endMs - span.startMs < SHORT_SPAN_MS) {
    advisories.push("This part is very short. There may be no notes to find in it.");
  }
  if (looksLikeFullMix(lane)) {
    advisories.push(
      "This looks like a whole mix. Notes are found best in a track with one instrument.",
    );
  }
  if (span.endMs - span.startMs > MAX_SPAN_MS) {
    return {
      lane,
      clips: inside,
      span,
      problem: problem(
        "too-long",
        "A conversion takes up to 10 minutes of audio at a time. Choose a shorter part.",
        "first-10-minutes",
      ),
      advisories,
    };
  }
  return { lane, clips: inside, span, problem: null, advisories };
}

/** The first 10 minutes of a span, for the "Use the first 10 minutes" fix. */
export const firstTenMinutes = (span: LaneRange): LaneRange => ({
  startMs: span.startMs,
  endMs: span.startMs + MAX_SPAN_MS,
});

/** `m:ss` of a point on the audio timeline. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What the lane dialog tells about a source: "Lead guitar, clip 3, 0:48 to 1:30". */
export function describeSource(report: SourceReport, source: Pick<ResolvedSource, "clipIds">) {
  const name = report.lane?.name ?? "Audio track";
  const part = report.span ? `${clock(report.span.startMs)} to ${clock(report.span.endMs)}` : "";
  const clip =
    source.clipIds.length === 1 && report.lane
      ? `, clip ${report.lane.clips.findIndex((c) => c.id === source.clipIds[0]) + 1}`
      : source.clipIds.length > 1
        ? `, ${source.clipIds.length} clips`
        : "";
  return `${name}${clip}${part ? `, ${part}` : ""}`;
}

// --- Where the notes go ------------------------------------------------------------------

/** The bar the notes start at, and what to tell about it. */
export interface StartBar {
  /** 0-based. */
  bar: number;
  /** The span starts clearly inside a bar: notes are placed from the bar's start. */
  midBar: boolean;
  /** The audio starts before the first bar of the tab. */
  beforeFirst: boolean;
  /** The bar is past the end of the tab: it grows. */
  pastEnd: boolean;
}

/**
 * The default start bar: where the span starts on the song's grid, rounded to a bar and kept
 * from 0 to the number of bars (a bar past the last one means the tab grows).
 */
export function startBarFor(
  audio: AudioLanesSettings,
  grid: SongGrid,
  startMs: number,
  barCount: number,
): StartBar {
  const exact = barAtTimelineMs(audio, grid, startMs);
  const rounded = Math.round(exact);
  const bar = Math.min(Math.max(rounded, 0), Math.max(barCount, 0));
  return {
    bar,
    midBar: exact >= 0 && Math.abs(exact - rounded) > 0.08,
    beforeFirst: exact < -0.001,
    pastEnd: bar >= barCount,
  };
}

/** The first bar after the last bar of a track that holds notes (0 for an empty track). */
export function firstEmptyBar(score: Score, trackIndex: number): number {
  const staff = score.tracks[trackIndex]?.staves[0];
  if (!staff) return 0;
  for (let i = staff.bars.length - 1; i >= 0; i--) {
    if (staff.bars[i]!.voices.some((voice) => !isPlaceholderVoice(voice))) return i + 1;
  }
  return 0;
}

export type TrackKindFor = "stringed" | "pitched" | "drums";

/** Which kind of track an instrument goes on. */
export const trackKindFor = (instrument: RecordInstrument): TrackKindFor =>
  instrument === "drums" ? "drums" : instrument === "piano" ? "pitched" : "stringed";

/** The tracks an instrument can be written on. */
export function compatibleTracks<T extends { kind: string }>(
  tracks: readonly T[],
  instrument: RecordInstrument,
): T[] {
  const kind = trackKindFor(instrument);
  return tracks.filter((t) => t.kind === kind);
}

/** Where the notes go: a track of this tab, a new track in it, or a new tab. */
export type PlaceChoice =
  { kind: "track"; index: number } | { kind: "new-track" } | { kind: "new-tab" };

export const samePlace = (a: PlaceChoice, b: PlaceChoice): boolean =>
  a.kind === b.kind && (a.kind !== "track" || (b.kind === "track" && a.index === b.index));

/**
 * The track to suggest: a suitable track named like the lane, then the track of the edit cursor,
 * then the first suitable track, then a new track. A new tab when no song is open.
 */
export function defaultPlace(options: {
  laneName: string;
  instrument: RecordInstrument;
  tracks: readonly { index: number; name: string; kind: string }[] | null;
  cursorTrack: number | null;
}): PlaceChoice {
  if (options.tracks === null) return { kind: "new-tab" };
  const suitable = compatibleTracks(options.tracks, options.instrument);
  const name = options.laneName.trim().toLowerCase();
  const named =
    name === ""
      ? undefined
      : (suitable.find((t) => t.name.trim().toLowerCase() === name) ??
        suitable.find((t) => {
          const track = t.name.trim().toLowerCase();
          return track !== "" && (name.includes(track) || track.includes(name));
        }));
  if (named) return { kind: "track", index: named.index };
  const cursor = suitable.find((t) => t.index === options.cursorTrack);
  if (cursor) return { kind: "track", index: cursor.index };
  if (suitable[0]) return { kind: "track", index: suitable[0].index };
  return { kind: "new-track" };
}

// --- From the audio timeline to a take ---------------------------------------------------

/**
 * A function from a point of the audio timeline (ms) to the song's time (ms played straight
 * through), built once for a whole run of notes.
 */
function timelineToSong(audio: AudioLanesSettings, grid: SongGrid) {
  const swapped = syncPairs(audio.sync, grid).map((p) => ({ songMs: p.ms, ms: p.songMs }));
  return (ms: number) => audioMsAt(swapped, ms);
}

/**
 * The transcribed notes (seconds on the audio timeline) as a take that starts at the downbeat of
 * `startBar`: the sync points turn audio time into the song's time, and the song's time of the
 * start bar is taken off. What follows is the same as a take from Record to tab.
 */
export function laneNotesToTake(
  audio: AudioLanesSettings,
  grid: SongGrid,
  notes: readonly RecordedNote[],
  startBar: number,
): RecordedNote[] {
  const toSong = timelineToSong(audio, grid);
  const origin = songMsAt(grid, startBar);
  const seconds = (s: number) => (toSong(s * 1000) - origin) / 1000;
  return notes.map((n) => ({ ...n, start: seconds(n.start), end: seconds(n.end) }));
}

// --- The part that was found -------------------------------------------------------------

/** The notes found in a lane, ready to be placed anywhere in a song. */
export interface LanePart {
  /** Seconds on the audio timeline, as the transcriber found them. */
  notes: RecordedNote[];
  /** The take for a song: time 0 is the downbeat of `originBar`. */
  take: RecordedNote[];
  /** The bar (0-based) the span starts at in the song; where the part sits when nothing is moved. */
  originBar: number;
  /** The span that was converted, on the audio timeline. */
  span: LaneRange;
  instrument: RecordInstrument;
  /** The tuning a new guitar or bass track gets. */
  tuning: number[];
  laneName: string;
}

export const INSTRUMENT_LABEL: Record<RecordInstrument, string> = {
  guitar: "Guitar",
  bass: "Bass",
  piano: "Piano",
  drums: "Drums",
};

/** Makes a part from what the transcriber found. */
export function buildPart(
  audio: AudioLanesSettings,
  grid: SongGrid,
  found: { notes: readonly RecordedNote[]; span: LaneRange },
  options: {
    instrument: RecordInstrument;
    tuning: number[];
    laneName: string;
    barCount: number;
  },
): LanePart {
  const originBar = startBarFor(audio, grid, found.span.startMs, options.barCount).bar;
  return {
    notes: [...found.notes],
    take: laneNotesToTake(audio, grid, found.notes, originBar),
    originBar,
    span: found.span,
    instrument: options.instrument,
    tuning: options.tuning,
    laneName: options.laneName,
  };
}

/** Bars as the player counts them (from 1): "bar 5" or "bars 5 to 12". */
export function describeBars(firstBar: number, lastBar: number): string {
  const first = firstBar + 1;
  const last = Math.max(lastBar + 1, first);
  return first === last ? `bar ${first}` : `bars ${first} to ${last}`;
}

// --- What a placement would do ----------------------------------------------------------

/** How many notes a track holds in bars `from` to `to` (0-based, inclusive). */
export function countNotes(score: Score, trackIndex: number, from: number, to: number): number {
  const staff = score.tracks[trackIndex]?.staves[0];
  if (!staff) return 0;
  let count = 0;
  for (let i = Math.max(0, from); i <= to && i < staff.bars.length; i++) {
    for (const voice of staff.bars[i]!.voices) {
      for (const beat of voice.beats) count += beat.notes.length;
    }
  }
  return count;
}

/** The words under the preview: what the placement does, to which bars and which track. */
export function placementCaption(input: {
  kind: PlaceChoice["kind"];
  firstBar: number;
  lastBar: number;
  appended: number;
  trackName: string;
  existingNotes: number;
  noteCount: number;
}): string {
  const bars = describeBars(input.firstBar, input.lastBar);
  const notes = `${input.noteCount} ${input.noteCount === 1 ? "note" : "notes"}`;
  if (input.kind === "new-tab") return `Opens a new tab with ${notes}.`;
  const grows =
    input.appended > 0
      ? ` The tab grows by ${input.appended} ${input.appended === 1 ? "bar" : "bars"}.`
      : "";
  if (input.kind === "new-track") return `Adds ${bars} on a new track (${notes}).${grows}`;
  const existing =
    input.existingNotes > 0
      ? ` (${input.existingNotes} existing ${input.existingNotes === 1 ? "note" : "notes"})`
      : "";
  const verb = input.existingNotes > 0 ? "Replaces" : "Adds";
  return `${verb} ${bars} on ${input.trackName}${existing}, ${notes}.${grows}`;
}

// --- Time as typed -----------------------------------------------------------------------

/** `m:ss.s` of a point on the audio timeline, for the time fields. */
export function formatTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** Reads "48", "48.5", "0:48" or "1:02.5" as ms; null when it is not a time. */
export function parseTime(text: string): number | null {
  const match = /^\s*(?:(\d+):)?(\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]!.replace(",", "."));
  if (!Number.isFinite(seconds) || (match[1] !== undefined && seconds >= 60)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}

/** Where a lane's last clip ends on the timeline, in ms. */
export const laneEndOf = (lane: Pick<AudioLane, "clips">): number => laneEndMs(lane);
