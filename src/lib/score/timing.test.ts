/**
 * What the synthesizer is asked to play: the MIDI that alphaTab generates from
 * a parsed song (as ScorePlayer does), checked note by note against the score.
 */
import { midi, Settings } from "@coderline/alphatab";

import { parseScore, type Score } from "@/lib/score/score";
import { fixtureBytes } from "@/test/score";

function generateMidi(score: Score) {
  const file = new midi.MidiFile();
  const handler = new midi.AlphaSynthMidiFileHandler(file);
  new midi.MidiFileGenerator(score, new Settings(), handler).generate();
  return file.tracks.flatMap((track) => track.events);
}

/** Converts ticks to milliseconds using the song's tempo changes. */
function timeline(events: midi.MidiEvent[], ticksPerQuarter: number) {
  const tempos = events
    .filter((e): e is midi.TempoChangeEvent => e instanceof midi.TempoChangeEvent)
    .map((e) => ({ tick: e.tick, bpm: e.beatsPerMinute }))
    .sort((a, b) => a.tick - b.tick);
  return (tick: number) => {
    let ms = 0;
    for (let i = 0; i < tempos.length; i++) {
      const start = tempos[i]!;
      const end = Math.min(tick, tempos[i + 1]?.tick ?? Infinity);
      if (end <= start.tick) break;
      ms += ((end - start.tick) / ticksPerQuarter) * (60_000 / start.bpm);
    }
    return Math.round(ms);
  };
}

function setup() {
  const { score } = parseScore(fixtureBytes("practice-song.gp"));
  const events = generateMidi(score);
  const toMs = timeline(events, 960);
  const noteOns = events.filter((e): e is midi.NoteOnEvent => e instanceof midi.NoteOnEvent);
  /** Note-on times (ms) per track, by the track's MIDI channel. */
  const timesOf = (trackIndex: number) => {
    const channel = score.tracks[trackIndex]!.playbackInfo.primaryChannel;
    return [...new Set(noteOns.filter((e) => e.channel === channel).map((e) => toMs(e.tick)))];
  };
  return { score, events, toMs, timesOf };
}

// Practice Song: bars 1–2 at 60 BPM (4 s each), bars 3–4 at 120 BPM (2 s each).
const BAR_STARTS_MS = [0, 4_000, 8_000, 10_000];

describe("playback timing", () => {
  it("follows the tempo changes in the score", () => {
    const { events } = setup();

    const tempos = events
      .filter((e): e is midi.TempoChangeEvent => e instanceof midi.TempoChangeEvent)
      .map((e) => [e.tick, e.beatsPerMinute]);

    expect(tempos).toEqual([
      [0, 60],
      [7_680, 120],
    ]);
  });

  it("lasts exactly as long as the score", () => {
    const { events, toMs } = setup();
    expect(toMs(Math.max(...events.map((e) => e.tick)))).toBe(12_000);
  });

  it("starts every track's bars at the same moment", () => {
    const { score, timesOf } = setup();

    for (const track of score.tracks) {
      const times = timesOf(track.index);
      for (const barStart of BAR_STARTS_MS) {
        expect(times, `${track.name} at ${barStart} ms`).toContain(barStart);
      }
    }
  });

  it("plays each note at its written position", () => {
    const { timesOf } = setup();

    // Guitar: quarter notes. 1 s apart at 60 BPM, 0.5 s at 120 BPM.
    expect(timesOf(0)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 8_500, 9_000, 9_500, 10_000,
      10_500, 11_000, 11_500,
    ]);
    // Bass: half notes.
    expect(timesOf(1)).toEqual([0, 2_000, 4_000, 6_000, 8_000, 9_000, 10_000, 11_000]);
    // Drums: quarters, then eighths at 120 BPM (0.25 s apart).
    expect(timesOf(2)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 8_250, 8_500, 8_750, 9_000, 9_250,
      9_500, 9_750, 10_000, 10_250, 10_500, 10_750, 11_000, 11_250, 11_500, 11_750,
    ]);
    // Piano: whole-note chords, one per bar.
    expect(timesOf(3)).toEqual(BAR_STARTS_MS);
  });

  it("plays every track at full channel volume, leaving the level to the mixer", () => {
    const { events } = setup();

    const volumes = events
      .filter((e): e is midi.ControlChangeEvent => e instanceof midi.ControlChangeEvent)
      .filter((e) => e.controller === midi.ControllerType.VolumeCoarse)
      .map((e) => e.value);

    expect(volumes.length).toBeGreaterThan(0);
    expect(new Set(volumes)).toEqual(new Set([127]));
  });

  it("sends each track's pan to its channels", () => {
    const { score, events } = setup();
    const panOf = (channel: number) =>
      events.find(
        (e): e is midi.ControlChangeEvent =>
          e instanceof midi.ControlChangeEvent &&
          e.controller === midi.ControllerType.PanCoarse &&
          e.channel === channel,
      )?.value;

    const bass = score.tracks[1]!.playbackInfo;
    expect(panOf(bass.primaryChannel)).toBe(32); // balance 4 of 16: half left
    expect(panOf(bass.secondaryChannel)).toBe(32);
    expect(panOf(score.tracks[0]!.playbackInfo.primaryChannel)).toBe(64); // centre
  });
});
